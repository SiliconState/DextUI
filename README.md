# DextUI

A lightweight, agent-ergonomic web front end for the [dext](../Dext) coding agent.
DextUI is one half of an event-sourced pair: a host journals every session event
with a monotonic `seq`; DextUI folds that journal into a live terminal-native UI.

Two hosts speak the same AgentLink v1 protocol:

- **`agentlinkd`** — the real thing. Spawns `dext --output stream-json` per turn
  and bridges the event stream to the browser. Real sessions, real models, real cost.
- **`mock-server`** — fixture replay for development. No API key, no cost.

## Packages

| Package | What it is |
|---|---|
| `packages/protocol` | AgentLink v1 types + envelope helpers (`@dextui/protocol`) |
| `packages/client` | Framework-free `Connection` + `SessionStore` (WS, seq-resume, reconnect) |
| `packages/agentlinkd` | Real host: dext one-shot bridge, seat resume, on-disk journals (`--state-dir`) |
| `packages/mock-server` | Fixture-replay mock host — no API key needed |
| `apps/web` | Svelte 5 PWA, hand-rolled terminal design system (no CSS framework) |

## Quickstart — real dext

```bash
npm install
npm run build            # protocol -> client -> web
npm run serve -- --cwd=$HOME/my-project --approval=auto-read
```

Open http://127.0.0.1:8788 and pair with the printed token (or pass `--token=...`).
Every prompt runs a real `dext` turn in `--cwd`; follow-up prompts resume the same
session via a dedicated dext seat.

After pulling host changes, **restart the running `agentlinkd`** (e.g.
`systemctl --user restart dext-agentlinkd`): the process keeps the code it
started with, and the web app reads host capabilities once per connection —
an old host hides every control it can't honor (the session rail says so).
Web-only changes need just `npm run build` plus a tab reload; the host serves
`apps/web/dist` from disk.

Host flags: `--port` (8788) · `--token` (random, printed) · `--dext` (auto-detects
`~/Dext/target/release/dext`, falls back to PATH) · `--cwd` (session working dir —
must be owner-safe, not under /tmp) · `--approval` (`auto-read|auto-write|never|always`,
default `auto-read`) · `--static` (built PWA dir) · `--state-dir` (on-disk journals +
session index; default `~/.dextui/agentlinkd`) · `--crew` (crew binary; default `crew` on PATH, or `CREW_BIN`).

In-session host commands: `/help`, `/approval <profile>` (applies from the next turn), `/pack run <name> <task>`, `/pack list`, `/pack inspect <name>`, `/pack create <shelf>/<name>`.

## Bridge verification and thinking transactions

With NDJSON-capable Dext, agentlinkd keeps a warm child per session. The pipe reader
preserves UTF-8 across chunks and enforces output limits per encoded line, not per
chunk. Writes reject frames over 256 KiB or beyond a 1 MiB pending stdin budget
before enqueueing; `false` means the frame was not accepted locally, while core
`input_ack` events report core-side refusals. Correlation value `seq: 0` is retained.

Both the live `SessionStore` (`session.ts`) and journal snapshot fold (`fold.mjs`)
apply `thinking_preview_discarded` and `thinking_preview_committed`. Thinking blocks
remain provisional even after block completion until commit, so a retry removes
all previews from that attempt without removing previously committed reasoning.
Snapshots preserve the optional `provisional` flag for reconnect during an attempt;
rollback rebuilds tool indexes. Local Chat's late thinking completion updates its
existing block instead of duplicating reasoning or splitting text.

Run the credential-free real-core integration gate in addition to `npm test`,
`npm run typecheck`, and `npm run build`:

```sh
DEXT_CORE_BIN=/absolute/path/to/Dext/target/release/dext npm run test:core
```

This gate requires the binary explicitly (no silent skip). It uses isolated temporary
state and a loopback mock provider to exercise real core retry/rollback through both
projections, UTF-8 text, an approved file write, busy steering and overload refusal,
interrupt, close, and EOF. Unit tests cover deterministic split-byte input, bounded
writes, committed reasoning preservation, and mid-preview snapshot reconnect.

