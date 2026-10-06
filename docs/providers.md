# Provider sign-in

Open Settings > Providers to paste a provider API key or token. Credentials
travel once over the live connection and CORE's stdin, never command-line
arguments, the reconnect outbox, or the chat journal. The field clears after
submission, dialog close, browser offline and disconnect. Sign-out is live-only
too. A stored credential is not proof that the provider accepts it;
these controls do not make a paid provider request.

The provider list and model catalog refresh after sign-in. Failed status
inspection keeps the last known list instead of replacing it with an empty
one. The dialog shows an actionable error and a Refresh button. A successful
credential write followed by failed status inspection is reported separately;
it is not displayed as a successful sign-in or sign-out. Error messages use
reviewed categories only, never raw tool output or credential fragments.

Credential writes are globally serialized across tabs. An overlapping write
is refused before CORE runs; refresh waits for the current write to settle.
Nonforced restart waits through the write and final status check. This host
reservation does not serialize independent terminal/other-host writes and
cannot protect a forced termination during a write. Unresolved credentials
are shown as missing, not signed in. A zero exit code alone is not a saved
sign-in receipt. New sessions use the current active provider after a saved
login or status refresh; existing sessions keep their chosen provider/model.

## Unsafe permissions after login

CORE rejects a group/world-writable `providers.json`. This can block every
new Dext invocation, including provider status, model discovery and session
startup. In CORE `df69d873`, provider catalog replacement uses ordinary file
creation permissions. Under umask `002`, login can succeed but write mode
`0664`, which the next invocation refuses.

On Linux, the host owner can inspect the named file and make it owner-only:

```sh
chmod 600 ~/.dext/providers.json
```

Use the exact state path in CORE's error if `DEXT_HOME` is customized. This
changes permissions only; do not delete the catalog or paste credentials into
chat. Retry CORE and refresh Providers afterward. The original credential may
already have been saved, so check status before replacing it again.

DextUI spawns auth-write children with private umask `077`, restoring the host
mask immediately after spawn. This prevents DextUI login from recreating
`0664`; it does not repair existing files or protect standalone CORE writes.
The underlying CORE catalog-write fix remains upstream-owned.

Verification: `provider-auth-failure.test.mjs` covers redacted diagnostics,
empty/failed status, post-login refresh failure and recovery. Installed-CORE
fixtures reproduce the permissions refusal and verify that DeepSeek login
under host umask `002` writes `0600` and remains discoverable after restart.
Browser checks use synthetic credentials only and verify that failed login
and refresh keep the list visible, clear the field, and recover on retry.
