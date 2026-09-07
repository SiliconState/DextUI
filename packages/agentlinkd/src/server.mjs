#!/usr/bin/env node
// agentlinkd: the REAL AgentLink v1 host. Bridges dext one-shot processes
// (--output stream-json) to the DextUI web client over WebSocket, with
// seat-based session resume, per-session journals, and static PWA serving.
//
//   node packages/agentlinkd/src/server.mjs \
//     [--port=8788] [--token=SECRET] [--dext=/path/to/dext] \
//     [--cwd=/work/dir] [--approval=auto-read] [--static=apps/web/dist] \
//     [--state-dir=~/.dextui/agentlinkd]
//
// Every prompt becomes one dext child:
//   turn 1:  dext -p --output stream-json --cd CWD --approval P --seat SEAT
//   turn 2+: dext -p --output stream-json --cd CWD --approval P --seat SEAT --resume
// The child's ndjson events are journaled and fanned out verbatim; the client
// already speaks this dialect byte-for-byte (fixtures are recordings of it).
//
// Durable state lives under --state-dir (default $HOME/.dextui/agentlinkd, env
// AGENTLINKD_STATE_DIR), created 0700 with symlink rejection throughout: each
// session's envelopes append to journals/<id>.jsonl (0600) and the index
// sessions.json is rewritten atomically, so a host restart restores the list.
// Restored sessions come back "cold" — no child, not working; session.open or
// prompt.submit wakes them through starting -> live, and session.close returns
// them to cold because the durable session is the dext seat, not the child.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";
import { spawn, spawnSync, execFile } from "node:child_process";
import { acceptKey, FrameParser, encodeFrame, OP_PONG, OP_TEXT } from "../../mock-server/src/ws.mjs";
import { fold, foldMeta } from "../../mock-server/src/fold.mjs";
import { checkedPath, purgeSeat, seatFiles } from "./session-files.mjs";
import { GALLERY_DEFAULTS, PACK_NAME_RE, buildCatalog, listPackFiles, listPackTree, loadGallery, packCommands, parsePackListingJson, parsePackSlash, readPackFile, renderPackList, unmetRequirements, writePackFile } from "./packs.mjs";
import { RUN_ID_RE as CREW_RUN_ID_RE, TAIL_MAX_LINES, createCrewAdapter } from "./crew.mjs";
import { createSelfEdit, resolveStaticDir } from "./selfedit.mjs";
import { confine, createDir, listDirs } from "./dirs.mjs";
import { applyCredentialPatch, mergedPackCredentialEnv, packCredentialStatus, readPackCredentials, writePackCredentials } from "./pack-credentials.mjs";
import { createConnectors } from "./connectors.mjs";
import { compileFlow, deleteFlow, listFlows, readFlow, writeFlow } from "./flows.mjs";
import { createScheduler } from "./triggers.mjs";
import { TASK_STATUSES, createTasksAdapter } from "./tasks.mjs";
import { bridgeArgs, probeNdjsonSupport, spawnBridge, toBridgeChoice, toPermissionRequest } from "./bridge.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..", "..", "..");

// ---------- args ----------

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function resolveDext() {
  const explicit = argValue("dext", process.env.DEXT_BIN);
  if (explicit) return explicit;
  const release = path.join(process.env.HOME ?? "", "Dext", "target", "release", "dext");
  if (fs.existsSync(release)) return release;
  return "dext"; // PATH
}

const PORT = Number(argValue("port", process.env.AGENTLINKD_PORT ?? 8788));
const TOKEN = argValue("token", process.env.AGENTLINKD_TOKEN ?? crypto.randomBytes(9).toString("base64url"));
const DEXT_BIN = resolveDext();
// Every dext child (turns, catalog probes, auth) runs with the dext binary's
// own directory (and ~/.cargo/bin) ahead of PATH: under a service unit PATH
// is minimal, and the agent's *own* `bash` otherwise cannot find `dext`
// ("command not found" on turn 1, then a hardcoded fallback path).
const DEXT_PATH = (() => {
  const dirs = [];
  if (DEXT_BIN.includes(path.sep)) dirs.push(path.dirname(path.resolve(DEXT_BIN)));
  const cargo = path.join(process.env.HOME ?? "", ".cargo", "bin");
  if (fs.existsSync(cargo)) dirs.push(cargo);
  const have = (process.env.PATH ?? "").split(path.delimiter);
  return [...dirs.filter((d) => !have.includes(d)), ...have].filter(Boolean).join(path.delimiter);
})();
function dextEnv(extra = {}) {
  // PACK_CRED_ENV: every stored pack credential (see pack-credentials.mjs) —
  // the CLI's "export before dext" model; dext's scrubber exposes only the
  // active pack's declared names to its tool commands. A name the operator
  // already exported wins over the store — same rule as patches/dext/0004.
  const stored = Object.fromEntries(Object.entries(PACK_CRED_ENV).filter(([k]) => process.env[k] === undefined));
  return { ...process.env, ...stored, PATH: DEXT_PATH, DEXT_NO_TUI: "1", ...extra };
}
let PACK_CRED_ENV = {};
const DEXT_HOME = process.env.DEXT_HOME ? path.resolve(process.env.DEXT_HOME) : path.join(process.env.HOME ?? "", ".dext");
const DEFAULT_CWD = path.resolve(argValue("cwd", process.cwd()));
const DEFAULT_APPROVAL = argValue("approval", process.env.DEXT_APPROVAL ?? "auto-read");
// `--safe` serves the last-known-good build (apps/web/dist.lkg) so a broken
// self-edit can never lock the operator out of the UI that fixes it.
const SAFE_MODE = process.argv.includes("--safe");
const STATIC_RESOLVED = resolveStaticDir({ staticDir: argValue("static", path.join(repoRoot, "apps", "web", "dist")), repoRoot, safe: SAFE_MODE });
const STATIC_DIR = STATIC_RESOLVED.dir;
const STATE_DIR = path.resolve(
  argValue("state-dir", process.env.AGENTLINKD_STATE_DIR ?? path.join(process.env.HOME ?? "", ".dextui", "agentlinkd")),
);
const JOURNALS_DIR = path.join(STATE_DIR, "journals");
const INDEX_PATH = path.join(STATE_DIR, "sessions.json");
const JOURNAL_TRUNCATE_BYTES = 64 * 1024 * 1024;
// `ask` only makes sense with the bridge (patches/dext/0003): one-shot children
// can never answer a permission prompt, so every guarded tool would be denied.
const APPROVALS = new Set(["ask", "auto-read", "auto-write", "never", "always"]);
const EFFORT_OPTIONS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORTS = new Set(EFFORT_OPTIONS);
const MAX_PROMPT_CHARS = 1_000_000;
const MAX_STDOUT_BUFFER = 16 * 1024 * 1024;
const STEERING_MAX_MESSAGES = 10;
const STEERING_MAX_CHARS = 100_000;

if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error(`invalid --port '${PORT}'`);
if (!TOKEN) throw new Error("pairing token must not be empty");
if (!APPROVALS.has(DEFAULT_APPROVAL)) throw new Error(`invalid --approval '${DEFAULT_APPROVAL}'`);
if (!fs.existsSync(DEFAULT_CWD) || !fs.statSync(DEFAULT_CWD).isDirectory()) {
  throw new Error(`--cwd is not a directory: ${DEFAULT_CWD}`);
}

// ---------- auth: constant-time compare + failure limiter ----------

// sha256 both sides so timingSafeEqual always sees equal-length buffers.
const TOKEN_DIGEST = crypto.createHash("sha256").update(TOKEN, "utf8").digest();
const AUTH_FAILURE_LIMIT = 5;
const AUTH_WINDOW_MS = 60_000;
const AUTH_LOCKOUT_MS = 30_000;
let authFailures = [];
let authLockedUntil = 0;
let authLockLogged = false;

function tokenEquals(presented) {
  const digest = crypto.createHash("sha256").update(String(presented ?? ""), "utf8").digest();
  return crypto.timingSafeEqual(digest, TOKEN_DIGEST);
}

function authLocked() {
  const now = Date.now();
  if (authLockedUntil > now) return true;
  if (authLockedUntil !== 0) {
    authLockedUntil = 0;
    authLockLogged = false;
  }
  authFailures = authFailures.filter((t) => now - t < AUTH_WINDOW_MS);
  return false;
}

function noteAuthFailure() {
  const now = Date.now();
  authFailures = authFailures.filter((t) => now - t < AUTH_WINDOW_MS);
  authFailures.push(now);
  // Global limiter: single-operator host, one counter. Engaging clears the
  // window so the lockout expiry starts from a clean slate.
  if (authFailures.length >= AUTH_FAILURE_LIMIT && authLockedUntil <= now) {
    authLockedUntil = now + AUTH_LOCKOUT_MS;
    authFailures = [];
    if (!authLockLogged) {
      authLockLogged = true;
      console.error(
        `agentlinkd: ${AUTH_FAILURE_LIMIT} auth failures in ${AUTH_WINDOW_MS / 1000}s; rejecting auth attempts for ${AUTH_LOCKOUT_MS / 1000}s`,
      );
    }
  }
}

function dextOutput(args) {
  const result = spawnSync(DEXT_BIN, args, {
    encoding: "utf8",
    env: dextEnv(),
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : "";
}

// Provider ids are echoed to browsers and used as argv: keep them plain.
// Marker words safe to send to a browser. For API-key providers dext's marker
// can echo credential-derived material — anything unrecognised collapses to
// "key" ("a credential is held"), never the value itself. Declared before the
// boot-time discovery below, which parses `auth status --json` with them.
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/i;
const AUTH_MARKERS = new Set(["auth", "key", "none", "web", "oauth", "token", "session", "failed", "expired", "missing", "absent", "unknown", "present", "ok", "disabled", "off"]);

function parseModels(text) {
  const groups = [];
  let current = null;
  let readingModels = false;
  for (const line of text.split("\n")) {
    const header = /^\s*\*?\s*provider '([^']+)' models:/.exec(line);
    const fallback = /^\s*\*?\s*provider '([^']+)' default model:\s*(\S+)/.exec(line);
    if (header) {
      current = { provider: header[1], models: [] };
      groups.push(current);
      readingModels = true;
      continue;
    }
    if (fallback) {
      current = { provider: fallback[1], models: [fallback[2]] };
      groups.push(current);
      readingModels = false;
      continue;
    }
    if (readingModels && current) {
      const model = /^-\s+(\S+)\s*$/.exec(line);
      if (model) current.models.push(model[1]);
      else if (line.trim()) readingModels = false;
    }
  }
  return groups.filter((g) => g.models.length > 0);
}

// `dext auth models --json` / `dext auth status --json` (patches/dext/0001):
// a versioned document, so a prose reformat upstream cannot silently empty the
// model picker or the Providers dialog. Older binaries print prose for the
// unknown flag (or fail); both fall through to the prose parsers.
function parseModelsJson(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || doc.version !== 1 || !Array.isArray(doc.providers)) return null;
  return doc.providers
    .filter((p) => p && typeof p.id === "string" && Array.isArray(p.models))
    .map((p) => ({ provider: p.id, models: p.models.filter((m) => typeof m === "string" && m) }))
    .filter((g) => g.models.length > 0);
}
function discoverModels() {
  return parseModelsJson(dextOutput(["auth", "models", "--json"])) ?? parseModels(dextOutput(["auth", "models"]));
}

function discoverActiveModel(catalog) {
  const json = parseProviderStatusJson(dextOutput(["auth", "status", "--json"]));
  if (json) {
    const hit = json.providers.find((p) => p.active) ?? json.providers.find((p) => p.id === json.active);
    const group = catalog.find((g) => g.provider === (json.active ?? hit?.id)) ?? catalog[0];
    return { provider: json.active ?? hit?.id ?? group?.provider, model: hit?.model ?? group?.models[0] };
  }
  const status = dextOutput(["auth", "status"]);
  const active = /^active provider:\s*(\S+)/m.exec(status)?.[1];
  const line = status
    .split("\n")
    .find((l) => /^\s*\*/.test(l) || (active && l.trimStart().startsWith(active + " ")));
  const model = line ? /\bmodel=(\S+)/.exec(line)?.[1] : undefined;
  const group = catalog.find((g) => g.provider === active) ?? catalog[0];
  return { provider: active ?? group?.provider, model: model ?? group?.models[0] };
}

const MODEL_CATALOG = discoverModels();

// Persistent-child bridge (`dext --input ndjson`, patches/dext/0003). With it,
// steering is live, `/effort` applies mid-turn, model changes survive history
// (respawn with --resume), and permission_request events get real per-action
// answers. Without it every turn is a one-shot `-p` child (runTurn below).
const BRIDGE = probeNdjsonSupport(dextOutput);
const DEFAULT_MODEL = discoverActiveModel(MODEL_CATALOG);
if (DEFAULT_MODEL.provider && DEFAULT_MODEL.model) {
  let group = MODEL_CATALOG.find((g) => g.provider === DEFAULT_MODEL.provider);
  if (!group) {
    group = { provider: DEFAULT_MODEL.provider, models: [] };
    MODEL_CATALOG.push(group);
  }
  if (!group.models.includes(DEFAULT_MODEL.model)) group.models.unshift(DEFAULT_MODEL.model);
}

// Provider sign-in state, parsed from `dext auth status` (one line per
// provider: `[*] id  Label…  model=… … auth=<auth|key|none|…>`). Reused by the
// web's Providers dialog; login/logout shell out to `dext auth login|logout`
// so dext's own auth store stays the single credential holder.
function parseProviderStatus(text) {
  const json = parseProviderStatusJson(text);
  if (json) return json;
  const active = /^active provider:\s*(\S+)/m.exec(text)?.[1] ?? null;
  const providers = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\*)?\s*(\S+)\s+(.*?)\s+model=(\S+)(.*)$/.exec(line);
    if (!m || !PROVIDER_ID_RE.test(m[2])) continue;
    const raw = (/\bauth=(\S+)/.exec(m[5])?.[1] ?? "none").replace(/^[^\w]+|[^\w]+$/g, "").toLowerCase();
    providers.push({ id: m[2], label: m[3].trim() || m[2], model: m[4], auth: AUTH_MARKERS.has(raw) ? raw : "key", active: !!m[1] || m[2] === active });
  }
  return { active, providers };
}
function parseProviderStatusJson(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || doc.version !== 1 || !Array.isArray(doc.providers)) return null;
  const active = typeof doc.active_provider === "string" ? doc.active_provider : null;
  const providers = [];
  for (const p of doc.providers) {
    if (!p || typeof p.id !== "string" || !PROVIDER_ID_RE.test(p.id)) continue;
    const raw = String(p.auth ?? "none").replace(/[^\w].*$/, "").toLowerCase();
    providers.push({
      id: p.id,
      label: typeof p.label === "string" && p.label.trim() ? p.label.trim() : p.id,
      model: typeof p.default_model === "string" ? p.default_model : "",
      auth: AUTH_MARKERS.has(raw) ? raw : "key",
      active: p.active === true || p.id === active,
    });
  }
  return { active, providers };
}
// Request handlers use these async twins: the sync spawns above are boot-only —
// a spawnSync inside a handler would freeze every connected client for up to
// 15 s per dext invocation.
async function providerStatusAsync() {
  const j = await dextOutputAsync(["auth", "status", "--json"]);
  const parsed = j.ok ? parseProviderStatusJson(j.out) : null;
  if (parsed) return parsed;
  const r = await dextOutputAsync(["auth", "status"]);
  return parseProviderStatus(r.ok ? r.out : "");
}
// After a login the model list may grow (a provider's models appear once it
// is authenticated): refresh the catalog in place so hello_ok and the status
// reply agree.
async function refreshModelCatalog() {
  const j = await dextOutputAsync(["auth", "models", "--json"]);
  const groups = j.ok ? parseModelsJson(j.out) : null;
  if (groups) {
    MODEL_CATALOG.splice(0, MODEL_CATALOG.length, ...groups);
    return MODEL_CATALOG;
  }
  const r = await dextOutputAsync(["auth", "models"]);
  if (!r.ok) return MODEL_CATALOG;
  MODEL_CATALOG.splice(0, MODEL_CATALOG.length, ...parseModels(r.out));
  return MODEL_CATALOG;
}
/** `stdin` (optional) is written and closed; used to hand `auth login` its
 *  credential off argv (patches/dext/0001) so /proc/<pid>/cmdline never has it. */
