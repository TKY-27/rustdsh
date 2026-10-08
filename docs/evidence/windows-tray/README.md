# Windows notification-area tray verification

The native Windows launcher starts `project` / `harness` without a resident
console window. Each notification-area icon has Open / 開く and Exit / 終了.
The direct Node CLI keeps foreground behavior unless `--tray` is requested;
`--no-tray` keeps the installed launcher in terminal mode.

## Actual UI captures

These PNGs capture the running WinForms controls using Windows `PrintWindow`.
The before/after images show an owned neutral test window before opening and
following closing of the **new** menu; they are menu-flow states, not a fabricated
old application screenshot. `menu.png` captures the real production menu.
The GIF cycles these captures. No user's desktop or credentials are included.

| Before menu | Native menu | After menu |
| --- | --- | --- |
| ![Before](before.png) | ![Open and Exit](menu.png) | ![After](after.png) |

![Menu flow](flow.gif)

## Behavior and checks

Before: the Windows `project` / `harness` launcher occupied its console and
printed the local server URL and Ctrl-C instructions. After: it waits for the
server and real tray to be ready, prints the notification-area message, and
returns. Other subcommands, MCP streams, and explicit terminal mode stay foreground.

Native Windows Dashboard suite: **194 passed**. The latest focused tray/launcher
checks: **13 passed**, including real PowerShell forwarding and MCP stdin/stdout,
quoted/Unicode project paths, duplicate startup rejection, separate project
survival, actual menu callbacks, NotifyIcon disposal, failed stop retry and lost
warning-pipe handling. Linux runs the portable checks and skips native UI cases.
The real Windows installer also passed with an apostrophe/metacharacter destination
and a changed PATH after installation. It installs without package lifecycle
scripts and verifies the native prebuilt rather than skipping ownership checks.

Rust **103**, examples **7**, CLI regression **53**, browser **8 flows**, Markdown
lint and the installed dependency audit also passed. Source hashes are recorded
in [verification.json](verification.json); these checks make no model calls.

Exit calls the captured server's existing scoped close operation. Its managed
Harness must have verified empty descendants before shutdown completes.
Unverified stop leaves the server available and the tray can warn/retry.
No process-name kill or runtime-file PID kill was added. The helper receives no
provider credentials, browser URLs or administrator keys. Browser opening retains
the existing URL-handler behavior documented in [Dashboard README](../../../dashboard/README.md).

A Linux-installed Koffi tree cannot run the Windows kernel ownership tests. The
full Windows check used a dedicated Windows copy and Windows `npm ci` instead
of weakening the ownership checks or changing the shared development dependencies.
The original checkout's concurrent Codex-bridge and release-note edits are excluded.
