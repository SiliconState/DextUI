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
import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { confine, DIR_NAME_RE } from "./dirs.mjs";

export const CONNECTOR_KINDS = ["github", "git", "gdrive", "dropbox"];
export const CONNECTED_DIR = "Connected";
export const ID_RE = /^[a-f0-9]{8}$/;
export const TICKET_RE = /^[a-f0-9]{16}$/;
/** rclone's OAuth loopback listener — fixed by rclone (its registered redirect URI). */
export const RCLONE_AUTH_ORIGIN = "http://127.0.0.1:53682";
const AUTHORIZE_TTL_MS = 10 * 60_000;
const GITHUB_SHORT_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/;
const HTTPS_RE = /^https:\/\/[A-Za-z0-9._-]+(?::\d+)?\/[^\s@]*$/;
const REMOTE_PATH_RE = /^(?:[A-Za-z0-9 _.()-]+(?:\/[A-Za-z0-9 _.()-]+)*)?$/;
const ASKPASS = fileURLToPath(new URL("../scripts/git-askpass.sh", import.meta.url));
const OP_TIMEOUT_MS = 10 * 60_000;
/** rclone copies may legitimately run for hours (a whole Drive on rclone's
 *  shared client_id is slow) — they run in the background, and a retry
 *  resumes: `rclone copy` skips files that are already present. */
const COPY_TIMEOUT_MS = 2 * 60 * 60_000;

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

/** Fetch `url` without following redirects; resolves `{status, location, body}`. */
function httpGet(url, timeout = 10_000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { if (body.length < 65536) body += d; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, location: res.headers.location ?? null, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve({ status: 0, location: null, body: "", error: err.message }));
  });
}

/** The landing URL a browser on another device ends up on (rclone's loopback
 *  callback, unreachable from there). Accept it only if it is exactly that
 *  callback for `state`; returns the path+query to relay, or null. */
