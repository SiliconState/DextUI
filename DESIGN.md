# DextUI — System Design

A web + phone front end for dext (and peer CLI agents), built as one coherent, event-sourced stack. Separate repo, separate layer: dext itself gains only a small stdio bridge; everything else lives here.

## The tower

```
┌─ clients ──────────────────────────────────────────────┐
│  PWA (web/phone, installable)   Tauri desktop+mobile    │
│  supervising agents (via /__agent digest + same WS)     │
└──────────────▲──────────────────────────────────────────┘
               │ AgentLink v1 (WS + REST, same origin, token auth)
┌──────────────┴──────────────────────────────────────────┐
│  agentlinkd  (zero-dep Node host today; serves the PWA)  │
│  per-session event journal (seq, on disk) · auth · push  │
│  child supervisor: spawn / resume / reap / kill         │
└──────────────▲──────────────────────────────────────────┘
               │ dext bridge protocol (stdio NDJSON, one child per session)
┌──────────────┴──────────────────────────────────────────┐
│  dext bridge  (tiny upstream addition: one sink +       │
│  stdin command loop; the agent, tools, sandbox,         │
│  sessions, checkpoints all stay in dext, unchanged)     │
└─────────────────────────────────────────────────────────┘
```

Each layer has exactly one job and one contract with the layer below: dext owns agent semantics; `agentlinkd` owns sessions, persistence of the event journal, auth, and fan-out; clients own projection and rendering. Any layer is replaceable behind its contract — that is the entire scaling story.

## Why these decisions

| decision | choice | reasoning |
|---|---|---|
| Seam with dext | stdio bridge, one child per session | dext is deliberately one local binary; in-process multi-session would force a lib-ification of a 13k-line `main.rs` and bloat the upstream PR into unreviewability. Child-per-session gives crash isolation, matches crew's proven pattern, and "other agents" become spawnable adapters, not forks. |
| Server placement | this repo, one process that serves API + PWA | The host is a zero-dependency Node module today (`packages/agentlinkd`) because it shares the WebSocket framing, fold, and fixtures with the mock and could ship the day the protocol stabilized. A Rust/axum port stays on the table once the upstream `dext bridge` lands; the protocol, not the runtime, is the contract. |
| Server framework | node: builtins only (http, crypto, child_process) | Boring, auditable, no install step beyond `npm ci`. The mock server is the zero-dep reference implementation of the same protocol. |
| Client framework | Svelte 5 runes + a hand-rolled terminal design system (no CSS framework) | Runes' fine-grained reactivity appends one DOM node per 30 Hz token delta instead of diffing a VDOM; a single frame-coalesced `useSession` bridge means one projection copy per frame, not per token; small bundle; no React. Tailwind was dropped — dext's TUI palette is ~15 CSS variables and square corners. |
| App stores | Tauri v2 (desktop now, iOS/Android later) reuses the exact PWA bundle; PWABuilder TWA is the low-effort Android stopgap | user asked for an easy PWA→app path; Tauri mobile makes it the same codebase, not a port. |
| Client/server split in TS | `packages/protocol` (types), `packages/client` (state machine), both zero-dep | the client package is framework-free, so React/Solid/CLI consumers remain possible; the mock server is zero-dep Node so conformance testing never needs npm install. |
| State truth | per-session sequenced journal in `agentlinkd`, appended to disk | replay, resync, snapshot, digest, and evals all derive from one log. The log is the legibility layer for humans *and* agents. A host restart restores every session `cold` from its journal; `hello_ok.instance` tells clients whether seq-resume is safe. |
| Auth | single-operator pairing token, loopback default, QR for LAN | matches dext's single-user posture; WAN = Tailscale, not a relay we operate. |

## UX model

The unit of attention is the **decision**, not the message.

- **Action Queue** is the home screen on phone: every pending approval across all sessions as a card with syntax-aware diff (dext's mutation preview), Once / Always / Deny (exactly dext's `Choice`), and a note field. Push (ntfy/Telegram webhook from the host; PWA Web Push where installed) exists to pull the human back to a decision, not to chat.
- **Session view** borrows the TUI's proven contract: first-class blocks (text, dimmed collapsible thinking, tool cards with live output tails, batch markers, compaction markers), composer with `/` completion (command list comes from the host), steer-while-running, stop, model/effort/approval chips, usage ticker, agent-active clock, todo panel (reads the same per-session todo file dext's `Ctrl+L` modal reads).
- **Review mode** (post-turn): session-level aggregate diff from dext's checkpoint refs, one-tap handoff to `git_commit`.
- Desktop is keyboard-first (`a`/`d` on the focused approval); mobile is one-handed bottom sheets + haptics.

## Risk register → solutions