## Chart domains, ranking and report layout

Chart specs accept `"domain":[-3,3]` (two finite numbers, increasing) for bar,
hbar and line axes, and `"sort":"desc"` or `"asc"` for signed bar rankings.
Bar outliers retain their real-value labels while clipping to the plot; line
segments clip without flattening their underlying values. Interactive drag axes
and ranked row positions stay frozen until release. Related charts must keep the
same source label ordering when sharing a `dataset` ID.

Tables immediately followed by bar/hbar charts form a tape grid. Below a 1000px
message-container width it stacks; tape charts retain a 500px minimum content
width and scroll locally rather than shrinking text. Ordinary table cards retain
their existing sizing.

`npm test` includes chart geometry/validation tests and real-browser drag,
cross-highlight, clipping and responsive-layout checks (the browser gate visibly
skips if `agent-browser` is unavailable). To replay a report without a model:

```sh
REPORT_FILE=/absolute/report.md REPORT_CHARTS=10 SCREENSHOT_DIR=/tmp/report-shots \
  bash apps/web/scripts/chart-review-test.sh
```

See [the chart and market-report review](docs/chart-report-review.md) for findings,
methodology corrections and remaining verification limits.

## Quickstart — mock (no API key)

```bash
npm run mock             # fixture host on http://127.0.0.1:8787, token dev-token
```

The mock replays real recorded dext streams, synthesizes approval flows, and
answers `markdown table demo` with a rich-markdown turn.

## Features

- **Real markdown rendering**: GFM tables, nested lists, headings, blockquotes,
  fences, safe links — real DOM elements, escaped by construction; pre-drawn
  box-art passes through verbatim in x-scrolling `<pre>`
