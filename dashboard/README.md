# Project dashboard and private Harness access

[Coding agent MCP quickstart](../docs/MCP-CLIENTS.md): add tasks, questions
and structured UI to your existing coding agent through the local stdio bridge.

[Worker scopes and worktrees](../docs/WORKER-WORKSPACES.md): local CLI allocation,
source/worker conflict scans and retained checkouts after lease expiry or release.

[External agent runners](../docs/AGENT-RUNNERS.md): detached cursor-agent and devin
jobs with status, cancel, permission mapping and untrusted result handling.

[Budget admission control](../docs/BUDGET-CONTROL.md): soft warnings, hard guarded
DSH job/model-call limits, durable parallel reservations and delayed usage holds.
Native guard registration is required; ordinary/unsupported CLIs are display-only.

[CLI adapter contract](../docs/CLI-ADAPTERS.md): version-checked DSH ACP
start/resume/send/interrupt/stop/usage, explicit unsupported CLI capabilities,
and isolated lifecycle smoke without provider credentials or model requests.

[Persistent session ledger](../docs/SESSION-LEDGER.md): distinct project, run,
task and native CLI IDs, with exact run resolution after client restart.

[Follow-up instructions](../docs/INPUT-INSTRUCTIONS.md): exact-session browser/CLI
submission, preserved drafts, shared input ordering, human conflict review,
explicit interruption with native proof, and honest unsupported-steer fallback.

[Task preflight](../docs/TASK-PREFLIGHT.md) checks the required CLI, cwd, disk,
port, dependencies, GPU/WSL and selected authentication before an ACP session.

[Optional GPU leases](../docs/GPU-LEASES.md) reserve a requested UUID/VRAM amount
before original ACP attachment, report capacity waits separately from failures,
and retain uncertain ownership until actual process/group exit is confirmed.

[Resource admission](../docs/RESOURCE-ADMISSION.md) reserves local CPU, memory,
heavy-build slots and ports before a managed build or test command starts.

[Durable run recovery](../docs/RUN-RECOVERY.md) records control request/ack IDs
and separates recorded run state, root-process observations and UI connectivity.

[Bounded retry](../docs/SAFE-RETRY.md) preserves original permission and reconciles
uncertain writes. Public retry is opt-in for original CLI version queries only.

[Offline fault simulator](../docs/FAULT-SIMULATOR.md) reproduces six seeded
control-plane failures with local mock peers, saved input/reports, and Windows/Linux CI.

[Checkpoint recovery](../docs/CHECKPOINTS.md) distinguishes a verified native
resume from an explicit new conversation with an operator-provided summary.

[Acceptance evidence](../docs/ACCEPTANCE-EVIDENCE.md) separates reported `done`
from current full checks, preserves partial results and rejects stale evidence.

[Model assertions](../docs/MODEL-ROUTING.md) compare a declared run's requested
route with native ACP configuration and block mismatched or unknown prompts.
`routing enforce` adds the audited native dispatch guard on reattachment; the
human view compares actual request tuples and retains fallback permission history.

[Mobile overview](../docs/MOBILE-OVERVIEW.md) puts project/task context, observed
state, last result, pending decisions and stop availability before folded metrics
and reports. It preserves unobserved states and requires target confirmation
before stopping the live owned Harness run.

`rdsh-dashboard` provides two separate entry points:

| Mode      | Purpose                                                    | Data source                                      |
| --------- | ---------------------------------------------------------- | ------------------------------------------------ |
| `project` | Project metrics, tasks, questions, human answers, progress | Eight project-scoped MCP tools                   |
| `project` | Project metrics, tasks, questions, human answers, progress | Seven project-scoped MCP tools                   |
| `harness` | Launch and open the original DeepSeek Harness Web UI       | A separately managed `dsh --profile web` process |

Both bind to loopback and can use **Tailscale Serve** for private HTTPS access.
The QR code includes the access key and opens the correct authenticated page.
Treat it as a credential; share it only with intended users on your tailnet.
Keep Tailscale connected on the PC and phone and keep the dashboard running.

Project 画面の QR 鍵はブラウザー専用です。画面は鍵を URL fragment から
そのタブの sessionStorage に保存し、API へヘッダーで送ります。MCP 設定の鍵と
管理用の鍵は別々で、MCP 鍵から人間の回答は登録できません。Harness は元の Web
画面との互換性のため Cookie を使いますが、その鍵で MCP やダッシュボード終了 API は使えず、
中継時には Harness 側へ渡しません。同じホスト上の別ポートにも Harness Cookie
が届くため、そのホスト上で信頼できない Web サービスを開かないでください。

