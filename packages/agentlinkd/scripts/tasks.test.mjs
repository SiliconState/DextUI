// Shared task workspace: validation contract, rev/optimistic-concurrency,
// verified-completion rule, symlink refusal, and the watch/broadcast adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TASK_NAME_RE, validateTask, writeTask, readTask, listTasks, deleteTask, tasksDir, createTasksAdapter } from "../src/tasks.mjs";

function ws(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

const GOOD = {
  version: 1,
  name: "month-end-close",
  title: "Month-end close",
  goal: "Ledger reconciled and the report landed in the client's inbox",
  acceptance: ["reconcile report exits 0", "invoice pack says paid"],
  status: "active",
  constraints: { folders: ["invoices"], budget_usd: 5, notes: "no external sends" },
  artifacts: ["reports/close.md"],
};

test("TASK_NAME_RE: lowercase slug ok; spaces, dots, leading dash refused", () => {
  assert.equal(TASK_NAME_RE.test("month-end-close"), true);
  assert.equal(TASK_NAME_RE.test("a"), true);
  assert.equal(TASK_NAME_RE.test("has space"), false);
  assert.equal(TASK_NAME_RE.test(".hidden"), false);
  assert.equal(TASK_NAME_RE.test("-lead"), false);
  assert.equal(TASK_NAME_RE.test("UPPER"), false);
});

test("validateTask: accepts a full record; normalises, caps, defaults", () => {
  const r = validateTask(GOOD);
  assert.equal(r.ok, true);
  assert.equal(r.task.name, "month-end-close");
  assert.equal(r.task.status, "active");
  assert.deepEqual(r.task.checks, []);
  assert.deepEqual(r.task.links, { session: "", crew_run: "", flows: [] });
  // Caps: title and goal truncated, not rejected.
  const long = { ...GOOD, title: "t".repeat(200), goal: "g".repeat(9000) };
  const c = validateTask(long);
  assert.equal(c.ok, true);
  assert.equal(c.task.title.length, 80);
  assert.equal(c.task.goal.length, 4000);
});

test("validateTask: refuses bad shapes and contract violations", () => {
  assert.ok(validateTask(null).error);
  assert.ok(validateTask([]).error);
  assert.ok(validateTask({ ...GOOD, version: 2 }).error);
  assert.ok(validateTask({ ...GOOD, name: "Bad Name" }).error);
  assert.ok(validateTask({ ...GOOD, goal: "   " }).error);
  // blocked without a question for the human is refused
  assert.ok(validateTask({ ...GOOD, status: "blocked", blocked_on: "" }).error);
  // unknown status falls back to planned, not silently kept
  assert.equal(validateTask({ ...GOOD, status: "weird" }).task.status, "planned");
});

test("writeTask: rev assigned and bumped; created_at preserved; updated_by from actor", (t) => {
  const cwd = ws(t);
  const a = writeTask(cwd, GOOD, { actor: "agent" });
  assert.equal(a.ok, true);
  assert.equal(a.task.rev, 1);
  assert.equal(a.task.updated_by, "agent");
  const b = writeTask(cwd, { ...a.task, status: "planned" }, { actor: "user" });
  assert.equal(b.ok, true);
  assert.equal(b.task.rev, 2);
  assert.equal(b.task.created_at, a.task.created_at);
  assert.equal(b.task.updated_by, "user");
});

test("writeTask: expectedRev mismatch refused as stale_rev with the disk rev", (t) => {
  const cwd = ws(t);
  const a = writeTask(cwd, GOOD);
  assert.equal(a.ok, true);
  const r = writeTask(cwd, { ...a.task, goal: "clobber" }, { expectedRev: 99 });
  assert.equal(r.error.includes("stale rev"), true);
  assert.equal(r.code, "stale_rev");
  assert.equal(r.current, 1);
  // matching rev passes
  const ok = writeTask(cwd, { ...a.task, goal: "updated" }, { expectedRev: 1 });
  assert.equal(ok.ok, true);
  assert.equal(ok.task.rev, 2);
  // disk only moved for the matching-rev write — the stale one never landed
  assert.equal(readTask(cwd, GOOD.name).task.goal, "updated");
});

test("writeTask: 'done' without a passing check refused (unverified)", (t) => {
  const cwd = ws(t);
  const a = writeTask(cwd, GOOD);
  const noEvidence = writeTask(cwd, { ...a.task, status: "done", summary: "trust me" });
  assert.equal(noEvidence.code, "unverified");
  const withEvidence = writeTask(cwd, {
    ...a.task,
    status: "done",
    checks: [{ name: "reconcile report exits 0", ok: true, detail: "exit 0", by: "host" }],
  });
  assert.equal(withEvidence.ok, true);
  assert.equal(withEvidence.task.status, "done");
});

test("writeTask: an answered blocker stops blocking (status -> active)", (t) => {
  const cwd = ws(t);
  const a = writeTask(cwd, { ...GOOD, status: "blocked", blocked_on: "Which client folder?" });
  assert.equal(a.task.status, "blocked");
  const b = writeTask(cwd, { ...a.task, answer: "Clients/Acme" });
  assert.equal(b.task.status, "active");
});

test("listTasks/readTask: round-trip summary shape; unreadable file listed as a marker", (t) => {
  const cwd = ws(t);
  writeTask(cwd, GOOD);
  writeTask(cwd, { ...GOOD, name: "second-task", goal: "another", checks: [{ name: "c1", ok: true }, { name: "c2", ok: false }] });
  const list = listTasks(cwd);
  assert.equal(list.length, 2);
  const first = list.find((x) => x.name === "month-end-close");
  assert.equal(first.status, "active");
  assert.equal(first.rev, 1);
  const second = list.find((x) => x.name === "second-task");
  assert.equal(second.checks_ok, 1);
  // invalid JSON on disk: still visible (marker), never a hard failure
  const dir = tasksDir(cwd);
  fs.writeFileSync(path.join(dir, "broken.task.json"), "{not json");
  const again = listTasks(cwd);
  assert.equal(again.length, 3);
  assert.equal(again.find((x) => x.name === "broken").rev, 0);
  assert.ok(readTask(cwd, "broken").error);
});

test("deleteTask: removes the record; missing is no_task; symlink is refused", (t) => {
  const cwd = ws(t);
  writeTask(cwd, GOOD);
  assert.equal(deleteTask(cwd, GOOD.name).ok, true);
  assert.equal(readTask(cwd, GOOD.name).error, "no_task");
  assert.equal(deleteTask(cwd, GOOD.name).error, "no_task");
  // A symlink where the record would live is never read or written through.
  const dir = tasksDir(cwd, { create: true });
  const link = path.join(dir, "evil.task.json");
  fs.symlinkSync(path.join(cwd, "..", ".."), link);
  assert.equal(readTask(cwd, "evil").error, "refused");
  const w = writeTask(cwd, { ...GOOD, name: "evil" });
  assert.equal(w.code, "refused");
  assert.equal(deleteTask(cwd, "evil").error, "refused");
  assert.ok(fs.lstatSync(link).isSymbolicLink(), "the symlink itself must survive untouched");
});

test("adapter: put/delete broadcast the new list; dir() points at <cwd>/.dext/tasks", (t) => {
  const cwd = ws(t);
  const seen = [];
  const adapter = createTasksAdapter({ broadcast: (event, data) => seen.push([event, data]) });
  const r = adapter.put(cwd, GOOD, { actor: "user" });
  assert.equal(r.ok, true);
  // dir() resolves once the directory exists (the first put creates it)
  assert.equal(adapter.dir(cwd), path.join(cwd, ".dext", "tasks"));
  adapter.delete(cwd, GOOD.name);
  const events = seen.filter(([e]) => e === "x-agentlinkd.tasks.changed");
  assert.equal(events.length, 2, "one broadcast per mutation");
  assert.equal(events[0][1].tasks.length, 1);
  assert.equal(events[0][1].tasks[0].name, "month-end-close");
  assert.equal(events[1][1].tasks.length, 0);
});

test("adapter: put creates the tasks directory on first write", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const deep = path.join(base, "project");
  fs.mkdirSync(deep);
  const adapter = createTasksAdapter({ broadcast: () => {} });
  const r = adapter.put(deep, { ...GOOD, name: "first" }, {});
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(deep, ".dext", "tasks", "first.task.json")));
});
