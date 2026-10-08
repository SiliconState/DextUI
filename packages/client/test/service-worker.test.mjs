import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../../../apps/web/public/sw.js", import.meta.url), "utf8");
function worker() {
  const handlers = {};
  const stored = new Map();
  let failCache = false, failOpen = false, failMatch = false, offline = false;
  let networkCalls = 0;
  let nextResponse = () => new Response("asset", { status: 200 });
  let openGate = Promise.resolve();
  let openRelease;
  let claimCalls = 0;
  const cache = {
    put: async (request, response) => { if (failCache) throw new Error("quota"); stored.set(request.url, response); },
    delete: async request => stored.delete(request.url),
    match: async request => { if (failMatch) throw new Error("read denied"); return stored.get(request.url)?.clone(); },
  };
  const context = {
    self: { location: { href: "https://app.example/sw.js?v=fixture", origin: "https://app.example" }, addEventListener: (kind, fn) => { handlers[kind] = fn; }, clients: { claim: async () => { claimCalls++; } } },
    caches: { open: async () => { await openGate; if (failOpen) throw new Error("storage denied"); return cache; }, keys: async () => { if (failOpen) throw new Error("storage denied"); return []; }, delete: async () => true }, URL,
    fetch: async () => { networkCalls++; if (offline) throw new Error("network offline"); return nextResponse(); },
  };
  vm.runInNewContext(source, context);
  function request(url, options = {}) {
    const pending = [];
    let response;
    let dispatching = true;
    handlers.fetch({ request: { method: "GET", cache: "default", headers: new Headers(), url, ...options }, respondWith: p => { response = p; }, waitUntil: p => { assert.ok(dispatching, "waitUntil must be registered synchronously"); pending.push(p); } });
    dispatching = false;
    return { response, pending };
  }
  return { request, stored, deferOpen: () => { openGate = new Promise(resolve => { openRelease = resolve; }); }, releaseOpen: () => openRelease(), activate: async () => { let pending; handlers.activate({ waitUntil: p => { pending = p; } }); await pending; }, claimCalls: () => claimCalls, networkCalls: () => networkCalls, failCache: () => { failCache = true; }, failOpen: () => { failOpen = true; }, failMatch: () => { failMatch = true; }, offline: () => { offline = true; }, response: fn => { nextResponse = fn; } };
}

test("PWA demand-loaded assets finish caching and replay offline repeatedly", async () => {
  const w = worker();
  const url = "https://app.example/assets/mermaid-render-12345678.js";
  const online = w.request(url);
  assert.equal((await online.response).status, 200);
  assert.equal(online.pending.length, 1);
  await Promise.all(online.pending);
  assert.ok(w.stored.has(url));
  w.offline();
  for (let i = 0; i < 2; i++) {
    const hit = w.request(url);
    assert.equal(await (await hit.response).text(), "asset");
    await Promise.all(hit.pending);
  }
});

test("PWA caches its own clone even when the caller consumes before storage opens", async () => {
  const w = worker(); w.deferOpen();
  const asset = w.request("https://app.example/assets/renderer.js");
  assert.equal(await (await asset.response).text(), "asset");
  w.releaseOpen(); await Promise.all(asset.pending);
  assert.equal(w.stored.size, 1);
  assert.equal(await [...w.stored.values()][0].text(), "asset");
});

test("PWA cache failures cannot block a healthy network or hide its real failure", async () => {
  for (const failure of ["failCache", "failOpen"]) {
    const w = worker(); w[failure]();
    const asset = w.request("https://app.example/assets/renderer.js");
    assert.equal(await (await asset.response).text(), "asset");
    await Promise.all(asset.pending);
    assert.equal(w.networkCalls(), 1);
    assert.equal(w.stored.size, 0);
    w.offline();
    const miss = w.request("https://app.example/assets/absent.js");
    await assert.rejects(miss.response, /network offline/);
    await Promise.all(miss.pending);
  }
  const w = worker(); w.offline(); w.failMatch();
  const miss = w.request("https://app.example/assets/renderer.js");
  await assert.rejects(miss.response, /network offline/);
  await Promise.all(miss.pending);
});

test("PWA activation still claims clients when CacheStorage is denied", async () => {
  const w = worker(); w.failOpen();
  await w.activate();
  assert.equal(w.claimCalls(), 1);
});

test("PWA never intercepts live APIs, private request URLs or credentials", () => {
  const w = worker();
  for (const url of ["https://app.example/sessions/s/todos", "https://app.example/sessions/s/file/report.svg?t=secret", "https://app.example/diagram", "blob:https://app.example/id", "https://other.example/assets/a.js", "https://app.example/assets/a.js?t=secret", "https://app.example/assets/a.js?token=secret"]) assert.equal(w.request(url).response, undefined);
  assert.equal(w.request("https://app.example/assets/a.js", { cache: "no-store" }).response, undefined);
  assert.equal(w.request("https://app.example/assets/a.js", { method: "POST" }).response, undefined);
  assert.equal(w.request("https://app.example/assets/a.js", { headers: new Headers({ Authorization: "Bearer test" }) }).response, undefined);
  assert.equal(w.networkCalls(), 0);
});

test("PWA transient server errors retain the previously cached public shell", async () => {
  const w = worker();
  const url = "https://app.example/assets/renderer.js";
  const original = w.request(url);
  await original.response; await Promise.all(original.pending);
  w.response(() => new Response("unavailable", { status: 503 }));
  const unavailable = w.request(url);
  assert.equal((await unavailable.response).status, 503);
  await Promise.all(unavailable.pending);
  w.offline();
  const offline = w.request(url);
  assert.equal(await (await offline.response).text(), "asset");
  await Promise.all(offline.pending);
});

test("PWA purges a former public cache entry when network revokes cacheability", async () => {
  for (const options of [{ headers: { "cache-control": "private" } }, { headers: { "cache-control": "no-store" } }, { status: 403 }, { status: 404 }, { url: "https://app.example/login" }]) {
    const w = worker();
    const url = "https://app.example/assets/renderer.js";
    const publicAsset = w.request(url);
    await publicAsset.response; await Promise.all(publicAsset.pending);
    assert.ok(w.stored.has(url));
    w.response(() => {
      const response = new Response("revoked", options);
      if (options.url) Object.defineProperty(response, "url", { value: options.url });
      return response;
    });
    const revoked = w.request(url);
    assert.equal(await (await revoked.response).text(), "revoked");
    await Promise.all(revoked.pending);
    assert.equal(w.stored.has(url), false, JSON.stringify(options));
    w.offline();
    const offline = w.request(url);
    await assert.rejects(offline.response, /network offline/);
    await Promise.all(offline.pending);
  }
});

test("PWA does not cache no-store/private/errors or redirected private responses", async () => {
  for (const options of [{ status: 404 }, { headers: { "cache-control": "private" } }, { headers: { "cache-control": "no-store" } }, { url: "https://other.example/assets/a.js" }, { url: "https://app.example/sessions/s/file/a.js" }, { url: "https://app.example/assets/a.js?t=secret" }]) {
    const w = worker();
    w.response(() => {
      const response = new Response("content", options);
      if (options.url) Object.defineProperty(response, "url", { value: options.url });
      return response;
    });
    const asset = w.request("https://app.example/assets/a.js");
    assert.equal(await (await asset.response).text(), "content");
    await Promise.all(asset.pending);
    assert.equal(w.stored.size, 0, JSON.stringify(options));
  }
});
