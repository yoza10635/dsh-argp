/**
 * seq 去重位图（A5：长会话内存结构有界化）。
 *
 * 病灶：`Set<number>` 每枚 seq 要一个哈希槽 + 一个数字头（V8 实测约 30–40 字节），
 * 而 ARGP 的两枚"全日志规模"去重集（`FactorLedger.observed` 观察去重、
 * `SessionRuntimeState.shadowedSet` 被遮蔽 seq）在长会话里就是日志长度的量级。
 * 宿主契约保证 seq 是**稠密**的（`session.seq` 恒为日志长度、从 0 连续），
 * 故逐位存储天然适配：1 枚 seq = 1 bit，10 万事件仅 12.5 KB。
 *
 * 语义与 `Set<number>` 的 `has`/`add` 一致，不设条数上限——**丢弃任何一枚都是
 * 语义损失**（观察去重丢一枚 ⇒ 该 R 下次重放会被再计一次 sticky 失败；
 * 遮蔽集丢一枚 ⇒ recall 把已剪节点谎报为 live）。A5 的修法是压缩存储，不是截断。
 */

/** seq 集合面（`Set<number>` 与 {@link SeqBitset} 都满足）：消费方只做 `has`，写入方额外要 `add`。 */
export interface SeqSet {
  readonly size: number
  has(seq: number): boolean
  add(seq: number): void
}

export class SeqBitset implements SeqSet {
  private words: Uint32Array
  private _size = 0

  constructor(initialBits = 1024) {
    this.words = new Uint32Array(Math.max(1, Math.ceil(initialBits / 32)))
  }

  get size(): number {
    return this._size
  }

  /** 位图占用字节数（内存回归测试与诊断用）。 */
  get byteLength(): number {
    return this.words.byteLength
  }

  has(seq: number): boolean {
    if (!Number.isInteger(seq) || seq < 0) return false
    const word = seq >>> 5
    if (word >= this.words.length) return false
    return (this.words[word]! & (1 << (seq & 31))) !== 0
  }

  add(seq: number): void {
    if (!Number.isInteger(seq) || seq < 0) return
    const word = seq >>> 5
    if (word >= this.words.length) this.grow(word + 1)
    const mask = 1 << (seq & 31)
    if ((this.words[word]! & mask) !== 0) return
    this.words[word] = this.words[word]! | mask
    this._size += 1
  }

  /** 升序产出已置位 seq（诊断/测试用；生产路径只用 `has`）。 */
  *[Symbol.iterator](): Generator<number> {
    for (let w = 0; w < this.words.length; w += 1) {
      let bits = this.words[w]!
      while (bits !== 0) {
        const lowest = bits & -bits
        yield (w << 5) + (31 - Math.clz32(lowest))
        bits ^= lowest
      }
    }
  }

  private grow(minWords: number): void {
    let next = this.words.length
    while (next < minWords) next *= 2
    const words = new Uint32Array(next)
    words.set(this.words)
    this.words = words
  }
}
