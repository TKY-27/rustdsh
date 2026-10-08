# Fault simulator evidence

The simulator/control-plane source is commit
`9f4f7eb49097da7eaa31ae324f57366c7578de35`. Its declared source fingerprint is
`300e28f670d252bb5130652e16fdccb35ee70e1cb49491471ee1c9677891b1af`.
The later reply-test cleanup change and this evidence do not change those modules.

- [Before/after CLI output](before-after.txt) compares main `96dbcbb` with that
  source. The old checkout has no simulator entry point; the new CLI prints
  run/replay help and the six supported scenarios.
- [Saved input](input.json) is the exact seed-1 manifest used in CI.
- [Machine results](validation.json) summarize downloaded Windows/Linux reports,
  including every scenario's checks/effects/ack/resource facts, replay identity,
  both ENOSPC boundaries, runtime versions and raw-report SHA-256 hashes.
  Full isolated traces/state/reports are downloadable as the
  `fault-simulator-windows-latest` and `fault-simulator-ubuntu-latest` artifacts
  of [the pinned-source run](https://github.com/jimoto-no-llm/rustdsh/actions/runs/37815662307).
- That source passed all 186 dashboard tests with zero skips on both CI platforms.
  Local Linux also passed 186, fmt, release Clippy with no warnings, Rust 103 tests,
  example 7 tests and the 53-check shell regression.
- A local Windows full run failed in an existing interruption-test teardown:
  `history_unconfirmed_after_owned_stop` aborted cleanup before listener closing.
  It was diagnosed/cancelled and is **not** a passing full run. The fixture now
  attempts every owned stop/listener close, retains all cleanup errors and keeps
  failed state for diagnosis. The updated reply-test file passed all 22 Windows
  tests with zero skips.

These are mock control-plane and OS ownership checks. Physical GPU loss, real
provider access, real storage failure/power loss and phone/Tunnel/Dot behavior
remain outside this evidence. No UI was changed.
