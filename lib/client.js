window.__ModuleLoader__.load({ id: "dsh-argp", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/cites-strip.ts
var CITES_TAIL_FENCED = /```(?:json)?\s*(\{[\s\S]*?\})\s*```\s*$/;
var CITES_TAIL_BARE = /(\{\s*"cites"\s*:[\s\S]*?\})\s*$/;
function matchCitesTail(text) {
  const fenced = text.match(CITES_TAIL_FENCED);
  const bare = text.match(CITES_TAIL_BARE);
  const raw = fenced?.[1] ?? bare?.[1];
  if (raw === void 0) return null;
  const span = (fenced?.[0] ?? bare?.[0] ?? "").length;
  return { raw, span };
}
function parseCitesBlock(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.cites)) return null;
    const out = [];
    for (const item of parsed.cites) {
      if (typeof item === "string") {
        out.push({ text: item, level: "supporting" });
        continue;
      }
      if (item !== null && typeof item === "object" && typeof item.t === "string") {
        const t = item.t;
        const l = item.l;
        let level = "supporting";
        if (typeof l === "string") {
          const lv = l.trim().toLowerCase();
          if (lv === "c" || lv === "critical") level = "critical";
          else if (lv === "x" || lv === "contextual") level = "contextual";
          else level = "supporting";
        }
        out.push({ text: t, level });
        continue;
      }
      return null;
    }
    return out;
  } catch {
    return null;
  }
}
function stripCitesTail(text) {
  const matched = matchCitesTail(text);
  if (matched === null) return text;
  if (parseCitesBlock(matched.raw) === null) return text;
  return text.slice(0, text.length - matched.span).trimEnd();
}