function runDext(args, timeout = 60_000, stdin = null) {
  return new Promise((resolve) => {
    const child = execFile(DEXT_BIN, args, { env: dextEnv(), timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
    child.stdin?.on("error", () => {});
    if (stdin !== null) child.stdin?.end(`${stdin}\n`);
    else child.stdin?.end();
  });
}

// Capabilities are real: `approvals`, `steering.live` and `model_switch` are
// added only when the binary advertises the ndjson bridge (see BRIDGE).
// Without it dext's own --approval profile governs tool policy. `crew` is
// appended once the pack catalog has located the binary (below).
const CAPABILITIES = [
  "multi_session",
  "interrupt",
  // With the bridge, steering is delivered to the running turn (dext folds it
  // into the next model request). Without it, input sent mid-turn is queued
  // and delivered as the next turn's prompt.
  "steering",
  ...(BRIDGE ? ["steering.live", "approvals", "model_switch"] : []),
  "usage",
  "thinking",
  "effort_select",
  ...(MODEL_CATALOG.length > 0 ? ["model_select"] : []),
  "slash",
  "slash.help",
  "slash.approval",
  "todos_read",
  "files_read",
  // session.delete / session.clear / session.delete_all: true purge of the
  // journal, index entry, and the dext seat's own state dirs.
  "session_manage",
  // hello_ok.packs + /pack run|list|create|inspect + GET /packs + packs.changed.
  "packs",
  // x-agentlinkd.pack.{files,file,write}: the pack editor's confined read/write
  // surface (extension allowlist, no dotfiles/symlinks, 256 KB cap).
  "pack_edit",
  // x-agentlinkd.dirs.{list,create} + hello_ok.home: HOME-confined folder
  // browsing so a session can be "a folder" chosen by click, not a typed path.
  "dirs",
  // x-agentlinkd.flows.{list,get,put,delete,compile,run}: the flow builder —
  // flows live in <cwd>/.dext/flows/*.flow.json; runs compile to crew specs.
  "flows",
  // x-agentlinkd.connectors.{list,add,remove,sync,push}: GitHub/git/Drive/
  // Dropbox sources materialised as folders under <home>/Connected via git and
  // rclone; registry + secrets in DEXT_HOME (per user).
  "connectors",
  // x-agentlinkd.auth.{status,login,logout}: provider sign-in through
  // `dext auth login|logout` — dext's auth store is the only credential holder.
  "provider_auth",
  // x-agentlinkd.packs.credentials.set: values for a pack's `credential-env`
  // names, stored under DEXT_HOME (0600) and injected into dext children.
  // Names-only status rides on PackInfo.credentials; values never come back.
  "pack_credentials",
];

// Root of the folder picker — and of every session folder a client may name.
// session.open / session.configure{cwd} accept only what the picker could have
// shown (inside the root, no symlinks on the way, no dot-dirs) plus the host's
// two well-known folders: its boot cwd and the workbench checkout.
const DIRS_ROOT = path.resolve(argValue("dirs-root", process.env.DEXTUI_DIRS_ROOT ?? process.env.HOME ?? process.cwd()));
const CWD_REFUSALS = {
  outside_root: "folder is outside the host's root",
  hidden: "hidden folders are not available",
  refused: "symlinked paths are refused",
  missing: "folder does not exist",
  not_dir: "not a folder",
};
function resolveSessionCwd(requested) {
  if (typeof requested !== "string" || !requested.trim()) return { error: "missing", message: "cwd must be a folder path" };
  const raw = requested.trim();
  // Relative paths are root-relative, exactly as x-agentlinkd.dirs.* takes
  // them; only absolute paths can name a well-known folder.
  if (path.isAbsolute(raw)) {
    const abs = path.resolve(raw);
    const wellKnown = [DEFAULT_CWD, SELF?.enabled ? path.resolve(SELF.status().repo) : null];
    if (wellKnown.includes(abs)) {
      let ok = false;
      try { ok = fs.statSync(abs).isDirectory(); } catch { /* gone */ }
      return ok ? { abs } : { error: "missing", message: `${CWD_REFUSALS.missing}: ${abs}` };
    }
  }
  const c = confine(DIRS_ROOT, raw);
  if (c.error) return { error: c.error, message: `${CWD_REFUSALS[c.error] ?? c.error}: ${path.resolve(DIRS_ROOT, raw)}` };
  return { abs: c.abs };
}
const CONNECTORS = createConnectors({ home: DEXT_HOME, root: DIRS_ROOT, allowLocal: process.env.DEXTUI_CONNECTORS_ALLOW_LOCAL === "1" });

// Host-handled slash commands, advertised in hello_ok so the composer's
// completion menu is driven by the host rather than a client-side guess.
const COMMANDS = [
  { cmd: "/help", desc: "List host commands" },
  { cmd: "/login", desc: "Sign-in help for another device; --show reveals the access code" },
  { cmd: "/approval", desc: `Set dext approval profile (${[...APPROVALS].join("|")}) — next turn` },
];

// Random per process: lets clients tell a reconnect to the same host (resume
// by seq) from a reconnect to a restarted one (resync from snapshot).
const INSTANCE = crypto.randomBytes(8).toString("hex");

// ---------- packs ----------

// Prefer dext's machine-readable catalog (`pack list --json`, dext ≥ the
// packs handoff) and fall back to parsing the verbose text on older binaries.
// Probed once at boot: a fake/old dext that prints text for `--json` still
// gets a catalog. `--gallery=<file>` / DEXTUI_GALLERY curates without code.
function probePackListArgs() {
  const out = dextOutput(["pack", "list", "--json"]);
  return parsePackListingJson(out) ? ["pack", "list", "--json"] : ["pack", "list", "--verbose"];
}
const PACK_LIST_ARGS = probePackListArgs();
const GALLERY = argValue("gallery", process.env.DEXTUI_GALLERY) ? loadGallery(path.resolve(argValue("gallery", process.env.DEXTUI_GALLERY))) : GALLERY_DEFAULTS;

// Boot discovery is sync like models (one extra spawnSync, typically <1 s).
// Refreshes are async and serialized: a sync spawn on the event loop would
// stall every WebSocket client for up to 15 s while dext walks the shelves.
let PACKS = buildCatalog(dextOutput(PACK_LIST_ARGS), { approval: DEFAULT_APPROVAL, gallery: GALLERY });
function refreshPackCredentialEnv() {
  PACK_CRED_ENV = mergedPackCredentialEnv(DEXT_HOME, PACKS);
}
refreshPackCredentialEnv();
/** Catalog as clients see it: names-only credential status per pack. */
function publicPacks() {
  return PACKS.map((p) => (p.credential_env?.length ? { ...p, credentials: packCredentialStatus(DEXT_HOME, p.name, p.credential_env) } : p));
}
let packRefresh = null;
let packRefreshDirty = false;
let packWatchTimer = null;

// crew binary: --crew / CREW_BIN, else the crew pack's own bin/ from the
// catalog (a systemd unit's PATH will not have it), else PATH. Absent → no
// `crew` capability, no crew UI.
function resolveCrew() {
  const explicit = argValue("crew", process.env.CREW_BIN);
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const pack = PACKS.find((p) => p.name === "crew");
  if (pack?.path) {
    const bin = path.join(pack.path, "bin", "crew");
    if (fs.existsSync(bin)) return bin;
  }
  for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
    if (d && fs.existsSync(path.join(d, "crew"))) return path.join(d, "crew");
  }
  return null;
}
const CREW_BIN = resolveCrew();
// hello_ok.crews + x-agentlinkd.crew.{open,close,tail,file,stop,resume}.
if (CREW_BIN) CAPABILITIES.push("crew");
// x-agentlinkd.tasks.* + /task: the shared task workspace (goal, acceptance,
// constraints, links, blockers, verified checks) — one record both the user
// and the agent read/write at <cwd>/.dext/tasks/<name>.task.json.
CAPABILITIES.push("tasks");

function refreshPacks() {
  if (packRefresh) {
    // A change landed while a listing is in flight: run once more afterwards.
    packRefreshDirty = true;
    return packRefresh;
  }
  packRefresh = new Promise((resolve) => {
    execFile(DEXT_BIN, PACK_LIST_ARGS, { env: dextEnv(), timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      packRefresh = null;
      if (err) {
        console.error(`agentlinkd: pack refresh failed: ${err.message}`);
      } else {
        const next = buildCatalog(stdout, { approval: DEFAULT_APPROVAL, gallery: GALLERY });
        const changed = JSON.stringify(next) !== JSON.stringify(PACKS);
        if (changed) {
          PACKS = next;
          refreshPackCredentialEnv();
        }
        if (changed) broadcastControl("packs.changed", { packs: publicPacks(), commands: hostCommands() });
      }
      if (packRefreshDirty) {
        packRefreshDirty = false;
        schedulePackRefresh();
      }
      resolve(PACKS);
    });
  });
  return packRefresh;
}

function schedulePackRefresh() {
  clearTimeout(packWatchTimer);
  packWatchTimer = setTimeout(() => void refreshPacks(), 500);
}

// Watch every root dext reads packs from. Recursive fs.watch is native on
// Linux (Node 20+) and macOS; on platforms without it we fall back to the
// slash-command-driven refresh (create/inspect/run all re-list afterwards).
function watchPackRoots() {
  const home = process.env.DEXT_HOME ? path.resolve(process.env.DEXT_HOME) : path.join(process.env.HOME ?? "", ".dext");
  const roots = [path.join(home, "shelves"), path.join(home, "packs"), path.join(DEFAULT_CWD, ".dext", "shelves"), path.join(DEFAULT_CWD, ".dext", "packs")];
  for (const root of roots) {
    try {
      if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) continue;
      const w = fs.watch(root, { recursive: true, persistent: false }, () => schedulePackRefresh());
      w.on("error", () => {});
    } catch (err) {
      console.error(`agentlinkd: not watching ${root}: ${err.message}`);
    }
  }
}

function packByName(name) {
  return typeof name === "string" && PACK_NAME_RE.test(name) ? PACKS.find((p) => p.name === name) ?? null : null;
}

/** Curated-then-alphabetical, exactly what clients see in hello_ok. */
function hostCommands() {
  return [...COMMANDS, ...packCommands(PACKS)];
}

// ---------- state ----------

let clientCounter = 0;
const sessions = new Map();
const clients = new Set();

// ---------- crew ----------

// Assigned below (self-edit section); crew's constructor scans synchronously
// and may fire onChanged before the adapter exists.
let SELF = null;

// Runs are global (detached, cwd-keyed), so the adapter lives beside the pack
// catalog rather than inside any session. Roots: crew's home runs dir plus
// every project's `.crew/runs` (the default cwd now, session cwds as they open).
const CREW = CREW_BIN
  ? createCrewAdapter({
      roots: [path.join(DEXT_HOME, "crew", "runs"), path.join(DEFAULT_CWD, ".crew", "runs")],
      crewBin: CREW_BIN,
      dextBin: DEXT_BIN,
      onChanged: (payload) => {
        broadcastControl("x-agentlinkd.crew.changed", payload);
        SELF?.tick();
      },
      onRunChanged: (id, detail) => {
        for (const c of clients) if (c.phase === "live" && c.crewOpen.has(id)) sendControl(c, "x-agentlinkd.crew.run", detail);
      },
      isOpen: (id) => [...clients].some((c) => c.phase === "live" && c.crewOpen.has(id)),
      log: (m) => console.error(`agentlinkd: ${m}`),
    })
  : null;

function crewRootFor(cwd) {
  if (CREW && typeof cwd === "string" && cwd) CREW.addRoot(path.join(cwd, ".crew", "runs"));
  if (TRIGGERS && typeof cwd === "string" && cwd) TRIGGERS.addWorkspace(cwd);
  if (TASKS && typeof cwd === "string" && cwd) TASKS.ensureWatch(cwd);
}

// ---------- triggers (what starts a flow besides a click) ----------

// Declared with `let` for the same reason as SELF: crew's constructor fires
// onChanged synchronously and crewRootFor runs before this is assigned.
let TRIGGERS = null;
TRIGGERS = createScheduler({
  stateDir: STATE_DIR,
  secret: TOKEN,
  startRun: (cwd, name, opts) => startFlowRun(cwd, name, opts),
  meshBin: (() => { const p = PACKS.find((x) => x.name === "mesh"); const b = p?.path ? path.join(p.path, "bin", "mesh") : null; return b && fs.existsSync(b) ? b : "mesh"; })(),
  log: (m) => console.error(`agentlinkd: ${m}`),
  broadcast: (event, data) => broadcastControl(event, data),
});

// ---------- shared tasks ----------

// Declared with `let` for the same reason as TRIGGERS (broadcastControl runs
// before this point during adapter construction is fine — it only sends to
// live clients, of which there are none at boot).
let TASKS = null;
TASKS = createTasksAdapter({
  broadcast: (event, data) => broadcastControl(event, data),
  log: (m) => console.error(`agentlinkd: tasks: ${m}`),
});
COMMANDS.push({ cmd: "/task", desc: "Shared tasks: list | show <name> | new <name> <goal> | set <name> field=value | check <name> ok|fail <what>" });

// ---------- self-edit ----------

// DextUI editing itself: staged UI builds with LKG rollback, restart-when-idle,
// and detection of rebuilds the agent performed from a workbench session.
// Only advertised when this host runs from a buildable checkout.
function hostIdle() {
  return busyDetail().length === 0;
}
function busyDetail() {
  const out = [];
  for (const s of sessions.values()) if (s.working) out.push({ kind: "turn", session: s.id, title: s.title.slice(0, 40) });
  if (CREW) for (const r of CREW.summaries().runs) if (r.status === "running" || r.status === "pending") out.push({ kind: "crew", run: r.id });
  return out;
}
SELF = createSelfEdit({
  repoRoot,
  stateDir: STATE_DIR,
  staticDir: STATIC_DIR,
  broadcast: (event, data) => broadcastControl(event, data),
  isIdle: hostIdle,
  busyDetail,
  onRestart: (code) => restartHost(code),
  log: (m) => console.error(`agentlinkd: self-edit: ${m}`),
});
// hello_ok.self + x-agentlinkd.ui.{build,rollback,status} + x-agentlinkd.host.{restart,restart_cancel} + /ui + GET /__self.
if (SELF.enabled) {
  CAPABILITIES.push("self_edit");
  COMMANDS.push({ cmd: "/ui", desc: "Self-edit: status | build [--tests] | rollback | restart [why] | cancel" });
}

function restartHost(code) {
  shuttingDown = true;
  server.close();
  for (const s of sessions.values()) killChild(s);
  persistIndex(true);
  setTimeout(() => process.exit(code), 300);
}

async function handleCrewCommand(client, frame) {
  const verb = frame.cmd.slice("x-agentlinkd.crew.".length);
  if (!CREW) {
    sendError(client, "unsupported", "host has no crew binary");
    return;
  }
  const run = typeof frame.run === "string" && CREW_RUN_ID_RE.test(frame.run) ? frame.run : null;
  if (!run && verb !== "clear") {
    sendError(client, "bad_request", "run must match run-<12 hex>");
    return;
  }
  switch (verb) {
    case "open": {
      const detail = CREW.detail(run);
      if (!detail) return sendError(client, "no_run", `unknown run ${run}`);
      client.crewOpen.add(run);
      sendControl(client, "x-agentlinkd.crew.run", detail);
      return;
    }
    case "close":
      client.crewOpen.delete(run);
      return;
    case "tail": {
      const r = CREW.tail(run, frame.worker, Number(frame.lines) || TAIL_MAX_LINES);
      if (r.error) return sendError(client, r.error, `no log for ${run}/${String(frame.worker)}`);
      sendControl(client, "x-agentlinkd.crew.tail", r);
      return;
    }
    case "file": {
      const r = CREW.file(run, frame.path);
      if (r.error) return sendError(client, r.error, `cannot read ${String(frame.path)} in ${run}`);
      sendControl(client, "x-agentlinkd.crew.file", r);
      return;
    }
    case "stop": {
      const r = await CREW.stop(run);
      broadcastControl("x-agentlinkd.crew.control", { run, verb: "stop", ok: r.ok, by: client.id, message: r.message });
      return;
    }
    case "resume": {
      const answer = typeof frame.answer === "string" ? frame.answer.trim() : "";
      if (!answer || answer.length > 20_000) return sendError(client, "bad_request", "answer must be 1..20000 chars");
      const r = await CREW.resume(run, answer);
      if (!r.ok) return sendError(client, r.code ?? "crew_failed", r.message);
      broadcastControl("x-agentlinkd.crew.control", { run, verb: "resume", ok: true, by: client.id, message: r.message });
      return;
    }
    case "remove": {
      const r = CREW.remove(run);
      broadcastControl("x-agentlinkd.crew.control", { run, verb: "remove", ok: r.ok, by: client.id, message: r.message });
      return;
    }
    case "clear": {
      const r = CREW.clearFinished();
      broadcastControl("x-agentlinkd.crew.control", { verb: "clear", ok: r.ok, by: client.id, removed: r.removed, message: r.message });
      return;
    }
    default:
      sendError(client, "unknown_command", `unsupported cmd ${frame.cmd}`);
  }
}

// ---------- pack file editing ----------

// The pack editor's confined surface: everything routes through packs.mjs
// (extension allowlist, no dotfiles, symlink refusal, size cap) against the
// catalog's own resolved pack dirs — clients never supply absolute paths.
function handlePackFileCommand(client, frame) {
  const verb = frame.cmd.slice("x-agentlinkd.pack.".length);
  const pack = packByName(frame.pack);
  if (!pack) return sendError(client, "unknown_pack", `unknown pack ${String(frame.pack)}`, frame.cmd);
  switch (verb) {
    case "files":
      sendControl(client, "x-agentlinkd.pack.files", { pack: pack.name, files: listPackTree(pack.path) });
      return;
    case "file": {
      const r = readPackFile(pack.path, frame.path);
      if (r.error) return sendError(client, r.error, `cannot read ${String(frame.path)} in ${pack.name}: ${r.error}`, frame.cmd);
      sendControl(client, "x-agentlinkd.pack.file", { pack: pack.name, ...r });
      return;
    }
    case "write": {
      const r = writePackFile(pack.path, frame.path, frame.text);
      if (r.error) return sendError(client, r.error, `cannot write ${String(frame.path)} in ${pack.name}: ${r.error}`, frame.cmd);
      // Catalog refresh: PACK.md edits change ui-* front matter and commands.
      schedulePackRefresh();
      console.error(`agentlinkd: pack write ${pack.name}/${r.path} (${r.bytes}B) by client ${client.id}`);
      sendControl(client, "x-agentlinkd.pack.write", { pack: pack.name, path: r.path, bytes: r.bytes });
      return;
    }
    default:
      sendError(client, "unknown_command", `unsupported cmd ${frame.cmd}`, frame.cmd);
  }
}

