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
- **Steering without stopping**: input sent while a turn runs queues on the host and auto-runs as the next turn at the boundary — `steering_received` markers acknowledge immediately, `^c` keeps the queue for the next prompt
- **Desktop notifications** (opt-in): approval requests, turn completion with usage/cost, failures — only while the tab is hidden, deduped across reconnect replays
- **Keyboard-first approvals** (mock/upstream): `a` / `s` / `d`, note, diff preview — local dock or the global queue
- **Composer ergonomics**: per-session prompt history (shell semantics: `↑` from the first line, edit forks the draft, `[↑n]` recall marker), per-session drafts, host-driven `/` completion with legacy capability fallback, hero-typing spawns a seeded session
- **Finder** (`⌘K`/`Ctrl+K`): fzf-style — approvals first, then sessions, theme, stop, re-pair
- **Shortcuts overlay** (`?`): every binding in one dialog; overlays (finder, inspector, drawers) trap focus and restore it on close
- **Responsive working surface**: chat/history stay left-anchored and use the available main pane; the composer keeps its full-window prompt behavior; document height is fixed to the viewport and only scrollback scrolls
- **Status line** in dext's TUI idiom: `● cwd | title │ model │ effort │ approval │ Ctx [██████░░░░] │ ↑↓ $`
- **Per-session model + reasoning controls**: native web selectors populated from dext's configured provider catalog. Choose a provider/model before a fresh session's first turn; model then locks to the durable seat. Reasoning effort (`off` through `max`) remains changeable between turns and is reapplied after resume.
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
*first*: nothing is hidden, the rest folds under "developer tools" (or
"business tools" for developers) and "all packs".

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
  `Restart=on-failure` brings it back. `--force` restarts now.
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

## Real-host limits (until the upstream dext bridge lands)

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
                         # contract, connection lifecycle, chart spec + math,
                         # session purge/clear/reconnect against both hosts,
                         # pack catalog parse/guard/--pack routing (85 checks)
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
