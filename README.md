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

Host flags: `--port` (8788) · `--token` (random, printed) · `--dext` (auto-detects
`~/Dext/target/release/dext`, falls back to PATH) · `--cwd` (session working dir —
must be owner-safe, not under /tmp) · `--approval` (`auto-read|auto-write|never|always`,
default `auto-read`) · `--static` (built PWA dir) · `--state-dir` (on-disk journals +
session index; default `~/.dextui/agentlinkd`).

In-session host commands: `/help`, `/approval <profile>` (applies from the next turn).

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
- **Global action queue**: every pending approval across all sessions in one rail (oldest first) with in-place `a`/`s`/`d`, a status-line badge, finder actions, and a document-title counter for background tabs
- **Todo panel**: reads dext's own todo files per session through the host (`todos_read`-gated) — source badge, path, `○ ◐ ●` status glyphs; refreshes on activation and `turn_end`
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

## Agent affordances

DextUI is designed to be drivable by other agents, not just humans:

- Every actionable element carries a stable `data-agent-id` (e.g. `composer.send`,
  `approval.<request_id>.once`, `session.<id>.open`)
- New controls follow the same scheme: `queue.<session>.<request_id>.once`, `queue.badge`, `todos.toggle`, `notify.toggle`, `shortcuts.close`, `composer.histmark`
- Regions expose `data-state` (`awaiting_approval`, `working`, `idle`, `ready`, `disabled`)
- `GET /__agent` returns a bounded scene digest (auth required)
- `window.__agentlink` counts received envelopes by event type — transport debugging

## Real-host limits (until the upstream dext bridge lands)

- **Model changes after history exists require a new UI session** — resumed dext seats restore their persisted model. DextUI rejects the change instead of mutating dext's global provider defaults or pretending it applied. Effort remains configurable between turns.
- **No mid-turn steering** — one-shot children have no live stdin; the composer
  disables send while a turn runs (capability-gated).
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
                         # contract, connection lifecycle (48 checks)
npm run smoke           # mock host end-to-end (31 checks)
npm run smoke:agentlinkd # real-host surface with a fake dext (35 checks:
                         # restart/restore, seq replay, cold wake + auto-wake,
                         # todos, auth lockout + 429, digest 4 KiB cap)
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