プロジェクト画面では、Dashboard と同じ host・OS view から見える別terminalの
CLI process をPIDで読取専用登録できます。表示するのはprocessの生存状態と、登録時の
開始識別子・所有者が続いているかだけです。コマンドライン、環境変数、会話、ログは
読みません。観測解除やDashboard再起動で外部processへsignalを送りません。登録情報は
Dashboardのproject別状態ディレクトリにある `observed-cli.json` に保持し、所有者はOSの
UID/SIDそのものではなくscope付きSHA-256 fingerprintで保存します。Dashboardを別hostやPID namespaceから起動した
場合、同じPIDを同じprocessとは扱わず、識別できない状態にします。

追加端末には画面の「端末ごとの権限」から個別鍵を発行できます。閲覧のみが既定で、プロジェクト画面では質問への回答と追指示・質問取消しを個別に付与します。Harness入口では閲覧または管理中の実行停止を付与でき、端末鍵から本体のHarness画面には入れません。プロジェクトごとの鍵とHarness入口の鍵はそれぞれの `devices.json` に分けて保存します。どちらも鍵は発行時だけ表示し、保存先にはハッシュと端末名・権限・利用時刻・失効状態を記録します。失効はその端末にだけ適用され、既存のイベント接続を閉じたうえで以後のAPI要求と再接続も拒否します。既存の「スマホで開く」QRは所有者用の全権鍵なので、追加端末には個別発行リンクを使ってください。共有URLが未設定のとき、発行リンクはこのPCからのみ利用できます。端末の回答は質問への返答であり、回答によって実行権限は発行されません。

This optional Node.js component is separate from the Rust launcher's `rdsh serve`
status page. It does not replace the original Harness agent loop.

## Install and launch

Requires Node.js 22+, and PowerShell 7 for Windows launchers. Tailscale is optional
for local use and must be installed and signed in for phone access.

```powershell
# From the repository root; installs dependencies and a launcher in ~/.local/bin.
pwsh -NoProfile -ExecutionPolicy Bypass -File ./dashboard/install-windows.ps1

# A project-specific dashboard. The default port is stable for each project path.
rdsh-dashboard project --project C:\Projects\MyProject --open

# A separate Harness instance, with front-end :38081 and backend :3081.
rdsh-dashboard harness --open

# Reopen an existing instance or stop only that instance.
rdsh-dashboard open --project C:\Projects\MyProject
rdsh-dashboard stop --project C:\Projects\MyProject
rdsh-dashboard open --harness
rdsh-dashboard stop --harness
```

On native Windows the installed launcher starts `project` and `harness` in the
notification area without keeping a console window open. Right-click the icon for
**Open / 開く** or **Exit / 終了**; double-click also opens the authenticated page.
Windows notification-area settings control whether it sits in the hidden-icons overflow.
Each icon's tooltip identifies its project (or `rdsh Harness`). The helper receives
only a small Windows runtime environment; provider credentials are not forwarded.
Exit calls this instance's existing scoped shutdown: a managed Harness run must
have verified stopped before the icon/server disappear. If verification fails,
the icon remains with a warning so you can inspect the stop status and retry.
Closing the browser leaves the server running. CLI `stop` removes its tray too.
Independent Harness sessions and other project dashboards are not stopped.

```powershell
# Keep terminal output and Ctrl-C behavior for scripts or troubleshooting.
rdsh-dashboard project --project C:\Projects\MyProject --no-tray
```

Other subcommands remain foreground commands. Direct `node dashboard/cli.mjs ...`
remains foreground; native Windows can explicitly request `--tray` there.
Startup failure returns an error to the caller, rather than reporting a ready tray.
If startup exceeds 60 seconds, the launcher reports that readiness is unconfirmed;
the owned server may still start. Use `open` or `stop` with that same project to
inspect or stop it before starting another instance.
The helper runs this checkout's PowerShell script with process-local execution
policy; machine/user policy is not changed and enforced Group Policy still applies.
Opening a browser passes its authenticated URL to the Windows URL handler, as the
existing `open` command does. Other processes with the same OS-user access can
observe that short-lived command line; the tray helper itself receives no URL/key.
PowerShell 7 is resolved from PATH and the URL handler from the Windows system
directory; an executable placed in the project or working directory is never used.
Re-run the installer after upgrading to refresh an older launcher.
Installation uses the lockfile's native prebuilts without package lifecycle
scripts and verifies that Koffi loads before writing the launchers. An unavailable
native prebuilt fails installation; ownership checks are retained. The installed
wrapper also preserves the Node executable selected at installation time.

