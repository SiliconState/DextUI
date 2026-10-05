// Explicit installed-core/crew gate. All providers, roots and workers are test-owned.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { durableHost, until, sleep } from "./durable-harness.mjs";

const exec = promisify(execFile);
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
for (const keyed of [false, true]) test(`real host/core/crew ${keyed ? "keyed" : "custom"} foreground cleanup precedes parent interruption and background work survives`, { timeout: 60000 }, async (t) => {
  const core = process.env.DEXT_CORE_BIN, crew = process.env.DEXT_CREW_BIN;
  assert.ok(core && crew, "set DEXT_CORE_BIN and DEXT_CREW_BIN to reviewed binaries");
  let command, worker, foregroundStarted, backgroundStarted, backgroundSpec;
  const provider = http.createServer(async (req, res) => {
    if (req.method !== "POST") return res.end("{}");
    const parts = []; for await (const b of req) parts.push(b);
    const body = JSON.parse(Buffer.concat(parts));
    const hasResult = body.messages.some((m) => m.role === "tool");
    const delta = hasResult ? { content: "The test-owned crew run stopped." } : { tool_calls: [{ index: 0, id: "owned-crew-call", function: { name: "bash", arguments: JSON.stringify({ command }) } }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: hasResult ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  t.after(async () => { provider.closeAllConnections(); await new Promise((r) => provider.close(r)); });
  const h = await durableHost(t, {
    bin: core,
    env: { CREW_BIN: crew, DEXT_PROVIDER: "local", DEXT_MODEL: "mock-model", DEXT_MODEL_FORCE: "1", DEXT_BASE_URL: `http://127.0.0.1:${provider.address().port}`, DEXT_BACKGROUND_COMPACT: "0" },
    setup({ temp, state, cwd }) {
      foregroundStarted = path.join(temp, "foreground-started"); backgroundStarted = path.join(temp, "background-started");
      worker = path.join(temp, "worker.mjs");
      fs.writeFileSync(worker, `#!/usr/bin/env node\nimport fs from 'node:fs';\nlet input=''; for await(const b of process.stdin) input+=b;\nfs.writeFileSync(input.includes('Background fixture')?${JSON.stringify(backgroundStarted)}:${JSON.stringify(foregroundStarted)},String(process.pid));\nconsole.log(JSON.stringify({event:'turn_start',data:{}}));\nprocess.on('SIGTERM',()=>process.exit(1));\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
      const spec = path.join(cwd, "foreground.json"); backgroundSpec = path.join(cwd, "background.json");
      fs.writeFileSync(spec, JSON.stringify({ agent: "scout", task: "Foreground fixture", on_abort: "printf x > foreground-cleanup.started; sleep 0.4; printf x >> foreground-cleanup.count" }));
      fs.writeFileSync(backgroundSpec, JSON.stringify({ agent: "scout", task: "Background fixture", on_abort: "printf x >> background-cleanup.count" }));
      command = `${quote(crew)} run --spec ${quote(spec)} --cwd ${quote(cwd)} --runs-dir ${quote(path.join(cwd, ".crew/runs"))} ${keyed ? '--idempotency-key "$DEXT_SESSION_ID:$DEXT_TOOL_CALL_ID"' : '--run-id foreground-fixture.V1'} --allow-verify --dext ${quote(worker)}`;
      fs.mkdirSync(state); fs.writeFileSync(path.join(state, "sessions.json"), JSON.stringify([{ id: "sess_123", cwd, seat: "dextui-1234", approval: "always", provider: "local", model: "mock-model", turns: 0 }]));
    },
  });
  const env = { ...process.env, HOME: h.home, DEXT_HOME: h.home };
  delete env.DEXT_SESSIONS_DIR; delete env.DEXT_LOGS_DIR;
  const runs = path.join(h.cwd, ".crew/runs"), backgroundId = "background-fixture.V1";
  let foregroundFile, background;
  const stop = (file) => exec(crew, ["stop", file, "--cwd", h.cwd], { timeout: 45000, env, maxBuffer: 1024 * 1024 });
  try {
    const c = await h.client();
    c.send("session.subscribe", { id: "sess_123" }); await c.wait((e) => e.event === "session.snapshot");
    c.send("prompt.submit", { session: "sess_123", text: "Run the reviewed foreground crew fixture" });
    try { await until(() => fs.existsSync(foregroundStarted), "foreground worker never started"); }
    catch (err) { t.diagnostic(JSON.stringify(h.journal("sess_123"))); throw err; }
    const foregroundId = fs.readdirSync(runs).find((id) => fs.existsSync(path.join(runs, id, "manifest.json")));
    assert.ok(keyed ? /^key-[a-f0-9]{32}$/.test(foregroundId) : foregroundId === "foreground-fixture.V1");
    foregroundFile = path.join(runs, foregroundId, "manifest.json");
    const foreground = JSON.parse(fs.readFileSync(foregroundFile));
    assert.equal(foreground.owner.call_id, "owned-crew-call"); assert.equal(foreground.owner.mode, "foreground");
    await until(() => h.index()[0].dextSessionId === foreground.owner.session, "host did not persist core identity");
    background = spawn(crew, ["run", "--spec", backgroundSpec, "--cwd", h.cwd, "--runs-dir", runs, "--run-id", backgroundId, "--allow-verify", "--dext", worker, "--owner-session", foreground.owner.session, "--owner-call-id", "background-call", "--owner-mode", "background"], { env, stdio: "ignore" });
    await until(() => fs.existsSync(backgroundStarted), "background worker never started");
    const at = c.events.length;
    c.send("interrupt", { session: "sess_123" });
    await until(() => fs.existsSync(path.join(h.cwd, "foreground-cleanup.started")), "foreground cleanup never started");
    assert.ok(!c.events.slice(at).some((e) => e.event === "turn_end" || e.event === "interrupted"), "parent signalled before owned cleanup completed");
    c.send("prompt.submit", { session: "sess_123", text: "must be refused during cleanup" });
    await c.wait((e) => e.event === "error" && e.data.code === "busy", at);
    const result = await c.wait((e) => e.event === "x-agentlinkd.crew.control", at);
    assert.equal(result.data.run, foregroundId); assert.equal(result.data.ok, true, JSON.stringify(result));
    const stopped = JSON.parse(fs.readFileSync(foregroundFile));
    assert.equal(stopped.status, "failed"); assert.equal(stopped.abortHooks["0"].state, "completed");
    assert.equal(fs.readFileSync(path.join(h.cwd, "foreground-cleanup.count"), "utf8"), "x");
    const foregroundPid = Number(fs.readFileSync(foregroundStarted));
    await until(() => !fs.existsSync(`/proc/${foregroundPid}`), "foreground worker survived stop");
    const backgroundPid = Number(fs.readFileSync(backgroundStarted));
    assert.ok(fs.existsSync(`/proc/${backgroundPid}`), "same-session background worker must survive");
    assert.equal(background.exitCode, null);
    assert.equal(JSON.parse(fs.readFileSync(path.join(runs, backgroundId, "manifest.json"))).status, "running");
    assert.equal(fs.existsSync(path.join(h.cwd, "background-cleanup.count")), false);
    c.send("interrupt", { session: "sess_123" }); await sleep(150);
    assert.equal(fs.readFileSync(path.join(h.cwd, "foreground-cleanup.count"), "utf8"), "x", "cleanup must not replay");
  } finally {
    // Stop all fixture-owned runs before the harness removes their directories.
    for (const file of [foregroundFile, path.join(runs, backgroundId, "manifest.json")]) {
      if (file && fs.existsSync(file)) await stop(file);
    }
    if (background && background.exitCode === null && background.signalCode === null) await once(background, "exit");
    await h.stop();
  }
});
