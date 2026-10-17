# Worker scopes and worktree leases

`rdsh-dashboard workers` allocates a Git checkout and branch for each worker,
records its read/write scope and reports conflicts before and after editing.
Use the existing DSH worker/runtime with the resulting checkout. This command
does not start a model or change a DSH profile. It adds no browser or MCP tools.

## Declare and allocate

The project must be a Git repository root with a committed HEAD. Save a local
operator-owned declaration as `worker.json`:

```json
{
  "worker_id": "dashboard-editor",
  "role": "edit",
  "read_paths": ["."],
  "write_paths": ["dashboard", "tests"],
  "modules": ["dashboard"],
  "forbidden_paths": ["dashboard/package-lock.json", "tests/e2e/package-lock.json"],
  "lease_seconds": 3600
}
```

Scopes are repository-relative path prefixes. They accept files and directories,
with `.` meaning the repository root. Absolute paths, traversal, backslashes and
globs are rejected. A forbidden prefix takes precedence over write permission.
Writing Git metadata is excluded. Each write prefix must also be readable.
Worker IDs use lowercase letters, digits and hyphens, starting with a letter.

```sh
node dashboard/cli.mjs workers plan --project /path/to/repo --input-file worker.json
node dashboard/cli.mjs workers prepare --project /path/to/repo --input-file worker.json \
  --expected-revision 0 --expected-head <source.head_sha-from-plan>
node dashboard/cli.mjs workers inspect --project /path/to/repo
```

Use the actual `revision` and `source.head_sha` returned by `plan`. Changed
registry revisions and changed source commits require a fresh plan. Editing
scopes are compared against allocated workers and source checkout changes.
Common configuration and lockfiles receive a separate conflict reason. A
conflict blocks allocation; the plan lists the worker/path that needs attention.

All source changes are reported in `source.dirty_paths`, including untracked
files. Changes outside the new worker's write scope can remain in the original
checkout. The worker starts from the specified committed HEAD; uncommitted
source changes are retained in place. The record keeps the source observation
from before allocation and returns an observation after it.

Each worker receives a new `codex/worker-...` branch and a separate checkout
under the project's dashboard state directory. Configure `RDSH_DASHBOARD_HOME`
to choose that state location; it must be outside the source repository and
its Git metadata. Existing worker IDs and checkout paths are retained and cannot
be overwritten. Use a new worker ID for a new allocation.

For review workers, set `"role": "review"` and omit `write_paths` or set it to
`[]`. Supplying a write scope is rejected. A scan reports any observed review
edits as scope violations. The declaration and Git scan cover assignment and
diagnostics; DSH's native tool policy and the execution sandbox provide runtime
enforcement. Select a matching read-only native policy when launching a reviewer.

## Scan changes and retain work

`inspect` is read-only. It reports source checkout changes, each worker's actual
HEAD/branch, uncommitted paths, committed paths since its allocated base, scope
violations and overlapping changes across workers or the source checkout. Rename
and delete paths remain visible. Shared lock/config changes are detected even
when two workers declared different source modules and then wrote outside them.
Unavailable or reassigned checkouts have `tree.status: "unavailable"` and
`tree.dirty: null`; they do not supply a clean-tree result.

Lease state and checkout state are independent. An expired lease can retain
uncommitted files, committed changes or an unavailable checkout. Expiry keeps
the worker's scope allocated and performs no cleanup. After inspection, renew
or explicitly release the lease using the current registry revision:

```sh
node dashboard/cli.mjs workers renew --project /path/to/repo \
  --worker-id dashboard-editor --lease-seconds 3600 --expected-revision 2
node dashboard/cli.mjs workers release --project /path/to/repo \
  --worker-id dashboard-editor --expected-revision 3
```

Release records the operator's decision to end the allocation. The checkout,
branch and all changes are retained, and its dirty/changed paths remain in
inspection. A later plan warns about overlapping scopes of released workers;
review retained changes before allocating overlapping work again. Release
does not stop a running DSH process or establish integration success.

The registry uses a private writer lock, revision checks and a flushed atomic
replacement. It records provisioning before Git starts. An interrupted or failed
checkout operation retains a `provision_failed` or `provisioning` record and any
files/branch Git created; inspect it before further work. An existing writer lock
blocks mutations and is never reclaimed based on elapsed time. Corrupt or linked
registry files are rejected without replacement. Assignment uses an empty
checkout-hook directory.

## Native Git bridge and its benchmark

Worker Git reads run through the hidden `rdsh worker-git` JSON bridge, with the
JavaScript implementation as a fallback for binaries that do not provide it. The
bridge is the default on every platform and keeps process-tree containment.
`dashboard/worker-git.mjs` probes the binary with `--language en worker-git
--help`, because the capability marker is the command's English about text and
`general.language` / `LANG` would otherwise translate it away and silently
select the JavaScript path.

