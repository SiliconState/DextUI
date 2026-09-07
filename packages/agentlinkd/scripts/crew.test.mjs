import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectManifest, capRuns, sortRuns, countsOf, normStatus, tailLines, createCrewAdapter } from "../src/crew.mjs";

const NOW = Date.parse("2026-09-05T12:00:00Z");

function manifest(over = {}) {
  const chain = "/tmp/x/.crew/runs/run-8ee9930e5238/chain";
  return {
    runId: "run-8ee9930e5238",
    createdAt: "2026-09-05T11:59:37Z",
    rootTask: "Crew playground   smoke test\nfor the DextUI web seat",
    cwd: "/tmp/x",
    mode: "chain",
    chainDir: chain,
    status: "completed",
    steps: [
      {
        kind: "parallel",
        status: "completed",
        dir: `${chain}/step-0`,
        tasks: [
          { agent: "scout", label: "mapper", dir: `${chain}/step-0/mapper`, status: "completed", result: { durationMs: 7600, outputPath: `${chain}/context.md`, error: null, escalation: null } },
          { agent: "scout", label: "lore-hunter", dir: `${chain}/step-0/lore`, status: "completed", result: { durationMs: 9600, outputPath: `${chain}/context.md`, error: null, escalation: null } },
        ],
      },
      { kind: "sequential", agent: "reviewer", label: "reviewer · step 2", model: "gpt-x", dir: `${chain}/step-1`, status: "completed", result: { durationMs: 22500, text: "SECRET RESULT TEXT", outputPath: `${chain}/review.md`, error: null, escalation: null } },
    ],
    pausedReason: null,
    unit: "dext-crew-run-8ee9930e5238",
    ...over,
  };
}

test("normStatus / countsOf", () => {
  assert.equal(normStatus("done"), "completed");
  assert.equal(normStatus("weird"), "pending");
  assert.deepEqual(countsOf(["running", "completed", "failed", "paused", "pending"]), { pending: 1, run: 1, done: 1, fail: 1, paused: 1, total: 5 });
});

test("projectManifest strips result text and yields groups + counts", () => {
  const { summary, detail } = projectManifest(manifest(), { now: NOW, mtimeMs: NOW - 1000 });
  assert.equal(summary.id, "run-8ee9930e5238");
  assert.equal(summary.task, "Crew playground smoke test for the DextUI web seat");
  assert.equal(summary.state, "completed");
  assert.deepEqual(summary.counts, { pending: 0, run: 0, done: 3, fail: 0, paused: 0, total: 3 });
  assert.equal(summary.duration_ms, 39700);
  assert.equal(summary.age_ms, 23000);
  assert.equal(summary.detached, true);
  assert.equal(summary.escalation, undefined);
  assert.equal(detail.groups.length, 2);
  assert.equal(detail.groups[0].kind, "parallel");
  assert.deepEqual(detail.groups[0].workers.map((w) => w.key), ["0.0", "0.1"]);
  assert.equal(detail.groups[0].workers[0].output, "context.md");
  assert.equal(detail.groups[1].workers[0].model, "gpt-x");
  assert.equal(detail.groups[1].workers[0].output, "review.md");
  assert.ok(!JSON.stringify(detail).includes("SECRET RESULT TEXT"), "result text must never leave the host");
});

