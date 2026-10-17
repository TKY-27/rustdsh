import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as workerGit from "../worker-git.mjs";

// The bridge marker is the command's English about text. `general.language`
// translates it, so the probe must pin English or the native bridge looks
// unavailable and every worker Git call silently falls back (issue #586).
test("worker Git probes the bridge marker with a pinned English language", {
  skip: process.platform === "win32",
}, async (t) => {
  const previousBinary = process.env.RDSH_BIN;
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-worker-git-probe-"));
  const fake = path.join(cwd, "rdsh");
  const argsFile = path.join(cwd, "probe-args");
  await fs.writeFile(
    fake,
    "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$(dirname \"$0\")/probe-args\"\necho Internal JSON bridge for dashboard Git observations\n",
  );
  await fs.chmod(fake, 0o755);
  t.after(async () => {
    if (previousBinary === undefined) delete process.env.RDSH_BIN;
    else process.env.RDSH_BIN = previousBinary;
    await fs.rm(cwd, { recursive: true, force: true });
  });

  process.env.RDSH_BIN = fake;
  assert.equal(await workerGit.workerGitExecutable(), fake);
  const args = (await fs.readFile(argsFile, "utf8")).trim().split("\n");
  assert.deepEqual(args, ["--language", "en", "worker-git", "--help"]);
});
