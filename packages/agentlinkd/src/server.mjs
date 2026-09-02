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
import { spawn, spawnSync } from "node:child_process";
import { acceptKey, FrameParser, encodeFrame, OP_PONG, OP_TEXT } from "../../mock-server/src/ws.mjs";
import { fold, foldMeta } from "../../mock-server/src/fold.mjs";

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
const DEFAULT_CWD = path.resolve(argValue("cwd", process.cwd()));
const DEFAULT_APPROVAL = argValue("approval", process.env.DEXT_APPROVAL ?? "auto-read");
const STATIC_DIR = path.resolve(argValue("static", path.join(repoRoot, "apps", "web", "dist")));
const STATE_DIR = path.resolve(
  argValue("state-dir", process.env.AGENTLINKD_STATE_DIR ?? path.join(process.env.HOME ?? "", ".dextui", "agentlinkd")),
);
const JOURNALS_DIR = path.join(STATE_DIR, "journals");
const INDEX_PATH = path.join(STATE_DIR, "sessions.json");
const JOURNAL_TRUNCATE_BYTES = 64 * 1024 * 1024;
const APPROVALS = new Set(["auto-read", "auto-write", "never", "always"]);
const EFFORT_OPTIONS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORTS = new Set(EFFORT_OPTIONS);
const MAX_PROMPT_CHARS = 1_000_000;
const MAX_STDOUT_BUFFER = 16 * 1024 * 1024;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error(`invalid --port '${PORT}'`);
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
    env: { ...process.env, DEXT_NO_TUI: "1" },
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : "";
}

