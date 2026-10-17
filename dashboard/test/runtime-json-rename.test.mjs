import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJson } from "../state.mjs";

async function fixture(t, platform = "win32") {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, "rdsh-runtime-json-"));
  const file = path.join(root, "runtime.json");
  await fs.writeFile(file, '{"old":true}\n', { mode: 0o600 });
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  t.after(async () => {
    t.mock.restoreAll();
    Object.defineProperty(process, "platform", descriptor);
    assert.equal(path.dirname(await fs.realpath(root)), parent);
    assert.ok(path.basename(root).startsWith("rdsh-runtime-json-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, file };
}

function fault(code) {
  return Object.assign(new Error(`injected ${code}`), { code });
}
const runtime = { retryWindowsRename: true };

test("runtime rename retries the same completed temp without reserializing", async (t) => {
  const { root, file } = await fixture(t);
  const rename = fs.rename;
  const writeFile = fs.writeFile;
  const calls = [];
  let serializations = 0, writes = 0;
  t.mock.method(performance, "now", () => 0);
  t.mock.method(fs, "writeFile", async (...args) => {
    writes++;
    assert.equal(args[2].mode, 0o600);
    return writeFile(...args);
  });
  t.mock.method(fs, "rename", async (from, to) => {
    calls.push([from, to]);
    assert.equal(await fs.readFile(from, "utf8"), '{\n  "new": true\n}\n');
    if (calls.length < 3) throw fault("EPERM");
    return rename(from, to);
  });
  await writeJson(file, { toJSON() { serializations++; return { new: true }; } }, runtime);
  assert.equal(serializations, 1);
  assert.equal(writes, 1);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(calls[0], calls[2]);
  assert.equal(path.dirname(calls[0][0]), root);
  assert.equal(await fs.readFile(file, "utf8"), '{\n  "new": true\n}\n');
  assert.deepEqual(await fs.readdir(root), ["runtime.json"]);
});

test("permanent runtime EPERM is bounded, preserves old bytes, and cleans only its temp", async (t) => {
  const { root, file } = await fixture(t);
  const original = fault("EPERM");
  const before = await fs.stat(file);
  let attempts = 0;
  t.mock.method(performance, "now", () => 0);
  t.mock.method(fs, "rename", async (from, to) => {
    attempts++;
    original.path = from;
    original.dest = to;
    throw original;
  });
  await assert.rejects(writeJson(file, { new: true }, runtime), error => error === original);
  assert.equal(attempts, 6);
  assert.equal(original.dest, file);
  assert.equal(await fs.readFile(file, "utf8"), '{"old":true}\n');
  assert.equal((await fs.stat(file)).mode, before.mode);
  assert.deepEqual(await fs.readdir(root), ["runtime.json"]);
});

for (const [name, platform, options, code] of [
  ["ordinary state is not opted in", "win32", undefined, "EPERM"],
  ["explicit false is not opted in", "win32", { retryWindowsRename: false }, "EPERM"],
  ["truthy non-boolean is not opted in", "win32", { retryWindowsRename: "true" }, "EPERM"],
  ["POSIX remains single attempt", "linux", runtime, "EPERM"],
  ["EACCES is not retried", "win32", runtime, "EACCES"],
  ["EBUSY is not retried", "win32", runtime, "EBUSY"],
  ["ENOENT is not retried", "win32", runtime, "ENOENT"],
]) {
  test(name, async (t) => {
    const { root, file } = await fixture(t, platform);
    const original = fault(code);
    let attempts = 0;
    t.mock.method(fs, "rename", async () => { attempts++; throw original; });
    await assert.rejects(writeJson(file, { new: true }, options), error => error === original);
    assert.equal(attempts, 1);
    assert.equal(await fs.readFile(file, "utf8"), '{"old":true}\n');
    assert.deepEqual(await fs.readdir(root), ["runtime.json"]);
  });
}

test("runtime rename does not start another attempt after its time budget", async (t) => {
  const { root, file } = await fixture(t);
  const original = fault("EPERM");
  let nowCalls = 0, attempts = 0;
  t.mock.method(performance, "now", () => ++nowCalls < 3 ? 0 : 100);
  t.mock.method(fs, "rename", async () => { attempts++; throw original; });
  await assert.rejects(writeJson(file, { new: true }, runtime), error => error === original);
  assert.equal(attempts, 1);
  assert.deepEqual(await fs.readdir(root), ["runtime.json"]);
});

for (const operation of ["mkdir", "writeFile", "serialize"]) {
  test(`${operation} failure is not replayed as a runtime write`, async (t) => {
    const { root, file } = await fixture(t);
    const original = fault("ENOSPC");
    let attempts = 0;
    let value = { new: true };
    t.mock.method(fs, "rename", async () => { attempts++; });
    if (operation === "serialize") value = { toJSON() { throw original; } };
    else t.mock.method(fs, operation, async () => { throw original; });
    await assert.rejects(writeJson(file, value, runtime), error => error === original);
    assert.equal(attempts, 0);
    assert.equal(await fs.readFile(file, "utf8"), '{"old":true}\n');
    assert.deepEqual(await fs.readdir(root), ["runtime.json"]);
  });
}
