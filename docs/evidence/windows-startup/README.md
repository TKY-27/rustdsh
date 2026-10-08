# Windows startup observations

This records the local source at `8785f2f26a71d3e4720efc692912da64ae5d41b1`
against the original `fdaded938cf6b434929027e083a01747ec1ee229` helper.
[Raw results](windows.json) retain three alternating real NotifyIcon process
startups per version, source hashes and observed normal helper exits. Dummy
labels were used; no browser, model or provider API was opened.

| Local Windows / Node 22.23.3           | Original | CLR delegate and diagnostics |
| -------------------------------------- | -------: | ---------------------------: |
| Ready median, ms                       |   759.80 |                       461.86 |
| Start through observed exit median, ms |   980.99 |                       629.17 |

The helper uses a direct CLR `Console.ReadLine` delegate on the thread pool
instead of compiling a new C# type on each startup. The native menu fixture
compiles its screenshot helper only when evidence capture is requested.
The production ready deadline remains 15 seconds, launcher deadline 60 seconds,
and native fixture deadline 25 seconds. The external routing fixture allows its
existing owned-process cleanup to finish, as in the author's icon PR.

The parent records bounded elapsed times for spawn, PowerShell start, assembly
load, stdin reader, ready and exit. Node/PowerShell versions, exit code/signal,
and cleanup exit observation are included. Stderr is drained but only its first
16 KiB hash, byte count and truncation flag are retained. No raw stderr, URL,
credentials or label enters these observations. CLI startup failures forward
this same diagnostic through the private launcher IPC channel; successful
launches retain the ordinary user output. Routing fixtures emit elapsed phase,
exit/signal and byte-count diagnostics without prompt contents.

All 25 focused Windows routing/launcher/tray tests passed, including the actual
menu actions, another project's liveness, normal NotifyIcon disposal, bounded
diagnostic privacy, and a virtual deadline applied to a real never-ready helper.
That timeout test observed the exact helper's SIGTERM exit rather than treating
the elapsed deadline as proof. Native fixture cancellation also kills and waits
for only its captured child, with a fresh bounded exit wait.

These local process samples do not reproduce or establish the root cause of the
hosted runner's intermittent timeout in Issue #209. Subsequent CI logs include
the real stage timings and failure observations needed for that investigation.
The issue remains open until its actual acceptance is satisfied after merge.

From `dashboard`, reproduce the focused checks with:

```powershell
node --test --test-concurrency=1 test/windows-tray.test.mjs test/windows-launcher.test.mjs test/model-routing.test.mjs
```