| risk | solution |
|---|---|
| Approval latency (remote human is slow) | Host-side deadline (default 600 s) → `permission.timeout` + fail-closed Deny, so the agent pivots instead of hanging. Push notifications on `permission.request`. Time-boxed autonomy grants: "auto-write for 15 min" maps to dext's runtime `/approval` change with auto-revert. |
| Upstream bridge PR stalls | Fixtures + mock server mean UI work never blocks. Degraded fallback adapter wraps `dext -p --output stream-json` one-shots (read-only-ish sessions, no mid-turn approvals) so the app is usable against stock dext. |
| Transcript secrecy on LAN | Loopback default; `--lan` requires the pairing token; token file `0600` symlink-rejected; constant-time compare; rate-limited auth failures; Tailscale for WAN (encryption at the network layer, no relay). `local_auth` secrets are transient-only (never journaled/digested). Optional `--redact-egress` runs outbound events through a credential-pattern scrubber. |
| iOS push limits | Web Push works on installed PWAs (iOS 16.4+) via VAPID with outbound-only push-service calls; fallback is ntfy.sh/Telegram webhook (self-hostable, zero account). Honest docs; no promises we can't keep. |
| Multi-session resources | Cap live children (config); idle reaping exits the child (dext state is durable; `session.open` wakes on demand); per-session journal rotation. Cold sessions cost nothing. |
| Server restart mid-turn | In-flight turns abort fail-closed (children die with the host); sessions resume from dext's durable state; clients resync via snapshot. Documented, not hidden. |
| Two clients, one approval | First response wins; `permission.resolved` broadcast; loser gets `permission.already_resolved`. |
| Scope creep ("fits other agents") | Capability negotiation + `x-` namespacing. v1 ships the dext adapter only; ACP shapes treated as prior art, not a dependency. |
| Dep bloat (user constraint) | Root-pinned toolchain (typescript, vite, svelte, svelte-check); runtime JS deps: **zero** (protocol, client, mock, agentlinkd are dependency-free; the web app ships the Svelte runtime only). Tests use `node:test`. Markdown is rendered as auto-escaped Svelte components — no `{@html}`, no XSS surface. |

## Agent-ergonomic / agent-accretive layer

Designed from the driver's seat: what makes a *driving* agent excellent cheaply?

1. **Affordances as data.** `GET /__agent` returns a sub-4 KiB scene digest (what's running, what's pending, which commands are valid right now). Every DOM control carries a stable `data-agent-id`; regions carry `data-state`. A browser pack (edge_browser/agent_browser) drives the UI deterministically from snapshots — near-zero tokens, no pixel-guessing.
2. **One log, many drivers.** Human, TUI, a supervising crew agent, and eval harnesses are peers on the same sequenced stream. Later: sessions exposed as MCP tools (`read_transcript`, `respond_permission`) — the parent agent supervises through the identical contract the human uses.
3. **Accretion loops.** Deny-with-note → "make this a rule" → writes through dext's existing DEXT.md/recall.md paths (no duplicated validation). "Save this session's tool sequence as a pack skeleton" promotes verified workflows into the shelf. `dext session decisions` gets a UI digest. Every session leaves the tower taller.
4. **Frugality.** Seq-delta sync, snapshot-based resync, server-capped payloads, collapsed thinking by default, `?fields=` projections on REST. Respects the human's battery and the supervising agent's context budget equally.
5. **Self-edit.** DextUI is one of the workspaces the agent can edit. The host runs from the checkout it serves; `scripts/ui-build.mjs` is the single staged-build/atomic-swap/LKG implementation used by the Finder, `/ui build`, and the agent's bash alike; the host *notices* swaps (`dist` watcher → `ui.rebuilt`) rather than needing to be asked; host restarts are requested (command or `restart.request` file) and honored at the next idle boundary — the end of the agent's own turn. `--safe` boots from the LKG. New behaviour lands as extensions under `apps/web/src/ext/` (auto-registered fences, panels, Finder/slash commands, flow nodes), so the agent's edits are additive and a bad one is a folder to delete. Two engines stay separate: dext core owns thinking and tools; agentlinkd owns the control plane (sessions, packs, crews, self-edit, later flows and triggers).

## Repo map

```
PROTOCOL.md            AgentLink v1 wire contract (the keystone)
UPSTREAM.md            dext bridge-mode PR spec
packages/protocol      TS types + envelope helpers (zero deps)
packages/client        connection + per-session state machine + seq resume + chart renderer (zero deps)
  test/                node:test suites: fold equivalence, store contract, reconnect
packages/mock-server   zero-dep Node WS/HTTP reference host; replays real fixtures
  fixtures/            recordings of real dext stream-json runs
packages/agentlinkd    zero-dep Node host for real dext (one-shot bridge, on-disk journals)
apps/web               Svelte 5 PWA, hand-rolled terminal design system (the reference client)
.crew/                 project-local crew agents + specs used to build this repo
```

## Milestones

- **M0:** protocol, docs, fixtures, TS protocol/client, zero-dep mock with synthetic approvals, Svelte PWA (sessions, transcript, approvals, composer, queue, status), smoke test.
- **M1 (done, Node not Rust):** `agentlinkd` one-shot bridge around stock `dext --output stream-json` with seat resume, on-disk journals, cold/wake, model/effort controls, `/__agent` digest, todos, chart/image rendering (```chart fences + `files_read`), and queue-next-turn steering; PWA wired to real dext. The upstream `dext bridge` PR (UPSTREAM.md) remains the path to live in-stream steering and interactive approvals on the real host.
- **M2:** mobile loop — QR pairing, `--lan`, push on `permission.request`/`turn_end`, swipeable queue, haptics.
- **M3:** depth — checkpoints/undo timeline, review mode, seats switcher, pack browser, usage dashboard; Tauri desktop.
- **M4:** agent layer — `/__agent` hardening, MCP supervision surface, save-as-rule/save-as-pack accretion, fixture-driven visual regression via browser packs; Tauri mobile / PWABuilder store packaging.
