// Pack credentials: the values behind a pack's `credential-env` names.
// Values go to the host exactly once (x-agentlinkd.packs.credentials.set) and
// are stored under DEXT_HOME; nothing but names ever comes back. The store
// keeps no value after submit.
import type { Envelope, PackCredentialStatus, PackInfo } from "@dextui/protocol";
import { PACK_CREDENTIALS_EXT } from "@dextui/protocol";
import { app, pushToast } from "./state.svelte";

export const packCreds = $state({
  open: false,
  pack: "",
  pending: false,
  error: "",
});

export function packCredsEnabled(): boolean {
  return app.caps.includes("pack_credentials");
}

/** Packs that declare credentials, with their names-only status. */
export function packWithCredentials(name: string): (PackInfo & { credential_env: string[]; credentials: PackCredentialStatus }) | null {
  const p = app.packs.find((x) => x.name === name);
  if (!p || !p.credential_env?.length) return null;
  return { ...p, credential_env: p.credential_env, credentials: p.credentials ?? { set: [], missing: p.credential_env } };
}

/** Which pack a "credentials requested" marker is about: the active pack if
 *  known, else a pack whose name is the tool, else the pack declaring an env
 *  name the message mentions. Null when the host cannot take credentials —
 *  a button that silently no-ops is worse than no button. */
export function packForAuthMarker(auth: { tool: string; message: string; pack?: string }): string | null {
  if (!packCredsEnabled()) return null;
  if (auth.pack && packWithCredentials(auth.pack)) return auth.pack;
  if (packWithCredentials(auth.tool)) return auth.tool;
  for (const p of app.packs) {
    if (p.credential_env?.some((n) => auth.message.includes(n))) return p.name;
  }
  return null;
}

export function openPackCredentials(name: string): void {
  if (!packCredsEnabled() || !packWithCredentials(name)) return;
  packCreds.open = true;
  packCreds.pack = name;
  packCreds.error = "";
  packCreds.pending = false;
}

export function closePackCredentials(): void {
  packCreds.open = false;
  packCreds.pack = "";
  packCreds.error = "";
  packCreds.pending = false;
}

export function submitPackCredentials(values: Record<string, string>, clear: string[]): void {
  const c = app.conn;
  if (!c || !packCreds.pack) return;
  // A name being cleared never carries a value: the checkbox disables its
  // field, so anything typed before ticking it is stale, not intent.
  const filled = Object.fromEntries(Object.entries(values).filter(([k, v]) => v.trim() && !clear.includes(k)));
  if (Object.keys(filled).length === 0 && clear.length === 0) {
    packCreds.error = "Enter at least one value";
    return;
  }
  packCreds.pending = true;
  packCreds.error = "";
  c.packCredentialsSet(packCreds.pack, filled, clear);
}

/** Control-plane tap (wired from state.svelte.ts). */
export function onPackCredsControl(env: Envelope): void {
  if (env.event === PACK_CREDENTIALS_EXT) {
    const d = env.data as { name: string } & PackCredentialStatus;
    if (packCreds.pack === d.name) {
      packCreds.pending = false;
      closePackCredentials();
    }
    pushToast("ok", d.set.length ? `${d.name}: ${d.set.length} of ${d.set.length + d.missing.length} credentials set · applies from the next turn` : `${d.name}: credentials cleared`);
    return;
  }
  if (env.event === "error") {
    const d = env.data as { code: string; message: string; cmd?: string };
    if (typeof d?.cmd === "string" && d.cmd.startsWith(PACK_CREDENTIALS_EXT)) {
      packCreds.pending = false;
      packCreds.error = d.message;
    }
  }
}
