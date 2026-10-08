# Benchmarks

Measured on Linux x86_64. Numbers are medians; your machine will differ,
but the method below keeps them reproducible.

## Headline numbers

| Case | rdsh | Baseline | Factor |
| ---- | ---- | -------- | ------ |
| `--version` startup (median, n=5) | ~0.90ms | original `dsh` ~88ms | ~98x |
| `--version` peak RSS | ~2.9MB | original ~66MB | ~1/23 |
| Hook-equivalent peak RSS | ~2.7MB | equivalent Node script ~45MB | ~1/16 |
| search (`--max 10`, 160 files, 960k matching lines) | ~4.97ms | v0.2.0 ~197.50ms | ~39.7x |
| tokens (9.6MB text) | ~12ms | before ~35ms | ~2.9x |
| sessions --tokens (20 sessions) | ~0.41s | before ~1.65s | ~4.0x |
| Distribution size | one ~806KB binary | ~508MB Node tree | -- |

## How to reproduce

```sh
rdsh bench --n 5
/usr/bin/time -v rdsh --version
/usr/bin/time -v dsh --version
```

Before/after binaries were built from HEAD vs. the working tree in a scratch
worktree and their outputs were diffed for equality.

For the 2026-10-08 native search change, see
[raw samples, output equality, CPU affinity, and reproduction](evidence/search-performance/README.md).
This measurement uses generated dummy files, two warmups, ten alternating
before/after samples, and an isolated HOME. Ordinary, nonmatching searches
improved by 1.28–1.59x on this machine; the dense case benefits especially
from stopping once each worker has enough results. These are fixture results,
not a claim about every command or filesystem.

## Rules for benchmark PRs

1. State machine, OS, and `n`.
2. Paste raw output, not just the summary table.
3. Prove output equality (diff before/after outputs).
4. Update this file when a headline number moves by more than ~10 percent.
