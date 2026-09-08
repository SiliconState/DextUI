# Crew live monitoring

## Presentation

The original UI styling, layout, typography, sidebar and transcript presentation are retained. Existing transcript cleanup removes redundant tool names, batches four or more consecutive same-tool calls, and folds backend bash advisories into a compact disclosure without discarding their text. Error/authentication markers remain visible. The user-approved Markdown card-sizing fix is intentional: grid flex sizing applies only to `.md-tgrid .md-tcard`, not standalone cards.

The selected worker pane now renders structured events through the existing Block renderer, independently of the parent conversation. `v` switches to its plain-log view. Worker tool approvals appear in that pane; escalation answers remain a separate run-level action. Workers retain `--no-session` and do not become durable chat sessions.

## Captured worker producer

Crew's global pack owns the capture and control lifecycle. Captured workers launch core with `--output stream-json`. Core now emits live bash `tool_output_delta` records in machine mode instead of filtering them. Credential-bearing runtime helpers still suppress live streaming under core's existing credential-redaction path.

- Before spawn, crew writes private `worker.json` registration with run, worker-directory identity, random 192-bit attempt identity, role, capture start time and interactivity. Registration is not a claim that a queued child is running: `.state` becomes running only after spawn.
- `events.jsonl` contains complete versioned records `{v, run, worker, attempt, seq, ts, event, data}`. `seq` is monotonic within an attempt; `ts` is capture time in milliseconds, not a provider timestamp. Events include text/thinking, tool lifecycle/output, usage, permission requests/receipts and worker registration/spawn/exit.
- A core input record is limited to 4 MiB. Malformed UTF-8/JSON, an incomplete final record, oversized input, a failed turn or missing `turn_end` fails the worker rather than interpreting JSON as a result.
- Transcript strings retain at most 32 KiB plus a truncation marker; arrays/objects retain at most 256 entries. Encoded records exceeding 256 KiB become explicit `transcript_gap` events. Rotation happens at complete-record boundaries: 8 MiB active plus one archived segment, at most 16 MiB. Registration publishes the retained sequence range.
- Result assembly uses the final completed text block, not the event stream or intermediate narration. Existing file-based output, structured-output and acceptance contracts remain authoritative. Result/stdout and stderr assembly retain their existing 1 MiB caps; exceeding a result cap can still fail a worker. More than 8 MiB of tool-output events does not itself overflow final-result capture.
- Human `live.log` remains separate, with the existing 8 MiB plus one-segment rotation. tmux-pane workers retain the legacy plain capture path and have no structured transcript/control endpoint.

## Transport, replay and bounds

One authenticated WebSocket subscription covers the selected worker's events and plain log. Switching workers replaces it; closing, disconnecting or hiding the tab releases it. Returning or reconnecting resumes with independent event and log cursors. Subscription identities prevent delayed frames from a previous selection affecting the current pane.

Structured replay uses `{attempt, seq}`. The host reads only complete records from the latest 512 KiB of the active event file, returns at most 256 records per tick, and reconciles every 250 ms. Changed attempts reset the projection; missing sequence ranges, rotation, malformed records and producer truncation are visible gaps. The archived segment is not replayed. Client state retains at most 200 blocks and approximately 512 KiB of serialized block content, rebuilding tool indexes after eviction. Unknown events are ignored by the existing session fold.

Pending approval metadata is sent even with an empty event replay, allowing recovery after a reconnect or retained-window gap. Registration control tokens and socket paths are not sent to the browser. The host validates run/worker membership and confines file access to regular, non-symlink files below the run. Socket backpressure pauses reads at the existing 256 KiB queued-output threshold; a single bounded replay chunk can exceed that threshold. There is no unbounded per-worker send queue.

Plain logs retain their established `{generation, offset}` cursor, 32 KiB chunks, latest-64-KiB catch-up and persistent UTF-8 decoder. The client retains 64K UTF-16 code units plus a bounded line view. Replacement/truncation/attempt changes produce explicit resets. A legacy in-place truncate and regrowth beyond an old cursor between observations is not always detectable. Missing logs remain subscribed so queued workers can start later.

Dynamic `.state` discovery is bounded to 2048 entries per nonterminal group. Keys derive from step index and directory identity, surviving manifest materialization/reordering. Terminal manifest outcomes remain authoritative; known sidecar status leads nonterminal state. Manifest reconciliation remains two seconds plus a non-resetting 500 ms coalescing window. Silence is not a lifecycle heartbeat.

## Worker tool approvals