test("escalation requires status=paused AND a worker escalation; stop is dim not red", () => {
  const paused = manifest({
    status: "paused",
    pausedReason: "escalation",
    steps: [{ kind: "dynamic", agent: "worker", label: "worker-max", status: "paused", dir: "/d", materialized: [
      { itemKey: "web-agentic", dir: "/d/0", status: "paused", result: { escalation: { reason: "needs-decision", question: "global or scoped?", file: null }, durationMs: null } },
      { itemKey: "other", dir: "/d/1", status: "completed", result: { durationMs: 10 } },
    ] }],
  });
  const p = projectManifest(paused, { now: NOW });
  assert.equal(p.summary.escalation.question, "global or scoped?");
  assert.equal(p.summary.escalation.worker, p.detail.groups[0].workers[0].key);
  assert.match(p.summary.escalation.worker, /^0\.d-[a-f0-9]{24}$/);
  assert.equal(p.summary.escalation.label, "web-agentic");
  assert.equal(p.detail.groups[0].workers[0].agent, "worker");

  // paused_reason alone (a stop) never yields an escalation.
  const stopped = projectManifest(manifest({ status: "failed", pausedReason: "stopped by user" }), { now: NOW });
  assert.equal(stopped.summary.state, "stopped");
  assert.equal(stopped.summary.status, "failed");
  assert.equal(stopped.summary.escalation, undefined);

  // paused without any escalation field → no decision surfaced.
  const pausedNoEsc = projectManifest(manifest({ status: "paused", pausedReason: "escalation" }), { now: NOW });
  assert.equal(pausedNoEsc.summary.escalation, undefined);
});

test("rejects bad run ids and confines output paths to the chain dir", () => {
  assert.equal(projectManifest(manifest({ runId: "../etc" })), null);
  const m = manifest();
  m.steps[1].result.outputPath = "/etc/passwd";
  m.steps[1].result.error = "x".repeat(500);
  m.steps[1].status = "failed";
  const { detail } = projectManifest(m, { now: NOW });
  assert.equal(detail.groups[1].workers[0].output, undefined);
  assert.equal(detail.groups[1].workers[0].error.length, 80);
});

test("attention sort and cap", () => {
  const mk = (id, state, updated_ms = 0) => ({ id, state, updated_ms });
  const sorted = sortRuns([mk("run-000000000001", "completed"), mk("run-000000000002", "stopped"), mk("run-000000000003", "running"), mk("run-000000000004", "paused"), mk("run-000000000005", "failed")]);
  assert.deepEqual(sorted.map((r) => r.state), ["paused", "failed", "running", "completed", "stopped"]);
  // A day-old failure ranks below live and pending runs.
  const stale = sortRuns([mk("run-000000000001", "failed", 2 * 24 * 3600 * 1000), mk("run-000000000002", "pending"), mk("run-000000000003", "running")]);
  assert.deepEqual(stale.map((r) => r.state), ["running", "pending", "failed"]);
  // A day-old pending queue is just as cold: below running and fresh pending.
  const stalePend = sortRuns([mk("run-000000000001", "pending", 2 * 24 * 3600 * 1000), mk("run-000000000002", "pending"), mk("run-000000000003", "running")]);
  assert.deepEqual(stalePend.map((r) => r.state), ["running", "pending", "pending"]);
  const many = Array.from({ length: 11 }, (_, i) => mk(`run-0000000000${String(i).padStart(2, "0")}`, i < 2 ? "running" : "completed", i));
  const capped = capRuns(many);
  assert.equal(capped.runs.length, 8);
  assert.equal(capped.omitted, 3);
  assert.equal(capped.runs[0].state, "running");
});

