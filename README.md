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
| `packages/agentlinkd` | Real host: dext one-shot bridge with seat-based session resume |
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
default `auto-read`) · `--static` (built PWA dir).

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
- **Multi-session** index with status glyphs and pending badges
- **Keyboard-first approvals** (mock/upstream): `a` / `s` / `d`, note, diff preview
- **Finder** (`⌘K`/`Ctrl+K`): fzf-style — sessions, approvals, theme, stop, re-pair
- **Terminal composer**: `❯` prompt line, slash menu with tab completion, per-session drafts
- **Status line** in dext's TUI idiom: `● cwd | title │ model │ approval │ Ctx [██████░░░░] │ ↑↓ $`
- **Themes**: dark / light / system (follows OS live), persisted
- **Capability negotiation**: steer/approve controls appear only when the host
  advertises them (`hello_ok.capabilities`)
- Interrupt (`^c stop`), block inspector drawer, toasts, mobile drawer layout,
  offline-capable PWA

## Agent affordances

DextUI is designed to be drivable by other agents, not just humans:

- Every actionable element carries a stable `data-agent-id` (e.g. `composer.send`,
  `approval.<request_id>.once`, `session.<id>.open`)
- Regions expose `data-state` (`awaiting_approval`, `working`, `idle`, `ready`, `disabled`)
- `GET /__agent` returns a bounded scene digest (auth required)
- `window.__agentlink` counts received envelopes by event type — transport debugging

## Real-host limits (until the upstream dext bridge lands)

- **No mid-turn steering** — one-shot children have no live stdin; the composer
  disables send while a turn runs (capability-gated).
- **No interactive approvals** — tool policy is dext's own `--approval` profile;
  change per session with `/approval <profile>`.
- **Journals are in-memory** — a host restart clears the session list; the dext
  seats (and their history) persist on disk and hold the durable state.

See [UPSTREAM.md](./UPSTREAM.md) for the planned `dext serve` native bridge
(NdjsonSink, PermissionRequested round-trip, steering channel).

## Protocol

See [PROTOCOL.md](./PROTOCOL.md) for the AgentLink v1 wire format
(WS `/ws` primary, REST for health/session lists, hello capability negotiation).

## Screenshots

[`docs/screenshots/`](./docs/screenshots) — `real.png` / `real-light.png` are live
dext turns through `agentlinkd`; the rest are mock-host captures (approval flow,
markdown table result, finder, desktop, mobile).