function makeSession({ cwd, approval }) {
  // Never reuse a deleted id after restart (old tabs may still hold drafts).
  const id = `sess_${BigInt(`0x${crypto.randomBytes(12).toString("hex")}`)}`;
  const s = {
    id,
    title: "New session",
    cwd,
    approval,
    provider: DEFAULT_MODEL.provider ?? null,
    model: DEFAULT_MODEL.model ?? null,
    thinkingEffort: "medium",
    modelLocked: false,
    seat: `dextui-${crypto.randomBytes(4).toString("hex")}`,
    status: "live",
    working: false,
    turnStartedAt: null,
    createdAt: Date.now(),
    seq: 0,
    journal: [],
    pending: new Map(), // always empty: approvals live in dext's own policy
    steeringQueue: [],
    turns: 0,
    child: null,
    // Bridge mode: the persistent ndjson child and the approval it is blocked on.
    bridge: null,
    pendingPermission: null,
    dextSessionId: null,
    killed: false,
    indexEntry: null,
    // Bumped by session.clear so a turn already in flight cannot journal its
    // tail into the fresh transcript; deleted sessions never journal again.
    epoch: 0,
    deleted: false,
  };
  sessions.set(id, s);
  persistIndex();
  crewRootFor(cwd);
  return s;
}

// ---------- durable state (--state-dir) ----------

// Fail closed on symlinks anywhere under the state dir: a swapped link would
// redirect private journal/index writes outside the operator's 0700 tree.
function lstatChecked(p, what) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (st.isSymbolicLink()) throw new Error(`${what} is a symlink, refusing: ${p}`);
  return st;
}

function journalFile(s) {
  return path.join(JOURNALS_DIR, `${s.id}.jsonl`);
}

function appendJournalLine(s, env) {
  if (s.deleted) return; // a purged journal must never be recreated by a late child
  try {
    lstatChecked(journalFile(s), "journal file");
    fs.appendFileSync(journalFile(s), `${JSON.stringify(env)}\n`, { mode: 0o600 });
  } catch (err) {
    // The live stream stays authoritative; durability degrades loudly, not silently.
    console.error(`agentlinkd: journal append failed for ${s.id}: ${err.message}`);
  }
}

function indexEntryOf(s) {
  const tail = s.journal[s.journal.length - 1];
  return {
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    approval: s.approval,
    provider: s.provider,
    model: s.model,
    thinkingEffort: s.thinkingEffort,
    modelLocked: s.modelLocked,
    seat: s.seat,
    generation: s.generation ?? 0,
    ...(s.moved ? { moved: true } : {}),
    ...(s.cleanup ? { cleanup: s.cleanup } : {}),
    ...(s.steeringQueue.length > 0 ? { steeringQueue: [...s.steeringQueue] } : {}),
    turns: s.turns,
    createdAt: s.createdAt,
    updatedAt: tail?.ts ?? s.createdAt,
  };
}

// Rewrites sessions.json only when one of its fields actually changed; the
// tmp+rename swap keeps readers from ever seeing a torn index. `force` covers
// removals, which the per-session dirty check cannot observe.
function persistIndex(force = false, strict = false) {
  const entries = [...sessions.values()].map(indexEntryOf);
  if (!force && [...sessions.values()].every((s, i) => s.indexEntry === JSON.stringify(entries[i]))) return;
  try {
    checkedPath(INDEX_PATH);
    const tmp = `${INDEX_PATH}.tmp`;
    checkedPath(tmp);
    fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, INDEX_PATH);
    for (const s of sessions.values()) s.indexEntry = JSON.stringify(indexEntryOf(s));
  } catch (err) {
    if (strict) throw err;
    console.error(`agentlinkd: session index write failed: ${err.message}`);
  }
}

function initStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const st = lstatChecked(STATE_DIR, "state dir");
  if (!st?.isDirectory()) throw new Error(`--state-dir is not a directory: ${STATE_DIR}`);
  fs.mkdirSync(JOURNALS_DIR, { recursive: true, mode: 0o700 });
  const jst = lstatChecked(JOURNALS_DIR, "journals dir");
  if (!jst?.isDirectory()) throw new Error(`journals dir is not a directory: ${JOURNALS_DIR}`);
}

function restoreJournal(s) {
  const file = journalFile(s);
  let st;
  try {
    st = lstatChecked(file, "journal file");
  } catch (err) {
    console.error(`agentlinkd: journal for ${s.id} rejected: ${err.message}`);
    return;
  }
  if (!st?.isFile()) return; // missing file: seq stays 0 with an empty journal
  let buf = fs.readFileSync(file);
  if (buf.length > JOURNAL_TRUNCATE_BYTES) {
    const keep = buf.subarray(buf.length - JOURNAL_TRUNCATE_BYTES);
    const nl = keep.indexOf("\n");
    const trimmed = nl >= 0 ? keep.subarray(nl + 1) : Buffer.alloc(0);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, trimmed, { mode: 0o600 });
    fs.renameSync(tmp, file);
    console.error(
      `agentlinkd: journal for ${s.id} exceeded ${JOURNAL_TRUNCATE_BYTES} bytes; truncated to the last ${JOURNAL_TRUNCATE_BYTES} bytes at a line boundary`,
    );
    buf = trimmed;
  }
  if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) {
    // Torn final line: fence it off so the next append cannot merge into it.
    try {
      fs.appendFileSync(file, "\n", { mode: 0o600 });
    } catch {
      /* read-only media; parsing below already skips the partial line */
    }
  }
  for (const line of buf.toString("utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let env;
    try {
      env = JSON.parse(t);
    } catch {
      continue; // skip malformed lines
    }
    if (!env || typeof env !== "object" || typeof env.event !== "string" || !Number.isInteger(env.seq)) continue;
    s.journal.push(env);
    if (env.seq > s.seq) s.seq = env.seq;
  }
}

// A host that died mid-turn leaves the last turn unterminated: the snapshot
// fold would render a streaming block forever with failed:false, and the
// client only heals it on the next turn_end. Terminate it in the journal so
// every consumer sees one consistent story.
function terminateUnfinishedTurn(s) {
  let open = false;
  for (const env of s.journal) {
    if (env.event === "user_message" || env.event === "turn_start") open = true;
    else if (env.event === "turn_end" || env.event === "interrupted") open = false;
  }
  if (!open) return;
  journalData(s, "error", "turn lost: agentlinkd restarted while dext was running");
  journalData(s, "turn_end", { usage: zeroUsage(), failed: true });
  console.error(`agentlinkd: ${s.id} had an unfinished turn at restart; journaled as failed`);
}

// Boot: load sessions.json, bring every session back cold, replay journals,
// and retry unfinished cleanup intents after the entire index is loaded.
function restoreSessions() {
  let entries = [];
  const st = lstatChecked(INDEX_PATH, "session index");
  if (st?.isFile()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
      if (Array.isArray(parsed)) entries = parsed;
      else console.error("agentlinkd: sessions.json is not an array; starting with no restored sessions");
    } catch (err) {
      console.error(`agentlinkd: sessions.json unreadable (${err.message}); starting with no restored sessions`);
    }
  }
  for (const e of entries) {
    if (!e || typeof e !== "object" || typeof e.id !== "string" || !/^sess_\d+$/.test(e.id)) continue;
    if (sessions.has(e.id)) continue;
    const s = {
      id: e.id,
      title: typeof e.title === "string" && e.title ? e.title : "New session",
      cwd: typeof e.cwd === "string" && e.cwd ? e.cwd : DEFAULT_CWD,
      approval: APPROVALS.has(e.approval) ? e.approval : DEFAULT_APPROVAL,
      provider: typeof e.provider === "string" ? e.provider : null,
      model: typeof e.model === "string" ? e.model : null,
      thinkingEffort: EFFORTS.has(e.thinkingEffort) ? e.thinkingEffort : "medium",
      modelLocked: !!e.modelLocked,
      seat: typeof e.seat === "string" && e.seat ? e.seat : `dextui-${crypto.randomBytes(4).toString("hex")}`,
      moved: e.moved === true,
      steeringQueue: Array.isArray(e.steeringQueue)
        ? e.steeringQueue
            .filter((t) => typeof t === "string" && t.length > 0 && t.length <= STEERING_MAX_CHARS)
            .slice(0, STEERING_MAX_MESSAGES)
        : [],
      status: "cold",
      working: false,
      turnStartedAt: null,
      createdAt: Number.isInteger(e.createdAt) ? e.createdAt : Date.now(),
      seq: 0,
      journal: [],
      pending: new Map(), // always empty: approvals live in dext's own policy
      turns: Number.isInteger(e.turns) && e.turns >= 0 ? e.turns : 0,
      child: null,
      killed: false,
      indexEntry: null,
      epoch: 0,
      deleted: false,
      generation: Number.isSafeInteger(e.generation) ? e.generation : 0,
      cleanup: e.cleanup?.action === "delete" || e.cleanup?.action === "clear" ? e.cleanup : null,
    };
    sessions.set(s.id, s);
    restoreJournal(s);
    crewRootFor(s.cwd);
    if (!s.cleanup) terminateUnfinishedTurn(s);
    s.indexEntry = JSON.stringify(indexEntryOf(s));
  }
  // Load the entire index BEFORE completing intents (completion rewrites it).
  for (const s of [...sessions.values()]) {
    if (!s.cleanup) continue;
    try { finishCleanup(s); } catch (err) {
      console.error(`agentlinkd: pending ${s.cleanup?.action} for ${s.id} failed; retry from UI: ${err.message}`);
    }
  }
  if (sessions.size > 0) console.error(`agentlinkd: restored ${sessions.size} session(s) cold from ${STATE_DIR}`);
}

// ---------- journal + publish ----------

function journalData(s, event, data) {
  const env = { v: 1, session: s.id, seq: ++s.seq, ts: Date.now(), event };
  if (data !== undefined) env.data = data;
  s.journal.push(env);
  appendJournalLine(s, env);
  return env;
}

function metaOf(s) {
  return {
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    generation: s.generation ?? 0,
    agent: { name: "dext", version: "cli" },
    model: s.model ?? undefined,
    provider: s.provider ?? undefined,
    thinking_effort: s.thinkingEffort,
    model_locked: s.modelLocked,
    approval_profile: s.approval,
    status: s.status,
    created_at: s.createdAt,
    updated_at: s.journal.length > 0 ? s.journal[s.journal.length - 1].ts : s.createdAt,
    last_seq: s.seq,
    unread: 0,
    pending_permissions: 0,
  };
}

let listTimer = null;
function scheduleList() {
  if (listTimer) return;
  listTimer = setTimeout(() => {
    listTimer = null;
    const msg = JSON.stringify({
      v: 1,
      ts: Date.now(),
      event: "session.list",
      data: { sessions: [...sessions.values()].map(metaOf) },
    });
    for (const c of clients) if (c.phase === "live") c.send(msg);
  }, 60);
}

function publish(env) {
  const line = JSON.stringify(env);
  for (const c of clients) if (c.phase === "live" && c.subs.has(env.session)) c.send(line);
  scheduleList();
}

function snapshotEnvelope(s) {
  // Snapshot is a point-in-time projection at the current journal tail. It
  // MUST NOT consume a new seq: it is sent to one subscriber, so incrementing
  // would create an invisible gap for every other subscriber.
  const meta = foldMeta(s.journal);
  return {
    v: 1,
    session: s.id,
    seq: s.seq,
    ts: Date.now(),
    event: "session.snapshot",
    data: {
      meta: metaOf(s),
      blocks: fold(s.journal),
      pending_permissions: s.pendingPermission ? [s.pendingPermission] : [],
      last_seq: s.seq,
      working: s.working,
      turn_started_at: s.turnStartedAt ?? undefined,
      turn_usage: meta.turnUsage,
      session_usage: meta.sessionUsage,
      context_chars: meta.contextChars,
      diagnostics: meta.diagnostics,
      compacting: meta.compacting,
      failed: meta.failed,
      provider: s.provider ?? undefined,
      thinking_effort: s.thinkingEffort,
      model_locked: s.modelLocked,
    },
  };
}

// ---------- turn engine: one dext child per prompt ----------

function zeroUsage() {
  return { input: 0, output: 0, cache_create: 0, cache_read: 0, cost_usd: 0 };
}

// ---------- turn engine (bridge): one persistent dext child per session ----------

/** What `--resume` should replay. dext's seat records are project-scoped
 *  (<project of cwd>/seats/<seat>), so after a folder change the bare flag
 *  would find no seat in the new project and the child would exit 1. The
 *  host locates the seat's newest session by its header (any project) and
 *  resumes that path explicitly; dext then records the seat in the new
 *  project, so plain `--resume` would work again from the next turn on. */
function resumeTarget(s) {
  if (s.turns <= 0) return false;
  if (!s.moved) return true;
  return findDextSessionDir(s) ?? true;
}

function bridgeEnv(s) {
  const env = dextEnv();
  if (s.provider && s.model) {
    env.DEXT_PROVIDER = s.provider;
    env.DEXT_MODEL = s.model;
    env.DEXT_MODEL_FORCE = "1";
  }
  return env;
}

/** Spawn (or reuse) this session's bridged child. Resolves once dext is ready. */
function ensureBridge(s) {
  if (s.bridge && !s.bridge.exited) return s.bridge.whenReady().then(() => s.bridge);
  const epoch = s.epoch;
  let errTail = "";
  const args = bridgeArgs({ cwd: s.cwd, approval: s.approval, effort: s.thinkingEffort, seat: s.seat, resume: resumeTarget(s) });
  let bridge;
  const onEvent = (v) => {
    if (s.deleted || s.epoch !== epoch || s.bridge !== bridge) return;
    handleBridgeEvent(s, v);
  };
  const onExit = (code, sig) => {
    if (s.bridge === bridge) s.bridge = null;
    if (s.child === bridge?.child) s.child = null;
    if (s.deleted || s.epoch !== epoch) return;
    if (s.pendingPermission) {
      publish(journalData(s, "permission.resolved", { request_id: s.pendingPermission.request_id, choice: "deny", by: "exit" }));
      s.pendingPermission = null;
    }
    if (s.working && bridge.turnSeq === s.turnSeq) {
      // Only the bridge that owns the latest dispatched turn may fail it. A
      // recycled child exiting while its replacement already carries the next
      // prompt is expected turnover, not a failed turn.
      if (s.killed) publish(journalData(s, "interrupted"));
      else {
        const detail = errTail.trim().split("\n").slice(-3).join(" · ").slice(-400);
        publish(journalData(s, "error", `dext exited (code ${code ?? sig})${detail ? `: ${detail}` : ""}`));
      }
      publish(journalData(s, "turn_end", { usage: zeroUsage(), failed: !s.killed }));
      s.working = false;
      s.turnStartedAt = null;
    } else if (!s.killed && !bridge?.ready) {
      const detail = errTail.trim().split("\n").slice(-3).join(" · ").slice(-400);
      publish(journalData(s, "error", `dext failed to start (code ${code ?? sig})${detail ? `: ${detail}` : ""}`));
    }
    s.killed = false;
    persistIndex();
    scheduleList();
    SELF.tick();
  };
  try {
    bridge = spawnBridge({
      bin: DEXT_BIN,
      args,
      cwd: s.cwd,
      env: bridgeEnv(s),
      maxBuffer: MAX_STDOUT_BUFFER,
      onEvent,
      onNoise: (line) => { errTail = (errTail + `[stdout] ${line}\n`).slice(-2000); },
      onStderr: (text) => { errTail = (errTail + text).slice(-2000); },
      onExit,
    });
  } catch (err) {
    return Promise.reject(new Error(`failed to spawn dext (${DEXT_BIN}): ${String(err)}`));
  }
  s.bridge = bridge;
  s.child = bridge.child; // stopForPurge / signalChild keep working unchanged
  return bridge.whenReady().then(() => bridge);
}

/** Core event → journal. Turn/permission bookkeeping lives here in bridge mode. */
function handleBridgeEvent(s, v) {
  const d = v.data;
  switch (v.event) {
    case "ready":
      if (d && typeof d.session_id === "string") s.dextSessionId = d.session_id;
      if (d && typeof d.model === "string") s.model = d.model;
      if (d && typeof d.provider === "string") s.provider = d.provider;
      persistIndex();
      return;
    case "input_ack":
      // Withheld/invalid frames are the only acks worth showing.
      if (d && (d.route === "withheld" || d.route === "invalid" || d.route === "unsupported_busy_slash")) {
        publish(journalData(s, "warn", `input ${d.route}${d.detail ? `: ${d.detail}` : ""}`));
      }
      return;
    case "turn_start":
      s.working = true;
      s.turnStartedAt = Date.now();
      break;
    case "turn_end":
      s.working = false;
      s.turnStartedAt = null;
      s.turns += 1;
      publish(journalData(s, "session.configured", {
        provider: s.provider ?? undefined,
        model: s.model ?? undefined,
        thinking_effort: s.thinkingEffort,
        model_locked: false,
      }));
      publish(journalData(s, "turn_end", d));
      persistIndex();
      // Deferred restart (/approval during a live turn) lands here so the new
      // profile applies to the very next spawn, not "whenever the child dies".
      if (s.recycleOnTurnEnd) {
        s.recycleOnTurnEnd = false;
        recycleBridge(s);
      }
      // Turn boundary: queued steering auto-starts the next turn (parity with
      // the one-shot engine). Skipped when closed or interrupted; the queue
      // survives for the next prompt instead.
      if (s.status === "live" && !s.killed && s.steeringQueue.length > 0) {
        const text = s.steeringQueue.join("\n\n");
        s.steeringQueue = [];
        persistIndex();
        publish(journalData(s, "user_message", { text }));
        runBridgedTurn(s, text);
        return;
      }
      scheduleList();
      SELF.tick();
      return;
    case "turn_diagnostics":
      if (d) {
        if (typeof d.model === "string") s.model = d.model;
        if (typeof d.provider === "string") s.provider = d.provider;
      }
      break;
    case "thinking_effort_changed":
      if (EFFORTS.has(d?.effort)) s.thinkingEffort = d.effort;
      break;
    case "steering_received":
      // The host already journaled steering_received as the immediate ack;
      // dext's own event marks the fold into the model request.
      publish(journalData(s, "steering_applied", d));
      return;
    case "permission_request": {
      const req = toPermissionRequest(d ?? {});
      s.pendingPermission = req;
      publish(journalData(s, "permission.request", req));
      return;
    }
    case "permission_resolved": {
      const id = String(d?.id ?? "");
      // dext's event carries no resolver (patch 0003: {id, tool, choice}), so
      // an unanswered request means core resolved it itself — profile default
      // or its own deadline — not necessarily a timeout.
      const by = s.pendingPermission?.answeredBy ?? "core";
      if (s.pendingPermission?.request_id === id) s.pendingPermission = null;
      publish(journalData(s, "permission.resolved", { request_id: id, choice: d?.choice ?? "deny", by }));
      return;
    }
    case "tool_call_result":
      if (d?.name === "todo_write") {
        publish(journalData(s, v.event, d));
        publish(journalData(s, "todos.changed", todosFor(s)));
        return;
      }
      break;
    default:
      break;
  }
  publish(journalData(s, v.event, d));
}

