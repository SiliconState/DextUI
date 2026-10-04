// Agent-writable one-shot timers. No link traversal or unbounded JSON reads.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { checkedPath } from "./session-files.mjs";
export const TIMER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CAP = 128 * 1024;
const SUFFIX = ".timer.json";

export function validateTimer(raw, name = raw?.name) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "timer must be an object" };
  if (typeof name !== "string" || !TIMER_NAME_RE.test(name)) return { error: "bad_name" };
  // Bare {at, session, prompt} is rev 1; later edits must increase it.
  const rev = raw.rev === undefined ? 1 : raw.rev;
  if (!Number.isSafeInteger(rev) || rev < 1) return { error: "bad_rev" };
  if (typeof raw.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw.at) || !Number.isFinite(Date.parse(raw.at))) return { error: "at needs an ISO timestamp with timezone" };
  const civil = new Date(raw.at.slice(0, 19) + "Z");
  if (!Number.isFinite(civil.getTime()) || civil.toISOString().slice(0, 19) !== raw.at.slice(0, 19)) return { error: "invalid calendar timestamp" };
  if (typeof raw.session !== "string" || !/^sess_\d+$/.test(raw.session)) return { error: "bad_session" };
  if (typeof raw.prompt !== "string" || !raw.prompt.trim() || raw.prompt.length > 100_000) return { error: "prompt needs 1..100000 characters" };
  const at = new Date(raw.at).toISOString();
  if (!/^\d{4}-/.test(at)) return { error: "timestamp is outside the supported calendar range" };
  return { ok: true, timer: { name, rev, at, session: raw.session, prompt: raw.prompt.trim(), kind: "at" } };
}
export function timersDir(cwd, { create = false } = {}) {
  const dir = path.join(cwd, ".dext", "timers");
  try {
    if (!checkedPath(dir)) {
      if (!create) return null;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    return checkedPath(dir) && fs.statSync(dir).isDirectory() ? dir : null;
  } catch { return null; }
}
export function readTimer(cwd, name) {
  if (typeof name !== "string" || !TIMER_NAME_RE.test(name)) return { error: "bad_name" };
  const dir = timersDir(cwd);
  if (!dir) return { error: "no_dir" };
  const file = path.join(dir, name + SUFFIX);
  let fd;
  try {
    checkedPath(file);
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { error: "refused" };
    if (st.size > CAP) return { error: "too_large" };
    const buf = Buffer.alloc(CAP + 1);
    const size = fs.readSync(fd, buf, 0, buf.length, 0);
    if (size > CAP) return { error: "too_large" };
    return validateTimer(JSON.parse(buf.toString("utf8", 0, size)), name);
  } catch (err) { return { error: err.code === "ENOENT" ? "no_timer" : "refused_or_invalid" }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function listTimers(cwd) {
  const dir = timersDir(cwd);
  if (!dir) return [];
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(SUFFIX) && TIMER_NAME_RE.test(f.slice(0, -SUFFIX.length))).sort().slice(0, 64).map((f) => readTimer(cwd, f.slice(0, -SUFFIX.length))).filter((r) => r.ok).map((r) => r.timer);
  } catch { return []; }
}
// Host/test write helper, mirroring task CAS and unique-temp atomic rename.
export function writeTimer(cwd, raw, { expectedRev } = {}) {
  const v = validateTimer(raw);
  if (!v.ok) return v;
  const prev = readTimer(cwd, v.timer.name);
  if (prev.error && !["no_timer", "no_dir"].includes(prev.error)) return prev;
  if (expectedRev !== undefined && (!Number.isSafeInteger(expectedRev) || expectedRev < 0 || expectedRev !== (prev.timer?.rev ?? 0))) return { error: "stale_rev" };
  const timer = { ...v.timer, rev: (prev.timer?.rev ?? 0) + 1 };
  if (!Number.isSafeInteger(timer.rev)) return { error: "bad_rev" };
  const text = JSON.stringify(timer) + "\n";
  if (Buffer.byteLength(text) > CAP) return { error: "too_large" };
  const dir = timersDir(cwd, { create: true });
  if (!dir) return { error: "refused" };
  const file = path.join(dir, timer.name + SUFFIX);
  const tmp = path.join(dir, `.timer-${crypto.randomBytes(8).toString("hex")}.tmp`);
  try {
    checkedPath(file);
    fs.writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
    const fd = fs.openSync(tmp, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    checkedPath(file);
    fs.renameSync(tmp, file);
    const dfd = fs.openSync(dir, "r"); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    return { ok: true, timer };
  } catch { return { error: "write_failed" }; }
  finally { try { fs.rmSync(tmp, { force: true }); } catch { /* cleanup must not mask the write result */ } }
}
