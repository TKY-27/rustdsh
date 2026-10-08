# Performance change and security review — 2026-10-08

## Delivered behavior

Native search reuses one approved root directory descriptor and stops retaining
matches once each ordered worker chunk reaches the global output limit.
Dense fixture median fell from 197.500ms to 4.973ms; peak RSS fell from
132892KiB to 4316KiB. Nonmatching and deep fixtures also improved. Search
stdout/stderr matched v0.2.0 under default, one-CPU, and two-CPU affinity,
including 64 compatibility cases per setting. See
[raw samples and reproduction](search-performance/README.md).

The same-user native CLI was additionally hardened while integrating fixes
and a read-only search review from the user's existing Muse Spark session:

| Boundary | Previous behavior | Candidate behavior |
| --- | --- | --- |
| Explicit log selection | `logs --file` could print an arbitrary outside file | Resolved selection must stay under the logs root; Unix opens through no-follow directory handles |
| Log open after validation | Path-based read could follow a replacement link or wait on a FIFO | Unix descriptor checks reject changed links, nonregular files, and multiply linked files |
| Session discovery | Project traversal and planted project/session links could include outside entries | Project is one path component; project/session directory links and linked size entries are skipped |
| Session token sizing | Linked `.zstd` entries contributed outside frame sizes | Planted linked entries are skipped |
| Token cache publication | Predictable `.tmp` path could truncate a link target | Random exclusive temporary inode, Unix 0600 creation, then atomic replacement |
| Web search request | Configured base prefix could inject whitespace/CRLF into the raw request | Invalid separators and malformed authorities are rejected before connecting; query remains encoded |
| Web search transport | TCP connect/write could wait without the response deadline | Connect and write use the remaining 15-second request budget; response cap remains 2MiB |
| Setup provider link | New page received an opener reference | Existing button supplies `noopener` |

Ordinary logs, tail/grep, relative DSH_HOME/latest selection, and configured
web search retain their output. Three dummy outside-log disclosures now fail
with no secret in stdout. See the actual
[before/after output diff](search-performance/cli-output-diff.json) and
[real setup captures and click observations](setup-link-security/README.md).

## Verification

Local Linux x86_64 verification on the final source:

- `cargo fmt --check`; release Clippy for all targets with warnings denied.
- `cargo test --release`: 78 unit tests plus 11 CLI boundary integration tests.
- `tests/regress.sh`: all 53 checks, isolated HOME and a delegation stub.
- Plugin/security/kernel-boundary Node suites: 29 passes, no skipped tests;
  includes dummy credential access, network, environment, host writes, and
  mandatory-tool rejection checks.
- Audited ToolRuntime integration: allowed inspection dispatches through the
  kernel sandbox; forbidden, late-rewritten, and scoped shadow tools fail.
  Release-asset tests: six passes. Separate approval-integrity integration:
  four passes against the already prepared isolated patched upstream fixture.

The last integration fixture is not a claim that upstream DSH has released
that approval fix. The rdsh runtime boundary continues denying the original
bash tool entirely. This change does not alter the mandatory preload,
runtime-hash pin, explicitly shared-file snapshot, seccomp policy, or
permission display. Real-model README-only exploitation was not re-run or
established by these performance measurements.

The new `tests/log_session_boundaries.rs` is discovered automatically by
Cargo on CI. It covers ordinary and relative-home logs, traversal, outside
symlinks, hardlinks, FIFO rejection with bounded cleanup, project links,
linked token frames, a planted predictable cache temp link, and Unix 0600.
The new search/root tests deterministically cover ordered-prefix retention,
zero-limit reads, and replacing the approved root pathname.

[Validation manifest](search-performance/validation.json) records source and
binary hashes and review scores: correctness 3/3, style 3/3, tests 3/3.
No blocking finding remained in the changed scope; the limits below remain
part of that conclusion.

## Scope and remaining boundaries

These results do not establish that the entire project is free of every
vulnerability. GitHub CI must still validate the pushed commit on its Linux,
macOS, and Windows runners; their authoritative results belong to the PR.
Dashboard code is unchanged in this change.

The model execution boundary has no host session/log/cache access: only the
human's explicit shared files are snapshotted read-only, and the kernel
adapter denies networking and host writes. Native inspection commands run
as the human's account; the model cannot invoke them outside that adapter.
The native session directory enumeration and token decompression still use
paths after entry checks. Concurrent replacement by a process that can write
the same user's DSH_HOME is not made race-proof by these planted-link checks.
The non-Unix log opener retains the existing native-file implementation
after canonical confinement; Unix handle guarantees must not be attributed
to it. Unsupported agent-isolation platforms continue failing closed.

Remote SearXNG endpoints remain supported when selected through the human's
existing environment/configuration and enabled extra. Search queries/results
cannot select or redirect that endpoint. A loopback-only restriction was
reviewed and discarded because it would break documented remote settings
without strengthening the model's already denied networking. No additional
remote opt-in flag or silent credential import was introduced. OS DNS
resolution can still exceed the socket deadline; the new timeout guarantee
applies to TCP connect, write, and response reads, not the system resolver.

The existing Muse Spark session implemented the native inspection hardening
and its first ten tests, reviewed the two search files, and reviewed the
subsequent integration fixes without further edits. Codex removed a redundant
path-based chmod after cache rename, fixed relative-home log selection,
isolated the test environment, bounded FIFO-test cleanup, and added the
eleventh regression. No credentials or session transcript are included in
this report.