/** A pack run starting with none of its declared credentials stored: say so
 *  up front, in the same event dext uses when a tool asks (so the client's
 *  "Provide credentials…" action applies), instead of letting the agent burn
 *  a turn discovering it. Partial sets are the pack's business (cookie vs
 *  OAuth groups); only "nothing at all" is flagged. */
function warnMissingPackCredentials(s, packRun) {
  const pack = packRun?.sub === "run" ? packByName(packRun.name) : null;
  if (!pack?.credential_env?.length) return;
  const status = packCredentialStatus(DEXT_HOME, pack.name, pack.credential_env);
  if (status.set.length > 0) return;
  publish(journalData(s, "local_auth_prompt", {
    tool: pack.name,
    message: `this pack uses ${status.missing.join(", ")} and none are set — provide them once (they never enter the chat), or the run may fail at the first call.`,
  }));
}

function runBridgedTurn(s, prompt) {
  s.working = true; // optimistic: Send disables at once; turn_start confirms
  s.turnStartedAt = Date.now();
  s.killed = false;
  const packRun = parsePackSlash(prompt);
  const text = packRun?.sub === "run" && packByName(packRun.name) ? `/pack run ${packRun.name} ${packRun.task}` : prompt;
  warnMissingPackCredentials(s, packRun);
  ensureBridge(s).then((bridge) => {
    if (s.deleted) return;
    // Ownership stamp: onExit only fails a turn whose bridge carried it.
    s.turnSeq = (s.turnSeq ?? 0) + 1;
    bridge.turnSeq = s.turnSeq;
    if (!bridge.user(text)) throw new Error("dext stdin closed");
  }).catch((err) => {
    if (s.deleted) return;
    publish(journalData(s, "error", String(err?.message ?? err)));
    publish(journalData(s, "turn_end", { usage: zeroUsage(), failed: true }));
    s.working = false;
    s.turnStartedAt = null;
    persistIndex();
    scheduleList();
    SELF.tick();
  });
}

/** Stop the bridged child so the next turn respawns with new env/args (model,
 *  approval). Only between turns; the seat + session_id make it seamless. */
function recycleBridge(s) {
  const bridge = s.bridge;
  if (!bridge || bridge.exited) return;
  s.bridge = null;
  bridge.close();
  setTimeout(() => { if (!bridge.exited) bridge.kill("SIGKILL"); }, 5000);
}

// ---------- turn engine (fallback): one dext child per prompt ----------

function runTurn(s, prompt) {
  if (BRIDGE) return runBridgedTurn(s, prompt);
  s.working = true;
  s.turnStartedAt = Date.now();
  s.killed = false;
  const epoch = s.epoch;
  let sawTurnEnd = false;
  let turnEndData;
  let finished = false;
  let buf = "";
  let errTail = "";

  const args = [
    "-p",
    "--output",
    "stream-json",
    "--cd",
    s.cwd,
    "--approval",
    s.approval,
    "--effort",
    s.thinkingEffort,
    "--seat",
    s.seat,
  ];
  // `/pack run <name> <task>` (typed, queued as steering, or from the gallery)
  // becomes an explicit `--pack` invocation; only the task travels on stdin.
  // The name was validated against the catalog before the prompt was journaled.
  const packRun = parsePackSlash(prompt);
  let stdinText = prompt;
  if (packRun?.sub === "run" && packByName(packRun.name)) {
    args.push("--pack", packRun.name);
    stdinText = packRun.task;
  }
  warnMissingPackCredentials(s, packRun);
  const resume = resumeTarget(s);
  if (typeof resume === "string") args.push(`--resume=${resume}`);
  else if (resume) args.push("--resume");
  const childEnv = dextEnv();
  if (s.provider && s.model) {
    childEnv.DEXT_PROVIDER = s.provider;
    childEnv.DEXT_MODEL = s.model;
    childEnv.DEXT_MODEL_FORCE = "1";
  }

  let child;
  try {
    child = spawn(DEXT_BIN, args, {
      cwd: s.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      // A process group lets interrupt stop dext and any tool descendants.
      detached: process.platform !== "win32",
    });
  } catch (err) {
    publish(journalData(s, "error", `failed to spawn dext (${DEXT_BIN}): ${String(err)}`));
    publish(journalData(s, "turn_end", { usage: zeroUsage(), failed: true }));
    s.working = false;
    s.turnStartedAt = null;
    return;
  }
  s.child = child;
  // A failed spawn (ENOENT etc.) destroys stdin and emits an async stream
  // error; without a listener that unhandled error would crash the server.
  child.stdin.on("error", () => {});
  child.stdin.write(stdinText);
  child.stdin.end();

  const handleLine = (line) => {
    const t = line.trim();
    if (!t) return;
    if (s.deleted || s.epoch !== epoch) return; // purged/cleared under this turn
    let v;
    try {
      v = JSON.parse(t);
    } catch {
      return; // non-event noise on stdout
    }
    if (typeof v.event !== "string") return;
    if (v.event === "turn_end") {
      // Hold the terminal event until the child is actually closed. Otherwise
      // the UI enables Send while the host still rejects the next prompt busy.
      sawTurnEnd = true;
      turnEndData = v.data;
      return;
    }
    if (v.event === "turn_diagnostics" && v.data) {
      if (typeof v.data.model === "string") s.model = v.data.model;
      if (typeof v.data.provider === "string") s.provider = v.data.provider;
    }
    if (v.event === "thinking_effort_changed" && EFFORTS.has(v.data?.effort)) {
      s.thinkingEffort = v.data.effort;
    }
    publish(journalData(s, v.event, v.data));
  };

  // Idempotent: normally driven by 'close'; the spawn-error path schedules a
  // fallback because a failed spawn is not guaranteed to emit 'close'.
  const finalize = (code) => {
    if (finished) return;
    finished = true;
    if (s.child === child) s.child = null;
    // The session was deleted or cleared while this child ran: its tail
    // belongs to a transcript that no longer exists.
    if (s.deleted || s.epoch !== epoch) return;
    if (buf.trim()) {
      handleLine(buf);
      buf = "";
    }
    if (!sawTurnEnd) {
      if (s.killed) {
        publish(journalData(s, "interrupted"));
      } else {
        const detail = errTail.trim().split("\n").slice(-3).join(" · ").slice(-400);
        publish(journalData(s, "error", `dext exited (code ${code})${detail ? `: ${detail}` : ""}`));
        publish(journalData(s, "turn_end", { usage: zeroUsage(), failed: true }));
      }
    }
    s.working = false;
    s.turnStartedAt = null;
    // Only arm --resume after a protocol-complete turn. A child that emitted
    // turn_start and then crashed may not have persisted a resumable seat.
    if (sawTurnEnd) {
      s.turns += 1;
      s.modelLocked = !BRIDGE;
      publish(journalData(s, "session.configured", {
        provider: s.provider ?? undefined,
        model: s.model ?? undefined,
        thinking_effort: s.thinkingEffort,
        model_locked: !BRIDGE,
      }));
      publish(journalData(s, "turn_end", turnEndData));
    }
    // Turn boundary: queued steering auto-starts the next turn — the user
    // never has to stop the session to be heard. Skipped when the session was
    // closed or the turn was interrupted; the queue survives for the next
    // prompt instead.
    if (sawTurnEnd && s.status === "live" && !s.killed && s.steeringQueue.length > 0) {
      const text = s.steeringQueue.join("\n\n");
      s.steeringQueue = [];
      persistIndex();
      publish(journalData(s, "user_message", { text }));
      runTurn(s, text);
      return;
    }
    persistIndex();
    scheduleList();
    // Idle boundary: a restart requested mid-turn (by a human, or by the agent
    // editing the host from a workbench session) is honored here.
    SELF.tick();
  };

  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    if (buf.length > MAX_STDOUT_BUFFER) {
      errTail = `dext emitted more than ${MAX_STDOUT_BUFFER} bytes without a newline`;
      buf = ""; // never hand the oversized fragment to finalize's handleLine
      killChild(s, false);
      return;
    }
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      handleLine(line);
    }
  });

  child.stderr.on("data", (d) => {
    errTail = (errTail + d.toString("utf8")).slice(-2000);
  });

  child.on("error", (err) => {
    // Let finalize emit the one canonical error marker; publishing here as
    // well produced duplicate errors for every failed spawn.
    errTail = String(err);
    setTimeout(() => finalize(null), 1000);
  });

  child.on("close", (code) => finalize(code));
}

/** SIGINT the entire process group, with SIGKILL escalation if it lingers. */
function signalChild(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The group may already be gone; direct-child fallback handles races.
    try {
      child.kill(signal);
    } catch {
      /* gone */
    }
  }
}

function killChild(s, interrupted = true) {
  if (s.bridge && !s.bridge.exited) {
    const bridge = s.bridge;
    s.killed = interrupted;
    if (interrupted && s.working) {
      // Real interrupt: dext stops the turn and stays alive for the next one.
      bridge.interrupt();
      setTimeout(() => { if (s.working && s.bridge === bridge) bridge.kill("SIGINT"); }, 3000);
      setTimeout(() => { if (s.working && s.bridge === bridge) bridge.kill("SIGKILL"); }, 8000);
      return;
    }
    s.bridge = null;
    bridge.close();
    setTimeout(() => { if (!bridge.exited) bridge.kill("SIGKILL"); }, 5000);
    return;
  }
  const child = s.child;
  if (!child) return;
  s.killed = interrupted;
  signalChild(child, "SIGINT");
  setTimeout(() => {
    if (s.child === child) signalChild(child, "SIGKILL");
  }, 5000);
}

// Mid-turn steering: one-shot dext children have no live stdin, so input that
// arrives while a turn runs is queued here and delivered automatically as the
// next turn's prompt at the turn boundary. Journaled as steering_received so
// every subscribed client sees the ack immediately.
function queueSteering(s, text) {
  if (s.bridge && !s.bridge.exited && s.bridge.ready && s.working) {
    // Live: dext folds it into the running turn (its own steering_received
    // marks the fold); this row is the immediate "heard you" ack.
    if (s.bridge.steer(text)) {
      publish(journalData(s, "steering_received", { messages: [text], preview: text.slice(0, 80), live: true }));
      return true;
    }
  }
  const total = s.steeringQueue.reduce((n, t) => n + t.length, 0) + text.length;
  if (s.steeringQueue.length >= STEERING_MAX_MESSAGES || total > STEERING_MAX_CHARS) return false;
  s.steeringQueue.push(text);
  persistIndex();
  publish(journalData(s, "steering_received", { messages: [text], preview: text.slice(0, 80) }));
  return true;
}

/** Wake a cold session: starting -> live, journaled so reconnecting clients
 *  see the same transition. The dext seat is durable; waking needs no child. */
function wakeSession(s) {
  publish(journalData(s, "session.state", { status: "starting" }));
  s.status = "live";
  publish(journalData(s, "session.state", { status: "live" }));
  persistIndex();
  scheduleList();
}

// ---------- delete / clear ----------

function broadcastControl(event, data) {
  const msg = JSON.stringify({ v: 1, ts: Date.now(), event, data });
  for (const c of clients) if (c.phase === "live") c.send(msg);
}

function removeJournalFile(s) {
  for (const file of [journalFile(s), `${journalFile(s)}.tmp`]) {
    checkedPath(file);
    fs.rmSync(file, { force: true });
  }
}

async function stopForPurge(s) {
  const child = s.child;
  if (!child) return;
  s.killed = true;
  await new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(kill);
      clearTimeout(deadline);
      // Also stop remaining descendants after the parent exits.
      signalChild(child, "SIGKILL");
      resolve();
    };
    const kill = setTimeout(() => signalChild(child, "SIGKILL"), 1500);
    const deadline = setTimeout(() => {
      child.off("close", finish);
      reject(new Error("agent did not stop; purge not completed"));
    }, 6500);
    child.once("close", finish);
    signalChild(child, "SIGINT");
  });
}

// The persisted cleanup intent retains the OLD seat until every owned file
// is removed. A crash or disk error is retryable; no success ack on failure.
function finishCleanup(s, by) {
  const intent = s.cleanup;
  purgeSeat(intent.seat);
  removeJournalFile(s);
  s.journal = [];
  s.pending.clear();
  s.steeringQueue = [];
  s.working = false;
  s.turnStartedAt = null;
  if (intent.action === "delete") {
    sessions.delete(s.id);
    try { persistIndex(true, true); } catch (err) {
      sessions.set(s.id, s);
      throw err;
    }
    s.deleted = true;
    for (const c of clients) c.subs.delete(s.id);
    broadcastControl("session.removed", { id: s.id, by });
  } else {
    s.seat = intent.nextSeat;
    s.generation = intent.generation;
    s.seq = 0;
    s.turns = 0;
    s.modelLocked = false;
    s.status = "live";
    s.cleanup = null;
    try { persistIndex(true, true); } catch (err) {
      s.cleanup = intent;
      throw err;
    }
    for (const c of clients) c.subs.delete(s.id);
    broadcastControl("session.cleared", { id: s.id, generation: s.generation });
  }
  scheduleList();
}

async function manageSession(s, action, by) {
  if (s.managing) throw new Error("session cleanup already in progress");
  if (s.cleanup && s.cleanup.action !== action) throw new Error(`retry session.${s.cleanup.action} first`);
  s.managing = true;
  try {
    // Mark before signalling so late events cannot recreate purged data.
    s.epoch++;
    await stopForPurge(s);
    if (!s.cleanup) {
      s.cleanup = {
        action, seat: s.seat,
        nextSeat: `dextui-${crypto.randomBytes(4).toString("hex")}`,
        generation: (s.generation ?? 0) + 1,
      };
    }
    persistIndex(true, true);
    finishCleanup(s, by);
  } finally {
    s.managing = false;
  }
}

function deleteScopeFilter(scope) {
  if (scope === "cold") return (s) => s.status === "cold" || s.status === "exited";
  if (scope === "exited") return (s) => s.status === "exited";
  return () => true;
}

// ---------- command dispatch ----------

function sendControl(client, event, data) {
  const env = { v: 1, ts: Date.now(), event };
  if (data !== undefined) env.data = data;
  client.send(JSON.stringify(env));
}

// `cmd`, when known, tags the error with the request that caused it so clients
// can scope error handling to their own in-flight requests.
function sendError(client, code, message, cmd) {
  sendControl(client, "error", cmd ? { code, message, cmd } : { code, message });
}

const HOST_HELP = [
  "agentlinkd host commands:",
  "  /help                 this text",
  "  /login [--show]       sign in on another device; --show prints the access code",
  "  /approval <profile>   set this session's dext approval profile",
  `                        (${[...APPROVALS].join(" | ")}) — applies from the next turn`,
  "  /pack …               list | run <name> <task> | inspect <name> | create <shelf>/<name> [--from <pack>]",
  "  /task …               shared tasks: list | show <name> | new <name> <goal>",
  "                        set <name> status|goal|summary|blocked_on|answer=…",
  "                        check <name> ok|fail <what> ('done' needs a passing check)",
  "  /ui status            self-edit: served build, last build, pending restart",
  "  /ui build [--tests] [--no-check]   staged rebuild of the web app; swaps in only if it passes",
  "  /ui rollback          serve the previous (last-known-good) build again",
  "  /ui restart [why]     restart the host when idle (after this turn); --force = now",
  "",
  "steering: input sent while a turn runs is queued and delivered",
  "automatically as the next turn — no stopping required (^c keeps it queued).",
  "interactive approvals still need the upstream dext bridge; dext's",
  "--approval profile governs tool policy.",
].join("\n");

/** `/ui …`: the self-edit verbs, journaled so an agent-driven edit loop is
 *  legible in the transcript. Same primitives as the x-agentlinkd.ui.* commands. */
