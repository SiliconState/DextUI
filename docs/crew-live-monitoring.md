# Crew live monitoring: DextUI review

## Current scope after rollback

The transcript redesign was rejected and reverted. Keep the original typography, layout, tool command/output presentation, advisory treatment, sidebar, status bar and approval UI. Only redundant tool-name prefixes and grouping of **more than three** consecutive same-tool calls remain changed.

The previous polling, sidecar and protocol changes were also reverted to establish a clean baseline. Nothing below should be read as already implemented. The next work is crew/subagent streaming infrastructure, not a UI redesign.

## Implementation sequence — preserve the existing UI

1. **Producer contract:** emit stable run/worker/attempt IDs and versioned, sequenced, timestamped worker events. Register dynamic children at spawn rather than after they complete. Keep crew as process owner and preserve existing result artifacts.
2. **Durable bounded event capture:** capture narration, thinking, tool lifecycle/output and worker lifecycle separately from plain logs. Rotate storage with explicit gap/reset semantics instead of stopping at 8 MiB. Confirm what dext core can emit before choosing its launch flags or bridge mode.
3. **Authenticated host relay:** add per-worker subscribe/unsubscribe with replay cursors, reconnect recovery, bounded queues and backpressure. Watch for new events; reconcile lifecycle snapshots periodically. Do not stream every worker's complete history to every browser.
4. **Existing monitor integration:** feed the selected worker's existing pane from the subscription rather than manual refresh. Reuse current transcript components for structured events without changing their styling. Stop subscriptions when the pane closes; resume from the cursor after reconnect.
5. **Measure a live test:** use a small explicitly authorized crew to verify dynamic registration, incremental narration/tools, worker switches and reconnects. Target <500 ms host-event-to-browser latency. Do not claim streaming is complete based on polling or unit tests alone.

Interactive tool permissions are a separate phase after read-only observability works end to end.

## Why the current monitor lags

`apps/web/src/components/CrewRun.svelte` only ticked elapsed time. Worker `live.log` fetched on selection or manual refresh, not automatically. `packages/agentlinkd/src/crew.mjs` only enabled its 15 s reconciliation timer when initial watch installation threw. Its resetting debounce could starve under continuous writes. Worker sidecars supplied timing but not live status.

## Remaining work, in priority order

### 1. Complete crew status/log parity

The global crew pack at `~/.dext/shelves/orchestration/packs/crew` is Rust-backed. `src/render.rs::worker_rows` discovers dynamic fanout worker directories with `.state` files before they are materialized in the manifest. DextUI currently enumerates manifest workers only. Add producer-assigned stable worker/attempt IDs and incremental registration, or implement confined sidecar discovery with stable adapter keys and tail routing. Otherwise newly spawned dynamic children may appear late even with faster refresh.

`src/child.rs::capture_pipe` tees stdout/stderr to a combined `live.log`. Its sink stops writing at 8 MiB (`write_capped_log`), rather than rotating. Once capped, no browser refresh can produce newer output. Implement bounded rotation with attempt IDs and explicit truncation/reset events. Separate last-received time from last-output time in the UI.

Replace repeated tail requests with authenticated subscribe/unsubscribe and cursor-based chunks. Include run, worker, attempt, offset/sequence and timestamp; support reconnect replay, log rotation, bounded buffering and slow-client backpressure. Keep a low-rate snapshot reconciliation path. Target <500 ms visible update latency, measured rather than assumed.

### 2. Structured subagent transcripts

The current worker launch (`src/child.rs`) uses `dext -p --no-session`, pipes stdin for the task and captures plain stdout/stderr. It does not expose an AgentLink transcript stream to DextUI.

Add versioned structured worker events alongside human-readable logs: worker started/ended, narration, thinking, tool preview/start/result, output delta, usage and escalation. Every event needs run ID, worker ID, attempt ID, monotonic sequence and timestamp. Agentlinkd should relay these over the existing authenticated connection; DextUI can reuse its transcript fold and renderer. Keep crew as process owner; observability need not turn workers into durable chat sessions.

Structured events should retain original tool arguments and output metadata for faithful replay. The experimental description/command schema additions were reverted with the redesign. Do not reintroduce intent-first presentation as part of streaming. Legacy summary truncation is irreversible.

### 3. Interactive worker approvals and reliable continuation

A crew escalation is a paused step rerun with an answer, not approval of a suspended tool invocation. True live permissions require a retained bidirectional worker control channel, request IDs scoped to worker attempts, first-answer-wins semantics, timeout/exit cancellation, and explicit permission policy. Never interpret approve/skip text as a host-enforced tool permission.

The current adapter resume path records the answer then spawns `crew run --manifest` with ignored stdio; its success reply does not prove successful continuation. Track spawn/exit, persist bounded stderr and continuation status, and use crew's supervised execution lifecycle so host restarts do not lose accountability.

## Acceptance tests for the next phase

- Parallel and dynamic crews register every live child before completion.
- Narration/tool deltas reach the browser within the measured latency target.
- Switching workers, reconnecting, rerunning a step and rotating logs neither duplicate nor mix attempts.
- A long-running noisy worker continues to show fresh output beyond 8 MiB.
- Hidden tabs and disconnected/slow clients do not grow queues or repeatedly resend full logs.
- Two tabs answering the same escalation/permission yield exactly one accepted answer.
- Continuation spawn failure, worker crash, supervisor exit and host restart produce truthful UI states.

## Verification scope

No paid/live crew was launched for this review. Subagent transcript streaming, dynamic discovery and bidirectional permissions remain unimplemented. The crew pack was invoked for inspection and its sources reviewed; global pack/core files were not modified. The earlier test results applied to the now-reverted implementation; verify the rollback separately.
