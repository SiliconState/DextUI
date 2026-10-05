# Durable sessions

## Interrupted turns (G1)

Restart recovery is off by default. Start agentlinkd with `--auto-resume`
(or `--auto-resume=true`, or `AGENTLINKD_AUTO_RESUME=true`) to enable it.
`--auto-resume=false` overrides the environment setting.

The index records `working`, `turnNonce`, and `autoResumeAttempted`.
Only a session with a persisted working turn and an unfinished journal is
eligible. The host terminates that old UI turn as failed, atomically saves
a fsynced attempt fence, wakes the session, and durably accepts this fixed prompt before dispatch:

> Continue the interrupted turn. Review recovery evidence before taking any action; do not repeat side effects unless their outcome is known.

Its journal nonce is `resume:<turnNonce>`. The original turn nonce remains
unchanged during recovery; a second crash cannot resume that recovery turn
again. A fresh manually submitted turn gets a fresh nonce and is eligible
again. Attempt-fence or dispatch failures require manual intervention.
Sessions stopped deliberately, idle sessions, cleanup intents, and legacy
index entries without working/nonce evidence are not auto-resumed.

This starts a new model turn using the durable seat. It does not rerun tool
calls: CORE's recovery evidence remains authoritative. If the interrupted
first turn never saved its seat, recovery fails visibly rather than starting
an unrelated conversation. Graceful host shutdown cancels turns and is not
a crash-recovery trigger.

Verification: `node --test packages/agentlinkd/scripts/auto-resume.test.mjs`
uses temporary state, a fake core, and SIGKILL of the test host, covering both
one-shot and persistent bridge dispatch and a second crash during recovery.

## One-shot timers (G4)

Enable with `--timers` or `AGENTLINKD_TIMERS=true` (off by default).
An agent writes `<cwd>/.dext/timers/<name>.timer.json` with its normal file
tools. No timer tool, dependency or separate service is needed:

```json
{"rev":1,"at":"2026-10-05T09:00:00Z","session":"sess_123","prompt":"Check CI and report the result."}
```

Names use lowercase letters, digits, `_` and `-` (1..64 characters).
`at` is a valid ISO calendar timestamp with an explicit timezone; it is
canonicalized to UTC for the nonce `timer:<name>:<at>`. `session` is the
AgentLink session id, available to the agent as `DEXTUI_SESSION_ID`, not the
core's crew-owner `DEXT_SESSION_ID`. Targets must belong to the same workspace.
Files are capped at 128 KiB; prompt text at 100,000 characters; at most 64
files per workspace are read. Symlinks and non-regular files are refused.

Bare `{at,session,prompt}` starts at rev 1. Later edits increase `rev`; the
scheduler persists its accepted revision and content fingerprint, refusing
older revisions or changed content at the same revision. Write a unique
temporary file then rename it over the timer file, as for shared tasks.
The host's write helper performs rev CAS and atomic rename; direct agent
writes cannot be forced to use CAS, but observed stale edits are refused.
Delete the file to cancel an undelivered timer. The scheduler revalidates the
file immediately before dispatch, so deletion or rescheduling after polling
cannot execute the stale prompt. Host shutdown cancels queued dispatches.

The existing trigger scheduler polls timers every 30 seconds and immediately
at startup. Overdue timers fire once. Busy sessions wait for a later tick,
not live steering. Invalid targets/delivery failures emit
`x-agentlinkd.timers.trigger {kind:"at",phase:"failed",error,...}`; successful
acceptance emits `phase:"fired"`. Prompt acceptance is fsynced before dispatch,
and its journal nonce closes the crash window before the scheduler saves the
completion slot. This internal dedup does not expire after the ordinary
client-delivery one-hour TTL. Timer files remain in place after delivery;
rescheduling requires a new `at` and higher revision. No tool calls are
replayed by timer delivery.

Verification: `node --test packages/agentlinkd/scripts/timers.test.mjs`
covers validation, links/caps, revision checks, catch-up, restart dedup beyond
the client nonce TTL, dispatch serialization/cancellation, and fail-closed persistence.
Unreadable or malformed scheduler state disables timer delivery until it is
repaired and the host restarted; it is never treated as an empty delivery history.

