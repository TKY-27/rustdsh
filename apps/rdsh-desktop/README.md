# rdsh-desktop (native GPUI shell)

A native desktop window for DeepSeek Harness, ported from the upstream Electron
app (apps/desktop + apps/web at the pinned revision) to GPUI. It renders the same
design system and drives the same HTTP/WebSocket API, so the web UI is no longer
needed for day-to-day conversation work.

The process that paints the window is the process that talks to the harness; no
Electron, no bundled Chromium, no local web server.

## What works

- Project-grouped sidebar with the real conversation titles (filled from session
  projections, 80 conversations per launch)
- Header status: project, context usage, token totals, pending questions
- Model picker from the host catalog; the selection is stored by the host
  (session/selectModel) and survives restarts
- Live assistant streaming (session/follow + assistant-stream deltas) with a stop
  button (session/cancel)
- Approval prompts and user questions ($events waterfall, answered through
  $events/result and userQuestions/answer)
- Tool call rows and reasoning blocks in the timeline
- New conversation (session/create), Enter to send, composer focus handling

## Run

~~~sh
cd apps/rdsh-desktop
cargo run                      # window
cargo run -- --dump-ui         # sidebar/header state as JSON (headless)
cargo run -- --dump-live       # both live sockets, 8s (headless)
cargo run -- --new-session     # create a conversation and print its id
cargo run -- --dump-session    # raw opening snapshot of one conversation
cargo run -- --probe           # session list, model catalog, history
~~~

RDSH_DESKTOP_DSH points at the harness launcher (defaults to dsh on PATH).

## Prerequisites

Linux uses the Wayland GPUI backend: a Vulkan driver, fontconfig and xkbcommon.
gpui links xkbcommon-x11 as well; install the development package when the
distribution ships only the runtime library:

- Fedora: sudo dnf install libxkbcommon-x11-devel
- Debian/Ubuntu: sudo apt install libxkbcommon-x11-dev

build.rs falls back to the runtime library when the development symlink is
missing and prints a warning. Windows and macOS use the default GPUI features.

## Design values

Tokens come from the upstream theme (packages/client/ui-theme/src/styles at the
pinned revision):

- page: white
- sidebar: hsl-like near-white (f9fafb)
- composer: white
- user bubble: pale blue (edf3fe)
- label: near-black (0f1115)
- secondary and tertiary text: (61666b, 81858c)
- accent: (4176e6)
- hairline borders at 4%, 10% and 12% black
- radii 4/8/12/16/20/28, body 14px with a 24px line box

## Notes

- The window needs a GPU-backed Wayland session; every headless mode above runs
  without a display.
- xattr is vendored: gpui_http_client pins xattr 0.2.3, which no longer compiles
  on current Linux toolchains. vendor/xattr implements the 0.2 API the
  dependency uses (see NOTICE.md).