async function handleUiSlash(client, s, rest) {
  if (!SELF.enabled) {
    sendError(client, "unsupported", "self-edit is off: this host is not running from a buildable DextUI checkout");
    return;
  }
  const words = rest.split(/\s+/).filter(Boolean);
  const verb = words[0] ?? "status";
  const flags = new Set(words.slice(1).filter((w) => w.startsWith("--")));
  switch (verb) {
    case "status": {
      const st = SELF.status();
      const lines = [
        `ui: serving ${st.serving} ${st.version?.id ?? "?"} from ${st.static}`,
        `lkg: ${st.lkg ? st.lkg.id : "none"}`,
        st.building ? `building: ${st.building.id} (${st.building.step})` : "building: no",
        st.last ? `last build: ${st.last.ok ? "ok" : `FAILED ${st.last.error}${st.last.failed ? ` at ${st.last.failed}` : ""}`} · ${st.last.duration_ms ?? 0} ms · by ${st.last.by}` : "last build: none this host lifetime",
        st.restart_pending ? `restart pending (${st.restart_pending.by}${st.restart_pending.reason ? `: ${st.restart_pending.reason}` : ""}) — waits for idle` : "restart pending: no",
        `agent path: node ${st.build_script}   ·   restart: write ${st.request_file}`,
      ];
      publish(journalData(s, "structured_slash", lines.join("\n")));
      return;
    }
    case "build": {
      publish(journalData(s, "slash", `ui build started (${flags.has("--tests") ? "with tests, " : ""}${flags.has("--no-check") ? "no svelte-check" : "svelte-check"}) — served build stays until it passes`));
      const r = await SELF.build({ check: !flags.has("--no-check"), tests: flags.has("--tests"), by: `session:${s.id}` });
      if (s.deleted) return;
      publish(journalData(s, r.ok ? "slash" : "structured_slash", r.ok
        ? `ui build ok · ${r.version?.id ?? "?"} · ${r.duration_ms} ms — open tabs reload; previous build kept as LKG`
        : `ui build FAILED (${r.error}${r.failed ? ` at ${r.failed}` : ""}) — served build untouched\n${String(r.tail ?? r.message ?? "").slice(-2000)}`));
      return;
    }
    case "rollback": {
      const r = SELF.rollback({ by: `session:${s.id}` });
      publish(journalData(s, "slash", r.ok ? `ui rolled back to ${r.version?.id ?? "previous build"}` : `ui rollback failed: ${r.message ?? r.error}`));
      return;
    }
    case "restart": {
      const reason = words.slice(1).filter((w) => !w.startsWith("--")).join(" ");
      const r = SELF.requestRestart({ reason, by: `session:${s.id}`, force: flags.has("--force") });
      publish(journalData(s, "slash", r.pending
        ? `host restart queued${reason ? ` (${reason})` : ""} — happens when idle: ${r.busy?.map((b) => b.kind).join(", ") || "after this turn"}`
        : "host restarting now — tabs reconnect automatically"));
      return;
    }
    case "cancel":
      publish(journalData(s, "slash", SELF.cancelRestart() ? "pending host restart cancelled" : "no restart was pending"));
      return;
    default:
      sendError(client, "bad_request", `unknown /ui verb '${verb}'; try /ui status | build [--tests] [--no-check] | rollback | restart [why] [--force] | cancel`);
  }
}

function handleSlash(client, s, raw) {
  const trimmed = String(raw ?? "").trim();
  const pack = parsePackSlash(trimmed);
  if (pack) {
    if (pack.sub === "run" && s.working) {
      // Same semantics as a prompt sent mid-turn: queue for the boundary.
      if (guardPackRun(client, s, pack)) return;
      if (!queueSteering(s, `/pack run ${pack.name} ${pack.task}`)) sendError(client, "busy", "steering queue is full (10 messages / 100k chars); interrupt or wait");
      return;
    }
    return handlePackSlash(client, s, pack);
  }
  if (trimmed === "/help") {
    publish(journalData(s, "slash", HOST_HELP));
    return;
  }
  if (trimmed === "/login" || trimmed === "/login --show") {
    if (trimmed.endsWith("--show")) {
      publish(journalData(s, "structured_slash", [
        `access code: ${TOKEN}`,
        "",
        "pair another browser or device: open this host's address there and enter",
        "the code on its sign-in screen — it stays saved there until signed out.",
        "note: the code is now part of this transcript; prefer plain /login when",
        "the transcript may be shared.",
      ].join("\n")));
    } else {
      publish(journalData(s, "slash", [
        "sign in on another device:",
        `  1. open http://<this-host>:${PORT} in its browser`,
        "  2. enter this host's access code — printed at host startup",
        '     (agentlinkd → "token:"), e.g. journalctl --user -u dext-agentlinkd | grep token',
        "or run /login --show to print the code here.",
      ].join("\n")));
    }
    return;
  }
  const ui = /^\/ui\b\s*(.*)$/s.exec(trimmed);
  if (ui) return handleUiSlash(client, s, ui[1].trim());
  const task = /^\/task\b\s*([\s\S]*)$/.exec(trimmed);
  if (task) return handleTaskSlash(client, s, task[1].trim());
  const m = /^\/approval\s+(\S+)$/.exec(trimmed);
  if (m) {
    const profile = m[1];
    if (!APPROVALS.has(profile)) {
      sendError(client, "bad_request", `unknown approval profile '${profile}'`);
      return;
    }
    s.approval = profile;
    persistIndex();
    publish(journalData(s, "approval_profile_changed", { profile }));
    if (BRIDGE && !s.working) recycleBridge(s);
    else if (BRIDGE) s.recycleOnTurnEnd = true; // turn in flight: restart at its boundary
    publish(journalData(s, "slash", `approval profile → ${profile}${s.working ? " (next turn)" : ""}`));
    return;
  }
  sendError(client, "unsupported", `host handles /help, /login, /approval, /pack, /task and /ui; '${trimmed.split(/\s/)[0]}' needs interactive dext`);
}

// ---------- packs: slash + prompt routing ----------

function dextOutputAsync(args, cwd) {
  return new Promise((resolve) => {
    execFile(DEXT_BIN, args, { cwd, env: dextEnv(), timeout: 15_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout ?? ""), err: String(stderr ?? err?.message ?? "") });
    });
  });
}

/** Validate a `/pack run` request against the catalog and the session's
 *  approval profile. Returns null when it may proceed; otherwise sends the
 *  error (with `data.required` for a one-click profile switch) and returns it. */
function guardPackRun(client, s, run) {
  if (!run.name) {
    sendError(client, "bad_request", "/pack run needs <name> <task>; see /pack list");
    return "bad_request";
  }
  const pack = packByName(run.name);
  if (!pack) {
    sendError(client, "no_pack", `unknown pack '${run.name}'; see /pack list`);
    return "no_pack";
  }
  if (!run.task) {
    sendError(client, "bad_request", `/pack run ${pack.name} needs a task`);
    return "bad_request";
  }
  const unmet = unmetRequirements(pack.ui.requires, { approval: s.approval });
  const profile = unmet.find((u) => u.startsWith("approval:"));
  if (profile) {
    const required = profile.slice("approval:".length);
    sendControl(client, "error", {
      code: "pack_requires_profile",
      message: `${pack.name} needs approval profile ${required}; this session is ${s.approval}. Headless dext would deny its writes silently.`,
      // `retry` lets the client re-offer the exact command after the switch.
      data: { pack: pack.name, required, current: s.approval, session: s.id, retry: `/pack run ${pack.name} ${run.task}` },
    });
    return "pack_requires_profile";
  }
  if (unmet.length > 0) {
    sendError(client, "pack_requires", `${pack.name} needs ${unmet.join(", ")} which this host does not have`);
    return "pack_requires";
  }
  return null;
}

async function handlePackSlash(client, s, cmd) {
  switch (cmd.sub) {
    case "list": {
      const view = PACKS.map((p) => ({ ...p, unmet: unmetRequirements(p.ui.requires, { approval: s.approval }) }));
      publish(journalData(s, "structured_slash", renderPackList(view)));
      return;
    }
    case "run": {
      if (guardPackRun(client, s, cmd)) return;
      submitPrompt(s, `/pack run ${cmd.name} ${cmd.task}`);
      return;
    }
    case "inspect": {
      const pack = packByName(cmd.name);
      if (!pack) {
        sendError(client, "no_pack", `unknown pack '${cmd.name}'; see /pack list`);
        return;
      }
      const r = await dextOutputAsync(["pack", "inspect", pack.name], s.cwd);
      publish(journalData(s, "structured_slash", (r.ok ? r.out : `[err] ${r.err}`).slice(0, 8000)));
      return;
    }
    case "create": {
      if (!/^[a-z0-9_-]+\/[a-z0-9_-]+$/.test(cmd.selector)) {
        sendError(client, "bad_request", "/pack create needs <shelf>/<name> [--from <pack>] (lowercase letters, digits, - or _)");
        return;
      }
      const args = ["pack", "create", cmd.selector];
      if (cmd.from) {
        // Deterministic fork: dext copies the pack (no symlinks, no .env) and
        // rewrites `name:`; the original is untouched. Never pass free text.
        const src = packByName(cmd.from);
        if (!src) {
          sendError(client, "no_pack", `unknown pack '${cmd.from}' to copy from; see /pack list`);
          return;
        }
        args.push("--from", src.name);
      }
      const r = await dextOutputAsync(args, s.cwd);
      publish(journalData(s, "slash", (r.ok ? r.out : `[err] ${r.err}`).slice(0, 4000)));
      if (r.ok) {
        await refreshPacks();
        publish(journalData(s, "info", cmd.from
          ? `pack ${cmd.selector} is your copy of ${cmd.from} — edit it from the gallery or describe the change here`
          : `pack ${cmd.selector} scaffolded — describe what it should do and dext will fill in PACK.md`));
      }
      return;
    }
    default:
      sendError(client, "bad_request", `unknown /pack verb '${cmd.verb}'; try /pack list | run <name> <task> | inspect <name> | create <shelf>/<name>`);
  }
}

/** Journal + start a turn. Callers have validated text and busy state. */
function submitPrompt(s, incoming) {
  let text = incoming;
  if (s.steeringQueue.length > 0) {
    // Queued steering that missed its boundary (interrupt/crash/restart)
    // rides with the next real prompt instead of being lost. A pack run goes
    // first so its `/pack run <name>` prefix still activates the pack; the
    // queued text becomes part of the task.
    const packFirst = parsePackSlash(incoming)?.sub === "run";
    text = (packFirst ? [incoming, ...s.steeringQueue] : [...s.steeringQueue, incoming]).join("\n\n");
    s.steeringQueue = [];
    persistIndex();
  }
  if (s.status === "cold") wakeSession(s);
  publish(journalData(s, "user_message", { text }));
  if (s.title === "New session") {
    s.title = text.slice(0, 60);
    persistIndex();
  }
  runTurn(s, text);
}

// ---------- delivery dedup (nonce) ----------

// Clients tag prompt.submit / steering.inject / slash with a nonce; the host
// remembers it for an hour, so a reconnect replay can never double-run work.
// Rejections flow back through the normal cmd-tagged `error` envelope (the
// client correlates those), so acks here are positive-only: `ok` means
// durably accepted (journaled or queued), `duplicate` means already run.
const NONCE_RE = /^[A-Za-z0-9_-]{6,64}$/;
const ACKABLE_CMDS = new Set(["prompt.submit", "steering.inject", "slash"]);
const seenNonces = new Map(); // nonce -> first-seen ts
const NONCE_TTL_MS = 60 * 60 * 1000;
const NONCE_CAP = 4096;
function nonceClaim(frame) {
  const n = frame?.nonce;
  if (typeof n !== "string" || !NONCE_RE.test(n) || !ACKABLE_CMDS.has(frame.cmd)) return null;
  if (seenNonces.has(n)) return { nonce: n, duplicate: true };
  const now = Date.now();
  if (seenNonces.size >= NONCE_CAP) {
    for (const [k, t] of seenNonces) if (now - t > NONCE_TTL_MS) seenNonces.delete(k);
    if (seenNonces.size >= NONCE_CAP) seenNonces.delete(seenNonces.keys().next().value);
  }
  seenNonces.set(n, now);
  return { nonce: n, duplicate: false };
}
function ackOk(client, frame, duplicate = false) {
  const n = frame?.nonce;
  if (typeof n === "string" && ACKABLE_CMDS.has(frame.cmd)) {
    sendControl(client, "cmd_ack", { nonce: n, cmd: frame.cmd, ok: true, ...(duplicate ? { duplicate: true } : {}) });
  }
}

