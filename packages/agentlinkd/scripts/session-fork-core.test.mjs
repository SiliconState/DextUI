import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { durableHost } from "./durable-harness.mjs";

test("real host/core kept fork maps seq, rounds tool pairs, persists and resumes independently", { timeout: 30000 }, async (t) => {
  assert.ok(process.env.DEXT_CORE_BIN, "set DEXT_CORE_BIN to reviewed core");
  const requests = [];
  const provider = http.createServer(async (req, res) => {
    if (req.method !== "POST") return res.end("{}");
    const parts = []; for await (const b of req) parts.push(b); requests.push(JSON.parse(Buffer.concat(parts)));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"Fork resumed."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  t.after(async () => { provider.closeAllConnections(); await new Promise((r) => provider.close(r)); });
  let source;
  const h = await durableHost(t, { bin: process.env.DEXT_CORE_BIN, env: { DEXT_PROVIDER: "local", DEXT_MODEL: "mock-model", DEXT_BASE_URL: `http://127.0.0.1:${provider.address().port}`, DEXT_BACKGROUND_COMPACT: "0" }, setup({ home, state, cwd }) {
    const dir = path.join(home, "projects", "fixture", "sessions", "fork-source"); fs.mkdirSync(dir, { recursive: true });
    source = path.join(dir, "_latest.jsonl");
    const history = [
      { role: "user", content: [{ type: "text", text: "First task" }] },
      { role: "assistant", content: [{ type: "text", text: "Inspecting" }, { type: "tool_use", id: "read-1", name: "read_file", input: { path: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: "result" }] },
      { role: "assistant", content: [{ type: "text", text: "Done" }] },
    ];
    fs.writeFileSync(source, [{ version: 4, model: "mock-model", system: "test", session_id: "fork-source", sandbox: cwd, seat: { id: "dextui-1234" } }, ...history].map(JSON.stringify).join("\n") + "\n");
    fs.mkdirSync(path.join(state, "journals"), { recursive: true });
    fs.writeFileSync(path.join(state, "sessions.json"), JSON.stringify([{ id: "sess_123", title: "Source", cwd, seat: "dextui-1234", provider: "local", model: "mock-model", turns: 1, moved: true, approval: "never" }]));
    const script = [{ event: "user_message", data: { text: "First task" } }, { event: "text_block_complete", data: "Inspecting" }, { event: "tool_call_result", data: { call_id: "read-1" } }, { event: "turn_end", data: { usage: {}, failed: false } }];
    fs.writeFileSync(path.join(state, "journals/sess_123.jsonl"), script.map((e, i) => JSON.stringify({ v: 1, session: "sess_123", seq: (i + 1) * 10, ts: Date.now(), ...e })).join("\n") + "\n");
  } });
  const before = fs.readFileSync(source, "utf8"); const c = await h.client();
  assert.ok(c.hello.data.capabilities.includes("session_fork"));
  c.send("session.fork", { id: "sess_123", at_seq: 999 });
  assert.equal((await c.wait((e) => e.event === "error")).data.code, "fork_failed");
  assert.equal(h.index().length, 1, "invalid selection creates no session");
  c.send("session.fork", { id: "sess_123", at_seq: 20 });
  const result = await c.wait((e) => e.event === "session.forked");
  assert.equal(result.data.at, 1, "call without result rounds back");
  assert.notEqual(result.data.session_id, "fork-source");
  assert.equal(fs.readFileSync(source, "utf8"), before);
  assert.equal(requests.length, 0, "fork makes no provider request");
  const id = result.data.meta.id;
  c.send("session.subscribe", { id }); const snap = await c.wait((e) => e.event === "session.snapshot" && e.session === id);
  assert.equal(snap.data.working, false); assert.equal(snap.data.background_compaction, null);
  assert.ok(snap.data.blocks.some((b) => b.kind === "user" && b.text === "First task"));
  assert.ok(!snap.data.blocks.some((b) => b.kind === "tool"));
  await h.stop(); await h.start();
  const next = await h.client(); assert.ok(next.hello.data.sessions.some((s) => s.id === id));
  next.send("session.subscribe", { id }); await next.wait((e) => e.event === "session.snapshot");
  next.send("prompt.submit", { session: id, text: "Continue the fork" }); await next.wait((e) => e.event === "turn_end");
  assert.ok(JSON.stringify(requests.at(-1)).includes("First task"));
  assert.ok(!JSON.stringify(requests.at(-1)).includes("Inspecting"));
  assert.equal(fs.readFileSync(source, "utf8"), before);
});