The checkout must stay in place: the installed launcher points to its `windows-launcher.mjs`.
To run without installing a launcher, use `node dashboard/cli.mjs ...`.
On Linux/macOS, install with `npm ci --prefix dashboard` and use the Node CLI.
Project mode is portable. Managed Harness startup is selected through
`RDSH_HARNESS_PROVIDER`; `windows-wsl` is the default and the only verified
provider. It preserves the `web` profile, loopback readiness, process-scope
health observation, and verified owned-descendant stop. Its distribution defaults
to `FlashNext`, with `/root/.local/bin/rdsh-env` as the environment wrapper;
override those with `RDSH_WSL_DISTRO` and `RDSH_WSL_HARNESS_BIN` when needed.
`linux-native`, `macos-native`, `remote`, unknown providers, and `windows-wsl` on
other platforms fail with a specific reason and no silent fallback. Add a provider
only after its launch, readiness, health, and scoped-stop contract is verified.
It never stops an independently running Harness instance.

### Keep project history after moving a folder

Project IDs normally follow the canonical folder path. To keep the same tasks,
answers and evidence references after a rename or move, capture the ID before
moving the folder, then preview and explicitly apply the mapping at its new
location. The operation reuses the existing state directory; it does not copy,
merge or rewrite project history. Stop the project's dashboard first.

```powershell
rdsh-dashboard project-id --project C:\Projects\OldName
# Move or rename the project folder in Explorer or with your usual file tool.
rdsh-dashboard project-move preview --project D:\Work\NewName --from-id <project_id>
rdsh-dashboard project-move apply --project D:\Work\NewName --from-id <project_id> --expected-revision <source_revision>
rdsh-dashboard project-move rollback --migration-id <migration_id>
```

`preview` reports the source revision and task/answer counts. `apply` refuses a
changed source revision, an active dashboard, or any state already registered
for the destination path. The returned migration ID can remove the new path
mapping; rollback leaves the source state untouched. If a move is interrupted,
rerun `project-id` and `project-move preview` at the destination: an applied
mapping is reported as `already_moved` and does not duplicate history.
An abandoned identity lock expires after 30 seconds; stale same-runtime
dashboard locks are cleared only after their recorded process has exited. If a
command reports that `project-identity.lock.mutation` is busy, inspect its owner
and confirm no project-move or dashboard startup/shutdown is active before
removing that stale guard. Never remove `project-identity.lock` while its owner
may still be active.

WSL and native Windows share a project identity only when both runtimes use the
same `RDSH_DASHBOARD_HOME`. Capture the ID in the runtime that currently owns
the history and apply the explicit mapping from the runtime that will use the
new path. Paths are never joined by matching folder names.

Managed profile launches now use a per-run kernel ownership group. The Harness
entry page can stop that owned run and distinguishes requesting stop, verified
empty descendants and unverifiable results. The administrator-only dashboard
shutdown stays separate. Windows-to-WSL mode also needs the matching Linux native
prebuilt in this checkout; see [scoped-stop setup and limits](../docs/SCOPED-STOP.md).
When WSL runs the supervisor in systemd's un-delegated `init.scope`, it uses a
unique transient systemd scope and confirms that exact unit and cgroup are empty
before reporting stop success.

Use `--port 38100` to choose a project port, `--harness-port 3081` for its Harness
backend, or `--no-tailscale` for local access only. Conflicting ports fail startup.
Only one writer can run for a given canonical project directory.

### QR access

Open the dashboard and select **スマホで開く**. If Tailscale requests its first HTTPS
configuration, follow **利用設定を開く**, then select **接続を更新**. The QR code appears
only after the route has been verified. Harness QR codes open the actual Harness
UI, while project QR codes open the project's metrics and questions.

Existing Serve routes are preserved. A conflicting route or public Funnel on the
chosen port is rejected. Stop closes the local server and managed Harness child;
the private Serve route remains configured for the next launch.

## Report project data through MCP

State is stored outside the checkout:

- Windows: `%LOCALAPPDATA%\rdsh\dashboard\projects\<project-id>`
- Linux/macOS: `~/.local/state/rdsh/dashboard/projects/<project-id>`
- Override for isolated environments: `RDSH_DASHBOARD_HOME`