- **Multi-session** index with status glyphs and pending badges; desktop sidebar can be minimized/restored (`Ctrl/Cmd+B`) and persists, while narrow screens use an off-canvas drawer; `Ctrl+[` / `Ctrl+]` cycles sessions
- **Packs as product**: the host discovers dext's pack catalog (`dext pack list --verbose` + each `PACK.md`) and advertises it in `hello_ok.packs`. The empty state is a **pack gallery** (hero "Build a connector" card + curated cards + all packs), also one key away (`g`); every card prefills the composer with a starter prompt you review before it runs. `/pack run <name> <task>` is executed by the host as an explicit `dext --pack <name>` turn (the composer's `/` menu lists every pack), `/pack list|inspect|create` work too, turns carry a pack badge, and `runtime_view` cards get **run again · edit pack · make my own**. The rail has a collapsible packs section; a pack that needs a stricter approval profile than the session has is refused with `pack_requires_profile` and the toast offers a one-click `/approval` switch (headless dext would otherwise deny its writes silently). New pack directories are picked up live (`packs.changed`). Curated day-1 starter prompts live in `packages/agentlinkd/src/packs.mjs` (`GALLERY_DEFAULTS`); pack authors override them with flat `ui-*` keys in `PACK.md` front matter (see below). Assessment and deviations from the proposal: [`docs/packs-day1-assessment.md`](./docs/packs-day1-assessment.md)
- **Session lifecycle**: per-session menu with rename (`F2`), close/wake, clear (fresh agent context, keeps the shell), and true-purge delete — the host stops the child, then removes the journal, the index entry, the dext seat's transcripts and records, and the client's local drafts/history; `Ctrl+Backspace` deletes the active session; bulk "delete closed / delete all" run behind an explicit confirmation. Failed purges never fake success: the session stays, the intent is retried at host boot, and ids are never recycled
- **Crew runs as a first-class noun**: when a `crew` binary is on PATH (or `--crew=`), the host advertises `crew`, watches `~/.dext/crew/runs` plus every project's `.crew/runs`, and pushes run summaries (`hello_ok.crews`, `x-agentlinkd.crew.changed` — ids and counts, never worker prose). Three tiers, one projection: a statusline **ticker** while a run is live, a **crews** rail section beneath the queue (attention-sorted, 3 + `n more`, unmounts when empty), and a **run sheet** overlay (`x-agentlinkd.crew.open`) with step groups, one-line worker rows, a single bounded log tail (`.tail`, 80 lines), deliverable links (`.file`, realpath-confined to the run's chain dir), `[x] stop` while live and an answer composer while paused. Escalations (`status=paused` + a worker `result.escalation`) are the only crew decision: they appear as `[open]`-only rows in the Action Queue, count in the title badge, and notify while hidden; `a`/`s`/`d` skip them. Answering runs crew's two-step `resume --answer` then `run --manifest` on the host; first answer wins (`crew_already_answered`). A user-stopped run renders dim, not red. Failures never badge.
- **Global action queue**: every pending approval across all sessions in one rail (oldest first) with in-place `a`/`s`/`d`, a status-line badge, finder actions, and a document-title counter for background tabs
- **Todo panel**: reads dext's own todo files per session through the host (`todos_read`-gated) — source badge, path, `○ ◐ ●` status glyphs; refreshes on activation and `turn_end`
- **Interactive charts, images, and HTML artifacts**: a ` ```chart ` fence carrying a JSON spec (`bar`, `hbar`, `line`, `spark`, `donut`; multi-`series`, `x`/`y` axis captions, up to 180 points for lines / 31 for categorical) renders as a live chart — hover tooltips, drag points/bars for what-ifs with recomputed stats, click-sort, wheel-zoom + pan, legend toggles, donut isolate, and charts sharing a `dataset` id cross-highlight each other; all local, zero chart dependencies, no `{@html}` on dynamic strings. `![alt](path)` images a turn wrote under the session cwd render inline through the host's authenticated `files_read` endpoint; `![title](dashboard.html)` renders the page itself in a sandboxed frame (nested relative images resolve; `file://` and WSL `\\wsl.localhost\` style hrefs are normalized automatically). Remote URLs stay links — the app never fetches model-chosen hosts
- **Shared task workspace**: the one durable record both you and the agent hold (`<cwd>/.dext/tasks/<name>.task.json`) — goal, machine-checkable acceptance, blockers with your answer, evidence checks, artifacts. The UI ("t", `/tasks`) and the agent edit the same file; agent-side edits reach every tab live. `done` requires a passing check — a model-written summary is never verification.
- **Steering without stopping**: input sent while a turn runs queues on the host and auto-runs as the next turn at the boundary — `steering_received` markers acknowledge immediately, `^c` keeps the queue for the next prompt
- **Desktop notifications** (opt-in): approval requests, turn completion with usage/cost, failures — only while the tab is hidden, deduped across reconnect replays
- **Keyboard-first approvals** (mock/upstream): `a` / `s` / `d`, note, diff preview — local dock or the global queue
- **Composer ergonomics**: per-session prompt history (shell semantics: `↑` from the first line, edit forks the draft, `[↑n]` recall marker), per-session drafts, host-driven `/` completion with legacy capability fallback, hero-typing spawns a seeded session
- **Finder** (`⌘K`/`Ctrl+K`): fzf-style — approvals first, then sessions, theme, stop, re-pair
- **Shortcuts overlay** (`?`): every binding in one dialog; overlays (finder, inspector, drawers) trap focus and restore it on close
- **Responsive working surface**: chat/history stay left-anchored and use the available main pane; the composer keeps its full-window prompt behavior; document height is fixed to the viewport and only scrollback scrolls
- **Status line** in dext's TUI idiom: `● cwd | title │ model │ effort │ approval │ Ctx [██████░░░░] │ ↑↓ $`
- **Per-session model + reasoning controls**: native web selectors populated from core's available provider catalog, including Anthropic/Claude. The catalog refreshes on connection/reconnection, model-picker focus and opening Providers; credentials or models added through core appear without restarting the host. With the NDJSON bridge, model/provider changes apply between turns while preserving history; reasoning effort can change mid-turn. Legacy one-shot hosts lock the model after the first turn. Dext remains the only credential holder; no separate Anthropic key or model list is stored in the UI.
- **Themes**: dark / light / system (follows OS live), persisted
- **Capability negotiation**: steer/approve controls appear only when the host
  advertises them (`hello_ok.capabilities`)
