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

6. **Consumer packs, one folder.** The business packs (`packs/`) are Rust runtimes on a shared SDK (`dextui_pack_sdk`: protocol framing, money as cents, CSV, dates, confined paths, fences, live panels) that read each other's plain files in the user's folder — receipts feed reconciliation, cash flow and tax; invoices feed follow-ups and cash flow. The agent narrates and asks; the runtime owns every number. Flows chain the packs; triggers start flows; crew executes. Nothing new thinks.

## DextUI display capability

The host appends DextUI-specific display context to agent turns (including resumed sessions and pack tasks), without altering the user's UI journal or replacing core system policies. Dashboards, built webpages, interactive visualizations and HTML reports should be delivered as self-contained workspace HTML with `[Title](relative/path.html)`, or small fenced HTML/SVG displays. These open in the native report viewer; no report pack or preview server is required. This is presentation guidance, not a new core tool. Native slash controls are left intact. External websites remain ordinary links, and server-dependent applications need a self-contained preview rather than a claim of full sandbox compatibility.

## Lightweight technical displays and state

SVG is the preferred 2D plan/molecule format; use mesh previews (STL/OBJ converted offline or embedded mesh data) for 3D rather than shipping a CAD kernel. Native STEP/BIM editing is not provided. WebGL 1 and 2 were verified in an opaque allow-scripts iframe under the viewer CSP by drawing a triangle and checking pixels; the test used SwiftShader software rendering, not hardware GPU verification. Render on interaction, cap mesh complexity/pixel ratio, and dispose GPU resources when done. No new rendering dependency is shipped.

Report state is explicit, data-only persistence: click **Save state** in trusted viewer chrome, review the JSON, then confirm a new `uploads/<report>.state.json` file. The existing authenticated upload endpoint confines paths and suffixes collisions, never overwriting. Reports cannot pick destinations, obtain tokens, or trigger writes themselves. One outstanding request, a five-second response deadline, matching iframe source/request ID, and a 1 MiB UTF-8 JSON object/array limit bound accepted state. Uploads have a 15-second deadline and bounded receipts checked for snapshot path and exact byte count; unsuccessful saves retain the reviewed snapshot for retry. The preview can expand to show the complete bounded JSON. A timeout does not prove the file was not written, so check uploads before retrying. Restore is pinned to the selected report, iframe and theme across asynchronous file reads; simultaneous save/restore operations are refused. PostMessage still incurs browser structured-clone costs before validation; this is not a CPU/memory isolation boundary for hostile scripts. Reports remain untrusted data, including text inside saved JSON.

Minimal report integration (register after initialization):

```js
addEventListener('message', e => {
  if (e.source !== parent) return;
  const m = e.data;
  if (m?.dextArtifact === 'state.request') {
    parent.postMessage({ dextArtifact: 'state.response', requestId: m.requestId,
      json: JSON.stringify({ version: 1, ...editableState }) }, '*');
  }
  if (m?.dextArtifact === 'state.restore') {
    // Validate your own schema; never eval state or insert it as HTML.
    restoreValidatedState(JSON.parse(m.json));
  }
});
```

**Restore state** lets the user explicitly choose a local JSON snapshot; only that file is sent to the current iframe. No automatic filesystem reads, database, polling, or autosave. For future agent edits, the saved JSON is a normal workspace file. Browser storage is not durable in this opaque sandbox. Reports must opt into the contract; old reports do not automatically become editors.

## Artifact theming contract

HTML artifacts render in opaque-origin sandboxed iframes — they cannot see the app's DOM, storage, token, or theme toggle. The trusted parent fetches file artifacts with an Authorization header, inlines bounded same-session image dependencies as data URLs, then supplies token-free `srcdoc`. Embeds track the app theme through two deliberate channels:

1. **`color-scheme` inheritance (zero-JS path).** Artifact iframes inherit `color-scheme` from the app root, so a document styled with a `@media (prefers-color-scheme: dark)` block follows the app toggle in Chromium — no script needed. Every srcdoc document already gets `<meta name="color-scheme" content="light dark">` injected.
2. **`data-theme` (exact path).** The artifact sheet sets the app's resolved `dark|dim|light` value directly on the srcdoc document root. Documents wanting pixel-exact sync style `:root[data-theme="dark"]`; no URL value is reflected into the DOM.

Producers: `ArtifactSheet.svelte` applies `data-theme`, then sends `{theme: "light"|"dark"|"dim"}` to the frame on load so existing message-aware reports can correct startup OS-theme guesses. This is a best-effort compatibility message, not a readiness handshake: reports that register listeners after asynchronous initialization can miss it, and later OS-theme handlers can override it. Reports must preserve the injected theme and redraw theme-dependent charts themselves. Reports without dim styles or a theme listener are not automatically rewritten. It remounts the token-free srcdoc on theme changes, and retains the raw source for code/download actions. `HtmlArtifact.svelte` is the durable chat-side launcher; interactive HTML itself lives only in the wide sheet rather than competing with the transcript. Pack panels (`PackSheet`) are out of scope. Downloaded standalone documents fall back to their authored/OS theme.