`project-id` is derived from the canonical directory path. Separate projects have
separate state, credentials, MCP endpoints, and event subscriptions.

Each running project writes `mcp-config.json` for stdio clients and
`mcp-http-config.json` for HTTP clients into that private directory. Import the
appropriate configuration into your agent's MCP settings. The dashboard must be
running before the stdio bridge is used. The stdio bridge reads the current
runtime credential on each operation. HTTP clients must reload the generated
configuration after a restart, because the bearer key rotates.
画面はライトとダークの2テーマです。初回はOSの設定に従い、ヘッダーの
「ダーク表示／ライト表示」で切り替えると選択が保存されます。

`runtime.json` の `token` は管理用、`mcp_token` は MCP 用です。ブラウザー用の
鍵は `browser_url` に含まれます。これらを別用途で使い回さないでください。

| Tool                            | Effect                                          |
| ------------------------------- | ----------------------------------------------- |
| `dashboard_update_metrics`      | Report measured cumulative snapshots            |
| `dashboard_upsert_task`         | Create/update a task by ID                      |
| `dashboard_ask_question`        | Ask a human a question with a unique ID         |
| `dashboard_publish_event`       | Report progress or an artifact reference        |
| `dashboard_get_feedback`        | Read durable answers after a sequence cursor    |
| `dashboard_get_state`           | Read this project's current state               |
| `dashboard_create_handoff`      | Save a source-linked snapshot for one task      |
| `dashboard_get_handoff`         | Read the latest snapshot and source freshness   |
| `dashboard_present_ui`          | Present structured UI a human can act on        |
| `dashboard_record_review`       | Store a version-bound independent-review report |
| `dashboard_get_review_evidence` | Read review reports and freshness status        |

Example tool arguments:

Optional [outcome cards and fixed milestone criteria](../docs/TASK-OUTCOMES.md)
add purpose, ownership, latest outcome and next step to these tasks. Inspect
existing acceptance evidence from each card; reported `done`, partial checks and
operator reports never substitute for current full-check evidence. Task splits
do not change a milestone's declared criterion list.

```json
{
  "id": "M3.6",
  "title": "Validate the host launcher",
  "status": "doing",
  "milestone": "M3"
}
```

```json
{
  "id": "Q1",
  "question": "Which result should we adopt?",
  "urgency": "high",
  "default_action": "Wait for a reply"
}
```

A person answers in the dashboard. The answer is persisted before notification.
`dashboard_get_feedback({"after":0})` returns `messages` and `next_cursor`; pass
the returned cursor on the next read. Reads never consume answers. The default
action is descriptive and is never executed by this server.

Optional [versioned question cards](../docs/QUESTION-CONTRACTS.md) add explicit
consultation/approval types, choices, target revision, diff, impact and declared
cost limits. Use `decision` with `dashboard_ask_question`; `action: "revise"`
or `"cancel"` requires the current `expected_revision`. Stale, expired and
cancelled replies cannot answer a new revision. Durable feedback includes the
current contract validity; saving a reply grants no execution authority and
does not claim application by its consumer.

### Independent review evidence

`dashboard_record_review` stores a caller-submitted review report for an existing task. It validates the worker records and target commit, but does not invoke or authenticate a reviewer; the upstream subagent service remains the execution owner.
The implementation and reviewer worker IDs must resolve to separate active
worktrees. The implementation worker must have role `edit`; the reviewer must
have role `review` with an empty declared write scope. Both checkouts and the
clean project root must match `head_sha`. `base_sha` and `head_sha` identify the
binary diff whose SHA-256 is stored with the report. Reuse `review_id` when
retrying the same report; changing the contents under an existing ID is
rejected.

Reports retain findings, checks that were not run, and unavailable reviews as
different states. A project HEAD change, uncommitted source edit, or task update
makes an earlier report stale. `dashboard_get_review_evidence` and the browser
panel show the exact target, report digest, references, and freshness. A clear
caller-reported result only makes that exact target eligible for human review;
it is not an approval, correctness guarantee, or permission grant. The worker
role and read-only declaration are recorded evidence, not proof that the native
runtime enforced an OS sandbox. Evidence references are displayed as text and
are never fetched or executed.

