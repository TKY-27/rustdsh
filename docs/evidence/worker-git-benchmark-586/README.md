# Worker Git bridge benchmark (#586)

Fixed host: Linux x64, Node v22.23.1, same-machine run on 2026-10-17.
`benchmark.jsonl` records one baseline and one optimized run of
`scripts/bench-worker-git.mjs` (128 tracked / 8 dirty files, median of 7
alternating pairs), plus the fallback rejection.

| operation | JS (ms) | native before (ms) | native after (ms) |
| --- | ---: | ---: | ---: |
| repository | 8.21 | 15.22 | 10.05 |
| sourceSnapshot | 13.54 | 15.19 | 9.66 |
| dirtyPaths | 5.04 | 9.64 | 8.32 |
| observeWorktree | 25.22 | 31.77 | 14.35 |

Before the fix, `rdsh worker-git` is one process more than the JavaScript path
and its `run_bounded` sleep-poll quantised each Git call to the platform timer
tick (>=5 ms on Linux, the 15.6 ms Windows default). `dirtyPaths` is a single
`git status`, so that fixed cost dominated: the Windows measurement in #586 was
51.36 ms native against 37.93 ms JS. The remaining Linux `dirtyPaths` gap after
the fix is the ~3 ms bridge process hop.

The probe change is orthogonal and necessary to measure anything: the bridge
capability marker is the command's English `--help` about text, so
`general.language` / `LANG` translated it away and the dashboard silently used
the JavaScript path. The benchmark now refuses to report a fallback as native
and exits non-zero (last entry in `benchmark.jsonl`).

Reproduce:

```sh
cargo build --locked --release --bin rdsh
TMPDIR=/var/tmp RDSH_BENCH_BIN=$PWD/target/release/rdsh node scripts/bench-worker-git.mjs
```