export function relayTarget(landing, state, origin = RCLONE_AUTH_ORIGIN) {
  if (typeof landing !== "string" || landing.length > 4096) return null;
  let u;
  try { u = new URL(landing.trim()); } catch { return null; }
  const o = new URL(origin);
  const hostOk = (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === o.port && u.protocol === "http:";
  if (!hostOk || u.pathname !== "/") return null;
  if (u.searchParams.get("state") !== state || !u.searchParams.get("code")) return null;
  return `/?${u.searchParams.toString()}`;
}

export function createConnectors({ home, root, allowLocal = false, exec = run, bins, spawnFn = spawn, authOrigin = RCLONE_AUTH_ORIGIN } = {}) {
  if (!home || !root) throw new Error("connectors need home and root");
  const file = path.join(home, "connectors.json");
  const rcloneConf = path.join(home, "rclone.conf");
  const tools = bins ?? { git: which("git"), rclone: which("rclone"), gh: which("gh") };
  const busy = new Set();
  const runtime = new Map(); // id → { status, error }
  let listeners = [];
  let authListeners = [];
  // One OAuth sign-in at a time (rclone's listener port is fixed). The token
  // rclone prints is parked in memory under a ticket until `add` consumes it.
  let pendingAuth = null; // { ticket, kind, state, child, timer }
  const tokens = new Map(); // ticket → { kind, token, expires }

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
  // Registry mutations are serialized: `add` and `remove` await tool calls
  // between their read and their write, and two interleaved mutations would
  // silently drop one registration (stranding its folder on disk).
  let mutations = Promise.resolve();
  function serialize(fn) {
    const run = mutations.then(fn, fn);
    mutations = run.then(() => {}, () => {});
    return run;
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
  function emitAuth(data) {
    for (const fn of authListeners) fn(data);
  }
  function clearPendingAuth(kill = true) {
    if (!pendingAuth) return;
    clearTimeout(pendingAuth.timer);
    if (kill) try { pendingAuth.child.kill("SIGTERM"); } catch { /* gone */ }
    pendingAuth = null;
  }
  function takeToken(ticket) {
    const t = tokens.get(ticket);
    if (!t) return null;
    tokens.delete(ticket);
    return t.expires > Date.now() ? t : null;
  }
  function setRuntime(id, status, error) {
    runtime.set(id, { status, ...(error ? { error } : {}) });
    notify();
  }

  // Heal after a restart: a registered connector whose folder is gone (a
  // killed first copy, a manual delete) re-materialises in the background.
  for (const c of load()) {
    const l = localFor(c.label);
    if (l.error || fs.existsSync(l.abs)) continue;
    kick(c.id, c.kind === "gdrive" || c.kind === "dropbox" ? pullRemote : materialise);
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
    const token = c.secret ?? "";
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
    if (!tools.git) return { error: "git not found on the host" };
    const env = await withGhToken(c, gitEnv(c));
    const r = await exec(tools.git, ["clone", "--", c.remote, local], { env });
    return r.ok ? {} : { error: failLine(r) };
  }

  /** rclone pull: never deletes, and skips what is already there, so a retry
   *  picks up where the last attempt stopped. An empty folder left by a failed
   *  first copy is removed again — no half-made folder. */
  async function pullRemote(c, local) {
    if (!tools.rclone) return { error: "rclone not found on the host — install rclone to connect Drive or Dropbox" };
    fs.mkdirSync(local, { recursive: true });
    const r = await exec(tools.rclone, rcloneArgs(["copy", `${rcloneRemote(c)}:${c.remote}`, local]), { timeout: COPY_TIMEOUT_MS });
    if (r.ok) return {};
    try { if (fs.readdirSync(local).length === 0) fs.rmdirSync(local); } catch { /* keep */ }
    return { error: failLine(r) };
  }

  /** rclone push: copies local → remote, never deletes remote files. */
  async function pushRemote(c, local) {
    if (!fs.existsSync(local)) return { error: "local folder missing — sync first" };
    if (!tools.rclone) return { error: "rclone not found on the host — install rclone to connect Drive or Dropbox" };
    // Never ship DextUI's own per-folder state (flows, run logs) to the user's drive.
    const r = await exec(tools.rclone, rcloneArgs(["copy", "--exclude", ".dext/**", "--exclude", ".crew/**", local, `${rcloneRemote(c)}:${c.remote}`]), { timeout: COPY_TIMEOUT_MS });
    return r.ok ? {} : { error: failLine(r) };
  }

  /** Run a connector job in the background: status streams through the listing
   *  (syncing → idle/error) instead of blocking the caller for hours. */
  function kick(id, fn) {
    if (busy.has(id)) return;
    void guard(id, fn).catch(() => { /* guard records its own errors */ });
  }

  /** Tests: resolve once no connector job is running. */
  async function drain() {
    while (busy.size) await new Promise((r) => setTimeout(r, 10));
  }

  async function guard(id, fn) {
    const c = load().find((x) => x.id === id);
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
      // Re-validate before any recursive tool touches the folder: a path
      // swapped for a symlink must never become a copy source or target.
      let real = null;
      try { real = fs.realpathSync(l.abs); } catch { /* not created yet */ }
      if (real) {
        const base = fs.realpathSync(path.join(root, CONNECTED_DIR));
        if (real !== base && !real.startsWith(base + path.sep)) {
          setRuntime(id, "error", "folder is not inside Connected — refusing to touch it");
          return { error: "bad_path" };
        }
      }
      const out = await fn(c, l.abs);
      if (out.error) setRuntime(id, "error", out.error);
      else {
        // Reload before writing: a clone can take minutes and other
        // connectors may have been added/removed meanwhile.
        const now = Date.now();
        save(load().map((x) => (x.id === id ? { ...x, last_sync: now } : x)));
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
    /** Sign-in progress: `{ticket, kind, url}` when the consent page is ready,
     *  `{ticket, done: true}` once the token is in hand, `{ticket, error}` otherwise. */
    onAuth(fn) {
      authListeners.push(fn);
      return () => { authListeners = authListeners.filter((f) => f !== fn); };
    },
    list: listing,

    /** Start an OAuth sign-in for a drive kind: runs `rclone authorize` headless,
     *  resolves the provider's consent URL from rclone's loopback redirector, and
     *  parks the resulting token under a ticket. Resolves `{ticket, kind, url, state}`. */
    async authorize({ kind }) {
      if (kind !== "gdrive" && kind !== "dropbox") return { error: "bad_kind" };
      if (!tools.rclone) return { error: "no_rclone" };
      clearPendingAuth(); // a fresh sign-in replaces an abandoned one
      const ticket = crypto.randomBytes(8).toString("hex");
      const type = kind === "gdrive" ? "drive" : "dropbox";
      const child = spawnFn(tools.rclone, ["authorize", type, "--auth-no-open-browser"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      const state = await new Promise((resolve) => {
        const look = () => {
          const m = /\/auth\?state=([A-Za-z0-9_-]+)/.exec(err);
          if (m) resolve(m[1]);
        };
        child.stderr.on("data", look);
        child.on("exit", () => resolve(null));
        setTimeout(() => resolve(null), 15_000);
      });
      if (!state) {
        try { child.kill("SIGTERM"); } catch { /* gone */ }
        return { error: "tool_failed", detail: failLine({ stdout: out, stderr: err, code: child.exitCode ?? 1 }) };
      }
      const r = await httpGet(`${authOrigin}/auth?state=${state}`);
      if (!r.location || !/^https:\/\//.test(r.location)) {
        try { child.kill("SIGTERM"); } catch { /* gone */ }
        return { error: "tool_failed", detail: "rclone did not offer a sign-in link" };
      }
      const timer = setTimeout(() => {
        if (pendingAuth?.ticket === ticket) {
          clearPendingAuth();
          emitAuth({ ticket, error: "sign-in timed out — try again" });
        }
      }, AUTHORIZE_TTL_MS);
      pendingAuth = { ticket, kind, state, child, timer };
      child.on("exit", (code) => {
        if (pendingAuth?.ticket !== ticket) return;
        clearPendingAuth(false);
        const token = extractRcloneToken(out);
        if (code === 0 && token) {
          tokens.set(ticket, { kind, token, expires: Date.now() + AUTHORIZE_TTL_MS });
          emitAuth({ ticket, done: true });
        } else {
          emitAuth({ ticket, error: failLine({ stdout: out, stderr: err, code: code ?? 1 }) });
        }
      });
      const url = r.location;
      emitAuth({ ticket, kind, url });
      return { ticket, kind, url, state };
    },

    /** Browser on another device: the provider redirected it to rclone's
     *  loopback, which it cannot reach. The user pastes that address; we make
     *  the same request from here so rclone completes. */
    async relay({ ticket, landing }) {
      if (!pendingAuth || pendingAuth.ticket !== ticket) return { error: "no_auth" };
      const target = relayTarget(landing, pendingAuth.state, authOrigin);
      if (!target) return { error: "bad_landing" };
      const r = await httpGet(`${authOrigin}${target}`);
      if (r.status === 0) return { error: "tool_failed", detail: r.error ?? "rclone is not listening" };
      return { ticket, relayed: true };
    },

    cancelAuthorize({ ticket }) {
      if (pendingAuth && (!ticket || pendingAuth.ticket === ticket)) clearPendingAuth();
      if (ticket) tokens.delete(ticket);
      return { cancelled: true };
    },

    /** Validate, register, then materialise. Resolves with the listing (+ `added`) or `{error}`.
     *  Drive kinds take either a `ticket` from `authorize` or a pasted `secret`. */
    add(args) {
      return serialize(async () => {
        const { kind, label, remote, ticket } = args;
        let { secret } = args; // the rclone paths normalise/reassign it
      if (!CONNECTOR_KINDS.includes(kind)) return { error: "bad_kind" };
      if (typeof label !== "string" || !DIR_NAME_RE.test(label)) return { error: "bad_label" };
      const n = normaliseRemote(kind, remote, { allowLocal });
      if (n.error) return { error: n.error };
      const rclone = kind === "gdrive" || kind === "dropbox";
      if (rclone) {
        if (typeof ticket === "string" && TICKET_RE.test(ticket)) {
          const t = takeToken(ticket);
          if (!t || t.kind !== kind) return { error: "no_auth" };
          secret = t.token;
        } else {
          // Token pasted from `rclone authorize` — banner lines and all.
          secret = extractRcloneToken(secret);
          if (!secret) return { error: "bad_secret" };
        }
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
        // The token came from `authorize` (ticket) or a pasted `rclone authorize`
        // banner; either way rclone stores it in its own per-user config.
        fs.mkdirSync(home, { recursive: true, mode: 0o700 }); // rclone.conf lives here — do not rely on rclone creating it
        const type = kind === "gdrive" ? "drive" : "dropbox";
        const r = await exec(tools.rclone, rcloneArgs(["config", "create", rcloneRemote(c), type, `token=${secret}`, ...(type === "drive" ? ["scope=drive"] : []), "--non-interactive"]), { timeout: 60_000 });
        if (!r.ok) return { error: "tool_failed", detail: failLine(r) };
        try { fs.chmodSync(rcloneConf, 0o600); } catch { /* rclone already did */ }
      } else if (secret) {
        c.secret = secret;
      }
      items.push(c);
      save(items);
      if (rclone) {
        // The folder appears immediately and the first copy runs in the
        // background: a whole drive can take far longer than any request
        // should wait (rclone's shared client_id is slow). Retries resume.
        try { fs.mkdirSync(l.abs, { recursive: true }); } catch { /* the job surfaces it */ }
        kick(c.id, pullRemote);
        return listing({ added: c.id });
      }
      const out = await guard(c.id, (cc, local) => materialise(cc, local));
      if (out.error && out.error !== "busy") {
        // Materialise failed: keep the registration so the error is visible and
        // the user can fix the credential; nothing half-cloned is left behind.
        try { fs.rmSync(l.abs, { recursive: true, force: true }); } catch { /* ignore */ }
      }
        return listing({ added: c.id });
      });
    },

    remove(args) {
      return serialize(async () => {
        const { id, purge = false } = args;
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
      });
    },

    /** Pull remote → local. git: fast-forward only (never rewrites local work),
     *  awaited. rclone: copy in the background (never deletes; resumes). */
    async sync({ id }) {
      if (typeof id !== "string" || !ID_RE.test(id)) return { error: "bad_request" };
      const c = load().find((x) => x.id === id);
      if (!c) return { error: "no_connector" };
      if (c.kind === "gdrive" || c.kind === "dropbox") {
        // Backgrounded: the copy can run for hours; the status chip carries
        // progress (syncing → idle) and listing pushes land as events.
        kick(id, pullRemote);
        return listing();
      }
      const out = await guard(id, async (cc, local) => {
        if (!fs.existsSync(local)) return materialise(cc, local);
        const env = await withGhToken(cc, gitEnv(cc));
        const r = await exec(tools.git, ["-C", local, "pull", "--ff-only"], { env });
        return r.ok ? {} : { error: failLine(r) };
      });
      return out.error ? out : listing({ synced: id });
    },

    /** Push local → remote. git: commit everything + push. rclone: copy (never deletes remote files). */
    async push({ id, message }) {
      if (typeof id !== "string" || !ID_RE.test(id)) return { error: "bad_request" };
      const msg = typeof message === "string" && message.trim() ? message.trim().slice(0, 200) : `DextUI sync ${new Date().toISOString()}`;
      const c = load().find((x) => x.id === id);
      if (!c) return { error: "no_connector" };
      if (c.kind === "gdrive" || c.kind === "dropbox") {
        kick(id, pushRemote); // backgrounded like the pull — same reason
        return listing();
      }
      const out = await guard(id, async (cc, local) => {
        if (!fs.existsSync(local)) return { error: "local folder missing — sync first" };
        const env = await withGhToken(cc, gitEnv(cc));
        const identity = ["-c", "user.name=DextUI", "-c", "user.email=dextui@localhost"];
        // Stage everything except DextUI's own per-folder state: `.dext/` and
        // `.crew/` must not ride a user-visible commit.
        let r = await exec(tools.git, ["-C", local, "add", "-A", "--", ".", ":(exclude).dext", ":(exclude).crew"], { env });
        if (!r.ok) return { error: failLine(r) };
        r = await exec(tools.git, ["-C", local, ...identity, "commit", "-q", "-m", msg], { env });
        if (!r.ok && !/nothing to commit/i.test(r.stdout + r.stderr)) return { error: failLine(r) };
        r = await exec(tools.git, ["-C", local, "push"], { env });
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
    drain,
  };
}