- Interrupt (`^c stop`), block inspector drawer, toasts, mobile drawer layout,
  offline-capable PWA

## Pack gallery metadata

DextUI reads optional, flat `ui-*` keys from a pack's `PACK.md` front matter
(dext's parser ignores unknown keys, so this is backward compatible):

```yaml
---
name: report
description: Generate self-contained interactive HTML reports …
ui-starter-prompt: Summarise this workspace as an HTML report
ui-artifact: html            # html | chart | table | markdown | file | none
ui-time-to-first-artifact: 45
ui-requires: [approval:auto-write]   # also: chromium, lightpanda, connector:<name>
ui-gallery: true
ui-tags: [research, summary]
---
```

The sample `hello-chart` pack (guaranteed sub-10 s chart, no tools) ships in
`packages/agentlinkd/sample-packs/hello-chart/`. Install it into your shelves:

```bash
dext pack create samples/hello-chart && cp packages/agentlinkd/sample-packs/hello-chart/PACK.md ~/.dext/shelves/samples/packs/hello-chart/PACK.md
```

## Onboarding (who is this for?)

The first visit asks one question — **I keep the books / I run a business /
I build software** — and remembers the answer per browser (`dextui.persona`,
changeable any time from the gallery header). It only decides what you see
*first*: nothing is hidden, the rest folds under "Developer tools" (or
"Business tools" for developers) and "All packs".

- Cards show plain-language titles (`ui-title`, e.g. `crew` → **Team**,
  `mesh` → **Inbox**) and requirements in words ("needs permission to write
  files"). Curation lives in `packages/agentlinkd/gallery.json`
  (`--gallery=<file>` / `DEXTUI_GALLERY` to override); a pack's own
  `ui-title` / `ui-personas` front-matter keys win.
- **Work in a folder.** With no session active, picking a card opens the
  folder picker first: a HOME-confined browser (`hello_ok.home`,
  `x-agentlinkd.dirs.{list,create}`; `--dirs-root=` to change the root; no
  dot-directories, no symlinks, nothing outside the root is ever listed).
  "Use this folder" opens a session there with `auto-write`, seeded with the
  card's prompt. Keyboard: `↑↓` move · `→` open · `←` up · `⏎` use · `n` new folder.
- Personas: `accountant` | `business` | `developer`; a pack lists who it is
  for in `ui-personas` (`everyone` or empty = shown to all).

## Consumer packs (business shelf)

`packs/` holds six "Rust core, TS panel" packs for bookkeepers and small business
owners — receipts, invoices, bank reconciliation, cash-flow forecast, tax prep,
follow-ups — built and installed onto `~/.dext/shelves/business` by
`packs/build.sh`. State is plain files in the user's folder; every tool returns a
card (charts / sortable tables / live panel) the UI renders. See `packs/README.md`.

## Flows (drag-and-drop workflows)

Press `f` (or `/flows`, or Finder → "flows") to open the **flow builder**: a
zero-dependency SVG canvas where a workflow is a small graph of typed steps.
Flows are plain files — `<folder>/.dext/flows/<name>.flow.json` — you can
edit, copy and version. **crew is the executor**: "run" compiles the flow to a
crew chain spec (`.crew/specs/flow-<name>-<ts>.json`) and starts
`crew run --spec` detached; progress, deliverables and checkpoints show up in
the existing crew rail / run sheet / Action Queue. No second engine.

| Node | What it does | Compiles to |
|---|---|---|
| Pack | run one of your tools on a task | worker step, `run <pack> — <task>` (dext's pack inference) |
| Prompt | a helper does one step and writes a result | worker step with your prompt, optional agent/model |
| Checkpoint (gate) | pause and ask you before continuing | worker writes `escalation.json` → run pauses → Action Queue; answering resumes |
| Message | send a note via Inbox (mesh) | worker shells `mesh send <to>` with the resolved text |
| Condition | continue only if clearly true, else ask | worker replies `PASS:` or escalates |

Steps run in topological order (Kahn; declaration order breaks ties); each
step sees `{previous}` (crew's own template variable) and writes
`<node-id>.md` as its deliverable. Node types come from the extension registry
(`apps/web/src/ext/flow`), so a pack can register its own node type.

Canvas: drag nodes · drag the `○→` port onto another node to connect · click
a node to edit its fields · wheel zooms, background drag pans · `spec` shows
the exact crew spec a run would use. Validation (ids, types, cycles, caps) is
host-side (`packages/agentlinkd/src/flows.mjs`) and errors come back verbatim.

Sample: `packs/flows/month-end-close.flow.json` — scan receipts + who-owes-me
→ ledger clean? → summary → your approval → tell the accountant. Copy it into
a folder's `.dext/flows/` to try it.

### Triggers — what starts a flow besides ▶

Triggers live on the flow file (`flow.triggers[]`, max 8) and are armed by the
host's scheduler for every workspace it knows (the `--cwd`, every session's
cwd, every folder the builder touched). The "starts when" strip in the builder
edits them; the host validates on save and reports what is armed
(`flows.list` / `flows.changed` carry `triggers[]` with last-fire times).

| Trigger | Config | How it fires |
|---|---|---|
| schedule | `every: 15..10080` minutes, or `daily_at: "HH:MM"` (+ `weekday: 0-6`) | 30 s tick, local time; last fire persisted in `<state-dir>/triggers.json` so a restart never double-fires a day |
| watch | `path` relative folder (`.` = the workspace) | `fs.watch`, 5 s debounce, dot-dirs (`.dext`, `.receipts`…) ignored |
| mesh | `node` to listen as, optional `from` | `mesh recv --node <node>` polled every 15 s; a matching message fires |
| webhook | nothing stored | `POST /hooks/<token>`; the token is an HMAC of the pairing token + workspace + flow name — unguessable, never written, shown in the builder after save |

Every fire goes through the same `startFlowRun` as the ▶ button (compile →
`.crew/specs` → `crew run --spec` detached). Launches are **tracked spawn →
exit**: the reply honestly says `starting`, and the outcome (`started` exit 0 /
`failed` with exit code + stderr tail) is broadcast and shown in the flows
list — spawn accepted ≠ run succeeded. Firing semantics: one launch in flight
per flow (events while busy or cooling down coalesce into one pending fire), a
failed launch is not a fire — it backs off exponentially (30 s → 30 min) and
retries on later ticks, and schedules are idempotent per slot so a restart
never refires the same `every` bucket or `daily_at` calendar date. `daily_at`
slots move by calendar arithmetic, so DST cannot shift them. Wrong hook
tokens count toward the auth lockout like wrong bearers.

A flow is **one sequential chain** — every step has one outgoing and one
incoming connection (the canvas enforces it at draw time, the host at save):
the compiled crew chain's only data wire is `{previous}`. Parallel work goes in
separate flows.

Surface: capability `flows`; `x-agentlinkd.flows.{list,get,put,delete,compile,run}`
(replies carry `triggers[]` and the last `launches[]`),
broadcasts `x-agentlinkd.flows.changed`, `.run` (launch outcomes) and
`.trigger` (`phase: pending|start|failed` + `retry_at`);
`POST /hooks/<token>`. The mock host keeps flows in memory.

## Shared task workspace

A **task** is the one durable record around a piece of delegated work that
BOTH sides hold: `<cwd>/.dext/tasks/<name>.task.json`. The host validates and
confines every write (rev bump, atomic rename, symlinks refused); the agent
writes the very same file with its own tools — the host watches the directory
and broadcasts changes, so an agent-side edit reaches every open tab live.

- **UI**: "t" or `/tasks` — list with status glyphs (`○ ▶ ⛔ ✓ ✗`), the record
  editor (goal, acceptance one-per-line, blocked-on + answer, guardrails),
  agent attribution (`· agent`) and rev per row.
- **In-session slash**: `/task` lists; `/task plan <name> <goal>`,
  `/task block <name> <question>`, `/task answer <name> <answer>`,
  `/task check <name> <what>` (records evidence), `/task done <name>`
  (refused without a passing check).
- **Contract, enforced by the host on every write**: `rev` bumps per write and
  a concurrent edit is refused `stale_rev` — the UI shows a fork notice and
  offers reload, never a silent overwrite; `done` needs a passing check;
  `blocked` needs the question a human must answer, and answering clears it.

Surface: capability `tasks`; `x-agentlinkd.tasks.{list,get,put,delete}`;
broadcast `x-agentlinkd.tasks.changed`. See PROTOCOL.md for the full record
contract.

## Self-editing (workbench)

When `agentlinkd` runs from this checkout it advertises the `self_edit`
capability: DextUI can rebuild and restart **itself**, whether the change
comes from you (Finder → "rebuild UI") or from the agent in a **workbench
session** (Finder → "open workbench — edit DextUI itself": a session whose
cwd is this repo, `auto-write`, composer seeded with the contract below).

Both drivers converge on the same primitives, so nothing is special-cased:

| Path | Web change (`apps/web/**`) | Host change (`packages/agentlinkd/**`) |
|---|---|---|
| Human | Finder "rebuild UI" · `/ui build [--tests]` · `x-agentlinkd.ui.build` | Finder "restart host when idle" · `/ui restart [why]` |
| Agent (bash, inside its turn) | `node packages/agentlinkd/scripts/ui-build.mjs` (`npm run ui:build`) | write `{"reason":"…"}` to `<state-dir>/restart.request` |

- **Staged build → verify → atomic swap → LKG.** `ui-build.mjs` builds
  protocol → client → svelte-check → vite into `apps/web/dist.staging`, then
  renames `dist → dist.lkg` and `dist.staging → dist`. A failing step leaves
  the served build untouched. `--tests` adds `npm test`; `--no-check` skips
  svelte-check; `--rollback` (or `/ui rollback`, `npm run ui:rollback`)
  serves the previous build again.
- **The host notices, tabs reload.** agentlinkd watches `apps/web/dist` and
  broadcasts `x-agentlinkd.ui.rebuilt` after *any* swap — including one the
  agent ran from bash. Open tabs get a "reload" toast (hidden tabs reload on
  their own). Each build writes `dist/build-id.txt`; a tab whose
  `__BUILD_ID__` differs from the served one is offered a reload at hello.
- **Restart when idle.** A restart request (command, slash, or the request
  file) is refused-into-a-queue while any turn, crew run or build is live and
  honored at the next idle boundary — which, for an agent editing the host,
  is the end of its own turn. The host exits with status **75**; systemd's
  `Restart=on-failure` brings it back (the shipped `dext-agentlinkd` unit uses
  `Restart=on-failure`, `RestartSec=2` — keep it that way, `Restart=no` would
  strand the UI after a self-restart). `--force` restarts now.
- **`--safe`** serves `apps/web/dist.lkg` instead of `dist` so a broken build
  can never lock you out of the UI that fixes it; a missing `dist/index.html`
  falls back to the LKG automatically.
- **Extensions, not surgery.** `apps/web/src/ext/<name>/index.ts` is
  auto-imported; it registers fences (```lang → component), panels (above the
  composer), Finder commands, client-side slash commands and flow-builder node
  types. The reference extension `ext/csv` renders ```csv / ```tsv fences as
  sortable tables. The workbench seed prompt tells the agent to prefer an
  extension over editing core files.
- Surface: `hello_ok.self`, `GET /__self` (auth), `POST /__self/{build,rollback,restart,restart_cancel}`,
  `x-agentlinkd.ui.{status,build,rollback}`, `x-agentlinkd.host.{restart,restart_cancel}`,
  broadcasts `x-agentlinkd.ui.build` (start/step/ok/fail), `x-agentlinkd.ui.rebuilt`, `x-agentlinkd.host.restart` (pending/restarting/cancelled).

## Agent affordances

DextUI is designed to be drivable by other agents, not just humans:

- Every actionable element carries a stable `data-agent-id` (e.g. `composer.send`,
  `approval.<request_id>.once`, `session.<id>.open`)
- New controls follow the same scheme: `queue.<session>.<request_id>.once`, `queue.badge`, `todos.toggle`, `notify.toggle`, `shortcuts.close`, `composer.histmark`, `session.<id>.actions`, `session.action.confirm`, `packs.gallery`, `packs.card.<name>`, `packs.hero`, `rail.packs.<name>.run`, `view.<pack>.rerun`, `toast.<id>.action`
- `GET /packs` and `GET /packs/:name` (auth) expose the catalog and a shallow, read-only file listing
- Regions expose `data-state` (`awaiting_approval`, `working`, `idle`, `ready`, `disabled`)
- `GET /__agent` returns a bounded scene digest (auth required)
- `window.__agentlink` counts received envelopes by event type — transport debugging

## Legacy one-shot host limits (without core's NDJSON bridge)

Current core builds support live approvals/steering and between-turn model switching. The host probes for `--input ndjson`; only older binaries fall back to the following limits.

- **Model changes after history exists require a new UI session** — resumed dext seats restore their persisted model. DextUI rejects the change instead of mutating dext's global provider defaults or pretending it applied. Effort remains configurable between turns.
- **Queued steering, not live injection** — one-shot children have no live stdin, so mid-turn input queues on the host and delivers automatically as the next turn's prompt at the turn boundary (the composer stays enabled; interrupting keeps the queue). True in-stream steering needs the upstream dext bridge.
- **No interactive approvals** — tool policy is dext's own `--approval` profile;
  change per session with `/approval <profile>`.
- **Journals persist under `--state-dir`** — a host restart restores the session
  list cold from disk; dext seats hold the history, and a session wakes on
  `session.open` or the next prompt.

See [UPSTREAM.md](./UPSTREAM.md) for the planned `dext serve` native bridge
(NdjsonSink, PermissionRequested round-trip, steering channel).

## Verification

```bash
npm test                 # node:test — fold equivalence vs mock fold(), store
                         # contract, connection lifecycle + delivery acks,
                         # session purge/clear/reconnect against both hosts,
                         # pack catalog parse/guard/--pack routing, flows
                         # (one-chain contract, launch tracking), triggers
                         # (serialization/slot idempotency), shared tasks
                         # (rev/stale_rev/verified-done/symlink refusal) —
                         # then builds the PWA and runs the browser smoke
                         # (skips with a note where agent-browser is absent)
npm run smoke           # mock host end-to-end (31 checks)
npm run smoke:agentlinkd # real-host surface with a fake dext (50 checks:
                         # restart/restore, seq replay, cold wake + auto-wake,
                         # todos, auth lockout + 429, digest 4 KiB cap,
                         # html artifacts + file ?t auth)
npm run smoke:browser    # real-browser checks via agent-browser CLI (composer
                         # wrap/cap, slash menu, themed charts, rename/delete flows,
                         # pack gallery → prefill → run → badged runtime_view card)
```

`npm run typecheck` and `npm run build` cover protocol → client → web.

## Protocol

See [PROTOCOL.md](./PROTOCOL.md) for the AgentLink v1 wire format
(WS `/ws` primary, REST for health/session lists/todos/agent digest, hello
capability negotiation).

## Screenshots

[`docs/screenshots/`](./docs/screenshots) — `real.png` / `real-light.png` are live
dext turns through `agentlinkd`; `model-controls.png` shows the model lock + editable effort state; the rest are mock-host captures (approval flow,
markdown table result, finder, desktop, mobile). The newer panels (action
queue, todos, shortcuts overlay) are not yet captured.
