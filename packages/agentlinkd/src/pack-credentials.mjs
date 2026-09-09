// Pack credentials: the values behind a pack's `credential-env` front matter.
//
// One store, shared by the CLI and the web host:
//   $DEXT_HOME/packs/credentials/<pack>.env   (dir 0700, file 0600, KEY=VALUE)
//
// dext's own model is "credentials live in dext's process env; the tool
// scrubber hides every credential-looking variable from tool commands except
// the *active* pack's declared names" (src/main.rs allowed_pack_credential_env).
// The host therefore injects every stored pack's values into the dext child's
// env — exactly what `export X_AUTH_TOKEN=…; dext` does on the CLI — and dext
// decides per pack what its helpers may see. Values never enter the journal
// and never go back over the wire; only names do.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { checkedPath } from "./session-files.mjs";

export const MAX_VALUE_BYTES = 8 * 1024;

const SUFFIXES = ["_API_KEY", "_TOKEN", "_PASSWORD", "_SECRET", "_SECRET_KEY", "_PRIVATE_KEY", "_ACCESS_KEY", "_CLIENT_SECRET", "_CREDENTIALS", "_CONNECTION_STRING"];
const EXACT = new Set([
  "API_KEY", "TOKEN", "PASSWORD", "SECRET", "SECRET_KEY", "PRIVATE_KEY", "ACCESS_KEY", "CLIENT_SECRET", "CREDENTIALS", "CONNECTION_STRING",
  "AWS_ACCESS_KEY_ID", "AZURE_CLIENT_CERTIFICATE_PATH", "DOCKER_AUTH_CONFIG", "GH_TOKEN", "GITHUB_TOKEN", "GIT_ASKPASS", "GOOGLE_APPLICATION_CREDENTIALS",
  "KUBECONFIG", "MYSQL_PWD", "NETRC", "PGPASSFILE", "PGPASSWORD", "SSH_ASKPASS", "SSH_AUTH_SOCK", "SUDO_ASKPASS", "X_CONSUMER_KEY", "X_CT0",
]);

/** dext's `tool_credential_env_key`: does this name look like a credential? */
export function credentialKey(name) {
  const u = String(name).toUpperCase();
  return SUFFIXES.some((s) => u.endsWith(s)) || EXACT.has(u);
}

/** dext's `pack_credential_env_name_allowed`: a pack may declare this name. */
export function credentialNameAllowed(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 128 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && credentialKey(name) && !name.toUpperCase().startsWith("DEXT_");
}

export function credentialsDir(home) {
  return path.join(home, "packs", "credentials");
}

export function credentialsFile(home, pack) {
  return path.join(credentialsDir(home), `${pack}.env`);
}

/** Parse a KEY=VALUE env file (comments and blanks ignored; no unquoting — a
 *  value is everything after the first `=`, so tokens with `=` survive). */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = line.slice(eq + 1);
  }
  return out;
}

export function formatEnvFile(values) {
  const keys = Object.keys(values).sort();
  return `${["# dext pack credentials — one KEY=VALUE per line; loaded by DextUI and (with patches/dext/0004) by dext.", ...keys.map((k) => `${k}=${values[k]}`)].join("\n")}\n`;
}

/** Stored values for `pack` (empty when none). Refuses symlinked paths. */
export function readPackCredentials(home, pack) {
  const file = credentialsFile(home, pack);
  try {
    if (!checkedPath(file)) return {};
    return parseEnvFile(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** Validate write targets: every existing ancestor must be symlink-free (a
 *  missing final file is allowed — first-time saves create it), and an existing
 *  final component must be a regular file, never a symlink. */
function checkedFileForWrite(file) {
  if (!checkedPath(path.dirname(file))) throw new Error(`credentials path refused: ${path.dirname(file)}`);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if (err.code === "ENOENT") return; // first-time save: the file may not exist yet
    throw err;
  }
  if (st.isSymbolicLink()) throw new Error(`symlink refused: ${file}`);
}

/** Write (or remove when empty) the pack's file: dir 0700, file 0600, atomic.
 *  The temp file gets an unpredictable name and O_EXCL creation, so a planted
 *  `<file>.tmp` symlink can never be followed; rename replaces the target
 *  directory entry without following symlinks. */
export function writePackCredentials(home, pack, values) {
  const dir = credentialsDir(home);
  const file = credentialsFile(home, pack);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  checkedFileForWrite(file);
  if (Object.keys(values).length === 0) {
    try { fs.unlinkSync(file); } catch { /* absent */ }
    return;
  }
  const tmp = `${file}.${crypto.randomBytes(12).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, formatEnvFile(values));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

/** Names-only status: which declared names have a stored value. */
export function packCredentialStatus(home, pack, declared) {
  const stored = readPackCredentials(home, pack);
  const names = (declared ?? []).filter(credentialNameAllowed);
  const set = names.filter((n) => typeof stored[n] === "string" && stored[n].length > 0);
  return { set, missing: names.filter((n) => !set.includes(n)) };
}

/** Validate a client patch against the pack's declaration. Returns the next
 *  full value map, or `{ error }`. Values: non-empty, ≤ MAX_VALUE_BYTES, one
 *  line. `clear` removes names. Undeclared names are refused, not ignored —
 *  a typo must not silently store a secret nothing will read. */
export function applyCredentialPatch(existing, declared, values, clear) {
  const allowed = new Set((declared ?? []).filter(credentialNameAllowed));
  const next = {};
  for (const [k, v] of Object.entries(existing ?? {})) if (allowed.has(k)) next[k] = v;
  if (values !== undefined && (values === null || typeof values !== "object" || Array.isArray(values))) return { error: "values must be an object of NAME → value" };
  for (const [k, v] of Object.entries(values ?? {})) {
    if (!allowed.has(k)) return { error: `${k} is not a credential this pack declares` };
    if (typeof v !== "string" || !v.trim()) return { error: `${k}: value must be a non-empty string` };
    if (/[\r\n]/.test(v)) return { error: `${k}: value must be a single line` };
    if (Buffer.byteLength(v, "utf8") > MAX_VALUE_BYTES) return { error: `${k}: value too long` };
    next[k] = v.trim();
  }
  if (clear !== undefined && !Array.isArray(clear)) return { error: "clear must be a list of names" };
  for (const k of clear ?? []) {
    if (!allowed.has(k)) return { error: `${k} is not a credential this pack declares` };
    delete next[k];
  }
  return { values: next };
}

/** Union of every pack's stored values, restricted to what each declares —
 *  the env block the host adds to dext children. Later packs never override
 *  an earlier pack's identical name (first wins, packs in catalog order). */
export function mergedPackCredentialEnv(home, packs) {
  const env = {};
  for (const p of packs ?? []) {
    const declared = (p.credential_env ?? []).filter(credentialNameAllowed);
    if (declared.length === 0) continue;
    const stored = readPackCredentials(home, p.name);
    for (const n of declared) {
      if (typeof stored[n] === "string" && stored[n].length > 0 && env[n] === undefined) env[n] = stored[n];
    }
  }
  return env;
}
