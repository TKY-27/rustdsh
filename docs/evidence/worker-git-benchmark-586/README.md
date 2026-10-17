# Worker Git bridge benchmark (#586)

Fixed host: Linux x64, Node v22.23.1, same-machine run on 2026-10-17.
`benchmark.jsonl` records one baseline and one optimized run of
`scripts/bench-worker-git.mjs` (128 tracked / 8 dirty files, median of 7
alternating pairs), plus the fallback rejection. `windows-benchmark.jsonl`
records the same benchmark on the Windows GitHub runner (win32-x64, Node
22.23.3) in the `dashboard.yml` test job.

## Linux x64

| operation | JS (ms) | native before (ms) | native after (ms) |
| --- | ---: | ---: | ---: |
| repository | 8.21 | 15.22 | 10.05 |
| sourceSnapshot | 13.54 | 15.19 | 9.66 |
| dirtyPaths | 5.04 | 9.64 | 8.32 |
| observeWorktree | 25.22 | 31.77 | 14.35 |

`run_bounded` sleep-polled `Child::try_wait` with `Duration::from_millis(5)`,
quantising each Git call to the platform timer tick. Replacing it with a
watchdog-bounded blocking wait removed that cost: the multi-Git operations
improved by 34-55 percent and `dirtyPaths` by 14 percent.

## Windows runner

| operation | JS (ms) | native (ms) | native - JS (ms) |
| --- | ---: | ---: | ---: |
| repository | 119.20 | 73.13 | -46.07 |
| sourceSnapshot | 150.76 | 76.46 | -74.30 |
| dirtyPaths | 30.45 | 43.26 | 12.81 |
| observeWorktree | 330.61 | 165.83 | -164.79 |

`dirtyPaths` remains about 1.4x the JavaScript baseline on Windows. It is one
`git status`, so the cost of starting the extra `rdsh` bridge process (about
13 ms on Windows) is not amortised, and removing the sleep-poll does not
remove that process hop. The earlier 1.35x report in #586 (51.36 ms native
against 37.93 ms JS) is the same residual, not the poll. Native stays the
default because the multi-Git operations are about twice as fast and the
20 ms budget bounds the single-operation residual; a Windows-only JavaScript
path for `dirtyPaths` would drop process-tree containment for 13 ms.

## Probe fix

The bridge capability marker is the command's English `--help` about text, so
`general.language` / `LANG` translated it away and the dashboard silently used
the JavaScript path. The marker probe now pins `--language en`. The benchmark
refuses to report a fallback as native and exits non-zero (last entry in
`benchmark.jsonl`).

## Reproduce

```sh
cargo build --locked --release --bin rdsh
TMPDIR=/var/tmp RDSH_BENCH_BIN=$PWD/target/release/rdsh node scripts/bench-worker-git.mjs
```
