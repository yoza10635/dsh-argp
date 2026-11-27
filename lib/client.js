/* dsh-argp client bundle v2.3.0 */
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

// src/client/argp-config-controller.ts
var ARG_SETTINGS_KEY = "dsh-argp";
var en = {
  argpTitle: "ARGP context compaction",
  argpDescription: "Automatically trims a long conversation to free up room. Changes apply live, no restart.",
  compactionThreshold: "Compaction threshold",
  compactionThresholdHint: "Fraction of the declared window (0\u20131) at which context is compacted before sending. 0 or blank = off; when off, a wall hit (the provider rejecting an oversized request) triggers compaction as the fallback",
  overridden: "Changed",
  reset: "Reset to default",
  readOnly: "This deployment stores settings read-only.",
  expand: "Show settings",
  collapse: "Hide settings",
  save: "Save",
  saving: "Saving\u2026",
  discard: "Discard",
  unsaved: "Unsaved",
  saveFailed: "These values were not accepted; they were left for you to correct.",
  invalidNumber: "Enter a number between 0 and 1, or leave blank to turn the threshold off."
};
var zh = {
  argpTitle: "ARGP \u4E0A\u4E0B\u6587\u538B\u7F29",
  argpDescription: "\u5BF9\u8BDD\u592A\u957F\u65F6\u81EA\u52A8\u7CBE\u7B80\uFF0C\u817E\u51FA\u7A7A\u95F4\u7EE7\u7EED\u804A\u3002\u6539\u52A8\u7ACB\u5373\u751F\u6548\uFF0C\u65E0\u9700\u91CD\u542F\u3002",
  compactionThreshold: "\u538B\u7F29\u9608\u503C",
  compactionThresholdHint: "\u5360\u58F0\u660E\u7A97\u7684\u6BD4\u4F8B\uFF080\u20131\uFF09\uFF1A\u4E0A\u4E0B\u6587\u8FBE\u5230\u8BE5\u6BD4\u4F8B\u5148\u538B\u7F29\u518D\u53D1\u9001\u30020 \u6216\u7559\u7A7A = \u5173\u95ED\uFF1B\u5173\u95ED\u540E\u7531\u6A21\u578B\u649E\u5899\uFF08provider \u62D2\u6536\u8D85\u7A97\u8BF7\u6C42\uFF09\u81EA\u52A8\u538B\u7F29\u515C\u5E95",
  overridden: "\u5DF2\u4FEE\u6539",
  reset: "\u6062\u590D\u9ED8\u8BA4",
  readOnly: "\u672C\u90E8\u7F72\u7684\u8BBE\u7F6E\u4E3A\u53EA\u8BFB\u3002",
  expand: "\u5C55\u5F00\u8BBE\u7F6E",
  collapse: "\u6536\u8D77\u8BBE\u7F6E",
  save: "\u4FDD\u5B58",
  saving: "\u4FDD\u5B58\u4E2D\u2026",
  discard: "\u653E\u5F03\u4FEE\u6539",
  unsaved: "\u672A\u4FDD\u5B58",
  saveFailed: "\u8FD9\u4E9B\u503C\u6CA1\u6709\u88AB\u63A5\u53D7\uFF0C\u5DF2\u4FDD\u7559\u4F9B\u4F60\u4FEE\u6539\u3002",
  invalidNumber: "\u8BF7\u586B 0\u20131 \u4E4B\u95F4\u7684\u6570\u5B57\uFF1B\u7559\u7A7A\u8868\u793A\u5173\u95ED\u538B\u7F29\u9608\u503C\u3002"
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
function numberField(field, spec) {
  return {
    field,
    format: (value) => typeof value === "number" ? String(value) : "",
    parse: (text) => {
      const trimmed = text.trim();
      if (trimmed === "") return { kind: "clear" };
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) return void 0;
      if (spec !== void 0) {
        if (spec.integer === true && !Number.isInteger(parsed)) return void 0;
        if (spec.min !== void 0 && parsed < spec.min) return void 0;
        if (spec.max !== void 0 && parsed > spec.max) return void 0;
      }
      return { kind: "set", value: parsed };
    }
  };
}
var CardForm = class {
  scope;
  specs;
  staged = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  saving = false;
  failed = false;
  constructor(scope, specs) {
    this.scope = scope;
    this.specs = new Map(specs.map((spec) => [spec.field, spec]));
    scope.subscribe(() => {
      this.publish();
    });
  }
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
    try {
      for (const write of writes) landed = await write() && landed;
    } catch (error) {
      landed = false;
      console.warn("[dsh-argp] settings save failed:", error);
    } finally {
      if (landed) this.staged.clear();
      this.saving = false;
      this.failed = !landed;
      this.publish();
    }
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
    return this.settle(() => !this.stored(field));
  }
  async store(field, value) {
    await this.scope.set(field, value);
    return this.settle(() => this.userLayer()?.[field] === value);
  }
  /**
   * 批次 3-2（beta.1）：`set`/`unset` 的 Promise 只保证写入落盘，**不保证**快照已随之
   * 刷新（宿主快照经事件总线异步重发布）。旧实现写后立即读快照校验，读到陈旧 user 层
   * ⇒ 每次保存/恢复默认都被误判失败（"restore-default 恒失败"）。改为等待快照收敛：
   * 60ms 轮询（订阅监听会重发布表单，轮询只读快照），1.5s 超时按当时快照判——真实
   * 被宿主拒绝的写入仍会如期显示失败。
   */
  settle(pred, timeoutMs = 1500) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        if (pred()) {
          resolve(true);
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(check, 60);
      };
      check();
    });
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
      numberField("compactionThreshold", { min: 0, max: 1 })
    ]);
    this.store = this.form.bind(() => this.projection());
  }
  projection() {
    return {
      ...this.form.shell(),
      compactionThreshold: this.form.field("compactionThreshold")
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
  border: "0.5px solid var(--dsw-alias-border-l4, rgba(0, 0, 0, 0.16))",
  borderRadius: 16,
  margin: "8px 0",
  background: "var(--dsw-alias-bg-layer-3, #ffffff)",
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
  fontSize: 15,
  color: "var(--dsw-alias-label-primary, #17181a)"
};
var descriptionStyle = {
  fontSize: 13,
  color: "var(--dsw-alias-label-tertiary, #6b6f76)",
  flex: 1,
  minWidth: 0
};
var pendingStyle = {
  fontSize: 11,
  fontWeight: 500,
  whiteSpace: "nowrap",
  borderRadius: 999,
  padding: "1px 8px",
  background: "var(--dsw-alias-bg-module-platform, rgba(0, 0, 0, 0.06))",
  color: "var(--dsw-alias-label-secondary, #4c5057)"
};
var bodyStyle = {
  padding: "4px 16px 14px",
  borderTop: "0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))"
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
  border: "1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))",
  borderRadius: 4,
  padding: "0 5px"
};
var resetStyle = {
  fontSize: 10,
  background: "transparent",
  border: "1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))",
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
  border: "1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))",
  background: "var(--dsw-alias-bg-layer-2, #ffffff)",
  color: "var(--dsw-alias-label-primary, #17181a)",
  fontSize: 13
};
var inputInvalidStyle = {
  ...inputStyle,
  borderColor: "var(--dsw-alias-label-error, #d64550)"
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
  color: "var(--dsw-alias-label-error, #d64550)",
  margin: "0 0 0 auto"
};
var btnBase = {
  padding: "5px 14px",
  borderRadius: 8,
  border: "1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))",
  cursor: "pointer",
  fontSize: 13
};
var discardBtn = {
  ...btnBase,
  background: "transparent",
  color: "var(--dsw-alias-label-secondary, #4c5057)"
};
var saveBtn = {
  ...btnBase,
  background: "var(--dsw-alias-label-primary, #17181a)",
  color: "var(--dsw-alias-bg-layer-3, #ffffff)",
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
        id: "argp-compactionThreshold",
        label: t("compactionThreshold"),
        hint: t("compactionThresholdHint"),
        state: state.compactionThreshold,
        numeric: true,
        t,
        onEdit: (text) => {
          props.edit("compactionThreshold", text);
        },
        onReset: () => {
          props.resetField("compactionThreshold");
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
function asSettingsScope(form) {
  return {
    subscribe(listener) {
      form.subscribe(listener);
    },
    getSnapshot() {
      const snapshot = form.getSnapshot();
      return {
        status: snapshot.status === "loading" ? "loading" : snapshot.status === "unavailable" ? "unavailable" : "ready",
        writable: snapshot.writable,
        value: snapshot.value ?? {},
        base: snapshot.base ?? {},
        user: snapshot.user
      };
    },
    async set(field, value) {
      await form.set(field, value);
    },
    async unset(field) {
      await form.unset(field);
    }
  };
}
function registerDisposable(ctx, execute, label) {
  if (typeof ctx.effect === "function") {
    ctx.effect(execute, label);
    return;
  }
  execute();
}
var inject = ["locale", "slots"];
function registerArgpSettingsCard(ctx) {
  const locale = ctx.get("locale");
  if (locale?.register !== void 0) {
    registerDisposable(
      ctx,
      () => locale.register(ARG_SETTINGS_KEY, { zh, en }),
      "dsh-argp: settings card dictionaries"
    );
  }
  const injectable = ctx;
  if (typeof injectable.inject !== "function") return;
  injectable.inject(["configForms", "locale", "slots"], (scoped) => {
    try {
      const configForms = scoped.get("configForms");
      const slots = scoped.get("slots");
      if (configForms?.get === void 0 || slots?.inject === void 0) return;
      const form = configForms.get(ARG_SETTINGS_KEY);
      const controller = new ArgpConfigController(asSettingsScope(form));
      slots.inject("settings.plugins.tab", () => slots.register(
        {
          name: "settings.plugins.tab",
          id: ARG_SETTINGS_KEY,
          order: 20,
          // Tab 文案用中性缩写：ARGP 是专有名词，各语言同形，且切换语言时宿主
          // 会重新求值本函数，无需在这层做 locale 绑定。
          label: () => "ARGP",
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
  registerArgpSettingsCard(ctx);
}
return module.exports; } });
//# sourceMappingURL=client.js.map