async function handleCommand(client, frame) {
  if (!frame || typeof frame !== "object") return;
  if (frame.v !== 1) {
    sendError(client, "bad_version", "unsupported protocol version");
    return;
  }
  if (client.phase === "authing") {
    if (frame.cmd !== "hello") {
      sendError(client, "not_authenticated", "hello required");
      return;
    }
    if (authLocked()) {
      sendControl(client, "hello_fail", { reason: "rate_limited" });
      client.close(1008);
      return;
    }
    if (!tokenEquals(frame.token)) {
      noteAuthFailure();
      sendControl(client, "hello_fail", { reason: "invalid token" });
      client.close(1008);
      return;
    }
    client.phase = "live";
    sendControl(client, "hello_ok", {
      server: "agentlinkd",
      version: "0.1.0",
      protocol: 1,
      instance: INSTANCE,
      capabilities: CAPABILITIES,
      sessions: [...sessions.values()].map(metaOf),
      model_catalog: MODEL_CATALOG,
      effort_options: EFFORT_OPTIONS,
      commands: hostCommands(),
      packs: publicPacks(),
      home: DIRS_ROOT,
      ...(CREW ? { crews: CREW.summaries() } : {}),
      ...(SELF.enabled ? { self: SELF.status() } : {}),
    });
    for (const s of sessions.values()) crewRootFor(s.cwd);
    return;
  }
  if (client.phase !== "live") return;
  const target = sessions.get(frame.id ?? frame.session);
  if (target && (target.managing || target.cleanup) &&
      !["session.delete", "session.clear", "session.unsubscribe"].includes(frame.cmd)) {
    sendError(client, "busy", "session cleanup pending; retry delete/clear before using it", frame.cmd);
    return;
  }

  // Delivery dedup: a replayed nonce is acked as duplicate and never re-run.
  const claim = nonceClaim(frame);
  if (claim?.duplicate) {
    ackOk(client, frame, true);
    return;
  }

  switch (frame.cmd) {
    case "ping":
      sendControl(client, "pong", {});
      return;

    case "hello":
      sendError(client, "already_authenticated", "hello already completed");
      return;

    case "session.open": {
      if (frame.id) {
        const s = sessions.get(frame.id);
        if (!s) {
          sendError(client, "no_session", `unknown session ${frame.id}`);
          return;
        }
        if (s.status === "cold") wakeSession(s);
        else scheduleList();
        return;
      }
      const r = resolveSessionCwd(frame.cwd === undefined ? DEFAULT_CWD : frame.cwd);
      if (r.error) {
        sendError(client, "bad_request", `cwd refused — ${r.message}`);
        return;
      }
      const cwd = r.abs;
      const approval = APPROVALS.has(frame.approval) ? frame.approval : DEFAULT_APPROVAL;
      const s = makeSession({ cwd, approval });
      publish(journalData(s, "session.state", { status: "live" }));
      return;
    }

    case "session.subscribe": {
      const s = sessions.get(frame.id);
      if (!s) {
        sendError(client, "no_session", `unknown session ${frame.id}`);
        return;
      }
      client.subs.add(s.id);
      const since = frame.since_seq;
      // Replay only when every envelope after `since` is still retained
      // (oversized journals are truncated on boot); otherwise resync by snapshot.
      const firstRetainedSeq = s.journal.length > 0 ? s.journal[0].seq : s.seq + 1;
      if (typeof since === "number" && since >= 0 && since >= firstRetainedSeq && since <= s.seq) {
        for (const env of s.journal) if (env.seq > since) client.send(JSON.stringify(env));
      } else {
        client.send(JSON.stringify(snapshotEnvelope(s)));
      }
      return;
    }

    case "session.unsubscribe": {
      client.subs.delete(frame.id);
      return;
    }

    case "session.configure": {
      const s = sessions.get(frame.id);
      if (!s) {
        sendError(client, "no_session", `unknown session ${frame.id}`);
        return;
      }
      if (s.status !== "live" && s.status !== "cold") {
        sendError(client, "not_live", "session is not live");
        return;
      }
      const wantsModel = frame.provider !== undefined || frame.model !== undefined;
      const wantsEffort = frame.thinking_effort !== undefined;
      const wantsCwd = frame.cwd !== undefined;
      const liveBridge = !!(s.bridge && !s.bridge.exited && s.bridge.ready);
      // The folder never moves under a running turn: the agent's tool calls
      // are resolving paths against it right now.
      if (s.working && (wantsCwd || !(BRIDGE && liveBridge && wantsEffort && !wantsModel))) {
        sendError(client, "busy", wantsCwd ? "the folder changes between turns — wait for this one to finish" : "model applies between turns; effort can change mid-turn");
        return;
      }
      let nextCwd = null;
      if (wantsCwd) {
        const r = resolveSessionCwd(frame.cwd);
        if (r.error) {
          sendError(client, "bad_request", `cwd refused — ${r.message}`);
          return;
        }
        nextCwd = r.abs;
      }
      if (wantsModel) {
        if (!BRIDGE && (s.modelLocked || s.turns > 0)) {
          sendError(client, "model_locked", "this session has history; start a new session to change model");
          return;
        }
        if (typeof frame.provider !== "string" || typeof frame.model !== "string") {
          sendError(client, "bad_request", "model selection requires provider and model");
          return;
        }
        const group = MODEL_CATALOG.find((g) => g.provider === frame.provider);
        if (!group || !group.models.includes(frame.model)) {
          sendError(client, "bad_request", `unknown model selection ${frame.provider}/${frame.model}`);
          return;
        }
      }
      if (frame.thinking_effort !== undefined && !EFFORTS.has(frame.thinking_effort)) {
        sendError(client, "bad_request", `invalid thinking effort '${String(frame.thinking_effort)}'`);
        return;
      }
      if (wantsModel) {
        const changed = s.provider !== frame.provider || s.model !== frame.model;
        s.provider = frame.provider;
        s.model = frame.model;
        // History lives in the seat's session file; the next turn resumes it
        // under the new model (DEXT_MODEL_FORCE), so only the child restarts.
        if (changed && BRIDGE) recycleBridge(s);
      }
      if (wantsEffort) {
        s.thinkingEffort = frame.thinking_effort;
        // Live child: /effort is a runtime control (applies even mid-turn).
        if (liveBridge) s.bridge.control(`/effort ${frame.thinking_effort}`);
      }
      if (nextCwd && nextCwd !== s.cwd) {
        const from = s.cwd;
        s.cwd = nextCwd;
        // History is the seat's, not the folder's: the next turn resumes it
        // from the new cwd (fresh DEXT.md / project context), so only the
        // child restarts. `moved` makes that resume name the session path
        // explicitly (see resumeTarget). A scrollback marker keeps the switch
        // visible.
        if (s.turns > 0) s.moved = true;
        if (BRIDGE) recycleBridge(s);
        publish(journalData(s, "info", `Folder: ${from} → ${nextCwd}`));
      }
      persistIndex();
      publish(journalData(s, "session.configured", {
        provider: s.provider ?? undefined,
        model: s.model ?? undefined,
        thinking_effort: s.thinkingEffort,
        model_locked: s.modelLocked,
        cwd: s.cwd,
      }));
      if (nextCwd) scheduleList();
      return;
    }

    case "session.rename": {
      const s = sessions.get(frame.id);
      if (!s || typeof frame.title !== "string" || !frame.title.trim()) {
        sendError(client, "bad_request", "session.rename needs id and title");
        return;
      }
      s.title = frame.title.trim().slice(0, 80);
      persistIndex();
      scheduleList();
      return;
    }

    case "session.close": {
      const s = sessions.get(frame.id);
      if (!s) {
        sendError(client, "no_session", `unknown session ${frame.id}`);
        return;
      }
      killChild(s);
      // The dext seat is durable; closing only stops the child. The session
      // stays resumable, so it goes cold rather than exited.
      if (s.bridge) recycleBridge(s);
      s.status = "cold";
      publish(journalData(s, "session.state", { status: "cold" }));
      persistIndex();
      return;
    }

    case "session.delete": {
      const s = sessions.get(frame.id);
      if (!s) {
        sendError(client, "no_session", `unknown session ${frame.id}`);
        return;
      }
      await manageSession(s, "delete", client.id);
      return;
    }

    case "session.clear": {
      const s = sessions.get(frame.id);
      if (!s) {
        sendError(client, "no_session", `unknown session ${frame.id}`);
        return;
      }
      await manageSession(s, "clear", client.id);
      return;
    }

    case "session.delete_all": {
      const scope = frame.scope;
      if (!["all", "cold", "exited"].includes(scope)) {
        sendError(client, "bad_request", "session.delete_all requires scope: all | cold | exited");
        return;
      }
      const targets = [...sessions.values()].filter(deleteScopeFilter(scope));
      // Lock the entire captured set synchronously; new sessions are unaffected.
      const results = await Promise.allSettled(targets.map((s) => manageSession(s, "delete", client.id)));
      const ids = targets.filter((_, i) => results[i].status === "fulfilled").map((s) => s.id);
      sendControl(client, "sessions.deleted", { ids, scope });
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length) sendError(client, "purge_failed", `${failed.length} session(s) could not be purged; retry. ${failed[0].reason.message}`);
      return;
    }

    case "prompt.submit": {
      const s = sessions.get(frame.session);
      if (!s) {
        sendError(client, "no_session", `unknown session ${frame.session}`);
        return;
      }
      if (typeof frame.text !== "string" || !frame.text.trim()) {
        sendError(client, "bad_request", "text required");
        return;
      }
      if (frame.text.length > MAX_PROMPT_CHARS) {
        sendError(client, "bad_request", `text exceeds ${MAX_PROMPT_CHARS} characters`);
        return;
      }
      // `/pack …` may arrive as a prompt too (agents driving /__agent). Management
      // verbs answer immediately; a run passes the catalog + profile guard before
      // anything is journaled, then follows the normal prompt/steering path.
      const packCmd = parsePackSlash(frame.text);
      if (packCmd && packCmd.sub !== "run") {
        await handlePackSlash(client, s, packCmd);
        ackOk(client, frame);
        return;
      }
      if (packCmd && guardPackRun(client, s, packCmd)) return;
      if (s.working) {
        // A prompt sent mid-turn is steering: queue it for the turn boundary.
        if (!queueSteering(s, frame.text)) {
          sendError(client, "busy", "steering queue is full (10 messages / 100k chars); interrupt or wait");
          return;
        }
        ackOk(client, frame);
        return;
      }
      submitPrompt(s, frame.text);
      ackOk(client, frame);
      return;
    }

    case "steering.inject": {
      const s = sessions.get(frame.session);
      if (!s) {
        sendError(client, "no_session", `unknown session ${frame.session}`);
        return;
      }
      if (typeof frame.text !== "string" || !frame.text.trim()) {
        sendError(client, "bad_request", "text required");
        return;
      }
      if (frame.text.length > MAX_PROMPT_CHARS) {
        sendError(client, "bad_request", `text exceeds ${MAX_PROMPT_CHARS} characters`);
        return;
      }
      if (!s.working && s.steeringQueue.length === 0) {
        sendError(client, "not_working", "no turn in flight; send a prompt instead");
        return;
      }
      if (!queueSteering(s, frame.text.trim())) {
        sendError(client, "busy", "steering queue is full (10 messages / 100k chars); interrupt or wait");
        return;
      }
      ackOk(client, frame);
      return;
    }

    case "interrupt": {
      const s = sessions.get(frame.session);
      if (!s) {
        sendError(client, "no_session", `unknown session ${frame.session}`);
        return;
      }
      // Idle persistent bridge: no turn in flight. Killing the warm child
      // would drop the live seat and approval wiring for nothing; the
      // interruptible part is any queued steering.
      if (BRIDGE && !s.working && s.bridge && !s.bridge.exited) {
        if (s.steeringQueue.length > 0) {
          s.steeringQueue = [];
          persistIndex();
          publish(journalData(s, "interrupted"));
        }
        return;
      }
      killChild(s);
      return;
    }

    case "permission.respond": {
      const s = sessions.get(frame.session);
      if (!s) {
        sendError(client, "no_session", `unknown session ${frame.session}`);
        return;
      }
      if (!BRIDGE) {
        sendError(client, "unsupported", "approvals are governed by the session's dext --approval profile (/approval <profile>)");
        return;
      }
      const choice = toBridgeChoice(frame.choice);
      const id = typeof frame.request_id === "string" ? frame.request_id : "";
      if (!choice || !id) {
        sendError(client, "bad_request", "permission.respond needs request_id and choice allow|allow_always|deny");
        return;
      }
      if (!s.pendingPermission || s.pendingPermission.request_id !== id) {
        sendControl(client, "permission.already_resolved", { request_id: id });
        return;
      }
      if (!s.bridge || s.bridge.exited || !s.bridge.permission(id, choice)) {
        sendError(client, "not_live", "no dext child is waiting on this approval");
        return;
      }
      s.pendingPermission.answeredBy = client.id;
      return;
    }

    case "slash": {
      const s = sessions.get(frame.session);
      if (!s) {
        sendError(client, "no_session", `unknown session ${frame.session}`);
        return;
      }
      await handleSlash(client, s, frame.raw);
      ackOk(client, frame);
      return;
    }

    default:
      if (typeof frame.cmd === "string" && frame.cmd.startsWith("x-agentlinkd.pack.")) {
        handlePackFileCommand(client, frame);
        return;
      }
      if (typeof frame.cmd === "string" && frame.cmd.startsWith("x-agentlinkd.crew.")) {
        await handleCrewCommand(client, frame);
        return;
      }
      if (typeof frame.cmd === "string" && (frame.cmd.startsWith("x-agentlinkd.ui.") || frame.cmd.startsWith("x-agentlinkd.host."))) {
        await handleSelfEditCommand(client, frame);
        return;
      }
      if (typeof frame.cmd === "string" && frame.cmd.startsWith("x-agentlinkd.flows.")) {
        handleFlowsCommand(client, frame);
        return;
      }
      if (frame.cmd === "x-agentlinkd.packs.credentials.set") {
        // Values arrive once, are written to DEXT_HOME (0600) and never echoed;
        // the reply and the catalog carry names only. Children pick the new
        // env up on their next spawn: idle bridges recycle now, busy ones at
        // turn end — a running turn keeps the env it started with.
        const pack = packByName(frame.name);
        if (!pack) {
          sendError(client, "no_pack", `unknown pack ${String(frame.name)}`, frame.cmd);
          return;
        }
        if (!pack.credential_env?.length) {
          sendError(client, "bad_request", `${pack.name} declares no credential-env`, frame.cmd);
          return;
        }
        const r = applyCredentialPatch(readPackCredentials(DEXT_HOME, pack.name), pack.credential_env, frame.values, frame.clear);
        if (r.error) {
          sendError(client, "bad_request", r.error, frame.cmd);
          return;
        }
        try {
          writePackCredentials(DEXT_HOME, pack.name, r.values);
        } catch (err) {
          sendError(client, "write_failed", `could not store credentials: ${err.message}`, frame.cmd);
          return;
        }
        refreshPackCredentialEnv();
        for (const s of sessions.values()) {
          if (!s.bridge || s.bridge.exited) continue;
          if (s.working) s.recycleOnTurnEnd = true;
          else recycleBridge(s);
        }
        sendControl(client, "x-agentlinkd.packs.credentials", { name: pack.name, ...packCredentialStatus(DEXT_HOME, pack.name, pack.credential_env) });
        broadcastControl("packs.changed", { packs: publicPacks(), commands: hostCommands() });
        return;
      }
      if (frame.cmd === "x-agentlinkd.dirs.list") {
        const r = listDirs(DIRS_ROOT, frame.path);
        if (r.error) sendError(client, r.error === "outside_root" || r.error === "hidden" || r.error === "refused" ? "bad_path" : r.error === "missing" ? "no_dir" : "bad_request", `cannot list folder: ${r.error}`, frame.cmd);
        else sendControl(client, "x-agentlinkd.dirs.list", r);
        return;
      }
      if (frame.cmd === "x-agentlinkd.dirs.create") {
        const r = createDir(DIRS_ROOT, frame.path, frame.name);
        if (r.error) sendError(client, r.error === "exists" ? "exists" : r.error === "bad_name" ? "bad_request" : "bad_path", `cannot create folder: ${r.error}`, frame.cmd);
        else {
          const l = listDirs(DIRS_ROOT, frame.path);
          sendControl(client, "x-agentlinkd.dirs.list", { ...(l.error ? { path: r.path, rel: "", dirs: [], parent: null, root: DIRS_ROOT, files: 0, truncated: false } : l), created: r.path });
        }
        return;
      }
      if (typeof frame.cmd === "string" && frame.cmd.startsWith("x-agentlinkd.connectors.")) {
        await handleConnectorsCommand(client, frame);
        return;
      }
      if (typeof frame.cmd === "string" && frame.cmd.startsWith("x-agentlinkd.auth.")) {
        await handleAuthCommand(client, frame);
        return;
      }
      if (typeof frame.cmd === "string" && frame.cmd.startsWith("x-agentlinkd.tasks.")) {
        handleTasksCommand(client, frame);
        return;
      }
      sendError(client, "unknown_command", `unsupported cmd ${String(frame.cmd)}`);
  }
}

// ---------- connectors (x-agentlinkd.connectors.*) ----------

// Progress (syncing → idle/error) is broadcast so every tab sees the state;
// the requesting client additionally gets the final listing tagged with
// added/removed/synced/pushed. Errors are cmd-tagged; a tool's last line
// rides in `detail` (already secret-scrubbed by the module).
CONNECTORS.onChange((l) => broadcastControl("x-agentlinkd.connectors.list", l));
// OAuth sign-in progress (consent URL ready / token in hand / failed) goes to
// every tab: the user may finish the Google page on another device.
CONNECTORS.onAuth((a) => broadcastControl("x-agentlinkd.connectors.authorize", a));

const CONNECTOR_ERROR_CODES = {
  bad_kind: "bad_request", bad_label: "bad_request", bad_remote: "bad_request", bad_secret: "bad_request", bad_request: "bad_request", bad_landing: "bad_request",
  no_rclone: "unsupported", no_git: "unsupported", exists: "exists", no_connector: "no_connector", no_auth: "no_auth", busy: "busy", bad_path: "bad_path", tool_failed: "tool_failed",
};
const CONNECTOR_ERROR_TEXT = {
  bad_kind: "unknown connector kind", bad_label: "label: letters, numbers, spaces, . _ ( ) - (max 80)", bad_remote: "remote must be owner/repo, an https URL, or a folder path",
  bad_secret: "a credential is required for this kind (single line)", no_rclone: "rclone is not installed on the host — install it to connect Drive or Dropbox",
  no_git: "git is not installed on the host", exists: "a connector or folder with that name already exists", no_connector: "unknown connector",
  no_auth: "sign in first — the sign-in expired or was cancelled", bad_landing: "that is not the address the sign-in landed on (expected http://127.0.0.1:53682/?state=…&code=…)",
  busy: "that connector is already syncing", bad_path: "connected folder refused", tool_failed: "the sync tool failed", bad_request: "bad request",
};

async function handleConnectorsCommand(client, frame) {
  const op = frame.cmd.slice("x-agentlinkd.connectors.".length);
  let r;
  switch (op) {
    case "list": r = CONNECTORS.list(); break;
    case "add": r = await CONNECTORS.add({ kind: frame.kind, label: frame.label, remote: frame.remote, secret: typeof frame.secret === "string" && frame.secret.trim() ? frame.secret.trim() : undefined, ticket: typeof frame.ticket === "string" ? frame.ticket : undefined }); break;
    case "remove": r = await CONNECTORS.remove({ id: frame.id, purge: frame.purge === true }); break;
    case "sync": r = await CONNECTORS.sync({ id: frame.id }); break;
    case "push": r = await CONNECTORS.push({ id: frame.id, message: frame.message }); break;
    case "authorize": {
      const a = await CONNECTORS.authorize({ kind: frame.kind });
      if (a.error) { r = a; break; }
      // The listener already broadcast {ticket, kind, url}; this client gets it as its reply too.
      sendControl(client, "x-agentlinkd.connectors.authorize", { ticket: a.ticket, kind: a.kind, url: a.url });
      return;
    }
    case "relay": {
      const a = await CONNECTORS.relay({ ticket: frame.ticket, landing: frame.landing });
      if (a.error) { r = a; break; }
      sendControl(client, "x-agentlinkd.connectors.authorize", { ticket: a.ticket, relayed: true });
      return;
    }
    case "cancel":
      CONNECTORS.cancelAuthorize({ ticket: typeof frame.ticket === "string" ? frame.ticket : undefined });
      sendControl(client, "x-agentlinkd.connectors.authorize", { ticket: frame.ticket ?? null, cancelled: true });
      return;
    default:
      sendError(client, "unknown_command", `unsupported cmd ${frame.cmd}`);
      return;
  }
  if (r.error) {
    const code = CONNECTOR_ERROR_CODES[r.error] ?? "tool_failed";
    const text = CONNECTOR_ERROR_TEXT[r.error] ?? r.error;
    sendError(client, code, r.detail ? `${text}: ${r.detail}` : text, frame.cmd);
    return;
  }
  sendControl(client, "x-agentlinkd.connectors.list", r);
}

// ---------- provider sign-in (x-agentlinkd.auth.*) ----------

// Credentials are pasted (never a browser flow: the host may be headless or
// paired over LAN/hosted, so `web`/`import` modes are refused). The value
// goes to `dext auth login <provider> <credential>` on argv of a child we
// spawn directly — no shell, no history — and is never echoed in any frame.
async function handleAuthCommand(client, frame) {
  const op = frame.cmd.slice("x-agentlinkd.auth.".length);
  if (op === "status") {
    sendControl(client, "x-agentlinkd.auth.status", { ...(await providerStatusAsync()), model_catalog: MODEL_CATALOG });
    return;
  }
  if (op !== "login" && op !== "logout") {
    sendError(client, "unknown_command", `unsupported cmd ${frame.cmd}`);
    return;
  }
  const provider = typeof frame.provider === "string" ? frame.provider.trim() : "";
  if (!PROVIDER_ID_RE.test(provider) || !(await providerStatusAsync()).providers.some((p) => p.id === provider)) {
    sendError(client, "bad_request", "unknown provider", frame.cmd);
    return;
  }
  let args;
  let credential = "";
  if (op === "login") {
    credential = typeof frame.credential === "string" ? frame.credential.trim() : "";
    if (!credential || credential.length > 8192 || /[\r\n]/.test(credential)) {
      sendError(client, "bad_request", "paste the API key or token (single line)", frame.cmd);
      return;
    }
    if (/^(web|import|cancel)$/i.test(credential)) {
      sendError(client, "bad_request", "browser and import flows are not available here — paste an API key or token", frame.cmd);
      return;
    }
    // Credential goes over stdin, never argv (visible in /proc/<pid>/cmdline
    // to the same user). Binaries predating patches/dext/0001 see no
    // credential and report "awaiting" instead of logging in.
    args = ["auth", "login", provider];
  } else {
    args = ["auth", "logout", provider];
  }
  const r = await runDext(args, 60_000, op === "login" ? credential : null);
  const awaiting = r.ok && op === "login" && /remains incomplete|paste/i.test(r.stdout) && !/stored|saved|logged in|active ->/i.test(r.stdout);
  if (!r.ok || awaiting) {
    let line = `${r.stderr}\n${r.stdout}`.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "dext refused";
    // Never let the pasted value ride back out, whatever dext printed.
    if (credential) line = line.split(credential).join("…");
    if (awaiting) line = "this dext build cannot take the credential over stdin; apply patches/dext/0001 or run `dext auth login` locally";
    sendError(client, "tool_failed", `${op} failed: ${line.slice(0, 200)}`, frame.cmd);
    return;
  }
  await refreshModelCatalog();
  const status = { ...(await providerStatusAsync()), model_catalog: MODEL_CATALOG, changed: provider };
  broadcastControl("x-agentlinkd.auth.status", status);
}

// ---------- flows (x-agentlinkd.flows.*) ----------

