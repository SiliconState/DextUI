# DextUI

A lightweight, agent-ergonomic web front end for the [dext](../Dext) coding agent.
DextUI is one half of an event-sourced pair: dext (or a mock host) journals every
session event with a monotonic `seq`; DextUI folds that journal into a live UI.

## Packages

| Package | What it is |
|---|---|
| `packages/protocol` | AgentLink v1 types + envelope helpers (`@dextui/protocol`) |
| `packages/client` | Framework-free `Connection` + `SessionStore` (WS, seq-resume, reconnect) |
| `packages/mock-server` | Fixture-replay mock host — no API key needed |
| `apps/web` | Svelte 5 + Tailwind v4 PWA |

## Quickstart

```bash
npm install
npm run build            # protocol -> client -> web
npm run mock             # agentlink mock host on http://127.0.0.1:8787
```

Open http://127.0.0.1:8787 and pair with the token `dev-token`
(override with `--token` / `MOCK_TOKEN`).

## Features

- **Multi-session** rail with live/starting/cold/exited status and pending-approval badges
- **Action queue**: permission cards with Once / Always / Deny (`a` / `s` / `d` hotkeys),
  optional decision note, risk badge, diff/JSON mutation preview
- **Command palette** (`⌘K`/`Ctrl+K`): sessions, approvals, theme, stop turn, re-pair
- **Transcript filters** (All / Text / Tools / Thinking / Flags), block inspector drawer (raw JSON)
- **Diff rendering** for tool output and approval previews
- **Slash-command menu** (`/` in composer) with tab completion
- **Usage HUD**: model, approval profile, tokens/cost, context gauge, turn clock
- **Draft persistence** per session; steer mid-turn; stop/interrupt
- **Toasts**, light/dark theme (persisted), mobile layout
- Offline-capable PWA (network-first service worker)

## Agent affordances

DextUI is designed to be drivable by other agents, not just humans:

- Every actionable element carries a stable `data-agent-id` (e.g. `composer.send`,
  `approval.<request_id>.once`, `session.<id>.open`)
- Regions expose `data-state` (`awaiting_approval`, `working`, `idle`, `ready`, `disabled`)
- `GET /__agent` returns a bounded scene digest (auth required)
- `window.__agentlink` counts received envelopes by event type — useful for transport debugging

## Protocol

See [PROTOCOL.md](./PROTOCOL.md) for the AgentLink v1 wire format
(WS `/ws` primary, REST for health/session lists/todos, hello capability negotiation).

## Screenshots

[`docs/screenshots/`](./docs/screenshots) — approval flow, resolved tool result,
command palette, desktop, and mobile captures.
