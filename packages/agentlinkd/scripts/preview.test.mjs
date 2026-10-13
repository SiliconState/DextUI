// Local preview checks: header reads from an explicitly chosen loopback dev
// server only. Every server here is a test-owned 127.0.0.1 listener.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { previewURL, framingAllowed, checkPreview } from "../src/preview.mjs";

async function serve(t, handler) {
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; handler(req, res); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return { port: server.address().port, hits: () => hits };
}

test("only loopback http addresses are accepted, never the control plane", () => {
  assert.equal(previewURL("http://localhost:5173/x").port, "5173");
  for (const bad of ["https://localhost:5173", "http://example.com", "http://10.0.0.2:80", "http://u:p@localhost:1", "http://localhost.evil.test:1", "file:///x", "http://127.0.0.1:1 ", 42]) {
    assert.throws(() => previewURL(bad), undefined, String(bad));
  }
  assert.throws(() => previewURL("http://127.0.0.1:8788/", [8788]), /control plane/);
});

test("framing headers: any X-Frame-Options or a non-matching frame-ancestors refuses", () => {
  const app = "http://127.0.0.1:8788";
  assert.equal(framingAllowed({}, "http://localhost:5173", app), true);
  assert.equal(framingAllowed({ "x-frame-options": "SAMEORIGIN" }, "http://localhost:5173", app), false);
  assert.equal(framingAllowed({ "x-frame-options": "ALLOWALL" }, "http://localhost:5173", app), false);
  assert.equal(framingAllowed({ "content-security-policy": "frame-ancestors 'none'" }, "http://localhost:5173", app), false);
  assert.equal(framingAllowed({ "content-security-policy": "frame-ancestors 'self'" }, "http://localhost:5173", app), false);
  assert.equal(framingAllowed({ "content-security-policy": `default-src 'self'; frame-ancestors ${app}` }, "http://localhost:5173", app), true);
  assert.equal(framingAllowed({ "content-security-policy": "frame-ancestors *" }, "http://localhost:5173", app), true);
  assert.equal(framingAllowed({ "content-security-policy": "script-src 'self'" }, "http://localhost:5173", app), true);
});

test("checkPreview sends one HEAD, follows no redirects and reports framing refusals", async (t) => {
  const ok = await serve(t, (req, res) => { assert.equal(req.method, "HEAD"); res.end(); });
  assert.deepEqual(await checkPreview(`http://127.0.0.1:${ok.port}/`, { appOrigin: "http://127.0.0.1:8788" }), { url: `http://127.0.0.1:${ok.port}/`, allowed: true });
  assert.equal(ok.hits(), 1);
  const redirect = await serve(t, (_req, res) => { res.writeHead(302, { location: "https://example.com/" }); res.end(); });
  await assert.rejects(checkPreview(`http://127.0.0.1:${redirect.port}/`, { appOrigin: "x" }), /without redirects/);
  assert.equal(redirect.hits(), 1);
  const deny = await serve(t, (_req, res) => { res.writeHead(200, { "x-frame-options": "DENY" }); res.end(); });
  await assert.rejects(checkPreview(`http://127.0.0.1:${deny.port}/`, { appOrigin: "x" }), /does not permit framing/);
  await assert.rejects(checkPreview("http://127.0.0.1:1/", { appOrigin: "x" }), /Cannot preview/);
  const slow = await serve(t, () => {});
  await assert.rejects(checkPreview(`http://127.0.0.1:${slow.port}/`, { appOrigin: "x", timeout: 150 }), /Cannot preview|in time/);
});
