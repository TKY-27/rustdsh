import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createHumanAnnotationPanel } from "../human-annotations-ui.mjs";
import { annotationSnapshotId, eventTargetId } from "../annotation-identifiers.mjs";

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.required = false;
    this.value = "";
    this.textContent = "";
    this.className = "";
    this.id = "";
    this.listeners = new Map();
  }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
  }
  getAttribute(key) {
    return this.attributes.get(key) ?? null;
  }
  append(...items) {
    for (const item of items) this.children.push(item);
    return this;
  }
  replaceChildren(...items) {
    this.children = [...items];
    return this;
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  emit(type) {
    for (const listener of this.listeners.get(type) ?? [])
      listener({ preventDefault() {}, target: this });
  }
  querySelectorAll(selector) {
    const wanted = new Set(
      selector
        .split(",")
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean),
    );
    const found = [];
    const walk = (element) => {
      if (wanted.has(element.tagName.toLowerCase())) found.push(element);
      for (const child of element.children)
        if (child instanceof FakeElement) walk(child);
    };
    for (const child of this.children)
      if (child instanceof FakeElement) walk(child);
    return found;
  }
}

function harness({ createPanel = createHumanAnnotationPanel, annotations = [], navigateTo = () => {} } = {}) {
  const created = [];
  const node = (tag, text, className) => {
    const element = new FakeElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    created.push(element);
    return element;
  };
  const container = new FakeElement("div");
  const api = async () => ({ annotations, git_head: null });
  const render = createPanel(container, { api, node, navigateTo });
  const form = created.find((item) => item.tagName === "FORM");
  const selects = created.filter((item) => item.tagName === "SELECT");
  // Creation order in human-annotations-ui.mjs: task, kind, event, decision.
  const kindSelect = selects[1];
  const sections = new Map(
    created
      .filter((item) => item.dataset.kind)
      .map((section) => [section.dataset.kind, section]),
  );
  assert.equal(sections.size, 3);
  return { form, kindSelect, sections, render, created, taskSelect: selects[0] };
}

function disabledByKind(sections, kind) {
  return sections
    .get(kind)
    .querySelectorAll("input, select, textarea")
    .map((control) => control.disabled);
}

test("hidden annotation target fields stay out of constraint validation", () => {
  const { kindSelect, sections } = harness();
  for (const kind of ["event", "decision", "diff"]) {
    kindSelect.value = kind;
    kindSelect.emit("change");
    const active = sections.get(kind);
    assert.equal(active.hidden, false, kind + " section should be visible");
    for (const control of active.querySelectorAll("input, select, textarea"))
      assert.equal(control.disabled, false, kind + " visible control enabled");
    for (const other of ["event", "decision", "diff"]) {
      if (other === kind) continue;
      const hidden = sections.get(other);
      assert.equal(hidden.hidden, true, other + " section should be hidden");
      const controls = hidden.querySelectorAll("input, select, textarea");
      assert.ok(controls.length > 0, other + " has form controls");
      for (const control of controls)
        assert.equal(
          control.disabled,
          true,
          other + " hidden control must be disabled",
        );
    }
  }
  // Required markers stay for the visible kind; disabled keeps hidden ones out.
  const eventControls = sections.get("event").querySelectorAll("input, select, textarea");
  const decisionControls = sections.get("decision").querySelectorAll("input, select, textarea");
  const diffControls = sections.get("diff").querySelectorAll("input, select, textarea");
  assert.ok(eventControls.some((control) => control.required));
  assert.ok(decisionControls.some((control) => control.required));
  assert.ok(diffControls.some((control) => control.required));
  kindSelect.value = "event";
  kindSelect.emit("change");
  assert.deepEqual(disabledByKind(sections, "event"), [false, false]);
});

