import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const read = (name) =>
  fs.readFile(fileURLToPath(new URL("../" + name, import.meta.url)), "utf8");
const html = await read("ui.html");
const server = await read("server.mjs");
const viewMode = await read("view-mode.mjs");
const stylesheet = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
const css = stylesheet.replace(/\/\*[\s\S]*?\*\//g, "");

test("stylesheet blocks are balanced", () => {
  // An unclosed rule once swallowed every later rule in the sheet.
  let depth = 0;
  for (const ch of css) {
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    assert.ok(depth >= 0, "closing brace without an opening one");
  }
  assert.equal(depth, 0, "unclosed rule in ui.html");
});

test("the view is applied before paint and defaults to simple", () => {
  const boot = html.indexOf('document.documentElement.dataset.view = view');
  assert.ok(boot > 0, "boot applies the view");
  assert.ok(boot < html.indexOf("<style>"), "boot runs before styles");
  assert.match(html, /let view = "simple";/);
  assert.match(html, /id="view-toggle"/);
  assert.match(html, /<script type="module" src="\.\/view-mode\.mjs"><\/script>/);
  assert.match(viewMode, /rdsh_dashboard_view/);
});

test("simple view keeps the collaboration panels and hides the rest", () => {
  const hidden = [
    ...css.matchAll(/html\[data-view="simple"\] ([^,{]+)[,{]/g),
  ].map((m) => m[1].trim());
  for (const id of [
    "#device-detail",
    "#github-status-detail",
    "#budget-admission",
    "#model-catalog-detail",
    "#profiles-detail",
  ])
    assert.ok(hidden.includes(id), "simple view hides " + id);
  for (const id of [
    "#project-overview",
    "#attention-list",
    "#questions",
    "#agent-ui-detail",
    "#tasks-detail",
    "#progress-detail",
    "#answered",
  ]) {
    assert.ok(!hidden.includes(id), "simple view keeps " + id);
    assert.ok(html.includes(`id="${id.slice(1)}"`), "panel exists: " + id);
  }
});

test("the view module is served like the other dashboard modules", () => {
  assert.equal(server.match(/"\/view-mode\.mjs"/g)?.length, 3);
});
