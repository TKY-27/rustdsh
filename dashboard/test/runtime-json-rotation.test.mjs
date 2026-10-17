import { after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const rename = fs.rename;
const completedTemps = new Set();
let blockedTemp, retried = false;
mock.method(fs, "rename", async (from, to) => {
  if (process.platform === "win32" && path.basename(to) === "runtime.json") {
    completedTemps.add(from);
    if (completedTemps.size === 2 && !blockedTemp) {
      blockedTemp = from;
      throw Object.assign(new Error("injected restart runtime EPERM"), { code: "EPERM", path: from, dest: to });
    }
    if (blockedTemp && !retried) {
      assert.equal(from, blockedTemp);
      retried = true;
    }
  }
  return rename(from, to);
});
after(() => {
  mock.restoreAll();
  if (process.platform === "win32") {
    assert.ok(blockedTemp, "the actual server restart must reach runtime replacement");
    assert.ok(retried, "the actual server must retry the same completed temp");
  }
});

// Reuse the real six-client rotation without weakening its reconnect assertions.
await import("./mcp-clients.test.mjs");
