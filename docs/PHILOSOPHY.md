# Philosophy: Rust Reins on the Node.js Titan

`rdsh` does not replace the DeepSeek Harness. It puts Rust reins on it: the
Node.js runtime keeps doing the work it is good at, and the small,
latency-critical boundary around it is written in Rust.

This document explains why the project is hybrid by design, where the boundary
runs, and what it deliberately leaves alone. [ARCHITECTURE.md](ARCHITECTURE.md)
describes the resulting subsystem ownership; [BENCHMARKS.md](BENCHMARKS.md)
holds the measurements.

## The titan

Node.js and V8 are the reason the Harness is as capable as it is. The upstream
runtime owns the agent loop, profile boot, model connections, the MCP tool
surface and the Web UI. Reimplementing that in Rust would mean tracking every
upstream change by hand, and losing compatibility the moment the two drift
apart. It is also not the bottleneck, so the project leaves it alone.

The cost sits at the boundary: starting a process, and starting it again for
every small check. Three properties matter there.

## Three weaknesses at the boundary

1. **Startup is expensive.** A cold Node.js process pays interpreter startup
   and module loading before it does any work. `dsh --version` costs roughly
   88 ms and 66 MB of peak RSS. For one command that is irrelevant; for a CLI
   that wraps every call it is the difference between instant and noticeable.
2. **Frequent hooks are hostile to process launches.** A PreToolUse hook runs
   once per tool call. Spawning a Node.js judge every time multiplies startup by
   the number of tool calls, so the hook stops being a policy check and becomes
   the session's largest fixed cost. A hook has to be cheap enough that nobody
   is tempted to turn it off.
3. **External tool execution needs a checkpoint.** Whatever the model asks to
   run, one place must inspect the command and be able to refuse it
   (`rdsh guard`). That place sits on the critical path of every tool call, so
   it must be fast and small enough to audit.

## The reins

The rule is to port only the hot paths and delegate everything else. Rust owns
the boundary where latency and safety are decided:

- the PreToolUse hook (`rdsh guard`), including the opt-in structured file
  policy;
- the local fast paths that would otherwise boot Node.js for nothing: token
  estimation, search, session listing and compaction, dependency inspection and
  health diagnostics.

Everything that needs the full agent runtime stays in Node.js and is reached
through a verbatim `exec`: the conversation loop, profile boot, model
execution, MCP tools and the Web UI. Delegation is byte-identical by
construction, so the reins never change what the titan does, only what it costs
to steer it.

## Architecture

```text
            user / CLI
                |
                v
      +-------------------+          the reins
      |   rdsh  (Rust)    |          fast, memory-safe, auditable
      +---------+---------+
                |
     every tool call         local fast paths
                +-----------------------> guard, tokens, search, sessions
                |
                |  only when the work needs the full agent runtime
                v
      +-------------------+          the titan
      | DeepSeek Harness  |          session loop, models, MCP, Web UI
      | Core  (Node.js)   |
      +-------------------+
```

The upper path is taken on every tool call and never starts Node.js. The lower
path is the full runtime, entered only when the work actually needs it, and it
runs the upstream implementation unchanged.

## What the boundary costs

All figures are process-level measurements on one Linux x86_64 host at `n=15`,
recorded in [BENCHMARKS.md](BENCHMARKS.md) and reproducible with
`scripts/benchmark-node-vs-rust.py`; the Node.js side of the comparison is
`scripts/benchmark-node-reference.mjs`. Absolute values depend on the host.

| Boundary step | rdsh (Rust) | Node.js reference | Factor |
| --- | --- | --- | --- |
| `rdsh --version` process launch (launch only) | ~0.90 ms | ~88 ms, upstream `dsh --version` | ~98x |
| PreToolUse hook `rdsh guard`, per tool call (launch included) | ~2.0 ms | 76–84 ms, equivalent Node.js judge | ~40x |
| PreToolUse hook peak RSS | 5.9 MiB | 49.6 MiB | ~1/8 |

Two cautions. First, `~0.90 ms` is `rdsh --version` **process launch only**;
it is not the cost of evaluating the hook. The hook figure already includes its
own process launch, and that is the number to use for a per-tool-call decision.
Second, the hook, `tokens` and `search` comparisons use an equivalent Node.js
implementation, not upstream `dsh`, because upstream exposes no such
subcommand; no upstream product ratio is claimed for them.

Booted sessions are outside these numbers. When `rdsh` starts a profile it
`exec`s the same upstream Node.js `dsh`, so conversation startup, interactive
latency and session memory are upstream's.

## Non-goals

The boundary is narrow on purpose, and it stays that way. As
[ROADMAP.md](ROADMAP.md) states:

- Reimplementing the agent loop or profile boot in Rust is out of scope.
- Forking the Harness UI or its protocol is out of scope.
- Rust is not a goal in itself. A path that is not on the hot boundary stays in
  Node.js and upstream.

## Related documents

- [ARCHITECTURE.md](ARCHITECTURE.md) — subsystem ownership and the delegation model.
- [BENCHMARKS.md](BENCHMARKS.md) — measurement methodology and raw samples.
- [USER-FLOW.md](USER-FLOW.md) — installation, usage and recovery.
- [ROADMAP.md](ROADMAP.md) — project direction and non-goals.