Optional [answer application acknowledgements](../docs/ANSWER-APPLICATION.md)
bind a card's `decision.consumer_id` to a confirmed run/native session. The
original ACP transport consumer records read, one-time input dispatch and a
correlated native result with an input digest. `reply-consumer once|serve`
explicitly resumes that exact session; missing results block automatic replay.
Webhook delivery and cursor reads remain separate from application evidence.
This is an opt-in input channel under the session's existing permissions.

Unknown metrics display **未取得**. This component does not scrape billing,
calculate spend, or infer context loss. Report measured values using:
`total_cost_usd`, `total_budget_usd`, `session_cost_usd`, `session_budget_usd`,
`session_id`, `input_tokens`, `cached_input_tokens`, `model_calls`, `tool_calls`,
`tool_errors`, `context_misses`, `auto_continues`, `refusals`, `api_errors`.
Omitted fields retain their previous value; `null` clears a numeric field.
Cache read percentage is cached input tokens / input tokens. Tool error rate is
tool errors / tool calls. Legacy numeric costs are reported API-equivalent values.
Optional [source-aware cost ledger inputs](../docs/COST-LEDGER.md) on the same
metrics tool declare a period and expected workers/sessions, then record stable
event IDs and event/cumulative sequences. Provider usage, CLI reports, explicit
external API estimates and invoice reports remain separate by source/currency.
Duplicate observations do not add costs; missing workers/costs stay unknown and
partial. The folded metrics section shows each amount's provenance and history.
`cost-ledger declare|report|inspect` uses the existing authenticated reporting
endpoint; browser credentials are read-only for these inputs. No prices are
looked up and legacy numeric costs are not merged with this optional ledger.

### Local human-effort metrics (#73)

Human-effort metrics are **off by default**. A user can enable them in the
project dashboard and choose 7, 30 or 90 days of local retention. The sidecar
`human-metrics.json` is created only after opt-in and contains only event types,
timestamps, durations and aggregate counts. Question, task, command and session
IDs, text, credentials and secrets are not retained. The dedicated endpoint requires the browser credential;
it is not an MCP tool, is absent from MCP state, and does not publish webhooks.
Export downloads an aggregate JSON file in the browser and does not send it.
Raw events are capped at 10,000; if older in-window records are dropped, the
summary marks the affected metrics as partial.

Decision time uses a user-started stopwatch that can be paused while away.
Recovery time is wall-clock time from a user-selected blocked task to the user's
stop action and can include waiting or absence. Question recurrence and
instruction resend are counted only after the user marks a specific recorded
item; text similarity and automatic replay are not inferred. Queue revision
conflicts count only the existing `queue_revision_changed` outcome. Missing
timer completions remain unpaired, and a metric with no completed samples stays
unavailable instead of displaying zero. Token snapshots are exported separately
from human-effort metrics so a token reduction cannot hide more resends or slower
recovery.

### Observation source and freshness (#16)

`dashboard_update_metrics`, `dashboard_upsert_task`, and
`dashboard_publish_event` accept an optional `observation` object:

```json
{
  "total_cost_usd": 2.45,
  "session_id": "session-123",
  "observation": {
    "kind": "measured",
    "observed_at": "2026-10-05T12:00:00Z",
    "source": "provider usage response",
    "session_id": "session-123",
    "reference": "request-456 / commit abc123",
    "max_age_seconds": 900
  }
}
```

Use the actual observation time, including a timezone. Source kinds are
`measured` (**実測**), `agent_reported` (**agent報告**), `estimated` (**推定**),
and `unavailable` (**未取得**). These are the authenticated reporter's claims;
the dashboard does not independently verify measurements or artifact quality.
Measured reports require both `source` and `observed_at`. Explicit estimates
remain visibly marked; missing values are never filled with zero or estimates.
`unavailable` permits only `null` numeric values. `null` always clears the value
and sets its kind to `unavailable`, even in a mixed measured report.

The server stores `recorded_at` separately from `observed_at`. It accepts past
observations, rejects future or invalid timestamps, and marks a report stale
when its observation age reaches `max_age_seconds` (default 900; allowed range
1–604800). Receipt time, unrelated events and metadata-only writes never make
an old observation fresh. The browser checks expiry every 30 seconds and when
the page becomes visible, including during a disconnected or idle session.
Expired values remain visible as previous reports, with **古い情報** replacing
the current value. Task counts include only fresh, non-estimated `done` reports;
this is a report count, not an acceptance or QA gate. Progress/artifact entries
remain history and show their own observation source and time.

