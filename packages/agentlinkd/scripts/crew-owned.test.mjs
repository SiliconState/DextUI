import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RUN_ID_RE, createCrewAdapter } from "../src/crew.mjs";
import { CREW_RUN_ID_RE } from "../../protocol/dist/index.js";
import { durableHost, sleep, until } from "./durable-harness.mjs";

function record(root, id, owner, status = "running") {
  const dir = path.join(root, id); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ runId: id, cwd: root, chainDir: path.join(dir, "chain"), status, owner, steps: [], createdAt: new Date().toISOString() }));
  return dir;
}
test("host/protocol run ids match crew portable keyed/custom grammar", () => {
  for (const id of ["run-000000000001", `key-${"a".repeat(32)}`, "foreground-fixture.V1", "x", "-", ".abc", "a".repeat(64)]) {
    assert.equal(RUN_ID_RE.test(id), true, id); assert.equal(CREW_RUN_ID_RE.test(id), true, id);
  }
  for (const id of ["", ".", "..", "../escape", "a/b", "a b", "🌍", "a".repeat(65)]) {
    assert.equal(RUN_ID_RE.test(id), false, id); assert.equal(CREW_RUN_ID_RE.test(id), false, id);
  }
});

const owner = (mode = "foreground", session = "core-1") => ({ session, call_id: "call-1", mode });

test("owner discovery is fresh, uncapped and path-keyed, refusing stale or invalid manifests", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "crew-owned-")); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const aRoot = path.join(temp, "a"), bRoot = path.join(temp, "b");
  for (let i = 1; i <= 10; i++) record(aRoot, `run-${i.toString(16).padStart(12, "0")}`, owner());
  record(bRoot, "run-000000000001", owner()); // same display id, different manifest identity
  record(aRoot, "run-000000000011", owner("background"));
  record(aRoot, "run-000000000012", owner("foreground", "other"));
  record(aRoot, "run-000000000013", owner(), "completed");
  record(aRoot, "run-000000000014", null);
  const a = createCrewAdapter({ roots: [aRoot, bRoot], crewBin: "/no-crew" }); t.after(() => a.close());
  assert.equal(a.summaries().runs.length, 8);
  assert.equal(a.foregroundOwned("core-1").length, 11);
  const file = path.join(aRoot, "run-000000000001/manifest.json");
  const before = fs.statSync(file);
  fs.writeFileSync(file, "{"); fs.utimesSync(file, before.atime, before.mtime);
  assert.equal(a.foregroundOwned("core-1").length, 10, "malformed file cannot retain cached owner");
  assert.deepEqual(a.foregroundOwned(""), []);
  const linkedRoot = path.join(temp, "linked"); fs.symlinkSync(aRoot, linkedRoot);
  const linked = createCrewAdapter({ roots: [linkedRoot], crewBin: "/no-crew" }); t.after(() => linked.close());
  assert.deepEqual(linked.foregroundOwned("core-1"), [], "symlinked runs roots are refused");
  const misnamed = record(aRoot, "run-000000000015", owner());
  const manifest = path.join(misnamed, "manifest.json");
  const raw = JSON.parse(fs.readFileSync(manifest)); raw.runId = "run-000000000016";
  fs.writeFileSync(manifest, JSON.stringify(raw));
  assert.equal(a.foregroundOwned("core-1").length, 10, "manifest identity must match its directory");
  record(aRoot, "project-1234567890abcdef", owner());
  record(path.join(aRoot, "project-fedcba0987654321"), "custom.V1", owner());
  assert.equal(a.foregroundOwned("core-1").length, 12, "project-like custom ids and nested project buckets both participate");
});

test("concurrent owned stops coalesce by manifest path and exclude background owners", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crew-stop-owned-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runs = path.join(root, "runs");
  const foreground = record(runs, "run-000000000001", owner());
  record(runs, "run-000000000002", owner("background"));
  const bin = path.join(root, "crew");
  fs.writeFileSync(bin, `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(path.join(root, "calls"))},process.argv[3]+'\\n');\nsetTimeout(()=>process.exit(0),150);\n`, { mode: 0o700 });
  const a = createCrewAdapter({ roots: [runs], crewBin: bin }); t.after(() => a.close());
  const [one, two] = await Promise.all([a.stopOwned("core-1"), a.stopOwned("core-1")]);
  assert.equal(one.length, 1); assert.equal(two.length, 1); assert.equal(one[0].ok, true);
  assert.equal(fs.readFileSync(path.join(root, "calls"), "utf8"), path.join(foreground, "manifest.json") + "\n");
});

