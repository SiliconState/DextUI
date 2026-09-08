// Bounded attempt-scoped event replay. Paths come only from the crew adapter.
import fs from "node:fs";
import net from "node:net";

const WINDOW = 512 * 1024;
function readRegular(file, limit, tail = false) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error("not a regular worker file");
    if (!tail && st.size > limit) throw new Error("worker metadata too large");
    const start = tail ? Math.max(0, st.size - limit) : 0;
    const buf = Buffer.alloc(Math.min(limit, st.size));
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    return { text: buf.subarray(0, n).toString("utf8"), clipped: start > 0 };
  } finally { fs.closeSync(fd); }
}
export function registration(source) {
  const meta = JSON.parse(readRegular(source.registration, 256 * 1024).text);
  if (meta.v !== 1 || !/^[a-f0-9]{48}$/.test(meta.attempt) || meta.run !== source.run || typeof meta.worker !== "string" || !Number.isSafeInteger(meta.last_seq)) throw new Error("invalid worker identity");
  return meta;
}
export function readEvents(source, cursor) {
  const meta = registration(source);
  const same = cursor?.attempt === meta.attempt && Number.isSafeInteger(cursor.seq) && cursor.seq >= 0 && cursor.seq <= meta.last_seq;
  const read = readRegular(source.events, WINDOW, true);
  let lines = read.text.split("\n");
  lines.pop(); // A partial final record is never an event.
  if (read.clipped) lines.shift();
  const records = [];
  let malformed = false;
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (r.v !== 1 || r.attempt !== meta.attempt || r.run !== meta.run || r.worker !== meta.worker || !Number.isSafeInteger(r.seq) || typeof r.event !== "string") throw new Error("invalid record");
      records.push(r);
    } catch { malformed = true; }
  }
  const first = records[0]?.seq ?? meta.first_seq;
  const gap = malformed || (same ? cursor.seq < first - 1 : first > 1 || !!cursor);
  const reset = !same || gap;
  const after = reset ? 0 : cursor.seq;
  const events = records.filter((r) => r.seq > after).slice(0, 256);
  let expected = reset ? first : after + 1;
  for (const r of events) { if (r.seq !== expected) malformed = true; expected = r.seq + 1; }
  const p = meta.permission;
  const permission = !meta.ended && p && typeof p.id === "string" ? {
    id: p.id, tool: String(p.tool ?? "tool"), summary: String(p.summary ?? "").slice(0, 4096),
    choices: Array.isArray(p.choices) ? p.choices.filter((c) => ["once", "always", "deny"].includes(c)) : [], sent: p.sent === true,
  } : null;
  return { attempt: meta.attempt, seq: events.at(-1)?.seq ?? (same ? cursor.seq : 0), reset, gap: gap || malformed, events, ended: meta.ended === true, interactive: meta.interactive === true, permission };
}
export function subscribeEvents({ source, cursor = null, send, writable = () => true }) {
  let observed = cursor;
  let unavailable = false;
  let closed = false;
  let lastState = "";
  function tick() {
    if (closed || !writable()) return;
    try {
      const src = source();
      if (!src) throw new Error("no worker");
      const chunk = readEvents(src, observed);
      const state = JSON.stringify([chunk.ended, chunk.permission]);
      if (!chunk.reset && !chunk.events.length && !unavailable && state === lastState) return;
      if (send(chunk) !== false) { observed = { attempt: chunk.attempt, seq: chunk.seq }; unavailable = false; lastState = state; }
    } catch {
      if (!unavailable) { send({ unavailable: true }); unavailable = true; }
    }
  }
  const timer = setInterval(tick, 250);
  timer.unref();
  tick();
  return () => { closed = true; clearInterval(timer); };
}
export async function replyPermission(source, { attempt, id, choice }) {
  if (typeof id !== "string" || id.length > 200 || !["once", "always", "deny"].includes(choice)) return { accepted: false };
  const meta = registration(source);
  if (meta.attempt !== attempt || !meta.interactive || meta.ended || !/^[a-f0-9]{48}$/.test(meta.token) || typeof meta.socket !== "string" || !/^\/tmp\/dext-crew-[a-f0-9]{48}\/control\.sock$/.test(meta.socket)) return { accepted: false };
  const parent = fs.lstatSync(meta.socket.slice(0, meta.socket.lastIndexOf("/")));
  const st = fs.lstatSync(meta.socket);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077 || !st.isSocket() || st.uid !== process.getuid() || parent.uid !== process.getuid()) return { accepted: false };
  return new Promise((resolve) => {
    const socket = net.createConnection(meta.socket);
    let text = "";
    let done = false;
    const finish = (accepted) => { if (done) return; done = true; socket.destroy(); resolve({ accepted }); };
    socket.setTimeout(2000, () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("end", () => finish(false));
    socket.on("connect", () => socket.write(JSON.stringify({ run: meta.run, worker: meta.worker, attempt, token: meta.token, id, choice }) + "\n"));
    socket.on("data", (data) => {
      text += data.toString();
      if (text.length > 1024) return finish(false);
      if (text.includes("\n")) { try { finish(JSON.parse(text).accepted === true); } catch { finish(false); } }
    });
  });
}
