// All roots, children and restart requests belong to these fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { durableHost, sleep, until } from "./durable-harness.mjs";

function manifest(root, id, status) {
  const dir = path.join(root, id); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "manifest.json");
  fs.writeFileSync(file, JSON.stringify({ runId: id, cwd: root, chainDir: path.join(dir, "chain"), status, steps: [], createdAt: new Date().toISOString() }));
  return file;
}

async function restart(h) {
  const r = await h.request("/__self/restart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "test-only idle restart", force: false }) });
  assert.equal(r.status, 200); return r.json();
}
async function assertExited(h) {
  await until(() => h.child.exitCode !== null, "test host failed to restart after activity completed");
  assert.equal(h.child.exitCode, 75);
}

test("restart discovers live crew outside eight attention summaries, with fresh path identities", async (t) => {
  let live;
  const env = {};
  const h = await durableHost(t, { env, setup({ temp, cwd }) {
    env.CREW_BIN = path.join(temp, "crew");
    fs.writeFileSync(env.CREW_BIN, "#!/usr/bin/env node\n", { mode: 0o700 });
    const root = path.join(cwd, ".crew/runs");
    for (let i = 0; i < 8; i++) manifest(root, `failed-${i}`, "failed");
    live = manifest(root, "hidden-live", "running");
  } });
  const c = await h.client();
  assert.equal(c.hello.data.crews.runs.length, 8);
  assert.ok(!c.hello.data.crews.runs.some((r) => r.id === "hidden-live"));
  const result = await restart(h);
  assert.equal(result.pending, true);
  assert.ok(result.busy.some((b) => b.run === "hidden-live"));
  await sleep(350); assert.equal(h.child.exitCode, null);
  const data = JSON.parse(fs.readFileSync(live)); data.status = "completed";
  fs.writeFileSync(live, JSON.stringify(data));
  await assertExited(h);
});

test("restart waits for a leased owned-stop cleanup even after its manifest becomes terminal", async (t) => {
  const env = {}; let started, finished;
  const h = await durableHost(t, { env, setup({ temp, state, cwd }) {
    started = path.join(temp, "cleanup-started"); finished = path.join(temp, "cleanup-finished");
    env.CREW_BIN = path.join(temp, "crew");
    fs.writeFileSync(env.CREW_BIN, `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst file=process.argv[3];const data=JSON.parse(fs.readFileSync(file));data.status='failed';fs.writeFileSync(file,JSON.stringify(data));fs.writeFileSync(${JSON.stringify(started)},'x');setTimeout(()=>{fs.writeFileSync(${JSON.stringify(finished)},'x');process.exit(0);},1000);\n`, { mode: 0o700 });
    const file = manifest(path.join(cwd, ".crew/runs"), "cleanup-fixture", "running");
    const data = JSON.parse(fs.readFileSync(file)); data.owner = { session: "core-1", call_id: "call-1", mode: "foreground" }; fs.writeFileSync(file, JSON.stringify(data));
    fs.mkdirSync(state); fs.writeFileSync(path.join(state, "sessions.json"), JSON.stringify([{ id: "sess_123", cwd, seat: "dextui-1234", dextSessionId: "core-1", turns: 1 }]));
  } });
  const c = await h.client(); c.send("interrupt", { session: "sess_123" });
  await until(() => fs.existsSync(started));
  const result = await restart(h);
  assert.equal(result.pending, true);
  assert.ok(result.busy.some((b) => b.kind === "cleanup"));
  await sleep(350); assert.equal(h.child.exitCode, null); assert.equal(fs.existsSync(finished), false);
  await until(() => fs.existsSync(finished)); await assertExited(h);
});

test("restart waits for an in-flight kept fork and completes after its result is persisted", async (t) => {
  const env = {}; let started;
  const binRoot = fs.mkdtempSync(path.join(os.tmpdir(), "restart-fork-bin-"));
  t.after(() => fs.rmSync(binRoot, { recursive: true, force: true }));
  const bin = path.join(binRoot, "fork-core");
  const h = await durableHost(t, { bin, env, setup({ temp, state, home, cwd }) {
    started = path.join(temp, "fork-started");
    const fake = path.resolve("packages/agentlinkd/scripts/fake-dext.mjs");
    fs.writeFileSync(bin, `#!/usr/bin/env node\nimport fs from 'node:fs';import {spawnSync} from 'node:child_process';\nconst args=process.argv.slice(2);if(args.includes('--help')){console.log('--fork-to');process.exit(0);}if(args.includes('--fork-to')){const seat=args[args.indexOf('--fork-to')+1];fs.writeFileSync(${JSON.stringify(started)},'x');setTimeout(()=>{console.log(JSON.stringify({event:'session_fork',data:{seat,session_id:'fork-target',source_session_id:'fork-source',at:0}}));},1000);}else{const r=spawnSync(process.execPath,[${JSON.stringify(fake)},...args],{stdio:'inherit'});process.exit(r.status??1);}\n`, { mode: 0o700 });
    const dir = path.join(home, "projects/fixture/sessions/fork-source"); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "_latest.jsonl"), JSON.stringify({ version: 4, model: "alpha", session_id: "fork-source", sandbox: cwd, seat: { id: "dextui-1234" } }) + "\n");
    fs.mkdirSync(state); fs.writeFileSync(path.join(state, "sessions.json"), JSON.stringify([{ id: "sess_123", title: "Source", cwd, seat: "dextui-1234", turns: 1 }]));
  } });
  const c = await h.client(); assert.ok(c.hello.data.capabilities.includes("session_fork"));
  c.send("session.fork", { id: "sess_123" }); await until(() => fs.existsSync(started));
  const result = await restart(h); assert.equal(result.pending, true);
  assert.ok(result.busy.some((b) => b.kind === "fork"));
  await sleep(350); assert.equal(h.child.exitCode, null);
  await c.wait((e) => e.event === "session.forked"); await assertExited(h);
  assert.equal(h.index().length, 2, "fork entry persisted before idle restart");
});