// src/client/argp-config-controller.ts
var ARG_SETTINGS_KEY = "dsh-argp";
var en = {
  argpTitle: "ARGP context compaction",
  argpDescription: "Guarded context compression: eager per-atom shrink + lazy reference-graph eviction. Edits apply live, no restart.",
  windowRatio: "Compaction window ratio",
  windowRatioHint: "Fraction of the context budget the engine may use before it compacts (0.1\u20131).",
  retainRatio: "Retain ratio",
  retainRatioHint: "Fraction of the window kept verbatim after a compaction (0.05\u20131).",
  maxPasses: "Max pruning passes",
  maxPassesHint: "Upper bound on reference-graph eviction passes per compaction (integer \u2265 1).",
  recencyGuard: "Recency guard (turns)",
  recencyGuardHint: "Newest N turns are never pruned (integer \u2265 0).",
  turnGuard: "Turn guard (turns)",
  turnGuardHint: "Keep at least this many turns regardless of score (integer \u2265 0).",
  minSpanChars: "Minimum span length (chars)",
  minSpanCharsHint: "Spans shorter than this are kept; below it, pruning is not worth the overhead (integer \u2265 0).",
  enableSummarize: "Enable extractive summarization",
  enableSummarizeHint: "When on, pruned spans are replaced by an extractive summary instead of being dropped.",
  sortMode: "Eviction order",
  sortModeHint: "legacy = insertion order; density = highest information-density first; density-chain = density with overlap chaining.",
  charsPerToken: "Chars per token",
  charsPerTokenHint: "Heuristic used to convert characters to tokens for budget math (0.5\u20138).",
  overridden: "Overridden",
  reset: "Reset to default",
  readOnly: "This deployment stores settings read-only.",
  expand: "Show settings",
  collapse: "Hide settings",
  save: "Save",
  saving: "Saving\u2026",
  discard: "Discard",
  unsaved: "Unsaved",
  saveFailed: "The deployment did not accept these values; they were left for you to correct.",
  invalidNumber: "Enter a number, or leave blank to use the default."
};
var zh = {
  argpTitle: "ARGP \u4E0A\u4E0B\u6587\u538B\u7F29",
  argpDescription: "\u5E26\u62A4\u680F\u7684\u4E0A\u4E0B\u6587\u538B\u7F29\uFF1A\u6025\u5207\u7684\u9010\u539F\u5B50\u6536\u7F29 + \u60F0\u6027\u5F15\u7528\u56FE\u9A71\u9010\u3002\u4FEE\u6539\u5373\u65F6\u751F\u6548\uFF0C\u65E0\u9700\u91CD\u542F\u3002",
  windowRatio: "\u538B\u7F29\u7A97\u53E3\u6BD4\u4F8B",
  windowRatioHint: "\u5F15\u64CE\u5728\u89E6\u53D1\u538B\u7F29\u524D\u53EF\u4F7F\u7528\u7684\u4E0A\u4E0B\u6587\u9884\u7B97\u5360\u6BD4\uFF080.1\u20131\uFF09\u3002",
  retainRatio: "\u4FDD\u7559\u6BD4\u4F8B",
  retainRatioHint: "\u6BCF\u6B21\u538B\u7F29\u540E\u539F\u6837\u4FDD\u7559\u7684\u7A97\u53E3\u5360\u6BD4\uFF080.05\u20131\uFF09\u3002",
  maxPasses: "\u6700\u5927\u9A71\u9010\u8F6E\u6570",
  maxPassesHint: "\u6BCF\u6B21\u538B\u7F29\u5F15\u7528\u56FE\u9A71\u9010\u7684\u6700\u5927\u8F6E\u6570\uFF08\u6574\u6570 \u2265 1\uFF09\u3002",
  recencyGuard: "\u65B0\u9C9C\u5EA6\u62A4\u680F\uFF08\u8F6E\uFF09",
  recencyGuardHint: "\u6700\u65B0\u7684 N \u8F6E\u6C38\u8FDC\u4E0D\u4F1A\u88AB\u9A71\u9010\uFF08\u6574\u6570 \u2265 0\uFF09\u3002",
  turnGuard: "\u8F6E\u6570\u62A4\u680F\uFF08\u8F6E\uFF09",
  turnGuardHint: "\u65E0\u8BBA\u8BC4\u5206\u5982\u4F55\u81F3\u5C11\u4FDD\u7559\u8FD9\u4E48\u591A\u8F6E\uFF08\u6574\u6570 \u2265 0\uFF09\u3002",
  minSpanChars: "\u6700\u5C0F\u7247\u6BB5\u957F\u5EA6\uFF08\u5B57\u7B26\uFF09",
  minSpanCharsHint: "\u77ED\u4E8E\u6B64\u957F\u5EA6\u7684\u7247\u6BB5\u4F1A\u88AB\u4FDD\u7559\uFF1B\u4F4E\u4E8E\u5B83\uFF0C\u9A71\u9010\u4E0D\u5212\u7B97\uFF08\u6574\u6570 \u2265 0\uFF09\u3002",
  enableSummarize: "\u542F\u7528\u62BD\u53D6\u5F0F\u6458\u8981",
  enableSummarizeHint: "\u5F00\u542F\u540E\uFF0C\u88AB\u9A71\u9010\u7684\u7247\u6BB5\u4F1A\u66FF\u6362\u4E3A\u62BD\u53D6\u5F0F\u6458\u8981\uFF0C\u800C\u4E0D\u662F\u76F4\u63A5\u4E22\u5F03\u3002",
  sortMode: "\u9A71\u9010\u987A\u5E8F",
  sortModeHint: "legacy = \u63D2\u5165\u987A\u5E8F\uFF1Bdensity = \u4FE1\u606F\u5BC6\u5EA6\u6700\u9AD8\u8005\u4F18\u5148\uFF1Bdensity-chain = \u5BC6\u5EA6\u4F18\u5148\u5E76\u5E26\u91CD\u53E0\u94FE\u8DEF\u3002",
  charsPerToken: "\u6BCF token \u5B57\u7B26\u6570",
  charsPerTokenHint: "\u7528\u4E8E\u628A\u5B57\u7B26\u6362\u7B97\u6210 token \u505A\u9884\u7B97\u4F30\u7B97\u7684\u542F\u53D1\u503C\uFF080.5\u20138\uFF09\u3002",
  overridden: "\u5DF2\u8986\u76D6",
  reset: "\u6062\u590D\u9ED8\u8BA4",
  readOnly: "\u672C\u90E8\u7F72\u7684\u8BBE\u7F6E\u4E3A\u53EA\u8BFB\u3002",
  expand: "\u5C55\u5F00\u8BBE\u7F6E",
  collapse: "\u6536\u8D77\u8BBE\u7F6E",
  save: "\u4FDD\u5B58",
  saving: "\u4FDD\u5B58\u4E2D\u2026",
  discard: "\u653E\u5F03\u4FEE\u6539",
  unsaved: "\u672A\u4FDD\u5B58",
  saveFailed: "\u672C\u90E8\u7F72\u6CA1\u6709\u63A5\u53D7\u8FD9\u4E9B\u503C\uFF0C\u5DF2\u4FDD\u7559\u4F9B\u4F60\u4FEE\u6539\u3002",
  invalidNumber: "\u8BF7\u586B\u6570\u5B57\uFF1B\u7559\u7A7A\u8868\u793A\u4F7F\u7528\u9ED8\u8BA4\u503C\u3002"
};
function createSnapshotStore(initial) {
  let current = initial;
  const listeners = /* @__PURE__ */ new Set();
  return {
    getSnapshot: () => current,
    set: (next) => {
      current = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}
function numberField(field) {
  return {
    field,
    format: (value) => typeof value === "number" ? String(value) : "",
    parse: (text) => {
      const trimmed = text.trim();
      if (trimmed === "") return { kind: "clear" };
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? { kind: "set", value: parsed } : void 0;
    }
  };
}
function textField(field) {
  return {
    field,
    format: (value) => typeof value === "string" ? value : "",
    parse: (text) => {
      const trimmed = text.trim();
      return trimmed === "" ? { kind: "clear" } : { kind: "set", value: trimmed };
    }
  };
}
function booleanField(field) {
  return {
    field,
    format: (value) => typeof value === "boolean" ? String(value) : "",
    parse: (text) => {
      const trimmed = text.trim().toLowerCase();
      if (trimmed === "") return { kind: "clear" };
      if (trimmed === "true") return { kind: "set", value: true };
      if (trimmed === "false") return { kind: "set", value: false };
      return void 0;
    }
  };
}
var CardForm = class {
  constructor(scope, specs) {
    this.scope = scope;
    this.specs = new Map(specs.map((spec) => [spec.field, spec]));
    scope.subscribe(() => {
      this.publish();
    });
  }
  specs;
  staged = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  saving = false;
  failed = false;
  /** Publish a projection rebuilt whenever the scope or a draft changes. */
  bind(project) {
    const store = createSnapshotStore(project());
    this.listeners.add(() => {
      store.set(project());
    });
    return store;
  }
  /** Read the card-level state: what the Host serves, and what a save would do. */
  shell() {
    const snapshot = this.scope.getSnapshot();
    const plan = this.plan();
    return {
      available: snapshot.status === "ready",
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some((item) => item.run === void 0),
      saving: this.saving,
      failed: this.failed
    };
  }
  /** Read one control's state. */
  field(field) {
    const staged = this.staged.get(field);
    const spec = this.spec(field);
    if (staged === void 0) {
      return {
        text: spec.format(this.sectionValue(field)),
        overridden: this.stored(field),
        invalid: false
      };
    }
    const write = staged.clear ? { kind: "clear" } : spec.parse(staged.text);
    return {
      text: staged.text,
      overridden: write?.kind === "set",
      invalid: write === void 0
    };
  }
  /** Build the edit/reset/save/discard actions bound to this form. */
  actions() {
    return {
      edit: (field, text) => {
        this.stage(field, { text, clear: false });
      },
      resetField: (field) => {
        this.stage(field, { text: this.spec(field).format(this.baseValue(field)), clear: true });
      },
      save: () => {
        void this.save();
      },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return;
        this.staged.clear();
        this.failed = false;
        this.publish();
      }
    };
  }
  /** Write every staged edit, then re-seed from what the Host accepted. */
  async save() {
    const plan = this.plan();
    const writes = plan.flatMap((item) => item.run === void 0 ? [] : [item.run]);
    if (plan.length === 0 || this.saving || writes.length !== plan.length) return;
    this.saving = true;
    this.failed = false;
    this.publish();
    let landed = true;
    for (const write of writes) landed = await write() && landed;
    if (landed) this.staged.clear();
    this.saving = false;
    this.failed = !landed;
    this.publish();
  }
  /** Every staged edit a save would write. */
  plan() {
    const plan = [];
    for (const [field, staged] of this.staged) {
      const spec = this.spec(field);
      if (staged.clear) {
        if (this.stored(field)) plan.push({ field, run: () => this.clear(field) });
        continue;
      }
      if (staged.text === spec.format(this.sectionValue(field))) continue;
      const write = spec.parse(staged.text);
      if (write === void 0) plan.push({ field, run: void 0 });
      else if (write.kind === "clear") plan.push({ field, run: () => this.clear(field) });
      else plan.push({ field, run: () => this.store(field, write.value) });
    }
    return plan;
  }
  async clear(field) {
    await this.scope.unset(field);
    return !this.stored(field);
  }
  async store(field, value) {
    await this.scope.set(field, value);
    return this.userLayer()?.[field] === value;
  }
  stage(field, edit) {
    this.staged.set(field, edit);
    this.failed = false;
    this.publish();
  }
  spec(field) {
    const spec = this.specs.get(field);
    if (spec === void 0) throw new Error(`ARGP config card has no field ${field}`);
    return spec;
  }
  sectionValue(field) {
    return this.scope.getSnapshot().value?.[field];
  }
  baseValue(field) {
    return this.scope.getSnapshot().base?.[field];
  }
  userLayer() {
    return this.scope.getSnapshot().user;
  }
  stored(field) {
    const user = this.userLayer();
    return user !== void 0 && Object.hasOwn(user, field);
  }
  publish() {
    for (const listener of this.listeners) listener();
  }
};
var ArgpConfigController = class {
  form;
  store;
  /** @param scope - the bound settings scope for the `dsh-argp` namespace. */
  constructor(scope) {
    this.form = new CardForm(scope, [
      numberField("windowRatio"),
      numberField("retainRatio"),
      numberField("maxPasses"),
      numberField("recencyGuard"),
      numberField("turnGuard"),
      numberField("minSpanChars"),
      booleanField("enableSummarize"),
      textField("sortMode"),
      numberField("charsPerToken")
    ]);
    this.store = this.form.bind(() => this.projection());
  }
  projection() {
    return {
      ...this.form.shell(),
      windowRatio: this.form.field("windowRatio"),
      retainRatio: this.form.field("retainRatio"),
      maxPasses: this.form.field("maxPasses"),
      recencyGuard: this.form.field("recencyGuard"),
      turnGuard: this.form.field("turnGuard"),
      minSpanChars: this.form.field("minSpanChars"),
      enableSummarize: this.form.field("enableSummarize"),
      sortMode: this.form.field("sortMode"),
      charsPerToken: this.form.field("charsPerToken")
    };
  }
  /** Build the face the card's slot registration injects. */
  inject() {
    return { hooks: { argpConfig: this.store }, ...this.form.actions() };
  }
};

// src/client/argp-config-card.ts
var import_react = __toESM(require("react"), 1);
var h = import_react.default.createElement;
var cardStyle = {
  listStyle: "none",
  border: "1px solid var(--border, #2a2a2e)",
  borderRadius: 8,
  margin: "8px 0",
  background: "var(--bg-elevated, #1e1e22)",
  overflow: "hidden"
};
var headerStyle = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "12px 14px",
  background: "transparent",
  border: "none",
  color: "inherit",
  cursor: "pointer",
  textAlign: "left"
};
var nameStyle = {
  fontWeight: 600,
  fontSize: 14
};
var descriptionStyle = {
  opacity: 0.7,
  fontSize: 12,
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
};
var pendingStyle = {
  fontSize: 11,
  color: "var(--accent, #6ea8fe)",
  border: "1px solid currentColor",
  borderRadius: 4,
  padding: "1px 6px"
};
var bodyStyle = {
  padding: "4px 14px 14px",
  borderTop: "1px solid var(--border, #2a2a2e)"
};
var fieldStyle = {
  margin: "12px 0"
};
var fieldHeadStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 4
};
var labelStyle = {
  fontSize: 13,
  fontWeight: 500
};
var badgeStyle = {
  fontSize: 10,
  opacity: 0.8,
  border: "1px solid var(--border, #2a2a2e)",
  borderRadius: 4,
  padding: "0 5px"
};
var resetStyle = {
  fontSize: 10,
  background: "transparent",
  border: "1px solid var(--border, #2a2a2e)",
  borderRadius: 4,
  color: "inherit",
  cursor: "pointer",
  padding: "0 5px"
};
var inputStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid var(--border, #2a2a2e)",
  background: "var(--bg-input, #161618)",
  color: "inherit",
  fontSize: 13
};
var inputInvalidStyle = {
  ...inputStyle,
  borderColor: "var(--danger, #f0686b)"
};
var hintStyle = {
  margin: "4px 0 0",
  fontSize: 11,
  opacity: 0.65,
  lineHeight: 1.4
};
var footerStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginTop: 16
};
var readOnlyStyle = {
  fontSize: 12,
  opacity: 0.7,
  margin: "8px 0 0"
};
var failedStyle = {
  fontSize: 12,
  color: "var(--danger, #f0686b)",
  margin: "0 0 0 auto"
};
var btnBase = {
  padding: "6px 14px",
  borderRadius: 6,
  border: "1px solid var(--border, #2a2a2e)",
  cursor: "pointer",
  fontSize: 13
};
var discardBtn = {
  ...btnBase,
  background: "transparent",
  color: "inherit"
};
var saveBtn = {
  ...btnBase,
  background: "var(--accent, #6ea8fe)",
  color: "var(--accent-fg, #08121f)",
  borderColor: "transparent",
  fontWeight: 600
};
var chevronStyle = (open) => ({
  transition: "transform 0.15s ease",
  transform: open ? "rotate(0deg)" : "rotate(-90deg)",
  opacity: 0.7,
  fontSize: 12
});
function TextField(props) {
  const { id, label, hint, state, numeric, t, onEdit, onReset } = props;
  return h(
    "div",
    { style: fieldStyle },
    h(
      "div",
      { style: fieldHeadStyle },
      h("label", { htmlFor: id, style: labelStyle }, label),
      state.overridden ? h(
        "span",
        { style: badgeStyle },
        t("overridden"),
        " ",
        h("button", {
          type: "button",
          style: resetStyle,
          disabled: false,
          onClick: onReset
        }, t("reset"))
      ) : null
    ),
    h("input", {
      id,
      type: "text",
      style: state.invalid ? inputInvalidStyle : inputStyle,
      inputMode: numeric ? "numeric" : void 0,
      "aria-invalid": state.invalid || void 0,
      value: state.text,
      placeholder: "",
      onChange: (e) => {
        onEdit(e.target.value);
      }
    }),
    h("p", { style: hintStyle }, state.invalid ? t("invalidNumber") : hint)
  );
}
function BoolField(props) {
  const { id, label, hint, state, t, onEdit, onReset } = props;
  return h(
    "div",
    { style: fieldStyle },
    h(
      "div",
      { style: fieldHeadStyle },
      h("label", { htmlFor: id, style: labelStyle }, label),
      state.overridden ? h(
        "span",
        { style: badgeStyle },
        t("overridden"),
        " ",
        h("button", {
          type: "button",
          style: resetStyle,
          disabled: false,
          onClick: onReset
        }, t("reset"))
      ) : null
    ),
    h("input", {
      id,
      type: "checkbox",
      checked: state.text === "true",
      onChange: (e) => {
        onEdit(e.target.checked ? "true" : "false");
      }
    }),
    h("p", { style: hintStyle }, hint)
  );
}
function SelectField(props) {
  const { id, label, hint, state, t, onEdit, onReset } = props;
  const options = ["legacy", "density", "density-chain"];
  return h(
    "div",
    { style: fieldStyle },
    h(
      "div",
      { style: fieldHeadStyle },
      h("label", { htmlFor: id, style: labelStyle }, label),
      state.overridden ? h(
        "span",
        { style: badgeStyle },
        t("overridden"),
        " ",
        h("button", {
          type: "button",
          style: resetStyle,
          disabled: false,
          onClick: onReset
        }, t("reset"))
      ) : null
    ),
    h("select", {
      id,
      style: inputStyle,
      value: state.text,
      onChange: (e) => {
        onEdit(e.target.value);
      }
    }, ...options.map((opt) => h("option", { value: opt, key: opt }, opt))),
    h("p", { style: hintStyle }, hint)
  );
}
function ArgpConfigCard(props) {
  const [open, setOpen] = import_react.default.useState(false);
  const saveStarted = import_react.default.useRef(false);
  const state = props.useArgpConfig((s) => s);
  import_react.default.useEffect(() => {
    if (state.saving) {
      saveStarted.current = true;
      return;
    }
    if (!saveStarted.current) return;
    saveStarted.current = false;
    if (!state.dirty && !state.failed) setOpen(false);
  }, [state.dirty, state.failed, state.saving]);
  if (!state.available) return null;
  const t = props.t;
  const title = t("argpTitle");
  const blocked = !state.dirty || state.invalid || state.saving;
  return h(
    "li",
    { style: cardStyle },
    h(
      "button",
      {
        type: "button",
        style: headerStyle,
        "aria-expanded": open,
        onClick: () => {
          setOpen(!open);
        }
      },
      h(
        "span",
        { style: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0 } },
        h("span", { style: nameStyle }, title),
        h("span", { style: descriptionStyle }, t("argpDescription"))
      ),
      state.dirty ? h("span", { style: pendingStyle }, t("unsaved")) : null,
      h("span", { style: chevronStyle(open) }, "\u25BE")
    ),
    open ? h(
      "div",
      { style: bodyStyle },
      !state.writable ? h("p", { style: readOnlyStyle, role: "status" }, t("readOnly")) : null,
      h(TextField, {
        id: "argp-windowRatio",
        label: t("windowRatio"),
        hint: t("windowRatioHint"),
        state: state.windowRatio,
        numeric: true,
        t,
        onEdit: (text) => {
          props.edit("windowRatio", text);
        },
        onReset: () => {
          props.resetField("windowRatio");
        }
      }),
      h(TextField, {
        id: "argp-retainRatio",
        label: t("retainRatio"),
        hint: t("retainRatioHint"),
        state: state.retainRatio,
        numeric: true,
        t,
        onEdit: (text) => {
          props.edit("retainRatio", text);
        },
        onReset: () => {
          props.resetField("retainRatio");
        }
      }),
      h(TextField, {
        id: "argp-maxPasses",
        label: t("maxPasses"),
        hint: t("maxPassesHint"),
        state: state.maxPasses,
        numeric: true,
        t,
        onEdit: (text) => {
          props.edit("maxPasses", text);
        },
        onReset: () => {
          props.resetField("maxPasses");
        }
      }),
      h(TextField, {
        id: "argp-recencyGuard",
        label: t("recencyGuard"),
        hint: t("recencyGuardHint"),
        state: state.recencyGuard,
        numeric: true,
        t,
        onEdit: (text) => {
          props.edit("recencyGuard", text);
        },
        onReset: () => {
          props.resetField("recencyGuard");
        }
      }),
      h(TextField, {
        id: "argp-turnGuard",
        label: t("turnGuard"),
        hint: t("turnGuardHint"),
        state: state.turnGuard,
        numeric: true,
        t,
        onEdit: (text) => {
          props.edit("turnGuard", text);
        },
        onReset: () => {
          props.resetField("turnGuard");
        }
      }),
      h(TextField, {
        id: "argp-minSpanChars",
        label: t("minSpanChars"),
        hint: t("minSpanCharsHint"),
        state: state.minSpanChars,
        numeric: true,
        t,
        onEdit: (text) => {
          props.edit("minSpanChars", text);
        },
        onReset: () => {
          props.resetField("minSpanChars");
        }
      }),
      h(BoolField, {
        id: "argp-enableSummarize",
        label: t("enableSummarize"),
        hint: t("enableSummarizeHint"),
        state: state.enableSummarize,
        t,
        onEdit: (text) => {
          props.edit("enableSummarize", text);
        },
        onReset: () => {
          props.resetField("enableSummarize");
        }
      }),
      h(SelectField, {
        id: "argp-sortMode",
        label: t("sortMode"),
        hint: t("sortModeHint"),
        state: state.sortMode,
        t,
        onEdit: (text) => {
          props.edit("sortMode", text);
        },
        onReset: () => {
          props.resetField("sortMode");
        }
      }),
      h(TextField, {
        id: "argp-charsPerToken",
        label: t("charsPerToken"),
        hint: t("charsPerTokenHint"),
        state: state.charsPerToken,
        numeric: true,
        t,
        onEdit: (text) => {
          props.edit("charsPerToken", text);
        },
        onReset: () => {
          props.resetField("charsPerToken");
        }
      }),
      h(
        "div",
        { style: footerStyle },
        state.failed ? h("p", { style: failedStyle, role: "status" }, t("saveFailed")) : null,
        h("button", {
          type: "button",
          style: discardBtn,
          disabled: !state.dirty || state.saving,
          onClick: props.discard
        }, t("discard")),
        h("button", {
          type: "button",
          style: saveBtn,
          disabled: blocked,
          onClick: props.save
        }, t(state.saving ? "saving" : "save"))
      )
    ) : null
  );
}