test("tailLines returns the last n lines, bounded", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-tail-"));
  const f = path.join(dir, "live.log");
  fs.writeFileSync(f, Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") + "\n");
  const t = tailLines(f, 5);
  assert.deepEqual(t.lines, ["line 195", "line 196", "line 197", "line 198", "line 199"]);
  assert.equal(t.truncated, true);
  assert.equal(tailLines(f, 1000).lines.length, 80);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("adapter scans a runs root, serves tail/file confined to the run, refuses escapes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crew-runs-"));
  const runDir = path.join(root, "run-8ee9930e5238");
  const chain = path.join(runDir, "chain");
  fs.mkdirSync(path.join(chain, "step-1"), { recursive: true });
  const m = manifest({ chainDir: chain, cwd: root });
  m.steps[1].dir = path.join(chain, "step-1");
  m.steps[1].result.outputPath = path.join(chain, "review.md");
  fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(m));
  fs.writeFileSync(path.join(chain, "review.md"), "# review\nwinner: mapper\n");
  fs.writeFileSync(path.join(chain, "step-1", "live.log"), "dext> a\ndext> b\n");
  fs.writeFileSync(path.join(root, "outside.txt"), "nope");
  fs.symlinkSync(path.join(root, "outside.txt"), path.join(chain, "link.txt"));

  const pushes = [];
  const a = createCrewAdapter({ roots: [root], crewBin: "/nonexistent/crew", onChanged: (p) => pushes.push(p) });
  try {
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].runs[0].id, "run-8ee9930e5238");
    // Symlinks are never listed as deliverables (and `file` refuses them below).
    assert.deepEqual(a.detail("run-8ee9930e5238").files, ["review.md"]);
    assert.deepEqual(a.tail("run-8ee9930e5238", "1", 10).lines, ["dext> a", "dext> b"]);
    assert.equal(a.tail("run-8ee9930e5238", "0.0").error, "no_log");
    assert.equal(a.tail("run-8ee9930e5238", "9").error, "no_worker");
    assert.equal(a.file("run-8ee9930e5238", "review.md").text, "# review\nwinner: mapper\n");
    assert.equal(a.file("run-8ee9930e5238", "../manifest.json").error, "bad_path");
    assert.equal(a.file("run-8ee9930e5238", "link.txt").error, "bad_path");
    assert.equal(a.file("run-8ee9930e5238", "/etc/passwd").error, "bad_path");
    assert.equal(a.file("run-000000000000", "x").error, "no_run");
  } finally {
    a.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("adapter stop/resume guard on state without spawning", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crew-runs-"));
  const runDir = path.join(root, "run-8ee9930e5238");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(manifest({ chainDir: path.join(runDir, "chain"), cwd: root })));
  const a = createCrewAdapter({ roots: [root], crewBin: "/nonexistent/crew" });
  try {
    assert.equal((await a.stop("run-8ee9930e5238")).ok, false); // completed: nothing to stop
    const r = await a.resume("run-8ee9930e5238", "yes");
    assert.equal(r.ok, false);
    assert.equal(r.code, "crew_already_answered"); // not paused
  } finally {
    a.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("remove/clearFinished: finished runs only, records gone, live runs and deliverables survive", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crew-rm-"));
  const mk = (name, status, sub = "") => {
    const dir = path.join(root, sub, name);
    const chain = path.join(root, "shared-chain");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(chain, { recursive: true });
    fs.writeFileSync(path.join(chain, "review.md"), "# deliverable\n");
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest({ runId: name, chainDir: chain, cwd: root, status })));
    return { dir, chain };
  };
  const done = mk("run-111111111111", "completed");
  const failed = mk("run-222222222222", "failed");
  const live = mk("run-333333333333", "running");
  // Crew's default layout nests runs under `project-<hash>`: a cleanup must
  // prune the emptied parent so nothing lingers.
  const nested = mk("run-444444444444", "completed", "project-0123456789abcdef");
  const a = createCrewAdapter({ roots: [root], crewBin: "/nonexistent/crew" });
  try {
    assert.equal(a.remove("run-333333333333").ok, false, "a live run must be refused");
    assert.match(a.remove("run-333333333333").message, /running/);
    assert.equal(a.remove("run-00000000000f").ok, false, "unknown run");
    const r = a.remove("run-111111111111");
    assert.equal(r.ok, true);
    assert.equal(fs.existsSync(done.dir), false, "the run record is deleted");
    assert.equal(a.detail("run-111111111111"), null);
    const c = a.clearFinished();
    assert.equal(c.ok, true);
    assert.equal(c.removed, 2, "the sweep covered both run layouts");
    assert.equal(fs.existsSync(failed.dir), false);
    assert.equal(fs.existsSync(nested.dir), false);
    assert.equal(fs.existsSync(path.dirname(nested.dir)), false, "the emptied project dir is pruned");
    assert.equal(fs.existsSync(live.dir), true, "the live run survives a sweep");
    assert.notEqual(a.detail("run-333333333333"), null);
    assert.equal(fs.existsSync(path.join(live.chain, "review.md")), true, "deliverables are never touched");
    assert.equal(a.clearFinished().removed, 0, "an empty sweep is a no-op");
  } finally {
    a.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
