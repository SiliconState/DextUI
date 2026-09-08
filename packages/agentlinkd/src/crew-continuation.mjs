// Reconcile the crew-owned continuation record; never launch or retry from the host.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

export function createContinuationMonitor({ changed = () => {}, exec = execFile } = {}) {
  const cache = new Map();
  const inflight = new Set();
  let closed = false;
  function readRecord(file) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > 16384) throw new Error("invalid continuation record");
      return JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally { fs.closeSync(fd); }
  }
  function inspect(dir) {
    const file = path.join(dir, "continuation.json");
    let record;
    try {
      record = readRecord(file);
      if (!/^dext-crew-[a-zA-Z0-9_-]+-resume-run-[a-f0-9]{12}$/.test(record.unit)) return null;
    } catch { return null; }
    const old = cache.get(dir);
    if (old?.unit === record.unit && Date.now() - old.checked < 2000) return old;
    if (!inflight.has(dir) && !closed) {
      inflight.add(dir);
      exec("systemctl", ["--user", "show", record.unit, "--property=LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus"], { timeout: 3000, maxBuffer: 8192 }, (error, stdout, stderr) => {
        if (closed) return;
        const fields = Object.fromEntries(String(stdout).trim().split("\n").map((line) => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
        const age = Date.now() / 1000 - Number(record.created);
        let state = "pending";
        if (record.state === "failed") state = "failed";
        else if (["active", "activating", "reloading"].includes(fields.ActiveState)) state = "running";
        else if (fields.ActiveState === "failed" || (fields.Result && fields.Result !== "success")) state = "failed";
        else if (fields.ActiveState === "inactive" && fields.LoadState === "loaded") state = fields.ExecMainCode === "1" && fields.ExecMainStatus === "0" ? "exited" : "failed";
        else if (age > 15) state = error && fields.LoadState !== "not-found" ? "unknown" : "failed";
        const next = { unit: record.unit, state, checked: Date.now(), exit_code: Number(fields.ExecMainStatus) || 0, message: record.error || (state === "failed" ? "continuation supervisor failed or disappeared" : state === "unknown" ? "supervisor unavailable; continuation state unconfirmed" : "") };
        const finish = (journal = "") => {
          inflight.delete(dir);
          if (closed) return;
          next.stderr = journal.slice(-4096);
          try {
            // Refuse stale completions after another continuation replaced the record.
            const current = readRecord(file);
            if (current.unit === record.unit) {
              cache.set(dir, next);
              const temp = `${file}.host-${process.pid}.tmp`;
              fs.writeFileSync(temp, JSON.stringify({ ...current, observed: next }), { mode: 0o600, flag: "wx" });
              fs.renameSync(temp, file);
            }
          } catch { /* next reconciliation retries without publishing stale observations */ }
          changed();
        };
        if (state === "failed" || state === "unknown") {
          exec("journalctl", ["--user", "-u", record.unit, "--no-pager", "-n", "20", "-o", "cat"], { timeout: 3000, maxBuffer: 16384 }, (_err, out) => finish(String(out || stderr || "")));
        } else finish();
      });
    }
    return old?.unit === record.unit ? old : record.observed?.unit === record.unit ? record.observed : { unit: record.unit, state: record.state, message: record.error || "" };
  }
  return { inspect, close() { closed = true; cache.clear(); } };
}
