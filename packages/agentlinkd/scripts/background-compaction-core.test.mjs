// Explicit real-core + real-host gate; barrier provider, no network credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { durableHost, until } from "./durable-harness.mjs";

for (const enabled of [true, false]) test(`real host/core background compaction ${enabled ? "overlaps and applies idle" : "defaults off"}`, { timeout: 30000 }, async (t) => {
  assert.ok(process.env.DEXT_CORE_BIN, "set DEXT_CORE_BIN to CORE's verified binary");
  const requests = []; let summaryResponse;
  const provider = http.createServer(async (req, res) => {
    if (req.method !== "POST") { res.end("{}"); return; }
    const parts = []; for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts)); requests.push(body);
    if (body.stream === false) { summaryResponse = res; return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "Foreground answer completed while the summary barrier remains closed." }, finish_reason: "stop" }], usage: { prompt_tokens: 13, completion_tokens: 9 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  t.after(async () => { provider.closeAllConnections(); await new Promise((r) => provider.close(r)); });
  const h = await durableHost(t, {
    bin: process.env.DEXT_CORE_BIN,
    env: { DEXT_PROVIDER: "local", DEXT_MODEL: "mock-model", DEXT_MODEL_FORCE: "1", DEXT_BASE_URL: `http://127.0.0.1:${provider.address().port}`, DEXT_BACKGROUND_COMPACT: enabled ? "1" : "0" },
    setup({ home, state, cwd }) {
      const dir = path.join(home, "projects", "fixture", "sessions", "background-source"); fs.mkdirSync(dir, { recursive: true });
      const transcript = path.join(dir, "_latest.jsonl");
      const header = { version: 4, model: "mock-model", system: "test", session_id: "background-source", sandbox: cwd, compact_threshold_chars: 30000, seat: { id: "dextui-01234567" } };
      const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: "context ".repeat(250) }] }));
      fs.writeFileSync(transcript, [header, ...history].map(JSON.stringify).join("\n") + "\n");
      fs.mkdirSync(state, { recursive: true });
      fs.writeFileSync(path.join(state, "sessions.json"), JSON.stringify([{ id: "sess_123", title: "Background test", cwd, seat: header.seat.id, provider: "local", model: "mock-model", turns: 1, moved: true, approval: "never" }]));
    },
  });
  const c = await h.client(); const id = "sess_123";
  c.send("session.subscribe", { id }); await c.wait((e) => e.event === "session.snapshot");
  const started = performance.now();
  c.send("prompt.submit", { session: id, text: "First foreground task" });
  await c.wait((e) => e.event === "turn_end");
  const foregroundMs = Math.round(performance.now() - started);
  if (!enabled) {
    assert.equal(requests.filter((r) => r.stream === false).length, 0);
    assert.ok(!c.events.some((e) => e.event === "background_compaction"));
    return;
  }
  await until(() => summaryResponse);
  assert.ok(c.events.some((e) => e.event === "background_compaction" && e.data.phase === "running"));
  assert.ok(!c.events.some((e) => e.event === "compact_end"));
  assert.equal(h.index()[0].working, false);
  const reconnect = await h.client(); reconnect.send("session.subscribe", { id });
  const snap = await reconnect.wait((e) => e.event === "session.snapshot");
  assert.equal(snap.data.background_compaction.phase, "running");
  assert.equal(snap.data.working, false); assert.equal(snap.data.compacting, false);
  const nextAt = reconnect.events.length;
  reconnect.send("prompt.submit", { session: id, text: "Second foreground task while summarizing" });
  await reconnect.wait((e) => e.event === "turn_end", nextAt);
  assert.equal(requests.filter((r) => r.stream === false).length, 1, "one speculative job across turns");
  const beforeUsage = reconnect.events.slice(nextAt).filter((e) => e.event === "usage_update").at(-1).data.session;
  const beforeApply = reconnect.events.length;
  summaryResponse.writeHead(200, { "content-type": "application/json" });
  summaryResponse.end(JSON.stringify({ choices: [{ message: { content: "Installed background summary" }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7 } }));
  await reconnect.wait((e) => e.event === "background_compaction" && e.data.phase === "applied", beforeApply);
  const totalMs = Math.round(performance.now() - started);
  assert.equal(reconnect.events.slice(beforeApply).filter((e) => e.event === "turn_start").length, 0);
  assert.equal(h.journal(id).filter((e) => e.event === "compact_start").length, 0);
  assert.equal(h.journal(id).filter((e) => e.event === "compact_end" && e.data.background).length, 1);
  assert.ok(!h.journal(id).some((e) => e.event === "background_compaction"));
  const afterAt = reconnect.events.length; reconnect.send("session.subscribe", { id });
  const after = await reconnect.wait((e) => e.event === "session.snapshot", afterAt);
  assert.equal(after.data.background_compaction, null); assert.equal(after.data.working, false);
  assert.equal(after.data.context_source, "history");
  assert.equal(after.data.session_usage.input - beforeUsage.input, 11);
  assert.equal(after.data.session_usage.output - beforeUsage.output, 7);
  assert.equal(reconnect.events.slice(beforeApply).filter((e) => e.event === "usage_update").length, 1, "summary accounted once");
  const transcripts = [];
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (entry.name === "_latest.jsonl") transcripts.push(fs.readFileSync(file, "utf8"));
    }
  };
  scan(h.home);
  const saved = transcripts.find((text) => text.includes("Installed background summary"));
  assert.ok(saved, "owner persisted installed history before application events");
  assert.ok(saved.includes("First foreground task")); assert.ok(saved.includes("Second foreground task while summarizing"));
  t.diagnostic(`barrier overlap: first foreground=${foregroundMs}ms, idle apply total=${totalMs}ms; summary withheld through both foreground turns; not a speedup benchmark`);
});