Measure both paths with the same fixture and alternating measurement order:

```sh
cargo build --locked --release --bin rdsh
TMPDIR=/var/tmp RDSH_BENCH_BIN=$PWD/target/release/rdsh node scripts/bench-worker-git.mjs
```

The script fails when the requested native binary is not selected, so a
JavaScript fallback is never reported as a native measurement. It pins the
selected binary to a private execution copy, records both paths and the copy's
SHA-256, and dispatches the JavaScript baseline and the native bridge directly so
binary discovery and the capability preflight stay out of the timed region. Each
operation row carries the seven raw samples and the measurement boundary. It also
compares each operation against a budget: the native median may exceed the
JavaScript median by at most 20 ms, except `dirtyPaths`, which has a 30 ms
allowance. The budgets are absolute rather than ratios because `dirtyPaths` is
one `git status`; a 1.2x target on a ~30 ms operation would leave no room for the
bridge process hop. The multi-Git operations are expected to be at or below the
baseline, so only the one-shot operation gets the wider allowance.
`RDSH_BENCH_MAX_OVERHEAD_MS` overrides every operation budget for benchmark
regression tests; the dashboard job keeps the defaults.

| operation | native - JS median budget | basis |
| --- | ---: | --- |
| `dirtyPaths` | 30 ms | one `git status`; the bridge process hop is not amortised |
| `repository`, `sourceSnapshot`, `observeWorktree` | 20 ms | multi-Git; native runs at or below the JS baseline |

Measured on Linux x64 (Node 22.23.1, 128 tracked / 8 dirty files, median of 7
alternating pairs). The fix replaced the `Child::try_wait` sleep-poll in
`run_bounded` with a bounded blocking wait, which removed the per-Git timer
quantisation:

| operation | JS (ms) | native before (ms) | native after (ms) |
| --- | ---: | ---: | ---: |
| repository | 8.21 | 15.22 | 10.05 |
| sourceSnapshot | 13.54 | 15.19 | 9.66 |
| dirtyPaths | 5.04 | 9.64 | 8.32 |
| observeWorktree | 25.22 | 31.77 | 14.35 |

The Windows dashboard job runs the same benchmark on every pull request
(win32-x64 runner, Node 22.23.3). It selects the native bridge and passes the
budget:

| operation | JS (ms) | native (ms) | native - JS (ms) |
| --- | ---: | ---: | ---: |
| repository | 119.20 | 73.13 | -46.07 |
| sourceSnapshot | 150.76 | 76.46 | -74.30 |
| dirtyPaths | 30.45 | 43.26 | 12.81 |
| observeWorktree | 330.61 | 165.83 | -164.79 |

`dirtyPaths` stays about 1.4x the JavaScript baseline. It is a single
`git status`, so the Windows cost of starting the extra `rdsh` bridge process
is not amortised, and the sleep-poll fix does not remove that process hop. The
bridge is kept as the default on Windows: it is about twice as fast on the
multi-Git operations, and selecting JavaScript for `dirtyPaths` alone would
drop process-tree containment and the single code path for a small difference
on one operation. That residual is runner-dependent: 12.81 ms in the #767
evidence above (#774 re-ran the main benchmark and failed at +22.81 ms), and
20.58 ms (Rust 63.87 / JS 43.29) with the pinned measurement from #778, where
the other three operations were 60-230 ms faster than JavaScript.
The 30 ms `dirtyPaths` budget keeps margin over the observed spread while the
multi-Git operations keep the 20 ms limit. Raw runs and the fallback rejection
are in
[`docs/evidence/worker-git-benchmark-586/`](evidence/worker-git-benchmark-586/README.md);
the Windows bridge benchmark in `dashboard.yml` fails the job when the native
binary is not selected or an operation exceeds its budget.

## Integration and verification

This CLI grants no merge/push authority and has no cleanup operation. Run the
existing DSH worker in the allocated `worktree`, with its native policy matching
the declared role. Scans expose work to integrate and validate separately;
integration order and validation belong to the integration queue in issue #22.

The current upstream subagent service owns provider capabilities, child sessions,
working-directory inheritance and tool filters. It remains the execution owner:
[upstream subagent contract](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/subsystems/subagent.md).
The old proposal's fork document is currently unavailable; no runtime feature
is inferred from that missing source.

`dashboard/test/workers.test.mjs` uses actual disposable Git repositories,
branches and worktrees. It covers assignment, source changes, overlap warnings,
shared lockfile changes before/after editing, committed changes, review scope,
expiry/renew/release retention, stale source/revision, conflicting allocators,
missing checkout, corrupt/locked storage and the existing Node CLI. No provider,
model or external repository is used by these tests.
