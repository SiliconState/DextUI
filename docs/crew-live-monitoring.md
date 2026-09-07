# Crew live monitoring

## Scope

Preserve the original UI styling, layout, typography, tool/output presentation, sidebar and approval UI. The retained transcript changes are redundant tool-name cleanup and batches of more than three consecutive same-tool calls (`cfbac11`). A subsequent cosmetic-only cleanup collapses backend bash advisories into a “Bash guidance · details” disclosure, retaining the complete original text; error and authentication markers are not collapsed. Crew monitoring changes below are transport and lifecycle behavior, not a redesign.

## Implemented: live log transport and worker discovery

- The selected worker's existing log pane subscribes over the authenticated WebSocket. No repeated browser `tail` requests. Switching workers replaces the single subscription; closing the pane/run or disconnecting releases it. Hidden tabs unsubscribe and resume when visible.
- Each subscription has a client-generated identity echoed on every chunk, so in-flight frames from a previous selection or refresh cannot overwrite the current view. Closing another run cannot cancel the selected log. Missing logs clear stale displayed output, retain replay state, and explicitly signal recovery even when no bytes were appended.
- Readers more than 64 KiB behind jump to the recent window with an explicit gap instead of accumulating unbounded latency. Client line clipping is reported as truncation. Failed log watchers are reinstalled; adapter shutdown refuses queued rescheduling.
- Dynamic discovery runs only for nonterminal runs/groups, preventing orphaned sidecars from resurrecting finished workers, and uses deterministic directory ordering.
- Host directory notifications drive reads, throttled to at most one per 100 ms, with a 250 ms reconciliation timer for missed notifications. Only new bytes are sent. A fixture measured 245 ms from file append to WebSocket receipt; this is not a live-model/browser rendering latency guarantee.
- Chunks are bounded to 32 KiB, initial replay to the latest 64 KiB, and the client retains 64K UTF-16 code units plus its existing bounded line view. Bytes travel as base64 so a persistent UTF-8 decoder handles split characters. Sending yields while the socket has at least 256 KiB queued; there is no per-worker unbounded queue.
- Reconnect uses `{generation, offset}` cursors. Generation includes file identity and the available `.state` process identity. Replacement, truncation below the cursor, or attempt changes reset the view and explicitly report a gap. Cursors never authorize paths. The host validates worker membership and confines regular non-symlink log access to the run.
- Dynamic worker directories with valid `.state` files are discovered before manifest materialization (scan bounded to 2048 directory entries per dynamic group). Keys are derived from step index plus worker directory identity, so later materialization/reordering does not switch the selected worker. Existing numeric sequential/parallel keys remain unchanged.
- Known sidecar status leads nonterminal manifest status; terminal manifest outcomes remain authoritative. Manifest watches have a non-resetting 500 ms coalescing window and unconditional two-second reconciliation (plus coalescing delay). Watchers are closed with the adapter.
- Captured crew workers rotate `live.log` at 8 MiB, retaining one `live.log.1` segment: at most 16 MiB total. Reruns clear both. stdout/stderr share the rotation lock. This producer change is in the global crew pack's `src/child.rs`, not dext core.

### Exact limits of this slice

This is **live plain-log streaming**, not a structured subagent transcript. The reader does not replay the archived segment: rotation advances to the newest retained window with an explicit gap. It is not lossless archival. Existing producer captures remain bounded to 1 MiB per stream for result assembly; exceeding that can still fail the worker result. tmux `pipe-pane` capture is unchanged.

Attempt identity is currently inferred from `.state` start time/PID/process-start ticks and file identity, not a producer-assigned durable attempt UUID. A legacy in-place truncate followed by regrowth beyond a cursor between observations cannot always be detected. The captured producer now rotates via replacement, but explicit attempt IDs are still required for structured replay.

Missing logs stay subscribed so queued workers can start later. Broad project/run scans, large fanouts, hidden-tab behavior in real browsers and sustained noisy-worker throughput still need live workload measurement. Log updates are not lifecycle heartbeats; silence does not mean failure.

## Next implementation: structured transcripts, end to end

### Existing core interfaces (verified from source)

Dext already supports `--output stream-json` and `--input ndjson`. `src/main.rs::JsonSink` serializes agent events, but currently **filters out `ToolOutputDelta`**. Its permission bridge emits `permission_request` and waits for a matching reply; stale replies are ignored and timeout/disconnection denies. Crew currently launches `dext -p --no-session` with plain text output and task stdin, then closes stdin. It does not use these interfaces.

Do not merely add `--output stream-json` to the existing launch: crew's result assembler expects plain stdout/handoffs. JSON framing must be separated from the existing result contract, and bridge mode needs an explicit end-of-turn shutdown so a one-shot crew worker does not remain alive waiting for another prompt.