// Flows belong to a workspace folder (a session cwd). frame.cwd may point at
// any existing directory — same posture as session.open.
function flowCwd(frame) {
  const cwd = typeof frame.cwd === "string" && frame.cwd ? path.resolve(frame.cwd) : DEFAULT_CWD;
  try {
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return { error: "no_dir" };
    return { cwd };
  } catch {
    return { error: "no_dir" };
  }
}

function meshBin() {
  const pack = PACKS.find((p) => p.name === "mesh");
  if (pack?.path) {
    const bin = path.join(pack.path, "bin", "mesh");
    if (fs.existsSync(bin)) return bin;
  }
  return "mesh";
}

function flowErr(client, cmd, r, what) {
  const code = r.error === "no_flow" ? "no_flow" : "bad_request";
  sendError(client, code, `flow '${what}': ${r.error}`, cmd);
}

function compileOrError(client, frame, flow) {
  try {
    return compileFlow(flow, { meshBin: meshBin(), packs: new Set(PACKS.map((p) => p.name)) });
  } catch (e) {
    sendError(client, e?.code === "no_pack" ? "no_pack" : "bad_request", String(e?.message ?? e), frame.cmd);
    return null;
  }
}

/** Launch registry: one record per (cwd, flow) — the LAST launch of that
 *  flow, tracked from spawn to process exit. Spawn-accepted is not
 *  run-succeeded: crew's exit status and output tail are recorded, persisted
 *  under --state-dir, and broadcast, so a run that dies at startup is a
 *  visible failure instead of a silent "started". */
const LAUNCHES_FILE = path.join(STATE_DIR, "flow-launches.json");
let LAUNCHES = {}; // `${cwd}\u0000${name}` -> last launch record
try {
  LAUNCHES = JSON.parse(fs.readFileSync(LAUNCHES_FILE, "utf8")) || {};
} catch {
  LAUNCHES = {};
}
function persistLaunches() {
  const keys = Object.keys(LAUNCHES);
  if (keys.length > 64) for (const k of keys.slice(0, keys.length - 64)) delete LAUNCHES[k];
  try {
    fs.writeFileSync(LAUNCHES_FILE, JSON.stringify(LAUNCHES));
  } catch (err) {
    console.error(`agentlinkd: cannot persist flow launches: ${err.message}`);
  }
}
function launchSummaries(cwd) {
  const out = [];
  for (const l of Object.values(LAUNCHES)) {
    if (cwd && l.cwd !== cwd) continue;
    out.push({ cwd: l.cwd, name: l.name, state: l.state, at: l.at, exit_code: l.exit_code, error: String(l.error ?? "").slice(0, 300) });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 16);
}

/** Start a flow run: compile to a crew spec, write it once under
 *  <cwd>/.crew/specs, spawn `crew run --spec` detached — and TRACK the
 *  launch to exit (see LAUNCHES above). Shared by the x-agentlinkd.flows.run
 *  command and every trigger. Returns `{ ok, spec_path, launch }` or
 *  `{ error, code }`; never throws. */
function startFlowRun(cwd, name, { by = "host", reason = "" } = {}) {
  if (!CREW_BIN) return { error: "flows run on crew; no crew binary on this host", code: "unsupported" };
  const r = readFlow(cwd, name);
  if (r.error) return { error: `flow '${name}': ${r.error}`, code: r.error === "no_flow" ? "no_flow" : "bad_request" };
  let spec;
  try {
    spec = compileFlow(r.flow, { meshBin: meshBin(), packs: new Set(PACKS.map((p) => p.name)) });
  } catch (e) {
    return { error: String(e?.message ?? e), code: e?.code === "no_pack" ? "no_pack" : "bad_request" };
  }
  const specsDir = path.join(cwd, ".crew", "specs");
  try {
    if (!checkedPath(specsDir)) fs.mkdirSync(specsDir, { recursive: true });
  } catch {
    return { error: `cannot write ${specsDir}`, code: "bad_path" };
  }
  const specPath = path.join(specsDir, `flow-${r.flow.name}-${Date.now().toString(36)}.json`);
  try {
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2) + "\n", { flag: "wx" });
  } catch {
    return { error: `cannot write ${specPath}`, code: "write_failed" };
  }
  if (CREW) CREW.addRoot(path.join(cwd, ".crew", "runs"));

  const launch = {
    cwd,
    name: r.flow.name,
    spec_path: specPath,
    by,
    reason: String(reason ?? "").slice(0, 200),
    at: Date.now(),
    state: "starting",
    exit_code: null,
    error: "",
  };
  LAUNCHES[`${cwd}\u0000${launch.name}`] = launch;
  persistLaunches();

  let child;
  try {
    child = spawn(CREW_BIN, ["run", "--spec", specPath, "--cwd", cwd], {
      cwd,
      env: dextEnv(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    launch.state = "failed";
    launch.error = `crew failed to start: ${err.message}`;
    persistLaunches();
    broadcastControl("x-agentlinkd.flows.run", { cwd, name: launch.name, failed: true, launch });
    return { error: launch.error, code: "spawn_failed" };
  }
  // Consume crew's output continuously (a full pipe would block the child);
  // keep only the tail so a startup crash explains itself.
  let tail = "";
  const feed = (b) => {
    tail = (tail + b.toString()).slice(-8192);
  };
  child.stdout?.on("data", feed);
  child.stderr?.on("data", feed);
  const finish = (failed, code, error) => {
    launch.state = failed ? "failed" : "started";
    launch.exit_code = code ?? null;
    if (failed) launch.error = String(error || `crew exited with code ${code}`).slice(0, 2000);
    persistLaunches();
    broadcastControl("x-agentlinkd.flows.run", { cwd, name: launch.name, failed, launch });
    SELF?.tick();
  };
  child.on("error", (err) => finish(true, null, `crew failed to start: ${err.message}`));
  child.on("exit", (code, signal) => finish(code !== 0, code, signal ? `crew terminated by ${signal}${tail ? ` — ${tail}` : ""}` : tail));
  child.unref();
  return { ok: true, spec_path: specPath, name: launch.name, launch };
}

function handleFlowsCommand(client, frame) {
  const { cwd, error } = flowCwd(frame);
  if (error) {
    sendError(client, "bad_request", `flows need an existing folder: ${error}`, frame.cmd);
    return;
  }
  TRIGGERS.addWorkspace(cwd);
  switch (frame.cmd) {
    case "x-agentlinkd.flows.list":
      sendControl(client, "x-agentlinkd.flows.list", { cwd, flows: listFlows(cwd), triggers: TRIGGERS.status(cwd), launches: launchSummaries(cwd) });
      return;
    case "x-agentlinkd.flows.get": {
      const r = readFlow(cwd, frame.name);
      if (r.error) flowErr(client, frame.cmd, r, frame.name);
      else sendControl(client, "x-agentlinkd.flows.get", { cwd, flow: r.flow });
      return;
    }
    case "x-agentlinkd.flows.put": {
      const r = writeFlow(cwd, frame.flow);
      if (r.error) sendError(client, "bad_request", `flow not saved: ${r.error}`, frame.cmd);
      else {
        sendControl(client, "x-agentlinkd.flows.put", { cwd, flow: r.flow, bytes: r.bytes });
        TRIGGERS.reload(cwd);
        broadcastControl("x-agentlinkd.flows.changed", { cwd, flows: listFlows(cwd), triggers: TRIGGERS.status(cwd) });
      }
      return;
    }
    case "x-agentlinkd.flows.delete": {
      const r = deleteFlow(cwd, frame.name);
      if (r.error) flowErr(client, frame.cmd, r, frame.name);
      else {
        TRIGGERS.reload(cwd);
        broadcastControl("x-agentlinkd.flows.changed", { cwd, flows: listFlows(cwd), triggers: TRIGGERS.status(cwd) });
      }
      return;
    }
    case "x-agentlinkd.flows.compile": {
      const r = readFlow(cwd, frame.name);
      if (r.error) return flowErr(client, frame.cmd, r, frame.name);
      const spec = compileOrError(client, frame, r.flow);
      if (spec) sendControl(client, "x-agentlinkd.flows.compile", { cwd, name: r.flow.name, spec });
      return;
    }
    case "x-agentlinkd.flows.run": {
      const r = startFlowRun(cwd, frame.name, { by: `client:${client.id}` });
      if (r.error) sendError(client, r.code, r.error, frame.cmd);
      else sendControl(client, "x-agentlinkd.flows.run", { cwd, name: r.name, spec_path: r.spec_path, started: true, launch: r.launch });
      return;
    }
    default:
      sendError(client, "unknown_command", `unsupported cmd ${String(frame.cmd)}`, frame.cmd);
  }
}

// ---------- shared tasks: slash surface (conversational control) ----------

const TASK_GLYPH = { planned: "○", active: "▶", blocked: "■", done: "●", failed: "✗", dropped: "·" };

/** `/task …` — the same surface a UI user gets, inside the conversation:
 *  list | show <name> | new <name> <goal> | set <name> field=value |
 *  check <name> ok|fail <what>. Records are also plain files the agent can
 *  edit directly with its file tools; the host watches and re-validates. */
function handleTaskSlash(client, s, rest) {
  const cwd = s.cwd;
  TASKS.ensureWatch(cwd);
  const say = (lines) => publish(journalData(s, "slash", Array.isArray(lines) ? lines.filter(Boolean).join("\n") : lines));
  const fail = (code, msg) => sendError(client, code, msg, "slash");

  if (!rest || rest === "list") {
    const { tasks, dir } = TASKS.list(cwd);
    if (tasks.length === 0) {
      return say(["no tasks in this workspace yet.", "", "/task new <name> <goal>  — create one", `records are plain files in ${dir}/ — the agent can edit them too`]);
    }
    return say([
      "tasks in this workspace:",
      ...tasks.map((t) => `  ${TASK_GLYPH[t.status] ?? "·"} ${t.name} [${t.status}] rev ${t.rev}${t.blocked_on ? " — BLOCKED" : ""}${t.checks_ok ? ` · ${t.checks_ok} ok check(s)` : ""} — ${t.title}`),
      "",
      "/task show <name> for the full record",
    ]);
  }

  let m = /^show\s+(\S+)$/.exec(rest);
  if (m) {
    const r = TASKS.get(cwd, m[1]);
    if (r.error) return fail(r.code ?? "bad_request", `task '${m[1]}': ${r.error}`);
    const t = r.task;
    return say([
      `${t.title} (${t.name}) — ${t.status} · rev ${t.rev} · updated ${new Date(t.updated_at).toLocaleString()} by ${t.updated_by}`,
      `goal: ${t.goal}`,
      t.acceptance.length ? `acceptance:\n${t.acceptance.map((a) => `  - ${a}`).join("\n")}` : "acceptance: (none written yet)",
      t.constraints.budget_usd !== null ? `budget: $${t.constraints.budget_usd}` : "",
      t.constraints.folders.length ? `folders: ${t.constraints.folders.join(", ")}` : "",
      t.constraints.notes ? `notes: ${t.constraints.notes}` : "",
      t.links.session || t.links.crew_run || t.links.flows.length ? `links: ${[t.links.session && `session ${t.links.session}`, t.links.crew_run && `run ${t.links.crew_run}`, ...t.links.flows.map((f) => `flow ${f}`)].filter(Boolean).join(" · ")}` : "",
      t.artifacts.length ? `artifacts: ${t.artifacts.join(", ")}` : "",
      t.blocked_on ? `BLOCKED: ${t.blocked_on}${t.answer ? `\nanswer: ${t.answer}` : "\n(answer via /task set <name> answer=…)"}` : "",
      t.checks.length ? `checks:\n${t.checks.map((c) => `  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`).join("\n")}` : "checks: (none — status 'done' requires at least one passing)",
      t.summary ? `summary: ${t.summary}` : "",
    ]);
  }

  m = /^new\s+(\S+)\s+([\s\S]+)$/.exec(rest);
  if (m) {
    const r = TASKS.put(cwd, { version: 1, name: m[1], goal: m[2], status: "planned" }, { actor: "agent" });
    if (r.error) return fail(r.code ?? "bad_request", `task not created: ${r.error}`);
    return say([`task '${r.task.name}' created (rev 1).`, `file: ${TASKS.dir(cwd)}/${r.task.name}.task.json`, "remember: 'done' needs a passing check — /task check <name> ok <what>"]);
  }

  m = /^set\s+(\S+)\s+(\S+)=([\s\S]*)$/.exec(rest);
  if (m) {
    const g = TASKS.get(cwd, m[1]);
    if (g.error) return fail(g.code ?? "bad_request", `task '${m[1]}': ${g.error}`);
    const [, name, field, rawValue] = m;
    const t = g.task;
    const value = rawValue.trim();
    if (field === "status") {
      if (!TASK_STATUSES.has(value)) return fail("bad_request", `status must be one of ${[...TASK_STATUSES].join(" | ")}`);
      if (value === "blocked" && !t.blocked_on) return fail("bad_request", "set blocked_on first: /task set <name> blocked_on=<question for the human>");
      t.status = value;
    } else if (["goal", "summary", "title", "blocked_on", "answer"].includes(field)) {
      if (!value) return fail("bad_request", `${field} must not be empty`);
      t[field] = value;
    } else {
      return fail("bad_request", "set supports status | goal | summary | title | blocked_on | answer");
    }
    const r = TASKS.put(cwd, t, { actor: "agent" });
    if (r.error) return fail(r.code ?? "bad_request", `task not saved: ${r.error}`);
    return say(`task '${name}': ${field} set (rev ${r.task.rev}${r.task.status !== t.status ? " — the answer cleared the block" : ""})`);
  }

  m = /^check\s+(\S+)\s+(ok|fail)\s+([\s\S]+)$/.exec(rest);
  if (m) {
    const g = TASKS.get(cwd, m[1]);
    if (g.error) return fail(g.code ?? "bad_request", `task '${m[1]}': ${g.error}`);
    const t = g.task;
    t.checks.push({ name: m[3].trim().slice(0, 120), ok: m[2] === "ok", detail: "", at: Date.now(), by: "agent" });
    const r = TASKS.put(cwd, t, { actor: "agent" });
    if (r.error) return fail(r.code ?? "bad_request", `check not saved: ${r.error}`);
    return say([`check recorded on '${t.name}' (rev ${r.task.rev}).`, r.task.checks.some((c) => c.ok) ? "a passing check exists — status 'done' is now allowed" : "still no passing check — 'done' stays refused"]);
  }

  return fail("bad_request", "/task: list | show <name> | new <name> <goal> | set <name> field=value | check <name> ok|fail <what>");
}

// ---------- shared tasks: WS surface (x-agentlinkd.tasks.*) ----------

function handleTasksCommand(client, frame) {
  const { cwd, error } = flowCwd(frame);
  if (error) {
    sendError(client, "bad_request", `tasks need an existing folder: ${error}`, frame.cmd);
    return;
  }
  TASKS.ensureWatch(cwd);
  switch (frame.cmd) {
    case "x-agentlinkd.tasks.list":
      sendControl(client, "x-agentlinkd.tasks.list", { cwd, ...TASKS.list(cwd) });
      return;
    case "x-agentlinkd.tasks.get": {
      const r = TASKS.get(cwd, frame.name);
      if (r.error) sendError(client, r.code ?? "bad_request", `task '${String(frame.name)}': ${r.error}`, frame.cmd);
      else sendControl(client, "x-agentlinkd.tasks.get", { cwd, task: r.task });
      return;
    }
    case "x-agentlinkd.tasks.put": {
      const r = TASKS.put(cwd, frame.task, {
        actor: frame.actor === "agent" ? "agent" : "user",
        expectedRev: typeof frame.expected_rev === "number" ? frame.expected_rev : undefined,
      });
      if (r.error) {
        const hint = r.code === "stale_rev" ? ` (disk is at rev ${r.current}; reload and re-apply)` : "";
        sendError(client, r.code ?? "bad_request", `task not saved: ${r.error}${hint}`, frame.cmd);
      } else {
        sendControl(client, "x-agentlinkd.tasks.put", { cwd, task: r.task });
      }
      return;
    }
    case "x-agentlinkd.tasks.delete": {
      const r = TASKS.delete(cwd, frame.name);
      if (r.error) sendError(client, r.code ?? "bad_request", `task '${String(frame.name)}': ${r.error}`, frame.cmd);
      return;
    }
    default:
      sendError(client, "unknown_command", `unsupported cmd ${String(frame.cmd)}`, frame.cmd);
  }
}

// ---------- self-edit commands (x-agentlinkd.ui.* / x-agentlinkd.host.*) ----------

async function handleSelfEditCommand(client, frame) {
  if (!SELF.enabled) {
    sendError(client, "unsupported", "self-edit is off on this host (not a buildable DextUI checkout)", frame.cmd);
    return;
  }
  switch (frame.cmd) {
    case "x-agentlinkd.ui.status":
      sendControl(client, "x-agentlinkd.ui.status", SELF.status());
      return;
    case "x-agentlinkd.ui.build": {
      if (SELF.isBuilding()) {
        sendError(client, "busy", "a UI build is already running", frame.cmd);
        return;
      }
      // Progress and the result ride the broadcast x-agentlinkd.ui.build events.
      void SELF.build({ check: frame.check !== false, tests: frame.tests === true, by: `client:${client.id}` });
      sendControl(client, "x-agentlinkd.ui.status", SELF.status());
      return;
    }
    case "x-agentlinkd.ui.rollback": {
      const r = SELF.rollback({ by: `client:${client.id}` });
      if (!r.ok) sendError(client, r.error === "busy" ? "busy" : "bad_request", r.message ?? r.error, frame.cmd);
      else sendControl(client, "x-agentlinkd.ui.status", SELF.status());
      return;
    }
    case "x-agentlinkd.host.restart": {
      const r = SELF.requestRestart({ reason: typeof frame.reason === "string" ? frame.reason : "", by: `client:${client.id}`, force: frame.force === true });
      sendControl(client, "x-agentlinkd.ui.status", { ...SELF.status(), restart: r });
      return;
    }
    case "x-agentlinkd.host.restart_cancel":
      SELF.cancelRestart();
      sendControl(client, "x-agentlinkd.ui.status", SELF.status());
      return;
    default:
      sendError(client, "unknown_command", `unsupported cmd ${String(frame.cmd)}`, frame.cmd);
  }
}

// ---------- HTTP ----------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

function checkAuth(req, res, allowQuery = false) {
  if (authLocked()) {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "rate_limited" }));
    return false;
  }
  const header = req.headers.authorization ?? "";
  let presented = header.startsWith("Bearer ") ? header.slice(7) : header;
  if (!presented && allowQuery) {
    // Subresource loads (<img>, <iframe>) cannot send Authorization headers;
    // the file endpoint also accepts ?t=<token>. Loopback single-operator
    // tradeoff, documented in PROTOCOL.md.
    presented = new URL(req.url, "http://localhost").searchParams.get("t") ?? "";
  }
  if (!tokenEquals(presented)) {
    // Only a WRONG token counts toward the lockout — missing auth on a stray
    // <img> from a stale page must never lock the operator out.
    if (presented) noteAuthFailure();
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return false;
  }
  return true;
}

