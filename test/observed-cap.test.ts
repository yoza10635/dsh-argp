/**
 * §A observedCap 解析单测：只从带真实上限数字的 400 报文取"上限"侧；无数 ⇒ undefined
 * （pi-ai 通用文案，行为不变）。这是"从声明窗切到有效窗"的唯一触发点，误取会误缩窗。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseObservedContextCap } from '../src/argp-engine.ts'

test('parseObservedContextCap：各家 400 报文取上限侧', () => {
  assert.equal(parseObservedContextCap(
    "This model's maximum context length is 131072 tokens. You requested 140000 tokens"), 131072)
  assert.equal(parseObservedContextCap(
    'prompt is too long: 210000 tokens > 200000 maximum'), 200000)
  assert.equal(parseObservedContextCap(
    "The input (140000 tokens) is longer than the model's context length (131072 tokens)"), 131072)
  assert.equal(parseObservedContextCap(
    "Requested token count exceeds the model's maximum of 8,192 tokens"), 8192)
  assert.equal(parseObservedContextCap(
    "This model's maximum context is 64000 tokens"), 64000)
})

test('parseObservedContextCap：无数/过小 ⇒ undefined（保留声明窗，行为不变）', () => {
  assert.equal(parseObservedContextCap('pi-ai detected context overflow for model "Qwen3.8-Flash-Next"'), undefined)
  assert.equal(parseObservedContextCap(''), undefined)
  assert.equal(parseObservedContextCap(undefined), undefined)
  assert.equal(parseObservedContextCap('overloaded_error: temporarily busy'), undefined)
  assert.equal(parseObservedContextCap('limit of 512 tokens'), undefined, '<1024 不当作上下文上限')
})