### Producer/event contract

1. Allocate a durable attempt ID before spawn and write an atomic worker registration record containing run ID, stable worker ID, attempt ID, role and start time. Keep queued, spawned, completed and failed distinct; queued children must not be reported as running merely because they were materialized.
2. Capture versioned records `{v, run, worker, attempt, seq, ts, event, data}`. Sequence is monotonic per attempt; preserve source event timestamps separately from capture timestamps. Include narration/thinking deltas, text completion, tool preview/start/result/output, usage, lifecycle, escalation and permission resolution.
3. Bound record size and buffer size. Rotate by complete records, persist the retained sequence range, and emit an explicit reset/gap when replay falls behind. Never interpret a partial record after a crash. Preserve human `live.log` and trusted file-based handoffs separately; monitoring must not turn ordinary verbose event output into a result-capture failure.
4. Reuse core's existing machine event stream, adding bounded tool-output emission rather than inventing another text parser. Audit full argument/output sensitivity and redaction before forwarding. Original arguments can be retained without restoring the rejected intent-first UI; older truncated summaries cannot be reconstructed.
5. Relay per-attempt event subscriptions with replay sequence cursors through agentlinkd. Fold into a worker-scoped transcript using existing renderer styling. No worker events go into the parent conversation, and no workers become durable chat sessions just for monitoring.

### Bidirectional permissions and continuation

A crew escalation answer reruns a paused step. It is **not** permission for a suspended tool call.

- Crew must retain the child's NDJSON stdin and own the control endpoint across UI disconnects. Use a private authenticated/local endpoint with bounded messages; the browser talks only to agentlinkd, never directly to worker pipes or arbitrary files.
- Permission requests and replies are scoped to run/worker/attempt/request ID. The crew owner accepts exactly one response, rejects stale attempts, and forwards only core-supported choices. Disconnect/timeout/exit cancels or denies outstanding requests. A received write is not a resolved permission; wait for core's `permission_resolved` receipt.
- Keep normal headless approval policies unchanged unless the operator explicitly enables interactive worker permissions. Do not infer policy from an escalation answer or a UI button label.
- `createCrewAdapter.resume()` currently records the answer then spawns `crew run --manifest` with ignored stdio. Its success message still does **not** prove continuation succeeded. Replace this with a tracked supervised continuation: persist pending launch before starting, use an attempt-specific `dext-` systemd unit, capture bounded stderr and exit status, reconcile after host restart, and broadcast truthful launch failure. Crew's current `launch` contract is spec-based; existing-manifest continuation needs a reviewed supervisor path rather than assuming `launch --manifest` works.
- Respect crew's run lease and detached-owner validation. Resolve first-answer-wins at the authoritative owner, not independently in each browser. Host restart recovery must not launch the same continuation twice.

## Acceptance gates for the structured/control phase

- Parallel/dynamic workers register before output; stable worker and distinct attempt identities survive retries and manifest reordering.
- A fake NDJSON child exercises incremental text, thinking, tool events, split UTF-8, malformed/oversized records, exits and stalled pipes without provider cost.
- A real small authorized crew measures producer-event-to-browser latency (target <500 ms) and confirms final artifacts/results remain identical.
- Switching workers, hidden tabs, reconnecting, rerunning and rotating cannot mix attempts or duplicate already folded events.
- Output beyond 8 MiB stays fresh; slow/disconnected clients have bounded memory and receive explicit gaps rather than false completeness.
- Two clients answering one permission yield one accepted response; stale replies never authorize the next attempt.
- Continuation spawn failure, worker crash, supervisor exit and host restart produce truthful persisted states.

## Verification for the live-log slice

- DextUI: 189 tests pass, including authenticated real-host WebSocket subscribe/reconnect/unsubscribe, cursor resets, bounded reads, symlink refusal, backpressure, dynamic discovery, stale subscription rejection, split UTF-8 across reconnects, missing-log recovery and advisory detection. Existing browser smoke passes; Svelte reports zero errors/warnings. Browser smoke does not specifically exercise the new advisory disclosure or hidden-tab monitoring.
- Crew: 75 tests and release build pass from an isolated archive of commit `f0dd184`; that binary is installed in the global pack. The working checkout also passed 77 tests, including two from pre-existing uncommitted `src/run.rs` progress-publication changes. Those unrelated changes were neither committed nor included in the installed binary. The touched Rust file passes formatting.
- No paid/live model crew was launched. No dext core source or interactive permission behavior changed. Structured worker events, archived-segment replay and reliable supervised continuation remain follow-up work.