// ---------- agent digest (GET /__agent) ----------

// Bounded AgentDigest: what is true right now plus the machine-form commands
// that are valid right now. Oldest sessions drop first to stay under 4 KiB.
function agentDigest() {
  const now = Date.now();
  let list = [...sessions.values()].sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  let omitted = 0;
  let body;
  for (;;) {
    body = {
      server: "agentlinkd",
      instance: INSTANCE,
      now,
      capabilities: CAPABILITIES,
      sessions: list.map((s) => ({
        id: s.id,
        title: s.title.slice(0, 60),
        status: s.status,
        working: s.working,
        model: s.model ?? undefined,
        cwd: s.cwd,
        last_seq: s.seq,
        last_event_age_ms: s.journal.length > 0 ? now - s.journal[s.journal.length - 1].ts : undefined,
        pending: [], // approvals live in dext's --approval policy, not the host
      })),
      actions: [
        ...list.flatMap((s) => {
          const acts = [];
          // prompt.submit is valid whenever a turn can run — idle OR working
          // (mid-turn it queues as steering and delivers at the boundary).
          if (s.status === "live" || s.status === "cold") {
            acts.push({
              cmd: "prompt.submit",
              session: s.id,
              ...(s.working ? { note: "queues as steering; delivered next turn" } : {}),
            });
          }
          if (s.working) acts.push({ cmd: "interrupt", session: s.id });
          if (s.status === "cold") acts.push({ cmd: "session.open", session: s.id });
          else if (s.status === "live") acts.push({ cmd: "session.close", session: s.id });
          if (s.seq > 0) acts.push({ cmd: "session.clear", session: s.id, note: "empty transcript, fresh context" });
          acts.push({ cmd: "session.delete", session: s.id, note: "purges journal + dext state" });
          return acts;
        }),
        { cmd: "session.open", note: "new session" },
        ...(list.length > 0 ? [{ cmd: "session.delete_all", note: "scope: all | cold" }] : []),
        ...(CREW
          ? CREW.summaries().runs.flatMap((r) => {
              const acts = [{ cmd: "x-agentlinkd.crew.open", run: r.id }];
              if (r.escalation) acts.push({ cmd: "x-agentlinkd.crew.resume", run: r.id, note: "answer: <text>" });
              if (["running", "pending", "paused"].includes(r.status)) acts.push({ cmd: "x-agentlinkd.crew.stop", run: r.id });
              if (["completed", "failed", "stopped"].includes(r.state)) acts.push({ cmd: "x-agentlinkd.crew.remove", run: r.id });
              return acts;
            })
          : []),
      ],
      ...(CREW ? { crews: CREW.summaries() } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(body)) <= 4096 || list.length === 0) break;
    list = list.slice(1);
    omitted += 1;
  }
  if (omitted > 0) body.sessions_omitted = omitted;
  return body;
}

// ---------- todos (GET /sessions/:id/todos) ----------

const TODOS_MAX_BYTES = 1024 * 1024;
const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);

// dext session headers (src/session.rs, format v3+) carry "seat":{"id":…}
// on their first JSON line. Seats are unique per agentlinkd session, so the
// dext session dirs whose header seat matches are this session's own state
// dirs (one per resume) — no need to reimplement dext's project_key derivation.
// Newest first.
function findDextSessionDirs(seat) {
  const home = process.env.DEXT_HOME ? path.resolve(process.env.DEXT_HOME) : path.join(process.env.HOME ?? "", ".dext");
  const projects = path.join(home, "projects");
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const project of projectDirs) {
    if (!project.isDirectory()) continue;
    const sessionsDir = path.join(projects, project.name, "sessions");
    let sessionDirs;
    try {
      sessionDirs = fs.readdirSync(sessionsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of sessionDirs) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(sessionsDir, entry.name);
      const headerFile = path.join(dir, "_latest.jsonl");
      let mtimeMs;
      try {
        const fd = fs.openSync(headerFile, "r");
        try {
          const cap = Buffer.alloc(64 * 1024);
          const n = fs.readSync(fd, cap, 0, cap.length, 0);
          const firstLine = cap.toString("utf8", 0, n).split("\n", 1)[0];
          const header = JSON.parse(firstLine);
          if (!header || typeof header !== "object" || header.seat?.id !== seat) continue;
        } finally {
          fs.closeSync(fd);
        }
        mtimeMs = fs.statSync(headerFile).mtimeMs;
      } catch {
        continue;
      }
      found.push({ dir, mtimeMs });
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map((f) => f.dir);
}

/** Newest dext session dir for this session's seat, or null. */
function findDextSessionDir(s) {
  return findDextSessionDirs(s.seat)[0] ?? null;
}

// Parse exactly like dext's TUI reader (src/tui.rs todo_items_from_path):
// array of objects, text trimmed non-empty, unknown status becomes pending.
function parseTodoItems(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const items = [];
  for (const el of parsed) {
    if (!el || typeof el !== "object" || typeof el.text !== "string") continue;
    const t = el.text.trim();
    if (!t) continue;
    const status = typeof el.status === "string" && TODO_STATUSES.has(el.status) ? el.status : "pending";
    items.push({ text: t, status });
  }
  return items;
}

function readTodoFile(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > TODOS_MAX_BYTES) return null;
  let items;
  try {
    items = parseTodoItems(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!items) return null;
  return { path: file, updated_at: Math.round(st.mtimeMs), items };
}

function todosFor(s) {
  // Seat-scoped only: this seat's own dext session state dir. No project-level
  // fallback — a missing session file must read as "no todos", so stale or
  // cross-session items never bleed into the UI.
  const dextDir = findDextSessionDir(s);
  if (dextDir) {
    const hit = readTodoFile(path.join(dextDir, "DEXT.todo.json"));
    if (hit) return { session: s.id, source: "session", ...hit };
  }
  return { session: s.id, source: "none", items: [] };
}

// ---------- session files (GET /sessions/:id/file?p=rel) ----------

const FILE_MAX_BYTES = 20 * 1024 * 1024;
const FILE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
};

// Resolve a session-relative path to a servable image. Confined to the
// session's cwd with realpath on both sides, so a symlink (in or out of the
// tree) cannot escape it; size-capped and MIME-allowlisted. Read-only:
// this exists so the UI can show charts/images a turn produced.
function sessionFile(s, rel) {
  if (typeof rel !== "string" || !rel || rel.length > 1024 || rel.includes("\0")) return null;
  try {
    const resolved = path.resolve(s.cwd, rel);
    if (!resolved.startsWith(s.cwd + path.sep)) return null;
    const real = fs.realpathSync(resolved);
    if (!real.startsWith(fs.realpathSync(s.cwd) + path.sep)) return null;
    const st = fs.statSync(real);
    if (!st.isFile() || st.size === 0 || st.size > FILE_MAX_BYTES) return null;
    const mime = FILE_MIME[path.extname(real).toLowerCase()];
    if (!mime) return null;
    return { real, mime };
  } catch {
    return null;
  }
}

// Response headers per artifact type. HTML dashboards run inline scripts and
// styles (self-contained model output) in a sandboxed opaque origin: they can
// never touch the app's storage/cookies, network is limited to images.
function fileHeaders(mime) {
  const html = mime.startsWith("text/html");
  return {
    "content-type": mime,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": html
      ? "default-src 'none'; style-src 'unsafe-inline'; img-src * data: blob:; script-src 'unsafe-inline'; font-src data:; sandbox allow-scripts"
      : "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  };
}

// Shared tail for both URL shapes of the file endpoint.
function serveSessionFile(s, rel, req, res) {
  const hit = sessionFile(s, rel);
  if (!hit) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no_file" }));
    return;
  }
  res.writeHead(200, fileHeaders(hit.mime));
  // A file vanishing between stat and read must not crash the host:
  // pipe() does not forward stream errors, so handle them here.
  const stream = fs.createReadStream(hit.real);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

const server = http.createServer((req, res) => {
  const pathName = new URL(req.url, "http://localhost").pathname;
  if (pathName === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, server: "agentlinkd", protocol: 1, dext: DEXT_BIN }));
    return;
  }
  if (pathName === "/packs" || pathName.startsWith("/packs/")) {
    if (!checkAuth(req, res, false)) return;
    if (pathName === "/packs") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-store" });
      res.end(JSON.stringify({ packs: publicPacks() }));
      return;
    }
    let name;
    try {
      name = decodeURIComponent(pathName.slice("/packs/".length));
    } catch {
      name = ""; // malformed percent-encoding is just "no such pack"
    }
    const pack = packByName(name);
    if (!pack) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no_pack" }));
      return;
    }
    // Metadata plus a shallow listing: names and sizes only, never contents,
    // never symlink targets. "Edit pack" needs the path, not the files.
    res.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-store" });
    res.end(JSON.stringify({ pack: { ...pack, files: listPackFiles(pack.path) } }));
    return;
  }
  if (pathName.startsWith("/hooks/")) {
    // Webhook trigger: POST /hooks/<token>. The token is derived from the
    // pairing token + workspace + flow name (HMAC), so it is unguessable and
    // never stored; no bearer needed (the token *is* the credential).
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    const token = pathName.slice("/hooks/".length);
    if (!/^[A-Za-z0-9_-]{32}$/.test(token) || authLocked()) {
      res.writeHead(authLocked() ? 429 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: authLocked() ? "rate_limited" : "no_hook" }));
      return;
    }
    req.on("data", () => {}); // body ignored (bounded by socket timeout)
    req.on("end", () => {
      const r = TRIGGERS.webhook(token);
      if (r.error) {
        noteAuthFailure(); // a wrong hook token counts like a wrong bearer
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no_hook" }));
        return;
      }
      res.writeHead(r.fired ? 202 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, flow: r.name, fired: r.fired, ...(r.fired ? {} : { note: "cooldown: fired less than a minute ago" }) }));
    });
    return;
  }
  if (pathName === "/__self" || pathName.startsWith("/__self/")) {
    // Self-edit surface for `/__agent` drivers and the agent's own bash:
    // GET status; POST build|rollback|restart|restart_cancel (JSON body optional).
    if (!checkAuth(req, res)) return;
    if (!SELF.enabled) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unsupported", message: "self-edit is off on this host" }));
      return;
    }
    const verb = pathName.slice("/__self".length).replace(/^\//, "");
    if (req.method === "GET" && !verb) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(SELF.status()));
      return;
    }
    if (req.method === "POST" && ["build", "rollback", "restart", "restart_cancel"].includes(verb)) {
      let body = "";
      req.on("data", (d) => { body = (body + d.toString("utf8")).slice(0, 4096); });
      req.on("end", async () => {
        let opts = {};
        try { opts = body.trim() ? JSON.parse(body) : {}; } catch { /* ignore */ }
        if (!opts || typeof opts !== "object") opts = {};
        let out;
        if (verb === "build") {
          if (SELF.isBuilding()) out = { ok: false, error: "busy" };
          else if (opts.wait === true) out = await SELF.build({ check: opts.check !== false, tests: opts.tests === true, by: "rest" });
          else { void SELF.build({ check: opts.check !== false, tests: opts.tests === true, by: "rest" }); out = { ok: true, started: true }; }
        } else if (verb === "rollback") out = SELF.rollback({ by: "rest" });
        else if (verb === "restart") out = SELF.requestRestart({ reason: typeof opts.reason === "string" ? opts.reason : "", by: "rest", force: opts.force === true });
        else out = { ok: true, cancelled: SELF.cancelRestart() };
        res.writeHead(out.ok === false ? (out.error === "busy" ? 409 : 400) : 200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      });
      return;
    }
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }
  if (pathName === "/sessions" || pathName === "/__agent" || pathName.startsWith("/sessions/")) {
    // The file endpoint also accepts ?t=<token> (subresource loads cannot send
    // Authorization headers); every other surface is header-only.
    const pre = pathName.split("/").filter(Boolean);
    if (!checkAuth(req, res, pre[0] === "sessions" && pre[2] === "file")) return;
    if (pathName === "/sessions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sessions: [...sessions.values()].map(metaOf) }));
      return;
    }
    if (pathName === "/__agent") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(agentDigest()));
      return;
    }
    const parts = pathName.split("/").filter(Boolean);
    const s = sessions.get(parts[1]);
    if (!s) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no_session" }));
      return;
    }
    if (parts.length === 2) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ session: metaOf(s) }));
      return;
    }
    if (parts.length === 3 && parts[2] === "todos") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(todosFor(s)));
      return;
    }
    if (parts.length >= 3 && parts[2] === "file") {
      // Path shape: /sessions/:id/file/<rel..> — required for HTML artifacts,
      // whose nested relative images must resolve against the document URL.
      // Query shape: /sessions/:id/file?p=<rel> — used by markdown images.
      // Auth (header or ?t=) was already checked at the outer gate.
      let rel;
      if (parts.length > 3) {
        try {
          rel = parts.slice(3).map(decodeURIComponent).join("/");
        } catch {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "no_file" }));
          return;
        }
      } else {
        rel = new URL(req.url, "http://localhost").searchParams.get("p") ?? "";
      }
      serveSessionFile(s, rel, req, res);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no_session" }));
    return;
  }
  const rel = pathName === "/" ? "index.html" : pathName.slice(1);
  const file = path.resolve(STATIC_DIR, rel);
  if (!file.startsWith(STATIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found (build apps/web to serve the PWA)");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(file));
});

// ---------- WS ----------

server.on("upgrade", (req, socket, head) => {
  const pathName = new URL(req.url, "http://localhost").pathname;
  const key = req.headers["sec-websocket-key"];
  const upgradeOk = /^websocket$/i.test(req.headers.upgrade ?? "") && /upgrade/i.test(req.headers.connection ?? "");
  if (pathName !== "/ws" || !upgradeOk || typeof key !== "string") {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  const client = {
    id: `c${++clientCounter}`,
    phase: "authing",
    subs: new Set(),
    crewOpen: new Set(),
    send: (text) => socket.write(encodeFrame(OP_TEXT, Buffer.from(text, "utf8"))),
    close: (code) => {
      try {
        socket.end(encodeFrame(0x8, Buffer.from([(code >> 8) & 0xff, code & 0xff])));
      } catch {
        /* already gone */
      }
    },
  };
  clients.add(client);
  const parser = new FrameParser({
    onMessage: (payload) => {
      let frame;
      try {
        frame = JSON.parse(payload.toString("utf8"));
      } catch {
        if (client.phase === "live") sendError(client, "bad_json", "malformed frame");
        return;
      }
      void handleCommand(client, frame).catch((err) => {
        console.error(`agentlinkd: ${frame?.cmd} failed: ${err.message}`);
        sendError(client, "operation_failed", `${frame?.cmd}: ${err.message}`);
      });
    },
    onClose: () => {
      clients.delete(client);
      socket.destroy();
    },
    onPing: (payload) => socket.write(encodeFrame(OP_PONG, payload)),
  });
  if (head && head.length > 0) parser.push(head);
  socket.on("data", (chunk) => parser.push(chunk));
  socket.on("close", () => clients.delete(client));
  socket.on("error", () => clients.delete(client));
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  for (const s of sessions.values()) killChild(s);
  const deadline = Date.now() + 5500;
  const wait = setInterval(() => {
    const active = [...sessions.values()].filter((s) => s.child);
    if (active.length === 0) {
      clearInterval(wait);
      persistIndex();
      process.exit(0);
    }
    if (Date.now() >= deadline) {
      for (const s of active) signalChild(s.child, "SIGKILL");
      clearInterval(wait);
      persistIndex();
      process.exit(1);
    }
  }, 100);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

initStateDir();
restoreSessions();
watchPackRoots();
SELF.start();
TRIGGERS.addWorkspace(DEFAULT_CWD);
TRIGGERS.start();

server.listen(PORT, "127.0.0.1", () => {
  console.log(`agentlinkd listening on http://127.0.0.1:${server.address().port}`);
  console.log(`  token:    ${TOKEN}`);
  console.log(`  dext:     ${DEXT_BIN}`);
  console.log(`  cwd:      ${DEFAULT_CWD}`);
  console.log(`  state:    ${STATE_DIR}`);
  console.log(`  static:   ${STATIC_DIR} (${STATIC_RESOLVED.mode}${SAFE_MODE ? ", --safe" : ""})`);
  console.log(`  self-edit: ${SELF.enabled ? `on — /ui build, exit ${SELF.status().restart_exit_code} = restart` : "off (not a buildable checkout)"}`);
  console.log(`  approval: ${DEFAULT_APPROVAL} (per-session: /approval <profile>)`);
  console.log(`  models:   ${MODEL_CATALOG.reduce((n, g) => n + g.models.length, 0)} across ${MODEL_CATALOG.length} provider(s)`);
});