function discoverModels() {
  const groups = [];
  let current = null;
  let readingModels = false;
  for (const line of dextOutput(["auth", "models"]).split("\n")) {
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

function discoverActiveModel(catalog) {
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
const DEFAULT_MODEL = discoverActiveModel(MODEL_CATALOG);
if (DEFAULT_MODEL.provider && DEFAULT_MODEL.model) {
  let group = MODEL_CATALOG.find((g) => g.provider === DEFAULT_MODEL.provider);
  if (!group) {
    group = { provider: DEFAULT_MODEL.provider, models: [] };
    MODEL_CATALOG.push(group);
  }
  if (!group.models.includes(DEFAULT_MODEL.model)) group.models.unshift(DEFAULT_MODEL.model);
}

// Real capabilities only. No "steering" (one-shot children have no stdin
// channel mid-turn) and no "approvals" (the interactive round-trip needs the
// upstream dext PermissionRequested bridge); dext's own --approval profile
// governs tool policy instead.
const CAPABILITIES = [
  "multi_session",
  "interrupt",
  "usage",
  "thinking",
  "effort_select",
  ...(MODEL_CATALOG.length > 0 ? ["model_select"] : []),
  "slash",
  "slash.help",
  "slash.approval",
  "todos_read",
];

// Host-handled slash commands, advertised in hello_ok so the composer's
// completion menu is driven by the host rather than a client-side guess.
const COMMANDS = [
  { cmd: "/help", desc: "list host commands" },
  { cmd: "/approval", desc: `set dext approval profile (${[...APPROVALS].join("|")}) — next turn` },
];

// Random per process: lets clients tell a reconnect to the same host (resume
// by seq) from a reconnect to a restarted one (resync from snapshot).
const INSTANCE = crypto.randomBytes(8).toString("hex");

// ---------- state ----------

let sessionCounter = 0;
let clientCounter = 0;
const sessions = new Map();
const clients = new Set();

function makeSession({ cwd, approval }) {
  const id = `sess_${(++sessionCounter).toString().padStart(3, "0")}`;
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
    turns: 0,
    child: null,
    killed: false,
    indexEntry: null,
  };
  sessions.set(id, s);
  persistIndex();
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
    turns: s.turns,
    createdAt: s.createdAt,
    updatedAt: tail?.ts ?? s.createdAt,
  };
}

// Rewrites sessions.json only when one of its fields actually changed; the
// tmp+rename swap keeps readers from ever seeing a torn index.
function persistIndex() {
  let dirty = false;
  for (const s of sessions.values()) {
    const entry = JSON.stringify(indexEntryOf(s));
    if (s.indexEntry !== entry) {
      s.indexEntry = entry;
      dirty = true;
    }
  }
  if (!dirty) return;
  try {
    lstatChecked(INDEX_PATH, "session index");
    const tmp = `${INDEX_PATH}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify([...sessions.values()].map(indexEntryOf), null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, INDEX_PATH);
  } catch (err) {
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
// and continue sessionCounter from the highest numeric id.
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
    };
    sessions.set(s.id, s);
    restoreJournal(s);
    terminateUnfinishedTurn(s);
    s.indexEntry = JSON.stringify(indexEntryOf(s));
    const n = Number(s.id.slice(5));
    if (Number.isInteger(n) && n > sessionCounter) sessionCounter = n;
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
      pending_permissions: [],
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

function runTurn(s, prompt) {
  s.working = true;
  s.turnStartedAt = Date.now();
  s.killed = false;
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
  if (s.turns > 0) args.push("--resume");
  const childEnv = { ...process.env, DEXT_NO_TUI: "1" };
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
  child.stdin.write(prompt);
  child.stdin.end();

  const handleLine = (line) => {
    const t = line.trim();
    if (!t) return;
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
      s.modelLocked = true;
      publish(journalData(s, "session.configured", {
        provider: s.provider ?? undefined,
        model: s.model ?? undefined,
        thinking_effort: s.thinkingEffort,
        model_locked: true,
      }));
      publish(journalData(s, "turn_end", turnEndData));
    }
    persistIndex();
    scheduleList();
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
  const child = s.child;
  if (!child) return;
  s.killed = interrupted;
  signalChild(child, "SIGINT");
  setTimeout(() => {
    if (s.child === child) signalChild(child, "SIGKILL");
  }, 5000);
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

// ---------- command dispatch ----------

function sendControl(client, event, data) {
  const env = { v: 1, ts: Date.now(), event };
  if (data !== undefined) env.data = data;
  client.send(JSON.stringify(env));
}

function sendError(client, code, message) {
  sendControl(client, "error", { code, message });
}

const HOST_HELP = [
  "agentlinkd host commands:",
  "  /help                 this text",
  "  /approval <profile>   set this session's dext approval profile",
  `                        (${[...APPROVALS].join(" | ")}) — applies from the next turn`,
  "",
  "everything else runs inside dext itself. steering and interactive",
  "approvals need the upstream dext bridge and are not yet available.",
].join("\n");

function handleSlash(client, s, raw) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "/help") {
    publish(journalData(s, "slash", HOST_HELP));
    return;
  }
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
    publish(journalData(s, "slash", `approval profile → ${profile} (next turn)`));
    return;
  }
  sendError(client, "unsupported", `host handles /help and /approval only; '${trimmed.split(/\s/)[0]}' needs interactive dext`);
}

function handleCommand(client, frame) {
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
      commands: COMMANDS,
    });
    return;
  }
  if (client.phase !== "live") return;

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
      const requestedCwd = typeof frame.cwd === "string" ? path.resolve(frame.cwd) : DEFAULT_CWD;
      if (!fs.existsSync(requestedCwd) || !fs.statSync(requestedCwd).isDirectory()) {
        sendError(client, "bad_request", `cwd is not a directory: ${requestedCwd}`);
        return;
      }
      const cwd = requestedCwd;
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
      if (s.working) {
        sendError(client, "busy", "settings apply between turns; stop or wait for the current turn");
        return;
      }
      const wantsModel = frame.provider !== undefined || frame.model !== undefined;
      if (wantsModel) {
        if (s.modelLocked || s.turns > 0) {
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
        s.provider = frame.provider;
        s.model = frame.model;
      }
      if (frame.thinking_effort !== undefined) s.thinkingEffort = frame.thinking_effort;
      persistIndex();
      publish(journalData(s, "session.configured", {
        provider: s.provider ?? undefined,
        model: s.model ?? undefined,
        thinking_effort: s.thinkingEffort,
        model_locked: s.modelLocked,
      }));
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
      s.status = "cold";
      publish(journalData(s, "session.state", { status: "cold" }));
      persistIndex();
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
      if (s.working) {
        sendError(client, "busy", "a turn is already running; interrupt it first");
        return;
      }
      if (s.status === "cold") wakeSession(s);
      publish(journalData(s, "user_message", { text: frame.text }));
      if (s.title === "New session") {
        s.title = frame.text.slice(0, 60);
        persistIndex();
      }
      runTurn(s, frame.text);
      return;
    }

    case "steering.inject": {
      sendError(client, "unsupported", "steering needs the upstream dext bridge (one-shot turns have no live stdin)");
      return;
    }

    case "interrupt": {
      const s = sessions.get(frame.session);
      if (!s) {
        sendError(client, "no_session", `unknown session ${frame.session}`);
        return;
      }
      killChild(s);
      return;
    }

    case "permission.respond": {
      sendError(client, "unsupported", "approvals are governed by the session's dext --approval profile (/approval <profile>)");
      return;
    }

    case "slash": {
      const s = sessions.get(frame.session);
      if (!s) {
        sendError(client, "no_session", `unknown session ${frame.session}`);
        return;
      }
      handleSlash(client, s, frame.raw);
      return;
    }

    default:
      sendError(client, "unknown_command", `unsupported cmd ${String(frame.cmd)}`);
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

function checkAuth(req, res) {
  if (authLocked()) {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "rate_limited" }));
    return false;
  }
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : header;
  if (!tokenEquals(presented)) {
    noteAuthFailure();
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
          if (s.working) acts.push({ cmd: "interrupt", session: s.id });
          else if (s.status === "live" || s.status === "cold") acts.push({ cmd: "prompt.submit", session: s.id });
          if (s.status === "cold") acts.push({ cmd: "session.open", session: s.id });
          else if (s.status === "live") acts.push({ cmd: "session.close", session: s.id });
          return acts;
        }),
        { cmd: "session.open", note: "new session" },
      ],
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
// newest dext session dir whose header seat matches is this session's own
// state dir — no need to reimplement dext's project_key derivation.
function findDextSessionDir(s) {
  const home = process.env.DEXT_HOME ? path.resolve(process.env.DEXT_HOME) : path.join(process.env.HOME ?? "", ".dext");
  const projects = path.join(home, "projects");
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    return null;
  }
  let best = null;
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
          if (!header || typeof header !== "object" || header.seat?.id !== s.seat) continue;
        } finally {
          fs.closeSync(fd);
        }
        mtimeMs = fs.statSync(headerFile).mtimeMs;
      } catch {
        continue;
      }
      if (!best || mtimeMs > best.mtimeMs) best = { dir, mtimeMs };
    }
  }
  return best?.dir ?? null;
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
  // (a) this seat's own dext session state dir, (b) the project-level file.
  const dextDir = findDextSessionDir(s);
  if (dextDir) {
    const hit = readTodoFile(path.join(dextDir, "DEXT.todo.json"));
    if (hit) return { session: s.id, source: "session", ...hit };
  }
  const project = readTodoFile(path.join(s.cwd, "DEXT.todo.json"));
  if (project) return { session: s.id, source: "project", ...project };
  return { session: s.id, source: "none", items: [] };
}

const server = http.createServer((req, res) => {
  const pathName = new URL(req.url, "http://localhost").pathname;
  if (pathName === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, server: "agentlinkd", protocol: 1, dext: DEXT_BIN }));
    return;
  }
  if (pathName === "/sessions" || pathName === "/__agent" || pathName.startsWith("/sessions/")) {
    if (!checkAuth(req, res)) return;
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
      handleCommand(client, frame);
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

server.listen(PORT, "127.0.0.1", () => {
  console.log(`agentlinkd listening on http://127.0.0.1:${PORT}`);
  console.log(`  token:    ${TOKEN}`);
  console.log(`  dext:     ${DEXT_BIN}`);
  console.log(`  cwd:      ${DEFAULT_CWD}`);
  console.log(`  state:    ${STATE_DIR}`);
  console.log(`  approval: ${DEFAULT_APPROVAL} (per-session: /approval <profile>)`);
  console.log(`  models:   ${MODEL_CATALOG.reduce((n, g) => n + g.models.length, 0)} across ${MODEL_CATALOG.length} provider(s)`);
});
