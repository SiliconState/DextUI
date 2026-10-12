// One agentlinkd per state dir. Two hosts on the same journals interleave
// appends with duplicate sequence numbers and "restart" each other's turns, so
// a second host must refuse before it writes anything.
//
// The lock is <state>/agentlinkd.lock: {pid, started, port, nonce, at}. A holder
// is live only if its pid exists AND its process start time still matches, so a
// recycled pid after a crash or SIGKILL is not mistaken for the old host. The
// lock is published with link(2), so readers never see a half-written file, and
// it is removed on any exit of the holder (including uncaught exceptions).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export const LOCK_NAME = "agentlinkd.lock";

/** Start time of a process as `ps` reports it (C locale, UTC), or null. */
export function processStarted(pid) {
  if (process.platform === "win32") return null;
  for (const ps of ["/bin/ps", "/usr/bin/ps"]) {
    const r = spawnSync(ps, ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: 3000 });
    if (r.error?.code === "ENOENT") continue;
    const out = r.status === 0 ? String(r.stdout).trim().replace(/\s+/g, " ") : "";
    return out || null;
  }
  return null;
}

function readLock(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    if (err.code === "ELOOP") throw new Error(`state lock is a symlink, refusing: ${file}`);
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`state lock is not a regular file: ${file}`);
    const raw = st.size <= 4096 ? fs.readFileSync(fd, "utf8") : "";
    let holder = null;
    try { holder = JSON.parse(raw); } catch { /* unreadable: treated as stale */ }
    return { raw, holder };
  } finally { fs.closeSync(fd); }
}

function alive(holder) {
  if (!holder || !Number.isInteger(holder.pid) || holder.pid <= 0) return false;
  try { process.kill(holder.pid, 0); } catch (err) { if (err.code !== "EPERM") return false; }
  if (typeof holder.started === "string" && holder.started) {
    const now = processStarted(holder.pid);
    if (now && now !== holder.started) return false; // the pid was recycled
  }
  return true;
}

function publish(tmp, file, raw) {
  try {
    fs.linkSync(tmp, file);
  } catch (err) {
    // Filesystems without hard links: an exclusive create is still atomic for
    // existence; a reader racing the write sees an unparsable file only briefly.
    if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(err.code)) throw err;
    fs.writeFileSync(file, raw, { mode: 0o600, flag: "wx" });
  }
}

/** Acquire the state-dir lock or throw an error with code "ELOCKED". */
export function acquireStateLock({ stateDir, port, log = () => {} }) {
  const file = path.join(stateDir, LOCK_NAME);
  const record = { pid: process.pid, started: processStarted(process.pid), port, nonce: crypto.randomBytes(8).toString("hex"), at: new Date().toISOString() };
  const raw = `${JSON.stringify(record)}\n`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, raw, { mode: 0o600, flag: "wx" });
    try {
      publish(tmp, file, raw);
      return handle(file, record);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    } finally { fs.rmSync(tmp, { force: true }); }
    const current = readLock(file);
    if (!current) continue; // released between our attempt and the read
    const h = current.holder;
    if (h && h.nonce !== record.nonce && h.pid !== process.pid && alive(h)) {
      const err = new Error(
        `another agentlinkd (pid ${h.pid}${h.port !== undefined ? `, port ${h.port}` : ""}${h.at ? `, since ${h.at}` : ""}) is using state dir ${stateDir}. ` +
        `Nothing was changed. Stop that host first, or start this one with a different --state-dir. If no such process is running, delete ${file}.`,
      );
      throw Object.assign(err, { code: "ELOCKED", holder: h, file });
    }
    // Stale: dead pid, recycled pid, or unreadable. Move it aside atomically and
    // confirm the moved file is the record judged stale, not a lock another
    // starting host published in between; restore that one if so.
    const aside = `${file}.stale.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
    try { fs.renameSync(file, aside); } catch (err) { if (err.code === "ENOENT") continue; throw err; }
    let moved = null;
    try { moved = readLock(aside); } catch { /* unreadable aside: discard */ }
    if (moved && moved.raw !== current.raw) {
      try { fs.linkSync(aside, file); } catch { /* a third host holds it now */ }
    } else {
      log(`removed stale state lock ${file} (pid ${h?.pid ?? "unknown"} is no longer running)`);
    }
    fs.rmSync(aside, { force: true });
  }
  throw new Error(`could not acquire state lock ${file}; retry the start`);
}

function handle(file, record) {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (readLock(file)?.holder?.nonce === record.nonce) fs.rmSync(file, { force: true });
    } catch { /* best effort on exit */ }
  };
  // "exit" also runs for uncaught exceptions and process.exit(); a SIGKILLed
  // holder leaves a lock that the liveness check treats as stale.
  process.once("exit", release);
  return { file, record, release };
}
