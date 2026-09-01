# UPSTREAM: `dext bridge` — PR spec

The only change DextUI needs from dext: a single-session, bidirectional machine interface over stdio NDJSON. Deliberately small — one new module plus dispatch wiring. No sockets, no server, no new tools, no prompt changes. Dext keeps its one-local-binary posture; multi-session supervision lives downstream in DextUI's host, which spawns one `dext bridge` child per session.

## Interface

```bash
dext bridge [--resume|--session ID] [--cwd DIR]   # plus existing global flags (--approval, --model, --seat, --sandbox, ...)
```

- **stdout** — one JSON object per line: the existing `AgentEvent` serialization, byte-identical to `--output stream-json` today, plus bridge-synthesized lines:
  - `bridge_hello` — `{agent:"dext", version, capabilities[], session_id}` as the first line.
  - `permission.request` — `{request_id, tool, summary, input, diff?}`; `input` capped, `diff` from `mutation_preview` for write tools.
  - `permission.timeout` — `{request_id}`.
  - `user_message` — `{text}` echo of each accepted prompt, so consumers rebuild full transcripts from the event stream alone.
- **stdin** — one JSON command per line:
  - `{"cmd":"prompt.submit","text":"…"}`
  - `{"cmd":"steering.inject","text":"…"}`
  - `{"cmd":"interrupt"}`
  - `{"cmd":"permission.respond","request_id":"…","choice":"once"|"always"|"deny","note?":"…"}`
  - `{"cmd":"local_auth.respond","request_id":"…","secret":"…"}` or `{"cancel":true}`
  - `{"cmd":"slash","raw":"/model glm-5"}` — routed through the existing slash handler; output emerges as normal `slash`/`structured_slash` events.
  - `{"cmd":"approval.set","profile":"always|auto-write|auto-read|ask|never"}` — runtime profile change (emits the existing `approval_profile_changed`).
  - `{"cmd":"shutdown"}` — graceful exit (interrupt turn, save session).
- **stderr** — human diagnostics only, as today.

## Implementation sketch (mapped to existing code)

New `src/bridge.rs`:

1. `BridgeSink` implements `EventSink`:
   - `emit` → `serde_json::to_string(&event)` to locked stdout. Same serialization path as `JsonSink`'s `StreamJson` arm, without `OutputStreamState`.
   - `request_permission(name, input)` → emit `permission.request` with a fresh `request_id`, then park on `std::sync::mpsc::sync_channel(0)` — the exact pattern `TuiSink` uses (tui.rs:330-342). Difference: `recv_timeout` with `DEXT_BRIDGE_PERMISSION_TIMEOUT_SECS` (default 600). Timeout → emit `permission.timeout`, return `Choice::Deny` (fail-closed, matching `JsonSink`'s posture).
   - `request_local_auth_secret` → same park pattern via `local_auth.request`/`local_auth.respond`. The secret travels only through the channel; it is never written to stdout, logs, or the session journal.
   - `live_output_sender` → forward `ToolOutputDelta` (the TUI gets live tails this way; `JsonSink` drops them — bridge should not).
2. Stdin command loop on a dedicated thread: `io::stdin().lock().read_line` (same pattern as the existing plain REPL, main.rs ~24004), parse NDJSON, dispatch:
   - `prompt.submit` / `steering.inject` → the same submission/steering channels the REPL and TUI feed (`steering_received` event already exists).
   - `interrupt` → the shared interrupt flag `Esc` sets (observed between bounded chunks in tool_round).
   - `permission.respond` → resolve `HashMap<request_id, SyncSender<Choice>>`; unknown/stale id → `error` line, no state change.
   - Malformed line → one `{"event":"error"}` line, keep running.
3. `main.rs` wiring: subcommand dispatch → build the project-scoped agent exactly as the REPL does, with `BridgeSink`. Durable sessions work as usual; `--no-session` honored.

## Verification items (confirm during the PR; do not assume)

1. **Concurrent sessions per project.** `session.rs` documents project-scoped locks. Crew children use `--no-session`; bridge sessions are durable. If a single-instance project lock exists, bridge needs a documented per-session exception or lock-scope narrowing.
2. **REPL submission path** — reuse the plain REPL's turn loop vs. a bridge-specific one; whichever shares the steering queue and slash handler with least duplication.
3. **Steering injection point** — confirm the TUI's steering path is callable between tool rounds, not only at turn boundaries.
4. **`ToolOutputDelta` routing** — confirm whether bash output deltas flow through `emit` or only `live_output_sender`; wire accordingly.
5. **`mutation_preview` invocation point** — previews are currently computed for the `--preview` flow; the bridge wants the same capped preview inside `permission.request`.

## Failure posture

- stdin EOF → graceful shutdown (turn interrupted, session durable).
- Permission timeout → `Deny` + event; the agent never hangs on a disconnected host.
- Host death → child sees stdin EOF and exits; in-flight turn aborts fail-closed; session resumable via `--resume`.
- Crash → host marks the session cold and offers resume. No partial state mutation beyond dext's existing journal/checkpoint guarantees.

## Conformance

`packages/mock-server/fixtures/*.raw.jsonl` (real `stream-json` recordings) pin the event shapes. The PR's tests: fixture round-trip, permission timeout → Deny, double-respond race (first wins), secret never appearing on stdout, interrupt mid-tool-round.

Estimated size: ~500-700 LOC new module, ~50 LOC wiring, tests included.