// src/client/index.ts
var inject = ["locale", "slots"];
function registerArgpSettingsCard(ctx) {
  const locale = ctx.get("locale");
  if (locale?.register !== void 0) {
    locale.register(ARG_SETTINGS_KEY, { zh, en });
  }
  const injectable = ctx;
  if (typeof injectable.inject !== "function") return;
  injectable.inject(["settingsScope"], (scoped) => {
    try {
      const settingsScope = scoped.get("settingsScope");
      const slots = scoped.get("slots");
      if (settingsScope?.bind === void 0 || slots?.inject === void 0) return;
      const bound = settingsScope.bind({ namespace: ARG_SETTINGS_KEY });
      const controller = new ArgpConfigController(bound);
      slots.inject("settings.plugin.item", () => slots.register(
        {
          name: "settings.plugin.item",
          key: ARG_SETTINGS_KEY,
          locale: ARG_SETTINGS_KEY,
          inject: () => controller.inject()
        },
        ArgpConfigCard
      ));
    } catch (err) {
      console.error("[dsh-argp] settings card registration failed:", err);
    }
  });
}
function apply(ctx) {
  const display = ctx.get("assistantDisplay");
  if (display?.register !== void 0) {
    display.register((blocks) => {
      let lastText = -1;
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const block = blocks[i];
        if (block !== void 0 && block.kind === "text" && typeof block.text === "string") {
          lastText = i;
          break;
        }
      }
      if (lastText === -1) return blocks;
      const text = blocks[lastText].text;
      const body = stripCitesTail(text);
      if (body === text) return blocks;
      const next = blocks.slice();
      next[lastText] = { ...blocks[lastText], text: body };
      return next;
    });
  }
  registerArgpSettingsCard(ctx);
}
return module.exports; } });
