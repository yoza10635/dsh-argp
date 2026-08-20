window.__ModuleLoader__.load({ id: "dsh-argp", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
    if (Array.isArray(parsed.cites) && parsed.cites.every((c) => typeof c === "string")) {
      return parsed.cites;
    }
    return null;
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

// src/client/index.ts
var inject = ["assistantDisplay"];
function apply(ctx) {
  ctx.assistantDisplay.register((blocks) => {
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
return module.exports; } });