test("activity admitted inside restart notice delay postpones actual shutdown", async (t) => {
  const h = await durableHost(t, { bridge: true, env: { FAKE_DEXT_TURN_DELAY_MS: "1000" } });
  const c = await h.client(), id = await h.open(c);
  assert.equal((await restart(h)).pending, false);
  c.send("prompt.submit", { session: id, text: "Complete before restarting" });
  await c.wait((e) => e.event === "turn_start");
  await sleep(350); assert.equal(h.child.exitCode, null);
  await c.wait((e) => e.event === "turn_end"); await assertExited(h);
});

for (const interrupt of [false, true]) test(`manual compaction reserves admission during bridge readiness${interrupt ? " and stop cancels it" : ""}`, async (t) => {
  const h = await durableHost(t, { bridge: true, env: { FAKE_DEXT_READY_DELAY_MS: "600" } });
  const c = await h.client(), id = await h.open(c);
  c.send("slash", { session: id, raw: "/compact", nonce: "coldcompact1" });
  await c.wait((e) => e.event === "compact_start");
  c.send("prompt.submit", { session: id, text: "must not run under compaction", nonce: "coldprompt1" });
  await c.wait((e) => e.event === "error" && e.data.code === "busy");
  if (interrupt) {
    c.send("interrupt", { session: id }); await c.wait((e) => e.event === "compact_failed");
    await sleep(800);
    assert.ok(!h.journal(id).some((e) => e.event === "compact_end"), "cancelled pre-ready control must never execute");
  } else await c.wait((e) => e.event === "compact_end");
  assert.ok(!h.journal(id).some((e) => e.event === "user_message"));
  const at = c.events.length; c.send("session.subscribe", { id });
  const snap = await c.wait((e) => e.event === "session.snapshot", at);
  assert.equal(snap.data.compacting, false); assert.equal(snap.data.working, false);
});