Agents authoring workspace `.html` artifacts SHOULD follow this contract: self-contained output; light default mirroring the app's paper palette (`#f4f2ec` body, `#ffffff` panels, `#ebe9e1` boxes, `#d4d0c2` lines, `#242830` foreground); dark and dim styles keyed to `:root[data-theme="dark"]` and `:root[data-theme="dim"]` (dim background `#1b1f27`, panels `#21262f`, text `#cdd4de`), with `prefers-color-scheme` as a standalone fallback; preserve the injected initial theme in report scripts; `<meta name="color-scheme" content="light dark">`. Small relative image dependencies are supported, but inline SVG/data assets are preferred.

## Repo map

```
docs/PROTOCOL.md       AgentLink v1 wire contract (the keystone)
docs/DESIGN.md         design notes, contracts, repo map, milestones (this file)
docs/UPSTREAM.md       dext bridge-mode PR spec
packages/protocol      TS types + envelope helpers (zero deps)
packages/client        connection + per-session state machine + seq resume + chart renderer (zero deps)
  test/                node:test suites: fold equivalence, store contract, reconnect
packages/mock-server   zero-dep Node WS/HTTP reference host; replays real fixtures
  fixtures/            recordings of real dext stream-json runs
packages/agentlinkd    zero-dep Node host for real dext (one-shot bridge, on-disk journals)
apps/web               Svelte 5 PWA, hand-rolled terminal design system (the reference client)
  src/ext/             auto-registered extensions (fences, panels, Finder/slash commands, flow nodes)
packs/                 consumer packs: sdk-rs, pack-sdk-ts, receipts, invoice, reconcile, cashflow, taxprep, followups, flows/
```

## Milestones

- **M0:** protocol, docs, fixtures, TS protocol/client, zero-dep mock with synthetic approvals, Svelte PWA (sessions, transcript, approvals, composer, queue, status), smoke test.
- **M1 (done, Node not Rust):** `agentlinkd` one-shot bridge around stock `dext --output stream-json` with seat resume, on-disk journals, cold/wake, model/effort controls, `/__agent` digest, todos, chart/image rendering (```chart fences + `files_read`), and queue-next-turn steering; PWA wired to real dext. The upstream `dext bridge` PR (UPSTREAM.md) remains the path to live in-stream steering and interactive approvals on the real host.
- **M2:** mobile loop — QR pairing, `--lan`, push on `permission.request`/`turn_end`, swipeable queue, haptics.
- **M3:** depth — checkpoints/undo timeline, review mode, seats switcher, pack browser, usage dashboard; Tauri desktop.
- **M4:** agent layer — `/__agent` hardening, MCP supervision surface, save-as-rule/save-as-pack accretion, fixture-driven visual regression via browser packs; Tauri mobile / PWABuilder store packaging.

## Development gates

Beyond `npm test` / `npm run typecheck` / `npm run build`:

### Bridge verification and thinking transactions

With NDJSON-capable dext, agentlinkd keeps a warm child per session. The pipe reader preserves UTF-8 across chunks and enforces output limits per encoded line, not per chunk. Writes reject frames over 256 KiB or beyond a 1 MiB pending stdin budget before enqueueing; `false` means the frame was not accepted locally, while core `input_ack` events report core-side refusals. Correlation value `seq: 0` is retained.

Both the live `SessionStore` (`session.ts`) and the journal snapshot fold (`fold.mjs`) apply `thinking_preview_discarded` and `thinking_preview_committed`. Thinking blocks remain provisional even after block completion until commit, so a retry removes all previews from that attempt without removing previously committed reasoning. Snapshots preserve the optional `provisional` flag for reconnect during an attempt; rollback rebuilds tool indexes. Local Chat's late thinking completion updates its existing block instead of duplicating reasoning or splitting text.

The credential-free real-core integration gate requires the binary explicitly (no silent skip):

```sh
DEXT_CORE_BIN=/absolute/path/to/Dext/target/release/dext npm run test:core
```

It uses isolated temporary state and a loopback mock provider to exercise real core retry/rollback through both projections, UTF-8 text, an approved file write, busy steering and overload refusal, interrupt, close, and EOF. Unit tests cover deterministic split-byte input, bounded writes, committed reasoning preservation, and mid-preview snapshot reconnect.

### Replaying a chart report without a model

`npm test` includes chart geometry/validation tests and real-browser drag, cross-highlight, clipping and responsive-layout checks (the browser gate visibly skips if `agent-browser` is unavailable). To replay a report directly:

```sh
REPORT_FILE=/absolute/report.md REPORT_CHARTS=10 SCREENSHOT_DIR=/tmp/report-shots \
  bash apps/web/scripts/chart-review-test.sh
```

See [chart-report-review.md](chart-report-review.md) for findings, methodology corrections and remaining verification limits.