// Expected copy keeps each backend reason distinct; no product catalog or
// renderer lookup is used to derive the expected translations.
const referenceCases = [
  ["eventMissing", "event", "missing", "参照切れ・保持期限または削除", "Reference unavailable · retention expired or deleted", "引用失效 · 保留期已过或已删除"],
  ["eventCurrent", "event", "current", "現行のevent", "Current event", "当前事件"],
  ["eventChanged", "event", "changed", "旧版・event内容が変更", "Old version · event content changed", "旧版 · 事件内容已更改"],
  ["decisionMissing", "decision", "missing", "参照切れ・決定記録がありません", "Reference unavailable · no decision record", "引用失效 · 决策记录不存在"],
  ["decisionCurrent", "decision", "current", "現行の決定記録", "Current decision record", "当前决策记录"],
  ["decisionChanged", "decision", "changed", "旧版・決定内容が変更", "Old version · decision content changed", "旧版 · 决策内容已更改"],
  ["gitUnavailable", "diff", "unknown", "参照状態を確認できません・Git repositoryが利用できません", "Reference status unconfirmed · Git repository is unavailable", "无法确认引用状态 · Git 仓库不可用"],
  ["commitMissing", "diff", "missing", "参照切れ・固定したcommitを確認できません", "Reference unavailable · pinned commit cannot be verified", "引用失效 · 无法确认固定的提交"],
  ["fileUnreadable", "diff", "unknown", "参照状態を確認できません・ファイルを読めません", "Reference status unconfirmed · file cannot be read", "无法确认引用状态 · 无法读取文件"],
  ["fileMissing", "diff", "missing", "参照切れ・現在のファイルがありません", "Reference unavailable · current file is missing", "引用失效 · 当前文件不存在"],
  ["headUnreadable", "diff", "unknown", "参照状態を確認できません・HEADを読めません", "Reference status unconfirmed · HEAD cannot be read", "无法确认引用状态 · 无法读取 HEAD"],
  ["worktreeUnreadable", "diff", "unknown", "参照状態を確認できません・作業ツリーを読めません", "Reference status unconfirmed · worktree cannot be read", "无法确认引用状态 · 无法读取工作区"],
  ["diffCurrent", "diff", "current", "固定したcommit・行と現行ファイルが一致", "Pinned commit and line match the current file", "固定的提交及行与当前文件一致"],
  ["diffChanged", "diff", "changed", "旧版・現行ファイルは別の内容", "Old version · current file has different content", "旧版 · 当前文件的内容不同"],
];

