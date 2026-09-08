// Reconcile the crew-owned continuation record; never launch or retry from the host.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
  function inspect(dir, expectedUnit) {
    const file = path.join(dir, "continuation.json");
    const observedFile = path.join(dir, "continuation-observed.json");
    let record;
    try {
      record = readRecord(file);
      if (!/^dext-crew-[a-zA-Z0-9_-]+-resume-run-[a-f0-9]{12}$/.test(record.unit) || (expectedUnit !== undefined && record.unit !== expectedUnit)) return null;
    } catch { return null; }
    const old = cache.get(dir);
    if (old?.unit === record.unit && (record.state !== "failed" || old.state === "failed") && Date.now() - old.checked < 2000) return old;
    if (!inflight.has(dir) && !closed) {
      inflight.add(dir);
      exec("systemctl", ["--user", "show", record.unit, "--property=LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus"], { timeout: 3000, maxBuffer: 8192 }, (error, stdout, stderr) => {
        if (closed) return;
        const fields = Object.fromEntries(String(stdout).trim().split("\n").map((line) => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
        const age = Date.now() / 1000 - Number(record.created);
        let state = "pending";
        if (record.state === "failed") state = "failed";
        else if (error && fields.LoadState !== "not-found") state = "unknown";
        else if (["active", "activating", "reloading"].includes(fields.ActiveState)) state = "running";
        else if (fields.ActiveState === "failed" || (fields.Result && fields.Result !== "success")) state = "failed";
        else if (fields.ActiveState === "inactive" && fields.LoadState === "loaded") state = fields.ExecMainCode === "1" && fields.ExecMainStatus === "0" ? "exited" : "failed";
        else if (age > 15) state = error && fields.LoadState !== "not-found" ? "unknown" : "failed";
        const next = { unit: record.unit, state, checked: Date.now(), exit_code: Number(fields.ExecMainStatus) || 0, message: record.error || (state === "failed" ? "continuation supervisor failed or disappeared" : state === "unknown" ? "supervisor unavailable; continuation state unconfirmed" : "") };
        const finish = (journal = "") => {
          inflight.delete(dir);
          if (closed) return;
          next.stderr = journal.slice(-4096);
          const temp = `${observedFile}.${randomUUID()}.tmp`;
          try {
            const current = readRecord(file);
            if (current.unit !== record.unit || current.state !== record.state) return;
            // Never rewrite crew's record: read/check/rename cannot exclude a
            // concurrent crew launch. Observations have their own unit-keyed file.
            cache.set(dir, next);
            fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: "wx" });
            fs.renameSync(temp, observedFile);
          } catch { /* next reconciliation retries without publishing stale observations */ }
          finally { try { fs.unlinkSync(temp); } catch { /* absent */ } }
          changed();
        };
        if (state === "failed" || state === "unknown") {
          exec("journalctl", ["--user", "-u", record.unit, "--no-pager", "-n", "20", "-o", "cat"], { timeout: 3000, maxBuffer: 16384 }, (_err, out) => finish(String(out || stderr || "")));
        } else finish();
      });
    }
    if (record.state === "failed") return { unit: record.unit, state: "failed", message: record.error || "continuation launch failed" };
    let observed;
    try { observed = readRecord(observedFile); } catch { /* no observation yet */ }
    return old?.unit === record.unit ? old : observed?.unit === record.unit ? observed : { unit: record.unit, state: record.state, message: record.error || "" };
  }
  return { inspect, close() { closed = true; cache.clear(); } };
}
