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
