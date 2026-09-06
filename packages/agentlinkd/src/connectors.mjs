// Connectors: external sources materialised as ordinary folders under the
// picker root (`<root>/Connected/<label>`), so the folder picker, sessions,
// and every pack see them as plain directories. The host maps this module
// onto x-agentlinkd.connectors.{list,add,remove,sync,push}.
//
// Kinds and the tool that does the real work (nothing is reimplemented here):
//   github / git  → git (clone / pull --ff-only / commit + push)
//   gdrive / dropbox → rclone (copy remote→local / local→remote)
//
// Multi-user posture: the registry lives in DEXT_HOME (per user in a hosted
// deployment, one agentlinkd per sandbox), the materialised folders under the
// per-user picker root, and rclone's own config under DEXT_HOME too — nothing
// is process-global. Credentials: a git token is kept in the 0600 registry
// and only ever reaches git via GIT_ASKPASS + environment (never argv, never
// .git/config, never a remote URL); rclone keeps its OAuth tokens in its own
// 0600 config. The public listing never carries a secret.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { confine, DIR_NAME_RE } from "./dirs.mjs";

export const CONNECTOR_KINDS = ["github", "git", "gdrive", "dropbox"];
export const CONNECTED_DIR = "Connected";
export const ID_RE = /^[a-f0-9]{8}$/;
const GITHUB_SHORT_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/;
const HTTPS_RE = /^https:\/\/[A-Za-z0-9._-]+(?::\d+)?\/[^\s@]*$/;
const REMOTE_PATH_RE = /^(?:[A-Za-z0-9 _.()-]+(?:\/[A-Za-z0-9 _.()-]+)*)?$/;
const ASKPASS = fileURLToPath(new URL("../scripts/git-askpass.sh", import.meta.url));
const OP_TIMEOUT_MS = 10 * 60_000;

function which(bin) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* keep looking */ }
  }
  return null;
}

/** Normalise + validate the remote for a kind. Returns `{remote}` or `{error}`. */
export function normaliseRemote(kind, remote, { allowLocal = false } = {}) {
  const r = typeof remote === "string" ? remote.trim().replace(/\/+$/, "") : "";
  switch (kind) {
    case "github": {
      if (GITHUB_SHORT_RE.test(r)) return { remote: `https://github.com/${r}` };
      if (GITHUB_URL_RE.test(r)) return { remote: r.replace(/\.git$/, "") };
      return { error: "bad_remote" };
    }
    case "git": {
      if (HTTPS_RE.test(r)) return { remote: r };
      if (allowLocal && (r.startsWith("file://") || path.isAbsolute(r))) return { remote: r };
      return { error: "bad_remote" };
    }
    case "gdrive":
    case "dropbox": {
      const p = r.replace(/^\/+/, "");
      if (!REMOTE_PATH_RE.test(p) || p.length > 200 || p.split("/").some((s) => /^\.+$/.test(s))) return { error: "bad_remote" };
      return { remote: p };
    }
    default:
      return { error: "bad_kind" };
  }
}

function run(bin, args, { cwd, env, timeout = OP_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, env: { ...process.env, ...env }, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/** Last meaningful line of a failing tool, reduced to its reason: rclone's
 *  `YYYY/MM/DD HH:MM:SS LEVEL:` prefix dropped, the innermost `: `-chained
 *  cause kept, anything token-shaped scrubbed. */
function failLine(r) {
  const text = `${r.stderr}\n${r.stdout}`.split("\n").map((l) => l.trim()).filter(Boolean);
  let line = text.at(-1) ?? `exit ${r.code}`;
  line = line.replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d [A-Z]+:\s*/, "");
  line = line
    .replace(/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "$1…")
    .replace(/\b(ya29|sl)\.[A-Za-z0-9_-]+/g, "$1.…")
    .replace(/"(access|refresh)_token":\s*"[^"]*"/g, '"$1_token":"…"')
    .replace(/https?:\/\/[^@\s/]+@/g, "https://…@");
  if (line.length > 240) {
    // Chained causes read best from the end ("…: couldn't fetch token: …").
    const parts = line.split(/:\s+(?=[A-Za-z])/);
    line = parts.slice(-2).join(": ");
    if (line.length > 240) line = `…${line.slice(-236)}`;
  }
  return line;
}

/** `rclone authorize` prints its token inside a paste banner; accept the
 *  whole paste and keep just the JSON object. Returns the object text or null. */
export function extractRcloneToken(secret) {
  if (typeof secret !== "string") return null;
  const m = /\{[^{}]*\}/.exec(secret);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    return o && typeof o === "object" && typeof o.access_token === "string" ? JSON.stringify(o) : null;
  } catch {
    return null;
  }
}