for (const failed of [false, true]) test(`host interrupt targets persisted foreground identity and reports ${failed ? "failure" : "success"}`, async (t) => {
  const env = {};
  const h = await durableHost(t, { env, setup({ temp, state, cwd }) {
    env.CREW_BIN = path.join(temp, "crew");
    fs.writeFileSync(env.CREW_BIN, `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(path.join(temp, "calls"))},process.argv[3]+'\\n');\n${failed ? "process.stderr.write('cleanup uncertain'); process.exit(1);" : "process.exit(0);"}\n`, { mode: 0o700 });
    const runs = path.join(cwd, ".crew/runs");
    record(runs, "run-000000000001", owner());
    record(runs, "run-000000000002", owner("background"));
    record(runs, "run-000000000003", owner("foreground", "other"));
    fs.mkdirSync(state); fs.writeFileSync(path.join(state, "sessions.json"), JSON.stringify([{ id: "sess_123", cwd, seat: "dextui-1234", dextSessionId: "core-1", turns: 1 }]));
  } });
  const c = await h.client(); c.send("session.subscribe", { id: "sess_123" }); await c.wait((e) => e.event === "session.snapshot");
  c.send("interrupt", { session: "sess_123" });
  const result = await c.wait((e) => e.event === "x-agentlinkd.crew.control");
  assert.equal(result.data.run, "run-000000000001"); assert.equal(result.data.ok, !failed);
  if (failed) await c.wait((e) => e.event === "warn" && e.data.includes("cleanup uncertain"));
  await sleep(50);
  const calls = fs.readFileSync(path.join(h.temp, "calls"), "utf8").trim().split("\n");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].endsWith("run-000000000001/manifest.json"));
});

for (const active of [false, true]) test(`slow cleanup fences admission when the parent is ${active ? "finishing" : "idle"}, then preserves its warm bridge`, async (t) => {
  const env = {};
  let started;
  const h = await durableHost(t, { bridge: true, env, setup({ temp }) {
    started = path.join(temp, "cleanup-started");
    env.CREW_BIN = path.join(temp, "crew");
    fs.writeFileSync(env.CREW_BIN, `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(started)},'started');\nsetTimeout(()=>process.exit(0),900);\n`, { mode: 0o700 });
  } });
  const c = await h.client(); const id = await h.open(c);
  c.send("prompt.submit", { session: id, text: active ? "SLOW natural finish" : "Warm bridge" });
  const turn = await c.wait((e) => e.event === "turn_start");
  if (!active) await c.wait((e) => e.event === "turn_end");
  await until(() => h.index().find((s) => s.id === id)?.dextSessionId === "fake-ndjson-1");
  record(path.join(h.cwd, ".crew/runs"), "run-000000000001", owner("foreground", "fake-ndjson-1"));
  c.send("interrupt", { session: id });
  await until(() => fs.existsSync(started));
  const at = c.events.length;
  c.send("prompt.submit", { session: id, text: "Rejected prompt" });
  await c.wait((e) => e.event === "error" && e.data.code === "busy", at);
  const steeringAt = c.events.length;
  c.send("steering.inject", { session: id, text: "Rejected steering" });
  await c.wait((e) => e.event === "error" && e.data.code === "busy", steeringAt);
  c.send("interrupt", { session: id }); // coalesced; must not signal the parent early
  const bulkAt = c.events.length;
  c.send("session.delete_all", { scope: "all" });
  await c.wait((e) => e.event === "error" && e.data.code === "purge_failed", bulkAt);
  assert.ok(h.index().some((s) => s.id === id), "bulk management must not kill the cleanup owner");
  if (active) await c.wait((e) => e.event === "turn_end");
  await c.wait((e) => e.event === "x-agentlinkd.crew.control");
  assert.ok(!h.journal(id).some((e) => JSON.stringify(e.data).includes("Rejected")));
  assert.equal(c.events.filter((e) => e.event === "x-agentlinkd.crew.control").length, 1);
  const nextAt = c.events.length;
  c.send("prompt.submit", { session: id, text: "Next accepted turn" });
  const next = await c.wait((e) => e.event === "turn_start", nextAt);
  assert.equal(next.data.pid, turn.data.pid, "finished turn must not lose its idle bridge");
  await c.wait((e) => e.event === "turn_end", nextAt);
});