Metric provenance is stored per field in `metric_observations`, including source,
reporting session, reference, observation/receipt times, and a server-generated
`report_id`. An observation applies only to numeric fields supplied in that
call (and an explicitly supplied `session_id`). Omitted fields retain both
their value and provenance. Report the numerator and denominator of cache/error
rates together: partial updates from different snapshots display **比較不可**,
and stale/missing counters do not produce a precise rate. When `session_id`
changes, session cost/budget values are cleared; project totals and cumulative
counters keep their original provenance. Supplying `observation.session_id`
alongside `session_id` requires them to match. Tasks/events store provenance in
their own `observation`; references default to the task ID or artifact path.

Existing schema-1 state and callers without `observation` remain readable.
Existing values without provenance display **出所未確認 / 鮮度未確認**; new
legacy-style reports default to `agent_reported` with no invented observation
time. Their numeric values are retained as previous reports, not treated as
current measurements. Send explicit observation metadata to show current values.
Reference strings and sources are displayed as text, never opened or executed.

Artifact references remain text until a human selects **プレビュー** on an
artifact event. The authenticated project browser can read only that event's
relative path beneath the project root; absolute paths, parent traversal,
dotfiles, symlinks, HTML/SVG, and files over 1 MiB are refused. UTF-8 text,
diffs, logs, and JSON are shown as text (never rendered as HTML), with common
credential patterns redacted and text previews capped at 128 KiB. PNG, JPEG,
GIF, and WebP are accepted only when their extension and signature agree.
Responses are private and non-cacheable. Previews never write, publish, or
share the source file. Credential redaction is a best-effort screen, not a
guarantee that arbitrary text or image content contains no secrets; inspect
the source when that assurance matters. Treat all user-authored paths as data.

### Decision inbox

The **判断待ちインボックス** groups unanswered questions, explicit failure or
dependency reports, and existing `blocked` tasks. A blocked task without attention
metadata appears as **停止中 · 種類未報告**, with its `blocker` as the reason;
the inbox does not infer a failure or dependency type. Ordinary events and metric
errors do not add alerts. Report attention through `dashboard_upsert_task`:

```json
{
  "id": "build",
  "title": "Restore the dependency download",
  "status": "blocked",
  "attention": {
    "cause_id": "package-fetch",
    "kind": "failure",
    "deadline": "2026-10-08T12:00:00Z",
    "impact": "high",
    "next_action": "Check the download log"
  }
}
```

Task attention requires `kind` (`failure` or `dependency`). Optional fields are
`cause_id` (1–160 characters), `deadline` (ISO date-time with timezone), `impact`
(`low`, `medium`, `high`, `critical`), and `next_action` (1–2000 characters).
Whitespace-only strings, invalid dates, unknown fields, and invalid types are
rejected without saving. `dashboard_ask_question` accepts the same optional
attention fields, without `kind`. Missing deadlines and impacts display 未報告.
Without a reported next action, the inbox offers answering the question or
reviewing the failure/stop reason.

Within a project, identical explicit `cause_id` values group tasks and questions;
without a known cause, each item stays separate. The default priority order uses
question urgency, earliest deadline, greatest impact, next-operation type, oldest
report, then ID. Urgency is not converted into impact. The selector also sorts by
deadline, impact, or operation type, using the default priority to break ties.
Operation order is: answer a question, review a reported next action, then review
a failure/stop reason; free-text actions are not sorted alphabetically. Missing
deadlines, impacts, and report times sort last within their comparison. Each
member retains its reported values, and buttons open the existing task row or
human answer form.

Each cause starts as a compact summary row; expand it to see every member's full
report and navigation button. Questions retain the existing approval/consultation
label and reported urgency, including when grouped with tasks. A question's
`default_action` is shown separately as informational and never runs automatically.
Long summary text is shortened visually, with the full text available in the
expanded report. Sorting and live updates preserve expanded groups and keyboard
focus within the inbox.

Omitting task `attention` preserves an explicit failure/dependency report until
`status: "done"`; moving to `doing` alone does not resolve it. An unclassified
blocked task resolves when its status changes to `todo`, `doing`, or `done`.
Sending the required task fields with `"attention": null` resolves either kind
and suppresses the blocked fallback for that stopped episode. A transition from
another status back to `blocked` starts a new episode and restores legacy reporting;
an explicit attention report can also reopen it.
A `done` update with non-null attention is rejected. An elapsed deadline does not
resolve anything. Resolving one member leaves other members of its cause group
active; human answers remove only their question. These fields never grant
permission or execute actions.