async function backendReferences() {
  const source = await readFile(new URL("../human-annotations.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function referenceStatus(");
  const body = source.slice(start, source.indexOf("\n}", start) + 2);
  assert.ok(start >= 0);
  assert.deepEqual(new Set([...body.matchAll(/label: "([^"]+)"/g)].map(match => match[1])), new Set(referenceCases.map(row => row[3])));
  const records = [];
  for (const [reason, kind, code, label] of referenceCases) {
    const target = { kind, title: "原題 日本語 {id}", event_id: "event", question_id: "question", revision: 1,
      question_excerpt: "質問原文 {id}", answer_excerpt: "回答原文 中文", excerpt: "保存原文 日本語 中文 {id}",
      commit: "a".repeat(40), path: "src/資料.rs", blob: "blob", line: 1, fingerprint: "changed" };
    const event = { id: "event", title: "event" }, question = { id: "question", answer: "answer" };
    if (reason === "eventCurrent") target.fingerprint = JSON.stringify(event);
    if (reason === "decisionCurrent") target.fingerprint = JSON.stringify(question);
    const state = { events: reason === "eventMissing" ? [] : [event], questions: reason === "decisionMissing" ? [] : [question] };
    const referenceStatus = vm.runInNewContext("(" + body + ")", {
      path, eventIdentifier: value => value.id, eventSnapshot: value => value, decisionSnapshot: (_state, value) => value,
      digest: value => JSON.stringify(value),
      repositoryRoot: async () => { if (reason === "gitUnavailable") throw new Error("synthetic Git unavailable"); return { realGitRoot: "/synthetic" }; },
      git: async (_root, args) => {
        if (args[0] === "status") { if (reason === "worktreeUnreadable") throw new Error("synthetic status error"); return ""; }
        if (args.at(-1) === "HEAD^{commit}") { if (reason === "headUnreadable") throw new Error("synthetic HEAD error"); return "head"; }
        if (args.at(-1).startsWith("head:")) return reason === "diffChanged" ? "other" : "blob";
        if (reason === "commitMissing") throw new Error("synthetic pinned commit missing");
        return "blob";
      },
      fs: { lstat: async () => {
        if (reason === "fileUnreadable") throw Object.assign(new Error("synthetic read error"), { code: "EACCES" });
        if (reason === "fileMissing") throw Object.assign(new Error("synthetic missing file"), { code: "ENOENT" });
        return { isFile: () => true, isSymbolicLink: () => false };
      } },
    });
    const status = await referenceStatus({ root: "/synthetic" }, { target }, state);
    assert.equal(status.code, code); assert.equal(status.label, label);
    records.push({ id: reason, task_id: "task", target, note: `利用者原文 ${label} · {id} · <img>`,
      created_at: "2026-10-14T00:00:00Z", reference_status: { ...status } });
  }
  return records;
}

for (const language of ["ja", "en", "zh-CN"]) {
  test(`all backend reference reasons render in ${language} while unknown labels, notes and codes stay verbatim`, async t => {
    const originalDocument = globalThis.document;
    t.after(() => { globalThis.document = originalDocument; });
    globalThis.document = { documentElement: { dataset: { rdshLocale: language } } };
    const source = (await readFile(new URL("../human-annotations-ui.mjs", import.meta.url), "utf8"))
      .replace('"./locale.mjs"', JSON.stringify(new URL(`../locale.mjs?annotation-language=${language}`, import.meta.url).href))
      .replace('"./annotation-identifiers.mjs"', JSON.stringify(new URL("../annotation-identifiers.mjs", import.meta.url).href));
    const { createHumanAnnotationPanel: createPanel } = await import("data:text/javascript," + encodeURIComponent(source));
    const records = await backendReferences();
    const expected = new Map(referenceCases.map(row => [row[0], row[{ ja: 3, en: 4, "zh-CN": 5 }[language]]]));
    for (const [i, label] of ["製品外の状態 {id} 中文", "annotation.reference.eventCurrent", "__proto__"].entries()) {
      records.push({ ...records[0], id: "external-" + i, note: "外部注釈 " + i, reference_status: { code: "external-code", label } });
      expected.set("external-" + i, label);
    }
    records.push({ ...records[0], id: "empty-label", note: "空labelの注釈", reference_status: { code: "unknown", label: "" } });
    expected.set("empty-label", { ja: "参照状態を確認できません", en: "Reference status is unconfirmed", "zh-CN": "无法确认引用状态" }[language]);
    const original = structuredClone(records), destinations = [];
    const f = harness({ createPanel, annotations: records, navigateTo: id => destinations.push(id) });
    f.render({ revision: 1, tasks: [{ id: "task", title: "原task" }], events: [], questions: [] });
    await new Promise(resolve => setImmediate(resolve));
    f.taskSelect.value = "task"; f.taskSelect.emit("change");
    const cards = f.created.filter(element => element.tagName === "ARTICLE");
    assert.equal(cards.length, records.length);
    for (const [i, record] of [...records].reverse().entries()) {
      const card = cards[i];
      assert.equal(card.children[0].textContent, expected.get(record.id), record.id);
      assert.equal(card.children[0].className, "human-annotation-status " + record.reference_status.code);
      assert.equal(card.children[2].textContent, record.note);
      const snapshot = card.children.find(element => element.tagName === "DETAILS");
      assert.equal(snapshot.children.at(-1).textContent, record.target.kind === "decision" ? record.target.answer_excerpt : record.target.excerpt);
      if (record.id === "eventCurrent" || record.id === "eventChanged") {
        card.children.find(element => element.className === "human-annotation-actions").children[0].emit("click");
        assert.equal(destinations.at(-1), record.id === "eventCurrent" ? eventTargetId(record.target.event_id) : annotationSnapshotId(record.id));
      }
    }
    assert.deepEqual(records, original, "rendering cannot rewrite backend codes, labels or saved text");
  });
}
