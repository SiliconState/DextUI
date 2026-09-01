#!/usr/bin/env node
// agentlinkd: the REAL AgentLink v1 host. Bridges dext one-shot processes
// (--output stream-json) to the DextUI web client over WebSocket, with
// seat-based session resume, per-session journals, and static PWA serving.
//
//   node packages/agentlinkd/src/server.mjs \
//     [--port=8788] [--token=SECRET] [--dext=/path/to/dext] \
//     [--cwd=/work/dir] [--approval=auto-read] [--static=apps/web/dist]
//
// Every prompt becomes one dext child:
//   turn 1:  dext -p --output stream-json --cd CWD --approval P --seat SEAT
//   turn 2+: dext -p --output stream-json --cd CWD --approval P --seat SEAT --resume
// The child's ndjson events are journaled and fanned out verbatim; the client
// already speaks this dialect byte-for-byte (fixtures are recordings of it).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { acceptKey, FrameParser, encodeFrame, OP_PONG, OP_TEXT } from "../../mock-server/src/ws.mjs";
import { fold } from "../../mock-server/src/fold.mjs";

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
const APPROVALS = new Set(["ask", "auto-read", "auto-write", "never", "always"]);

// Real capabilities only. No "steering" (one-shot children have no stdin
// channel mid-turn) and no "approvals" (the interactive round-trip needs the
// upstream dext PermissionRequested bridge); dext's own --approval profile
// governs tool policy instead.
const CAPABILITIES = ["multi_session", "interrupt", "usage", "thinking", "slash"];

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
    seat: `dextui-${crypto.randomBytes(4).toString("hex")}`,
    status: "live",
    working: false,
    createdAt: Date.now(),
    seq: 0,
    journal: [],
    pending: new Map(), // always empty: approvals live in dext's own policy
    turns: 0,
    child: null,
    killed: false,
    model: null,
  };
  sessions.set(id, s);
  return s;
}

// ---------- journal + publish ----------

function journalData(s, event, data) {
  const env = { v: 1, session: s.id, seq: ++s.seq, ts: Date.now(), event };
  if (data !== undefined) env.data = data;
  s.journal.push(env);
  return env;
}

function metaOf(s) {
  return {
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    agent: { name: "dext", version: "cli" },
    model: s.model ?? undefined,
    approval_profile: s.approval,
    status: s.status,
    created_at: s.createdAt,
    updated_at: Date.now(),
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
  const env = journalData(s, "session.snapshot", {
    meta: metaOf(s),
    blocks: fold(s.journal),
    pending_permissions: [],
    last_seq: 0,
  });
  env.data.last_seq = env.seq;
  return env;
}

// ---------- turn engine: one dext child per prompt ----------

function zeroUsage() {
  return { input: 0, output: 0, cache_create: 0, cache_read: 0, cost_usd: 0 };
}

function runTurn(s, prompt) {
  s.working = true;
  s.killed = false;
  let sawTurnEnd = false;

  const args = ["-p", "--output", "stream-json", "--cd", s.cwd, "--approval", s.approval, "--seat", s.seat];
  if (s.turns > 0) args.push("--resume");

  let child;
  try {
    child = spawn(DEXT_BIN, args, {
      cwd: s.cwd,
      env: { ...process.env, DEXT_NO_TUI: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    publish(journalData(s, "error", `failed to spawn dext (${DEXT_BIN}): ${String(err)}`));
    publish(journalData(s, "turn_end", { usage: zeroUsage(), failed: true }));
    s.working = false;
    return;
  }
  s.child = child;
  child.stdin.write(prompt);
  child.stdin.end();

  let buf = "";
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
    if (v.event === "turn_end") sawTurnEnd = true;
    if (v.event === "turn_diagnostics" && v.data && typeof v.data.model === "string") s.model = v.data.model;
    publish(journalData(s, v.event, v.data));
  };

  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      handleLine(line);
    }
  });

  let errTail = "";
  child.stderr.on("data", (d) => {
    errTail = (errTail + d.toString("utf8")).slice(-2000);
  });

  child.on("error", (err) => {
    publish(journalData(s, "error", `dext spawn error: ${String(err)}`));
  });

  child.on("close", (code) => {
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
    s.turns += 1;
    scheduleList();
  });
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
    if (frame.token !== TOKEN) {
      sendControl(client, "hello_fail", { reason: "invalid token" });
      client.close(1008);
      return;
    }
    client.phase = "live";
    sendControl(client, "hello_ok", {
      server: "agentlinkd",
      version: "0.1.0",
      protocol: 1,
      capabilities: CAPABILITIES,
      sessions: [...sessions.values()].map(metaOf),
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
        scheduleList();
        return;
      }
      const cwd = typeof frame.cwd === "string" && fs.existsSync(frame.cwd) ? path.resolve(frame.cwd) : DEFAULT_CWD;
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
      if (typeof since === "number" && since >= 0 && since <= s.seq) {
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

    case "session.rename": {
      const s = sessions.get(frame.id);
      if (!s || typeof frame.title !== "string" || !frame.title.trim()) {
        sendError(client, "bad_request", "session.rename needs id and title");
        return;
      }
      s.title = frame.title.trim().slice(0, 80);
      scheduleList();
      return;
    }

    case "session.close": {
      const s = sessions.get(frame.id);
      if (!s) {
        sendError(client, "no_session", `unknown session ${frame.id}`);
        return;
      }
      if (s.child) {
        s.killed = true;
        s.child.kill("SIGINT");
      }
      s.status = "exited";
      publish(journalData(s, "session.state", { status: "exited" }));
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
      if (s.status !== "live") {
        sendError(client, "not_live", "session is closed");
        return;
      }
      if (s.working) {
        sendError(client, "busy", "a turn is already running; interrupt it first");
        return;
      }
      publish(journalData(s, "user_message", { text: frame.text }));
      if (s.title === "New session") s.title = frame.text.slice(0, 60);
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
      if (s.child) {
        s.killed = true;
        s.child.kill("SIGINT");
      }
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

function requireAuth(req) {
  return (req.headers.authorization ?? "") === `Bearer ${TOKEN}`;
}

const server = http.createServer((req, res) => {
  const pathName = new URL(req.url, "http://localhost").pathname;
  if (pathName === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, server: "agentlinkd", protocol: 1, dext: DEXT_BIN }));
    return;
  }
  if (pathName === "/sessions" || pathName === "/__agent") {
    if (!requireAuth(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sessions: [...sessions.values()].map(metaOf) }));
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

server.listen(PORT, "127.0.0.1", () => {
  console.log(`agentlinkd listening on http://127.0.0.1:${PORT}`);
  console.log(`  token:    ${TOKEN}`);
  console.log(`  dext:     ${DEXT_BIN}`);
  console.log(`  cwd:      ${DEFAULT_CWD}`);
  console.log(`  approval: ${DEFAULT_APPROVAL} (per-session: /approval <profile>)`);
});
