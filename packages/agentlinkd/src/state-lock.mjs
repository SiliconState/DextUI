// One agentlinkd per state dir. Lock publication and stale-lock replacement are
// serialized by an atomically published guard. We never rename a record judged
// stale without that guard: another starter could have replaced it meanwhile.
// A killed guard owner requires explicit operator cleanup (fail closed); dead
// main locks are reclaimed automatically. No half-written lock is published.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export const LOCK_NAME = "agentlinkd.lock";
export const GUARD_NAME = `${LOCK_NAME}.guard`;

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
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) throw new Error(`state lock is a symlink, refusing: ${file}`);
    if (!st.isFile()) throw new Error(`state lock is not a regular file: ${file}`);
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
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
    try { holder = JSON.parse(raw); } catch { /* malformed main locks are stale */ }
    return { raw, holder };
  } finally { fs.closeSync(fd); }
}

function alive(holder) {
  if (!holder || !Number.isInteger(holder.pid) || holder.pid <= 0) return false;
  try { process.kill(holder.pid, 0); } catch (err) { if (err.code !== "EPERM") return false; }
  if (typeof holder.started === "string" && holder.started) {
    const now = processStarted(holder.pid);
    if (now && now !== holder.started) return false;
  }
  return true;
}

function publish(file, record) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
  try {
    // No exclusive-write fallback: it exposes an empty record that another
    // starter could mistake for a stale lock. Unsupported filesystems refuse.
    fs.linkSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

function removeOwned(file, record) {
  if (readLock(file)?.holder?.nonce === record.nonce) fs.rmSync(file, { force: true });
}

function withGuard(stateDir, record, action) {
  const guard = path.join(stateDir, GUARD_NAME);
  try { publish(guard, record); }
  catch (err) {
    if (err.code !== "EEXIST") throw err;
    const current = readLock(guard);
    const live = current && alive(current.holder);
    throw Object.assign(new Error(live
      ? `another agentlinkd is acquiring or releasing state dir ${stateDir}; retry the start`
      : `stale state-lock guard ${guard}; ensure no host is starting or running, then remove this guard and retry`), { code: "ELOCKED" });
  }
  try { return action(); }
  finally { removeOwned(guard, record); }
}

/** Acquire the state-dir lock or throw an error with code "ELOCKED". */
export function acquireStateLock({ stateDir, port, log = () => {} }) {
  const file = path.join(stateDir, LOCK_NAME);
  const record = { pid: process.pid, started: processStarted(process.pid), port, nonce: crypto.randomBytes(8).toString("hex"), at: new Date().toISOString() };
  withGuard(stateDir, record, () => {
    const current = readLock(file);
    const h = current?.holder;
    if (h && alive(h)) {
      throw Object.assign(new Error(
        `another agentlinkd (pid ${h.pid}${h.port !== undefined ? `, port ${h.port}` : ""}${h.at ? `, since ${h.at}` : ""}) is using state dir ${stateDir}. ` +
        `Nothing was changed. Stop that host first, or start this one with a different --state-dir. If no such process is running, delete ${file}.`,
      ), { code: "ELOCKED", holder: h, file });
    }
    if (current) {
      fs.rmSync(file);
      log(`removed stale state lock ${file} (pid ${h?.pid ?? "unknown"} is no longer running)`);
    }
    publish(file, record);
  });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener("exit", release);
    try { withGuard(stateDir, record, () => removeOwned(file, record)); }
    catch { /* main lock remains reclaimable after this process exits */ }
  };
  process.once("exit", release);
  return { file, record, release };
}