Interactive control is explicit opt-in: set `CREW_INTERACTIVE_PERMISSIONS=1` in the crew launcher environment. Detached launch forwards this value and PATH. Existing role approval/sandbox/privacy policies are unchanged; a run escalation answer never grants tool permission. Noninteractive workers still close task stdin and keep the ordinary headless approval behavior.

Interactive captured workers use core's NDJSON input bridge, wait for `ready`, send one task, and send `close` on `turn_end`. Input frames are capped at 256 KiB. Crew owns stdin and a private Unix socket for the full worker lifetime; browser/host disconnect does not kill the worker or transfer pipe ownership.

The owner validates run, worker, attempt, request ID and a random token. It accepts only the first matching `once`, `always` or `deny` response and rejects duplicate/stale replies. Agentlinkd requires an opened run and validates the private socket directory, owner and type. Browser acceptance means only that the owner forwarded a response; the UI remains pending until core emits `permission_resolved`. Core timeout, interrupt, input disconnection and worker exit retain their fail-closed semantics. If a reply is rejected/unconfirmed, refresh reconciles the authoritative pending metadata; no permission is automatically replayed. Socket control is Unix-only; the current captured journal also requires `/dev/urandom`.

## Escalation continuation

`crew resume <run|manifest> --answer <text> --launch [--dext <binary>]` records an escalation answer under the run lease and submits a new attempt-specific `dext-crew-…-resume-run-…` user-systemd unit. It persists `continuation.json` and the pending manifest/unit before releasing the lease. A second answer fails authoritative state validation. Supervisor submission is not completion.

The continuation record survives host restart. Agentlinkd reconciles `systemctl show`, records observed running/exited/failed/unknown state and exit status, and retains up to 4096 characters of journal diagnostics (the last 20 journal lines, which may include stdout as well as stderr). It never relaunches on restart. Missing units after a 15-second launch grace fail; unavailable supervisor queries are reported as unconfirmed rather than success. A pending/running manifest whose continuation exited or failed is projected failed. A crew-observed launch failure also persists a failed manifest. The host does not rewrite manifest execution state.

`runtime-limits.json` preserves timeout, maximum workers, maximum concurrency and child budget for subsequent manifest execution; explicit CLI values override them. Older runs without that record retain defaults, so their original limits cannot be reconstructed. Unsafe-policy opt-ins are not silently persisted/regranted. Resume does not force rerun: completed parallel members and completed dynamic children retain their result and attempt; paused members rerun. Explicit `--force` remains a full reset. A run crash can still lose results not yet committed at a group boundary; this is not transactional per-child checkpoint recovery.

## Verification and remaining limits

Verified with provider-free tests:

- Crew: 75 unit tests, release build, legacy integration adapted to event framing, and `tests/transcript.py`: final-result separation, UTF-8, malformed/partial/oversized records, noisy output above 8 MiB, failure, interactive first-answer-wins, stale rejection, receipt, one-shot shutdown, persisted supervisor failure, duplicate escalation rejection, and parallel/dynamic resume preservation with saved limits.
- Host/client: event/log replay, attempt reset, rotation/gaps, partial records, symlink refusal, metadata secret exclusion, pending permission recovery, backpressure, timer cleanup, bounded projection, stale subscriptions, and continuation failure/restart reconciliation. An authenticated real-host WebSocket fixture covers structured replay/reconnect and stale permission rejection; plain-log append-to-WebSocket delivery measured about 244 ms.
- Real core with a local mock provider: thinking retry rollback, permission/receipt, steering/budget, interrupt, close/EOF and live UTF-8 bash output preceding tool completion. Core formatting, Clippy, audit, license check, ratatui tests, release build and release tests pass.
- Web typecheck reports zero errors/warnings; all 198 root-suite tests and existing browser smoke pass. Browser smoke covers established UI behavior, not every worker-control interaction.

No paid/live model crew or full producer-to-browser latency measurement was performed. A sub-500-ms end-to-end latency guarantee, large-fanout throughput, real-browser hidden-tab/control races and successful continuation across a real systemd/host restart remain unmeasured. The optional real-Capsule acceptance suite currently fails on the installed Capsule binary's `invalid identity metadata` response; Capsule-specific continuation is not newly certified by this work.

Monitoring is a bounded recent view, not lossless archival or a secret-scrubbing boundary. Arguments, narration, ordinary bash output and journal diagnostics may contain sensitive user data; the authenticated host/UI has the user's local authority. Registration credentials are excluded from transport, but content should not be assumed fully redacted across arbitrary stream chunks. Hostile same-user file replacement/process activity is outside the isolation guarantee. Supervisor submission and the manifest/observation files are not a cross-process transaction; reconciliation reports failures and never guesses that a retry is safe.