Revisioned questions follow their existing question-contract lifecycle: cancelled
or expired cards leave the actionable inbox and remain in its history. This is
separate from the reported attention deadline, which does not expire a question.
Typed approval/consultation labels use the current contract kind. Optional
attention survives a question revision when omitted; answered history keeps the
original report snapshot even if that question is later revised. Navigation to
a task opens its folded section in the current overview layout.

Task attention changes are stored in server-managed `attention_history`, separate
from the bounded event log. The history includes report snapshots before changes,
resolution, cause replacement, and recurrence; identical reports do not add
history entries. Classified reports also retain the blocker and previous blocker,
including updates that change only the stop reason. Resolving an existing blocked task with no prior history saves
its original blocker in the resolution snapshot, without inventing an earlier
report event. Original questions and answers remain in project state. The inbox's
history section remains available after resolution and restart. Clients cannot
supply or replace `attention_history`; its unclassified `blocked` snapshots are
internal, not an accepted input kind.

[#13](https://github.com/sahenjp/rustdsh/issues/13) requires actionable items with
deadline/impact/operation sorting, same-cause grouping, and retained history after
resolution. The priority and compatibility rules above are this implementation's
design proposal. Producers remain the existing MCP tools and HTTP reporting API;
this adds no automatic Harness monitoring. Dependency execution (#15), question
contracts (#40), answer application (#41), and notification delivery (#56) remain
separate work.
The opt-in [local integration queue](../docs/INTEGRATION-QUEUE.md) applies fixed
worker commits in order to a dedicated worktree and requires current full-check
evidence before the next integration. Only explicit local CLI actions execute
Git/checks; queue registration and dashboard/MCP reads grant no push authority.

## OpenAI ChatGPT Dots and MCP Events

The project HTTP `/mcp` endpoint implements MCP 2.0 (`2026-07-28`) discovery and
native `events/list`, `events/subscribe`, and `events/unsubscribe`, with the same
project bearer authentication used for tools. Available events:

- `dashboard.answer.created`
- `dashboard.question.created`
- `dashboard.task.updated`
- `dashboard.progress.updated`
- `dashboard.metrics.updated`

Each requires the project's `project_id` filter. Subscribe to
`dashboard.answer.created` when a Dot should react to human replies, then retrieve
the full answer with the feedback tool. Users choose what the Dot should do;
the dashboard itself does not start agents or grant approval for their actions.

Subscriptions persist across restarts, default to 24 hours, and grant at most
seven days per refresh. Delivery verifies the callback challenge, signs exact
payload bytes with Standard Webhooks, rejects private callback addresses and
redirects, pins the checked address for TLS, and retries transient failures up to
five times with the same event ID. Verification is cached for one minute per
project/callback/key. Key rotation signs with both keys for five minutes. `410`
deactivates a subscription; `413` and other permanent failures are not retried.
The last 10,000 changes provide a bounded delivery buffer; protocol replay is not
advertised (`cursor: null`). Feedback remains durable and readable after a missed
notification. Review delivery failures in the QR section.

To revoke all subscriptions for a project, use:

```powershell
rdsh-dashboard revoke-events --project C:\Projects\MyProject
```

This is a private, single-owner project credential model, without OAuth or
multi-user roles. Removing a ChatGPT connection must also revoke its subscriptions
or stop the dashboard. Full Dot subscription/trigger validation requires a real
ChatGPT plugin connection; local protocol tests alone do not establish that.

### Connect a private server using Secure MCP Tunnel

Tailscale provides the phone/browser connection. A cloud Dot also needs an MCP
transport reachable from ChatGPT. The supported private option is OpenAI's
[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).
Its official client is downloadable from
[openai/tunnel-client releases](https://github.com/openai/tunnel-client/releases/latest).
On Windows, extract the client into `%LOCALAPPDATA%\rdsh\tunnel-client`, or set
`RDSH_TUNNEL_CLIENT` to the executable's path.

1. Create a tunnel in OpenAI Platform, associate it with your ChatGPT workspace,
   and obtain a runtime API key with Tunnels Read + Use.
2. Set `CONTROL_PLANE_API_KEY` privately in the terminal. Keep it out of chat,
   command arguments, and Git.
3. With the project dashboard running, start the authenticated HTTP tunnel:

   ```powershell
   rdsh-dashboard tunnel --project C:\Projects\MyProject --tunnel-id tunnel_YOUR_ID
   ```

   The launcher passes the current project bearer through a child-process
   environment reference, including discovery requests. It uses a loopback-only
   health listener with an ephemeral port, recorded in `tunnel-health-<owner>.url` in the
   project's private state directory. Check `/readyz` and `/ui` at that URL.
   Restart this command after restarting the dashboard.

4. In ChatGPT Plugins, create a private developer connection and choose Tunnel.
   Discover the tools/events, then authorize your Dot to monitor this project's
   `dashboard.answer.created` event and specify its response.
5. Verify a real question → human answer → signed webhook → Dot response, then
   stop monitoring and check that unsubscribe removes the subscription.

Project MCP clients expose `dashboard://state`, `dashboard://feedback`,
`dashboard://handoff`, and `dashboard://acceptance` resources. Legacy and stdio
clients also support resource subscriptions. The handoff is a human-readable
snapshot, not a session resume; missing details stay unknown, arbitrary event
artifact references are not opened, and test commands are not rerun. Registered
acceptance evidence is inspected read-only for integrity metadata without
copying file contents or private paths. Reads compare saved source fingerprints
with current task, decision, artifact, and acceptance records. Resource
notifications are distinct from the native webhook Events integration. See the
[handoff packet contract](HANDOFF-PACKETS.md).
See the [official Events contract](https://developers.openai.com/plugins/build/mcp-events).

Use **接続診断** in the project dashboard or
`rdsh-dashboard diagnostics --project <directory>` to inspect phone/Serve and
Tunnel/MCP/callback stages separately. The
[connection diagnostics contract](../docs/CONNECTION-DIAGNOSTICS.md) explains
restart detection and stage-specific recovery. Local readiness and callback
receipt leave actual Dot response and end-to-end status unconfirmed.

The project dashboard's **最新push・CI・レビュー状態** panel is a separate,
manual, read-only check. It compares the local HEAD and working tree with the
configured upstream branch's current SHA, then compares that SHA with the PR
head before showing required checks, review decision and each check's GitHub
event (`push` or `pull_request`). It uses the installed GitHub CLI's existing
authentication. A missing upstream/PR, changed SHA, dirty tree, pending check
or unavailable response remains unconfirmed; it never pushes, edits protection
rules or merges. The snapshot is timestamped and is not continuously refreshed.

## Selective history backup

`backup preview|export|inspect|restore|history` selects task/answer/decision/evidence
history, holds all source prose by default, and restores a separate historical
collection using the target dashboard's own authentication. Reviewed replacement
text can be supplied explicitly; active commands, credentials and event
subscriptions are never transported. See the
[history backup contract](../docs/HISTORY-BACKUP.md) for selection, review and
collision handling. `backup history` exposes imported records through the local
control CLI; the existing state resource also includes `history_backups`.

## Safe project-state migration

`state-migrate inspect|dry-run|apply|rollback` handles the explicit schema 1 to
2 transition. Stop the project dashboard before applying it. Dry-run preserves
the source; apply creates a checksum-linked exact snapshot and atomically cuts
over the state file. Rollback refuses to discard state written after migration.
See the [state migration contract](../docs/STATE-MIGRATIONS.md) for recovery
after interruption and stale-lock handling.

## Project-scoped pinned updates

`release stage|inspect|canary|promote|rollback` captures a compatible original DSH,
Node and adapter snapshot, qualifies it in one project and widens only explicitly.
Managed `session-ledger start|resume` and `reply-consumer once|serve` omit executable
overrides and dispatch through the captured CLI. Project defaults apply to new
runs; existing runs retain their own artifact and native ID through rollback.
See the [pinned update contract](../docs/STAGED-UPDATES.md) for trusted code roots,
selection revisions, native qualification and recovery. This controls local
managed runs; global updates, external user plugins and provider/billing adoption
are separate.

## Validation

```sh
cd dashboard
npm ci
npm test
```

Tests cover project isolation, durable feedback, HTTP/stdio compatibility,
resource notifications, native MCP 2.0 Events lifecycle, callback signatures,
retry/restart behavior, invalid callbacks, and private Serve conflicts. CI runs
these on Windows and Linux. Browser/phone access and real Dot triggers require
their respective account configurations and are checked separately.
Observation tests additionally cover idle expiry, independent field freshness,
source/session/reference persistence, legacy state, invalid metadata, explicit
unknown values, session cost resets, and incompatible ratio snapshots.
