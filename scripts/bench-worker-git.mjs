import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  dirtyPaths,
  observeWorktree,
  repository,
  sourceSnapshot,
  workerGitExecutable,
} from "../dashboard/worker-git.mjs";

const nativeBinary = process.env.RDSH_BENCH_BIN;
if (!nativeBinary || !path.isAbsolute(nativeBinary)) {
  throw new Error("RDSH_BENCH_BIN must be an absolute path");
}

// Native stays the default on every platform. `dirtyPaths` is one `git status`
// (~4 ms of Git work) and the bridge adds a fixed process hop, so a ratio target
// would demand sub-millisecond behavior; the budgets are absolute instead. The
// multi-Git operations are expected to beat the JavaScript baseline and keep the
// tighter default. `dirtyPaths` is one-shot, so on Windows the bridge process
// start is never amortised across several Git calls and the residual overhead is
// runner-dependent (12.81 ms when #767 landed, 20.58 ms on the 2026-10 runner);
// it gets a wider allowance. See docs/WORKER-WORKSPACES.md.
const DEFAULT_NATIVE_OVERHEAD_MS = 20;
const NATIVE_OVERHEAD_MS = new Map([["dirtyPaths", 30]]);

// The benchmark's own regression tests raise every operation budget through
// RDSH_BENCH_MAX_OVERHEAD_MS so a Node-based fake native can finish; the
// dashboard job keeps the defaults.
function nativeOverheadMs(operation) {
  const override = process.env.RDSH_BENCH_MAX_OVERHEAD_MS;
  if (override !== undefined) {
    const value = Number(override);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("RDSH_BENCH_MAX_OVERHEAD_MS must be a non-negative number");
    }
    return value;
  }
  return NATIVE_OVERHEAD_MS.get(operation) ?? DEFAULT_NATIVE_OVERHEAD_MS;
}

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-worker-git-bench-"));
const root = path.join(fixture, "repo");
const fallbackBinary = path.join(fixture, "missing-rdsh");
const originalBinary = process.env.RDSH_BIN;

function runGit(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

async function invoke(binary, operation) {
  process.env.RDSH_BIN = binary;
  return operation();
}

function median(values) {
  return [...values].sort((left, right) => left - right)[
    Math.floor(values.length / 2)
  ];
}

try {
  await fs.mkdir(root);
  runGit(["init", "-q"]);
  runGit(["config", "user.name", "RustDSH benchmark"]);
  runGit(["config", "user.email", "rustdsh-benchmark@example.invalid"]);
  runGit(["config", "commit.gpgsign", "false"]);
  for (let index = 0; index < 128; index++) {
    const name = `file-${String(index).padStart(3, "0")}.txt`;
    await fs.writeFile(path.join(root, name), `tracked ${index}\n`);
  }
  runGit(["add", "--all"]);
  runGit(["commit", "-qm", "benchmark fixture"]);
  const base = runGit(["rev-parse", "HEAD"]);
  for (let index = 0; index < 8; index++) {
    const name = `file-${String(index).padStart(3, "0")}.txt`;
    await fs.writeFile(path.join(root, name), `dirty ${index}\n`);
  }

  const metadata = await invoke(fallbackBinary, () => repository(root));
  const operations = [
    ["repository", () => repository(root)],
    ["sourceSnapshot", () => sourceSnapshot(root)],
    ["dirtyPaths", () => dirtyPaths(root)],
    [
      "observeWorktree",
      () =>
        observeWorktree(root, {
          git_common_dir: metadata.git_common_dir,
          branch: metadata.branch,
          base,
        }),
    ],
  ];
  const modes = [
    ["JS", fallbackBinary],
    ["Rust", nativeBinary],
  ];
  const backends = {};
  for (const [mode, binary] of modes) {
    backends[mode] = await invoke(binary, workerGitExecutable);
  }
  if (backends.JS !== null) {
    throw new Error(
      `JS mode resolved a native bridge (${backends.JS}); the fallback baseline is invalid`,
    );
  }
  if (backends.Rust !== nativeBinary) {
    throw new Error(
      `Rust mode did not select ${nativeBinary}; refusing to report a JavaScript fallback as native`,
    );
  }
  console.log(
    JSON.stringify({
      benchmark: "worker-git",
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      fixture: { tracked: 128, dirty: 8 },
      backends,
      maxNativeOverheadMs: nativeOverheadMs(),
      operationBudgetsMs: Object.fromEntries(NATIVE_OVERHEAD_MS),
      warmupsPerMode: 1,
      alternatingPairs: 7,
    }),
  );

  let failed = false;
  for (const [name, operation] of operations) {
    const timings = { JS: [], Rust: [] };
    const expected = {};
    for (const [mode, binary] of modes) {
      expected[mode] = await invoke(binary, operation);
    }
    assert.deepEqual(expected.Rust, expected.JS, `${name} output differs`);
    for (const [, binary] of modes) await invoke(binary, operation);

    for (let pair = 0; pair < 7; pair++) {
      const order = pair % 2 === 0 ? modes : [...modes].reverse();
      for (const [mode, binary] of order) {
        const started = performance.now();
        const result = await invoke(binary, operation);
        timings[mode].push(performance.now() - started);
        assert.deepEqual(result, expected.JS, `${name} output changed`);
      }
    }

    const javascriptMs = median(timings.JS);
    const rustMs = median(timings.Rust);
    const budgetMs = nativeOverheadMs(name);
    const overheadMs = rustMs - javascriptMs;
    const verdict = overheadMs <= budgetMs ? "pass" : "fail";
    if (verdict === "fail") failed = true;
    console.log(
      JSON.stringify({
        operation: name,
        javascriptMedianMs: Number(javascriptMs.toFixed(2)),
        rustMedianMs: Number(rustMs.toFixed(2)),
        rustOverJavascript: Number((rustMs / javascriptMs).toFixed(2)),
        rustMinusJavascriptMs: Number(overheadMs.toFixed(2)),
        maxNativeOverheadMs: budgetMs,
        verdict,
        outputsMatch: true,
      }),
    );
  }
  if (failed) process.exitCode = 1;
} finally {
  if (originalBinary === undefined) delete process.env.RDSH_BIN;
  else process.env.RDSH_BIN = originalBinary;
  await fs.rm(fixture, { recursive: true, force: true });
}
