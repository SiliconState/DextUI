# Durable sessions

## Interrupted turns (G1)

Restart recovery is off by default. Start agentlinkd with `--auto-resume`
(or `--auto-resume=true`, or `AGENTLINKD_AUTO_RESUME=true`) to enable it.
`--auto-resume=false` overrides the environment setting.

The index records `working`, `turnNonce`, and `autoResumeAttempted`.
Only a session with a persisted working turn and an unfinished journal is
eligible. The host terminates that old UI turn as failed, atomically saves
an attempt fence, wakes the session, and submits this fixed prompt:

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
Delete the file to cancel an undelivered timer.

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
the client nonce TTL, dispatch serialization, and fail-closed persistence.