## Background compaction (G8)

Opt in by starting the host with `DEXT_BACKGROUND_COMPACT=1`; the environment
is passed to core children. Off by default. CORE owns the immutable summary
worker, pair-safe prefix, validity checks, cancellation, persistence, usage,
and application. The UI adds no worker or dependencies.

The separate `background_compaction` v1 event contains:
`{version,session_id,session_epoch,job_id,origin_turn_id,phase,blocking,reason,elapsed_ms,wait_ms,before_chars,after_chars?,usage_known}`.
Phases: `running`, `ready`, `waiting`, `applied`, `failed`, `cancelled`,
`discarded`. Only `waiting` has `blocking:true`. These events are ephemeral in
agentlinkd: no journal sequence, transcript blocks, or saved job state. They
never set `working` or legacy `compacting`, resolve approvals, or add usage.

A background badge shows “Summarizing context” or “Waiting for compaction”.
Send remains usable; a real foreground turn still controls steering and busy
semantics. Stop, Ctrl/Cmd+C without a selection, and Escape in the composer
cancel the job. Background-only cancellation keeps the warm core child.
Manual compaction and child/session replacement clear transient status.

Snapshots carry `background_compaction` (current job or null). Seq-resume
sends an authoritative unsequenced, session-routed
`x-agentlinkd.background_compaction {current}` replacement, including null,
so disconnected clients cannot retain a stale badge. The host fences core
session, epoch, child identity and job id with bounded retired-job state.
Bridge death/restart never resurrects a journaled job; background-only work
does not mark an interrupted user turn for G1 recovery. Forks inherit no job.

Only installed history publishes `history_context_updated` and journaled
`compact_end {background:true,job_id,...}`. It creates one collapsed summary
block, not `compact_start` or an extra user turn, and cannot finish a manual
blocking compaction block. Bounded known-job identities accept an already
committed application buffered through interrupt exactly once without
reviving its badge. CORE guarantees cancelled candidates never publish an
installation. `post_compact` fires only on application. Usage comes only
from authoritative `usage_update.session`; per-turn `turn_end.usage` never
replaces cumulative session totals.

Verification: regular tests cover job validation, late phases, cancellation,
reconnect, child death, background-only host restart, buffered application,
legacy fold parity and accounting. Browser checks cover normal input, reload,
wait/apply, mobile Stop/Escape and draft preservation. The explicit gate
`DEXT_CORE_BIN=/verified/dext npm run test:core` uses a temporary host/core
and loopback barrier provider: two foreground turns finish while one summary
is withheld, then idle application preserves both prompts, persists history
and accounts summary usage once. Reported wall times demonstrate overlap,
not a production speedup benchmark; live paid-provider behavior is unverified.

## Kept forks (G5)

Hosts whose core advertises `--fork-to` expose capability `session_fork`.
`session.fork {id,at_seq?}` snapshots an idle session's saved core history and
calls CORE's one-shot kept-fork command. The session must have a checkpoint;
foreground work, compaction, background summaries and concurrent management
are refused. The host freezes management while the bounded snapshot is copied.

Blank `at_seq` keeps the latest saved history; zero keeps an empty prefix.
Otherwise it must identify one retained `user_message`, `text_block_complete`,
or `tool_call_result` by exact core text/tool identity. Repeated text,
compacted-away selections, deltas and missing entries are refused instead of
converting host sequence numbers to guessed message counts. CORE rounds a
pair-unsafe cut backwards and reports the actual count.

Success replies `session.forked {meta,source_id,seat,session_id,at}` and adds
a new session on the new seat. It rebuilds visible history from the retained
core messages, not a copy of approvals, usage, nonce receipts or transient jobs.
The source is untouched; CORE gives the branch a new session id and empty tool
journal. The first prompt resumes that new seat. Failures return `fork_failed`
and no successful session entry. Fork commands are live-only in the client,
never automatically replayed from its reconnect outbox.

The session controls offer Fork session, with an optional event sequence.
Real-core integration tests verify exact mapping, tool-pair roundback, source
preservation, new identity, no provider request during fork, host restart and
independent continuation. Mock/browser coverage verifies controls, new-session
selection and preserved visible history.


