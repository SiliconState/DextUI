// Installed CORE + host, isolated state and loopback provider only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { durableHost } from "./durable-harness.mjs";

function checkpoints(home) {
  const out = [];
  const scan = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, e.name); if (e.isDirectory()) scan(file); else if (e.name === "_latest.jsonl") out.push({ file, header: JSON.parse(fs.readFileSync(file, "utf8").split("\n")[0]) }); } };
  scan(home); return out;
}
async function setting(c, id, raw, nonce) {
  const at = c.events.length; c.send("slash", { session: id, raw, nonce });
  const result = await c.wait((e) => (e.event === "cmd_ack" || e.event === "error") && e.data.nonce === nonce, at);
  assert.equal(result.event, "cmd_ack", JSON.stringify(result)); return at;
}
async function provider(t) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") return res.end("{}");
    const parts = []; for await (const p of req) parts.push(p);
    const body = JSON.parse(Buffer.concat(parts)); requests.push(body);
    if (body.stream === false) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: "Regular compact summary" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } })); }
    else { res.writeHead(200, { "content-type": "text/event-stream" }); res.end('data: {"choices":[{"delta":{"content":"Foreground complete"},"finish_reason":"stop"}],"usage":{"prompt_tokens":13,"completion_tokens":9}}\n\ndata: [DONE]\n\n'); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  return { requests, env: { DEXT_PROVIDER: "local", DEXT_MODEL: "mock-model", DEXT_MODEL_FORCE: "1", DEXT_BASE_URL: `http://127.0.0.1:${server.address().port}` } };
}

test("installed CORE: default on/off/status saves, kept fork and host restart preserve false without a provider request", { timeout: 30000 }, async (t) => {
  assert.ok(process.env.DEXT_CORE_BIN, "set DEXT_CORE_BIN to reviewed installed core");
  const p = await provider(t);
  const h = await durableHost(t, { bin: process.env.DEXT_CORE_BIN, env: { ...p.env, DEXT_BACKGROUND_COMPACT: undefined } });
  const c = await h.client(), id = await h.open(c), other = await h.open(c);
  assert.ok(c.hello.data.capabilities.includes("background_compaction_setting"));
  assert.equal(h.index().find((s) => s.id === id).backgroundCompact, true);
  await setting(c, id, "/compact background off", "realSettingOff1");
  assert.equal(h.index().find((s) => s.id === id).backgroundCompact, false);
  assert.equal(h.index().find((s) => s.id === other).backgroundCompact, true);
  await setting(c, id, "/compact background status", "realSettingStatus1");
  const source = checkpoints(h.home).find((entry) => entry.header.seat.id === h.index().find((s) => s.id === id).seat);
  assert.equal(source.header.background_compact, false);
  const before = fs.readFileSync(source.file, "utf8");
  c.send("session.fork", { id }); const fork = await c.wait((e) => e.event === "session.forked");
  assert.equal(fork.data.meta.background_compact, false);
  assert.equal(fs.readFileSync(source.file, "utf8"), before);
  assert.equal(p.requests.length, 0, "saved settings/status/fork are provider-free");
  const forkId = fork.data.meta.id;
  await h.stop(); await h.start();
  const next = await h.client();
  assert.equal(next.hello.data.sessions.find((s) => s.id === id).background_compact, false);
  assert.equal(next.hello.data.sessions.find((s) => s.id === forkId).background_compact, false);
  next.send("session.subscribe", { id: forkId }); await next.wait((e) => e.event === "session.snapshot");
  await setting(next, forkId, "/compact background status", "realForkStatus1");
  assert.equal(p.requests.length, 0);
  await setting(next, forkId, "/compact background on", "realForkOn1");
  assert.equal(h.index().find((s) => s.id === forkId).backgroundCompact, true);
  assert.equal(h.index().find((s) => s.id === id).backgroundCompact, false);
  assert.ok(!h.journal(id).some((e) => ["user_message", "turn_start", "usage_update", "compact_start"].includes(e.event)));
});

test("installed CORE: save failure resyncs safely off, never ACKs success; ordinary compaction remains available", { timeout: 30000 }, async (t) => {
  assert.ok(process.env.DEXT_CORE_BIN, "set DEXT_CORE_BIN to reviewed installed core");
  const p = await provider(t); let transcript;
  const h = await durableHost(t, { bin: process.env.DEXT_CORE_BIN, env: { ...p.env, DEXT_BACKGROUND_COMPACT: "1" }, setup({ home, state, cwd }) {
    const dir = path.join(home, "projects/fixture/sessions/setting-source"); fs.mkdirSync(dir, { recursive: true }); transcript = path.join(dir, "_latest.jsonl");
    const header = { version: 4, model: "mock-model", system: "test", session_id: "setting-source", sandbox: cwd, compact_threshold_chars: 30000, background_compact: false, seat: { id: "dextui-01234567" } };
    const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: "context ".repeat(250) }] }));
    fs.writeFileSync(transcript, [header, ...history].map(JSON.stringify).join("\n") + "\n");
    fs.mkdirSync(state); fs.writeFileSync(path.join(state, "sessions.json"), JSON.stringify([{ id: "sess_123", cwd, seat: header.seat.id, provider: "local", model: "mock-model", turns: 1, moved: true, approval: "never" }]));
  } });
  const c = await h.client(), id = "sess_123";
  assert.equal(c.hello.data.sessions[0].background_compact, false, "saved core setting wins over env for legacy host metadata");
  c.send("session.subscribe", { id }); await c.wait((e) => e.event === "session.snapshot");
  await setting(c, id, "/compact background on", "realSettingOn2");
  transcript = checkpoints(h.home).find((entry) => entry.header.session_id === h.index()[0].dextSessionId && entry.header.background_compact === true)?.file;
  assert.ok(transcript, "resume writes the active checkpoint, not the frozen source");
  assert.equal(JSON.parse(fs.readFileSync(transcript, "utf8").split("\n")[0]).background_compact, true);
  const backup = `${transcript}.backup`; fs.renameSync(transcript, backup); fs.mkdirSync(transcript);
  const at = c.events.length; c.send("slash", { session: id, raw: "/compact background off", nonce: "realFailedSetting2" });
  const error = await c.wait((e) => e.event === "error" && e.data.nonce === "realFailedSetting2", at);
  assert.equal(error.data.code, "background_setting_failed");
  assert.ok(!c.events.slice(at).some((e) => e.event === "cmd_ack" && e.data.nonce === "realFailedSetting2"));
  assert.equal(h.index()[0].backgroundCompact, false, "status after failed save reports safely-off memory");
  fs.rmdirSync(transcript); fs.renameSync(backup, transcript);
  await setting(c, id, "/compact background off", "realSettingRetry2");
  const compactAt = c.events.length; c.send("slash", { session: id, raw: "/compact", nonce: "realManualOff2" });
  await c.wait((e) => e.event === "compact_end", compactAt);
  assert.ok(c.events.slice(compactAt).some((e) => e.event === "compact_start"));
  assert.ok(!c.events.slice(compactAt).some((e) => e.event === "turn_start"));
  assert.equal(p.requests.filter((body) => body.stream === false).length, 1, "only manual compaction requests a summary");
  assert.equal(h.index()[0].backgroundCompact, false);
});