export function createConnectors({ home, root, allowLocal = false, exec = run, bins } = {}) {
  if (!home || !root) throw new Error("connectors need home and root");
  const file = path.join(home, "connectors.json");
  const rcloneConf = path.join(home, "rclone.conf");
  const tools = bins ?? { git: which("git"), rclone: which("rclone"), gh: which("gh") };
  const busy = new Set();
  const runtime = new Map(); // id → { status, error }
  let listeners = [];

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw && raw.v === 1 && Array.isArray(raw.items)) return raw.items;
    } catch { /* first run or unreadable → empty */ }
    return [];
  }
  function save(items) {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, items }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  function publicView(c) {
    const rt = runtime.get(c.id);
    const { secret: _s, ...rest } = c;
    return {
      ...rest,
      local: path.join(root, CONNECTED_DIR, c.label),
      has_secret: !!c.secret,
      status: rt?.status ?? "idle",
      ...(rt?.error ? { error: rt.error } : {}),
    };
  }
  function listing(extra = {}) {
    return {
      connectors: load().map(publicView),
      tools: { git: !!tools.git, rclone: !!tools.rclone, gh: !!tools.gh },
      root: path.join(root, CONNECTED_DIR),
      ...extra,
    };
  }
  function notify() {
    const l = listing();
    for (const fn of listeners) fn(l);
  }
  function setRuntime(id, status, error) {
    runtime.set(id, { status, ...(error ? { error } : {}) });
    notify();
  }
  function localFor(label) {
    const dir = path.join(root, CONNECTED_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const c = confine(root, dir);
    if (c.error) return { error: c.error };
    return { abs: path.join(c.abs, label) };
  }
  function gitEnv(c) {
    const env = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: ASKPASS, GIT_CONFIG_NOSYSTEM: "1" };
    let token = c.secret ?? "";
    if (!token && c.kind === "github" && tools.gh) env.DEXTUI_GH_FALLBACK = "1";
    if (token) env.DEXTUI_GIT_TOKEN = token;
    return env;
  }
  async function withGhToken(c, env) {
    // No stored token, but gh is signed in on this box: borrow its token for
    // this one process. Never persisted by us.
    if (env.DEXTUI_GH_FALLBACK) {
      const r = await exec(tools.gh, ["auth", "token"], { timeout: 10_000 });
      if (r.ok && r.stdout.trim()) env.DEXTUI_GIT_TOKEN = r.stdout.trim();
      delete env.DEXTUI_GH_FALLBACK;
    }
    return env;
  }
  function rcloneRemote(c) {
    return `dextui-${c.id}`;
  }
  function rcloneArgs(extra) {
    return ["--config", rcloneConf, "--quiet", ...extra];
  }

  async function materialise(c, local) {
    if (c.kind === "github" || c.kind === "git") {
      if (!tools.git) return { error: "git not found on the host" };
      const env = await withGhToken(c, gitEnv(c));
      const r = await exec(tools.git, ["clone", "--", c.remote, local], { env });
      return r.ok ? {} : { error: failLine(r) };
    }
    if (!tools.rclone) return { error: "rclone not found on the host — install rclone to connect Drive or Dropbox" };
    fs.mkdirSync(local, { recursive: true });
    const r = await exec(tools.rclone, rcloneArgs(["copy", `${rcloneRemote(c)}:${c.remote}`, local]));
    return r.ok ? {} : { error: failLine(r) };
  }

  async function guard(id, fn) {
    const items = load();
    const c = items.find((x) => x.id === id);
    if (!c) return { error: "no_connector" };
    if (busy.has(id)) return { error: "busy" };
    busy.add(id);
    setRuntime(id, "syncing");
    try {
      const l = localFor(c.label);
      if (l.error) {
        setRuntime(id, "error", `local folder refused: ${l.error}`);
        return { error: "bad_path" };
      }
      const out = await fn(c, l.abs, items);
      if (out.error) setRuntime(id, "error", out.error);
      else {
        c.last_sync = Date.now();
        save(items.map((x) => (x.id === id ? c : x)));
        setRuntime(id, "idle");
      }
      return out;
    } finally {
      busy.delete(id);
    }
  }

  return {
    tools,
    onChange(fn) {
      listeners.push(fn);
      return () => { listeners = listeners.filter((f) => f !== fn); };
    },
    list: listing,

    /** Validate, register, then materialise. Resolves with the listing (+ `added`) or `{error}`. */
    async add({ kind, label, remote, secret }) {
      if (!CONNECTOR_KINDS.includes(kind)) return { error: "bad_kind" };
      if (typeof label !== "string" || !DIR_NAME_RE.test(label)) return { error: "bad_label" };
      const n = normaliseRemote(kind, remote, { allowLocal });
      if (n.error) return { error: n.error };
      const rclone = kind === "gdrive" || kind === "dropbox";
      if (rclone) {
        // Token pasted from `rclone authorize` — banner lines and all.
        secret = extractRcloneToken(secret);
        if (!secret) return { error: "bad_secret" };
      }
      if (secret !== undefined && (typeof secret !== "string" || secret.length > 8192 || /[\r\n]/.test(secret))) return { error: "bad_secret" };
      if (rclone && !tools.rclone) return { error: "no_rclone" };
      if ((kind === "github" || kind === "git") && !tools.git) return { error: "no_git" };
      const items = load();
      if (items.some((x) => x.label.toLowerCase() === label.toLowerCase())) return { error: "exists" };
      const l = localFor(label);
      if (l.error) return { error: "bad_path" };
      if (fs.existsSync(l.abs)) return { error: "exists" };
      const c = { id: crypto.randomBytes(4).toString("hex"), kind, label, remote: n.remote, created: Date.now() };
      if (kind === "gdrive" || kind === "dropbox") {
        // The user ran `rclone authorize "<drive|dropbox>"` on their own machine
        // and pasted the printed token; rclone stores it in its per-user config.
        const type = kind === "gdrive" ? "drive" : "dropbox";
        const r = await exec(tools.rclone, rcloneArgs(["config", "create", rcloneRemote(c), type, `token=${secret}`, ...(type === "drive" ? ["scope=drive"] : []), "--non-interactive"]), { timeout: 60_000 });
        if (!r.ok) return { error: "tool_failed", detail: failLine(r) };
        try { fs.chmodSync(rcloneConf, 0o600); } catch { /* rclone already did */ }
      } else if (secret) {
        c.secret = secret;
      }
      items.push(c);
      save(items);
      const out = await guard(c.id, (cc, local) => materialise(cc, local));
      if (out.error && out.error !== "busy") {
        // Materialise failed: keep the registration so the error is visible and
        // the user can fix the credential; nothing half-cloned is left behind.
        try { fs.rmSync(l.abs, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      return listing({ added: c.id });
    },

    async remove({ id, purge = false }) {
      if (typeof id !== "string" || !ID_RE.test(id)) return { error: "bad_request" };
      if (busy.has(id)) return { error: "busy" };
      const items = load();
      const c = items.find((x) => x.id === id);
      if (!c) return { error: "no_connector" };
      if ((c.kind === "gdrive" || c.kind === "dropbox") && tools.rclone) {
        await exec(tools.rclone, rcloneArgs(["config", "delete", rcloneRemote(c)]), { timeout: 30_000 });
      }
      if (purge) {
        const l = localFor(c.label);
        if (!l.error) try { fs.rmSync(l.abs, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      save(items.filter((x) => x.id !== id));
      runtime.delete(id);
      notify();
      return listing({ removed: id });
    },

    /** Pull remote → local. git: fast-forward only (never rewrites local work). rclone: copy (never deletes). */
    async sync({ id }) {
      if (typeof id !== "string" || !ID_RE.test(id)) return { error: "bad_request" };
      const out = await guard(id, async (c, local) => {
        if (!fs.existsSync(local)) return materialise(c, local);
        if (c.kind === "github" || c.kind === "git") {
          const env = await withGhToken(c, gitEnv(c));
          const r = await exec(tools.git, ["-C", local, "pull", "--ff-only"], { env });
          return r.ok ? {} : { error: failLine(r) };
        }
        if (!tools.rclone) return { error: "rclone not found on the host" };
        const r = await exec(tools.rclone, rcloneArgs(["copy", `${rcloneRemote(c)}:${c.remote}`, local]));
        return r.ok ? {} : { error: failLine(r) };
      });
      return out.error ? out : listing({ synced: id });
    },

    /** Push local → remote. git: commit everything + push. rclone: copy (never deletes remote files). */
    async push({ id, message }) {
      if (typeof id !== "string" || !ID_RE.test(id)) return { error: "bad_request" };
      const msg = typeof message === "string" && message.trim() ? message.trim().slice(0, 200) : `DextUI sync ${new Date().toISOString()}`;
      const out = await guard(id, async (c, local) => {
        if (!fs.existsSync(local)) return { error: "local folder missing — sync first" };
        if (c.kind === "github" || c.kind === "git") {
          const env = await withGhToken(c, gitEnv(c));
          const identity = ["-c", "user.name=DextUI", "-c", "user.email=dextui@localhost"];
          let r = await exec(tools.git, ["-C", local, "add", "-A"], { env });
          if (!r.ok) return { error: failLine(r) };
          r = await exec(tools.git, ["-C", local, ...identity, "commit", "-q", "-m", msg], { env });
          if (!r.ok && !/nothing to commit/i.test(r.stdout + r.stderr)) return { error: failLine(r) };
          r = await exec(tools.git, ["-C", local, "push"], { env });
          return r.ok ? {} : { error: failLine(r) };
        }
        if (!tools.rclone) return { error: "rclone not found on the host" };
        const r = await exec(tools.rclone, rcloneArgs(["copy", local, `${rcloneRemote(c)}:${c.remote}`]));
        return r.ok ? {} : { error: failLine(r) };
      });
      return out.error ? out : listing({ pushed: id });
    },

    /** Which connector (if any) owns `cwd` — the session header uses this for the sync affordance. */
    owner(cwd) {
      if (typeof cwd !== "string") return null;
      const base = path.join(root, CONNECTED_DIR) + path.sep;
      if (!cwd.startsWith(base)) return null;
      const label = cwd.slice(base.length).split(path.sep)[0];
      const c = load().find((x) => x.label === label);
      return c ? publicView(c) : null;
    },
  };
}
