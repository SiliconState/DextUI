import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { browserExecutable } from '../src/browser-process.mjs';
import { encodeFrame } from '../../mock-server/src/ws.mjs';
import { BrowserSession, browseURL, allowedRequest } from '../src/browser-session.mjs';
import { createBrowserHost } from '../src/browser-host.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { const end = Date.now() + 12000; while (!fn()) { if (Date.now() > end) throw Error(`Timeout: ${label}`); await sleep(30); } }
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

test('URL entry and protected requests are explicitly constrained', () => {
  assert.equal(browseURL('localhost:3000/path'), 'http://localhost:3000/path');
  assert.equal(browseURL('devbox:3000'), 'http://devbox:3000/', 'single-label host:port is a host, not a scheme');
  assert.equal(browseURL('192.168.1.5:8080/x'), 'http://192.168.1.5:8080/x');
  assert.equal(browseURL('[::1]:5173'), 'http://[::1]:5173/');
  assert.equal(browseURL('example.com:8443'), 'https://example.com:8443/');
  assert.equal(browseURL('HTTPS://Example.com'), 'https://example.com/');
  for (const text of ['mailto:a@b.test', 'ftp://host.test', 'chrome://settings', 'about:blank']) assert.throws(() => browseURL(text), text);
  assert.equal(browseURL('example.com/path?q=https://else.test'), 'https://example.com/path?q=https://else.test');
  for (const text of ['', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'https://user:pass@host.test', 'two words']) assert.throws(() => browseURL(text), text);
  assert.equal(allowedRequest('http://alternate.local:8788/sessions', 8788), false);
  assert.equal(allowedRequest('file:///etc/passwd', 8788), false);
  assert.equal(allowedRequest('http://169.254.169.254/latest/meta-data', 8788), false);
  assert.equal(allowedRequest('http://localhost:3000', 8788), true);
});

test('explicit browser discovery reuses files and never installs a browser', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dext-browser-discovery-'));
  try {
    const binary = path.join(dir, 'browser');
    fs.writeFileSync(binary, 'fixture', { mode: 0o700 });
    assert.equal(browserExecutable({ DEXTUI_BROWSER_BIN: binary }), binary);
    assert.throws(() => browserExecutable({ DEXTUI_BROWSER_BIN: dir }), /No supported browser/);
    assert.throws(() => browserExecutable({ DEXTUI_BROWSER_BIN: path.join(dir, 'missing') }), /Nothing is downloaded automatically/);
    // A PATH-installed browser needs no automation pack or managed profile.
    const onPath = path.join(dir, process.platform === 'win32' ? 'msedge.exe' : 'chromium');
    fs.copyFileSync(binary, onPath);
    fs.chmodSync(onPath, 0o700);
    const fromPath = browserExecutable({ PATH: dir, DXB_HOME: path.join(dir, 'unused-pack-home'), DXB_BROWSERS: path.join(dir, 'unused-pack-browsers') });
    assert.ok(fs.existsSync(fromPath));
    assert.deepEqual(fs.readdirSync(dir).sort(), ['browser', path.basename(onPath)].sort());
    assert.equal(browserExecutable({ DEXTUI_BROWSER_BIN: binary, DXB_BROWSER: '/missing/pack/browser' }), binary);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('transport authenticates tickets, rejects hostile origins/replay and cleans up on disconnect', async () => {
  let started = 0, closed = 0;
  class Fake {
    constructor({ send, protectedPort }) { this.send = send; assert.equal(protectedPort, server.address().port); }
    async start() { started++; this.send({ type: 'ready' }); }
    async close() { closed++; }
    async command() {}
    acknowledge() {}
  }
  const server = http.createServer((req, res) => host.http(req, res));
  const host = createBrowserHost({ port: () => server.address().port, Session: Fake, checkAuth(req, res) {
    if (req.headers.authorization === 'Bearer fixture') return true;
    res.writeHead(401); res.end(); return false;
  } });
  server.on('upgrade', (req, socket, head) => host.upgrade(req, socket, head));
  await listen(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ticket = async headers => fetch(origin, { method: 'POST', headers });
  let socket;
  async function upgrade(value, wantedOrigin = origin) {
    socket = net.connect(server.address().port, '127.0.0.1');
    await new Promise(r => socket.once('connect', r));
    socket.write(`GET /browser/stream HTTP/1.1\r\nHost: 127.0.0.1:${server.address().port}\r\nOrigin: ${wantedOrigin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nSec-WebSocket-Protocol: dext-browser.${value}\r\n\r\n`);
    return new Promise(r => socket.once('data', b => r(b.toString())));
  }
  try {
    assert.equal((await ticket({ origin })).status, 401);
    assert.equal((await ticket({ origin: 'https://evil.test', authorization: 'Bearer fixture' })).status, 403);
    const { ticket: first } = await (await ticket({ origin, authorization: 'Bearer fixture' })).json();
    assert.match(await upgrade(first), /^HTTP\/1.1 101/);
    await until(() => started === 1, 'browser start');
    assert.equal((await ticket({ origin, authorization: 'Bearer fixture' })).status, 409);
    socket.destroy(); await until(() => closed === 1, 'disconnect cleanup');
    assert.match(await upgrade(first), /^HTTP\/1.1 403/); socket.destroy();
    assert.equal(started, 1);
    const authenticated = { origin, authorization: ['Bearer', 'fixture'].join(' ') };
    // Behind a reverse proxy that rewrites Host, the forwarded host is accepted;
    // a mismatched forwarded host is still a cross-origin request.
    assert.equal((await ticket({ ...authenticated, host: '127.0.0.1:1', origin: 'https://dext.example.test', 'x-forwarded-host': 'dext.example.test' })).status, 200);
    assert.equal((await ticket({ ...authenticated, origin: 'https://evil.test', 'x-forwarded-host': 'dext.example.test' })).status, 403);
    const { ticket: hostile } = await (await ticket(authenticated)).json();
    assert.match(await upgrade(hostile, 'https://evil.test'), /^HTTP\/1.1 403/); socket.destroy();
    assert.match(await upgrade(hostile), /^HTTP\/1.1 403/); socket.destroy();
    assert.equal(started, 1, 'hostile upgrade never starts a browser');
    const { ticket: oversized } = await (await ticket(authenticated)).json();
    assert.match(await upgrade(oversized), /^HTTP\/1.1 101/);
    await until(() => started === 2, 'second browser start');
    const payload = Buffer.alloc(20000, 0x61);
    const wire = encodeFrame(1, payload);
    const header = wire.subarray(0, wire.length - payload.length); header[1] |= 0x80;
    socket.write(Buffer.concat([header, Buffer.alloc(4), payload]));
    await until(() => closed === 2, 'oversized message cleanup');
    await host.close();
    assert.equal((await ticket(authenticated)).status, 409, 'shutdown rejects fresh ownership');
  } finally { socket?.destroy(); await host.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

function fakeSession() {
  const calls = [], sent = [];
  const b = new BrowserSession({ send() {}, frame: p => { sent.push(p.readUInt32BE(0)); return true; } });
  b.proc = { send: (method, params) => { calls.push([method, params]); return Promise.resolve({}); }, post: (method, params) => { calls.push([method, params]); }, close: async () => {} };
  b.sessionId = 'fixture';
  return { b, calls, sent };
}

test('a lost frame ACK delays delivery but cannot freeze the stream', async () => {
  const { b, sent } = fakeSession();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  try {
    b.pendingFrame = jpeg; b.flushFrame(); await sleep(100);
    assert.deepEqual(sent, [1]);
    b.pendingFrame = jpeg; b.flushFrame(); await sleep(150);
    assert.deepEqual(sent, [1], 'an unacknowledged frame still gates delivery');
    // Simulate the ACK deadline passing rather than sleeping for it.
    clearTimeout(b.frameTimer); b.frameTimer = null; b.inFlightAt -= 2000;
    b.flushFrame(); await sleep(100);
    assert.deepEqual(sent, [1, 2]); assert.equal(b.metrics.dropped, 1);
    b.acknowledge(2); assert.equal(b.inFlight, 0);
  } finally { await b.close(); }
});

test('socket backpressure retries the newest frame instead of leaving a stale canvas', async () => {
  let accept = false; const sent = [];
  const b = new BrowserSession({ send() {}, frame: p => { if (!accept) return false; sent.push(p.readUInt32BE(0)); return true; } });
  b.proc = { send: () => Promise.resolve({}), post() {}, close: async () => {} }; b.sessionId = 'fixture';
  try {
    b.pendingFrame = Buffer.from([0xff, 0xd8]).toString('base64'); b.flushFrame(); await sleep(120);
    assert.deepEqual(sent, []); assert.ok(b.pendingFrame, 'frame retained while the socket is full');
    accept = true; await sleep(350);
    assert.equal(sent.length, 1, 'retained frame delivered once the socket drains');
  } finally { await b.close(); }
});

test('input is dropped while a website dialog is open instead of blocking the queue', async () => {
  const { b, calls } = fakeSession();
  try {
    b.dialog = true;
    await b.command({ type: 'key', kind: 'keyDown', key: 'a', code: 'KeyA', modifiers: 0 });
    await b.command({ type: 'mouse', kind: 'mousePressed', x: 1, y: 1, button: 'left', buttons: 1 });
    await b.command({ type: 'text', text: 'x' });
    assert.equal(calls.length, 0);
    await b.command({ type: 'dialog', accept: false });
    assert.equal(calls.at(-1)[0], 'Page.handleJavaScriptDialog'); assert.equal(b.dialog, false);
    await assert.rejects(b.command({ type: 'navigate', url: 'mailto:x@y.test' }), e => e.user === true);
  } finally { await b.close(); }
});

test('held keys and buttons are released when input is suspended; characters keep key events', async () => {
  const { b, calls } = fakeSession();
  try {
    await b.command({ type: 'key', kind: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0 });
    assert.equal(calls.at(-1)[1].text, 'a', 'printable keys reach page keydown handlers with text');
    await b.command({ type: 'key', kind: 'keyDown', key: 'c', code: 'KeyC', keyCode: 67, modifiers: 2 });
    assert.equal(calls.at(-1)[1].text, undefined, 'Ctrl shortcuts insert no text');
    await b.command({ type: 'key', kind: 'keyDown', key: '@', code: 'KeyQ', keyCode: 81, modifiers: 3 });
    assert.equal(calls.at(-1)[1].text, '@', 'AltGr characters are text');
    await b.command({ type: 'mouse', kind: 'mousePressed', x: 10, y: 10, button: 'left', buttons: 1, count: 2 });
    assert.equal(calls.at(-1)[1].clickCount, 2, 'double-click count is forwarded');
    calls.length = 0;
    await b.command({ type: 'visible', value: false });
    const released = calls.filter(([m, p]) => (m === 'Input.dispatchKeyEvent' && p.type === 'keyUp') || (m === 'Input.dispatchMouseEvent' && p.type === 'mouseReleased'));
    assert.deepEqual(released.map(([, p]) => p.code ?? p.button).sort(), ['KeyA', 'KeyC', 'KeyQ', 'left']);
    calls.length = 0;
    await b.command({ type: 'key', kind: 'keyDown', key: 'x', code: 'KeyX', modifiers: 0 });
    assert.equal(calls.length, 0, 'input queued before suspension is dropped, not dispatched');
    await b.command({ type: 'resetInput' });
    assert.equal(calls.length, 0, 'nothing left to release');
  } finally { await b.close(); }
});

test('a session that closes itself releases host ownership', async () => {
  let session;
  class Fake {
    constructor({ send, onClosed }) { this.send = send; this.onClosed = onClosed; session = this; }
    async start() { this.send({ type: 'ready' }); }
    async close() { if (!this.closed) { this.closed = true; this.onClosed(); } }
    async command() {}
    acknowledge() {}
  }
  const server = http.createServer((req, res) => host.http(req, res));
  const host = createBrowserHost({ port: () => server.address().port, Session: Fake, checkAuth: () => true });
  server.on('upgrade', (req, socket, head) => host.upgrade(req, socket, head));
  await listen(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  let socket;
  try {
    const { ticket } = await (await fetch(origin, { method: 'POST', headers: { origin } })).json();
    socket = net.connect(server.address().port, '127.0.0.1');
    await new Promise(r => socket.once('connect', r));
    const received = [];
    socket.on('data', b => received.push(b));
    socket.write(`GET /browser/stream HTTP/1.1\r\nHost: 127.0.0.1:${server.address().port}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nSec-WebSocket-Protocol: dext-browser.${ticket}\r\n\r\n`);
    await until(() => session, 'session start');
    assert.equal((await fetch(origin, { method: 'POST', headers: { origin } })).status, 409);
    session.send({ type: 'error', message: 'Browser process stopped.' });
    await session.close(); // simulated browser crash, not a client close
    await until(() => Buffer.concat(received).includes('Browser process stopped.'), 'crash explanation flushed before close');
    // Await each poll: overlapping unawaited fetches can outlive the server.
    const end = Date.now() + 5000;
    while ((await fetch(origin, { method: 'POST', headers: { origin } })).status !== 200) {
      if (Date.now() > end) throw Error('Timeout: ownership released');
      await sleep(30);
    }
  } finally { socket?.destroy(); await host.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test('slow commands coalesce pointer traffic and never block a dialog answer', async () => {
  const ran = [];
  let release, session;
  class Fake {
    constructor({ send }) { this.send = send; session = this; }
    async start() { this.send({ type: 'ready' }); }
    async close() {}
    acknowledge() {}
    async command(m) {
      ran.push(m.type === 'mouse' ? `${m.kind}:${m.kind === 'mouseWheel' ? m.dy : m.x}` : m.type);
      if (m.type === 'navigate') await new Promise(r => { release = r; });
    }
  }
  const server = http.createServer((req, res) => host.http(req, res));
  const host = createBrowserHost({ port: () => server.address().port, Session: Fake, checkAuth: () => true });
  server.on('upgrade', (req, socket, head) => host.upgrade(req, socket, head));
  await listen(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  let socket;
  const message = m => { const payload = Buffer.from(JSON.stringify(m)); const wire = encodeFrame(1, payload); const header = wire.subarray(0, wire.length - payload.length); header[1] |= 0x80; return Buffer.concat([header, Buffer.alloc(4), payload]); };
  try {
    const { ticket } = await (await fetch(origin, { method: 'POST', headers: { origin } })).json();
    socket = net.connect(server.address().port, '127.0.0.1');
    await new Promise(r => socket.once('connect', r));
    socket.write(`GET /browser/stream HTTP/1.1\r\nHost: 127.0.0.1:${server.address().port}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nSec-WebSocket-Protocol: dext-browser.${ticket}\r\n\r\n`);
    await until(() => session, 'session start'); await sleep(50);
    socket.write(message({ type: 'navigate', url: 'https://example.test' }));
    await until(() => release, 'slow command running');
    // 100 moves and 100 wheel ticks exceed the 64-command cap unless coalesced.
    for (let i = 0; i < 100; i++) socket.write(message({ type: 'mouse', kind: 'mouseMoved', x: i, y: 1 }));
    for (let i = 0; i < 100; i++) socket.write(message({ type: 'mouse', kind: 'mouseWheel', x: 1, y: 1, dx: 0, dy: 1 }));
    socket.write(message({ type: 'dialog', accept: true }));
    await until(() => ran.includes('dialog'), 'dialog answered while the queue is blocked');
    release();
    await until(() => ran.length === 4, 'coalesced pointer commands run');
    assert.deepEqual(ran, ['navigate', 'dialog', 'mouseMoved:99', 'mouseWheel:100']);
    assert.equal(socket.destroyed, false, 'pointer bursts do not close the session');
  } finally { socket?.destroy(); await host.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test('real browser: streaming, input, idle/hidden budgets, backpressure and cleanup', { timeout: 45000 }, async () => {
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
    res.end('<title>Browser fixture</title><style>body{margin:0}input{width:200px;height:40px}</style><input id="field" oninput="document.title=this.value"><h1>Stream fixture</h1><script>window.animate=()=>setInterval(()=>document.body.style.background=`hsl(${Math.random()*360} 50% 50%)`,20)</script>');
  });
  await listen(site);
  let ack = true, frames = 0;
  const states = [];
  const b = new BrowserSession({ protectedPort: 8788, send: m => states.push(m), frame: data => {
    assert.equal(data[4], 0xff); assert.equal(data[5], 0xd8);
    frames++; if (ack) setTimeout(() => b.acknowledge(data.readUInt32BE(0)), 0); return true;
  } });
  const started = performance.now();
  try {
    await b.start();
    await b.command({ type: 'navigate', url: `http://127.0.0.1:${site.address().port}/` });
    await until(() => frames > 0 && b.url.includes(String(site.address().port)), 'render a site refusing iframe embedding');
    const firstFrameMs = Math.round(performance.now() - started);
    const ua = (await b.cdp('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true })).result.value;
    assert.doesNotMatch(ua, /HeadlessChrome/, 'bot filters (e.g. X.com) reject the headless product token');
    assert.match(ua, /Chrome\//);
    // Let navigation repaints settle (slow under a loaded parallel suite), then
    // measure: a static page must produce no frames while nothing changes.
    for (let last = b.metrics.frames, quietSince = Date.now(), end = Date.now() + 8000; Date.now() < end; await sleep(50)) {
      if (b.metrics.frames !== last) { last = b.metrics.frames; quietSince = Date.now(); }
      else if (Date.now() - quietSince >= 600) break;
    }
    const idleStart = { ...b.metrics }; await sleep(1500);
    const idleFrames = b.metrics.frames - idleStart.frames;
    const idleBytes = b.metrics.bytes - idleStart.bytes;
    assert.equal(idleFrames, 0, 'static page should not need periodic capture');
    await b.command({ type: 'mouse', kind: 'mousePressed', x: 30, y: 20, button: 'left', buttons: 1 });
    await b.command({ type: 'mouse', kind: 'mouseReleased', x: 30, y: 20, button: 'left', buttons: 0 });
    await b.command({ type: 'text', text: 'hello stream' });
    assert.equal((await b.cdp('Runtime.evaluate', { expression: 'document.querySelector("input").value', returnByValue: true })).result.value, 'hello stream');
    await until(() => states.some(m => m.type === 'state' && m.title === 'hello stream'), 'live title update without reloading');
    await assert.rejects(b.command({ type: 'navigate', url: 'http://localhost:8788/' }));
    await assert.rejects(b.command({ type: 'Runtime.evaluate', expression: '1' }));
    const origin = `http://127.0.0.1:${site.address().port}`;
    let controlRequests = 0;
    const protectedSite = http.createServer((_req, res) => { controlRequests++; res.end('control plane'); });
    protectedSite.on('upgrade', (_req, s) => { controlRequests++; s.destroy(); });
    await listen(protectedSite);
    // A cross-site iframe runs in another renderer process and a shared worker
    // is its own target; both must be guarded, not only the top page.
    const child = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<script>fetch('http://127.0.0.1:${protectedSite.address().port}/from-iframe').catch(()=>{})</script>`); });
    await listen(child);
    const originalPort = b.protectedPort;
    b.protectedPort = protectedSite.address().port;
    try {
      await b.cdp('Runtime.evaluate', { expression: `fetch('http://127.0.0.1:${b.protectedPort}/secret').catch(()=>{})` });
      await b.cdp('Runtime.evaluate', { expression: `(()=>{const f=document.createElement('iframe');f.src='http://localhost:${child.address().port}/';document.body.append(f);new SharedWorker(URL.createObjectURL(new Blob(["fetch('http://127.0.0.1:${b.protectedPort}/from-shared-worker').catch(()=>{})"])));})()` });
      await sleep(1200);
      assert.equal(controlRequests, 0, 'page, cross-site iframe and shared-worker requests cannot reach the protected port');
    } finally { b.protectedPort = originalPort; protectedSite.closeAllConnections(); child.closeAllConnections(); await new Promise(r => protectedSite.close(r)); await new Promise(r => child.close(r)); }
    // A click that opens a dialog stays pending until answered; answering it
    // out of band completes both without a spurious failure.
    await b.cdp('Runtime.evaluate', { expression: `document.body.insertAdjacentHTML('beforeend','<button id="dlg" style="position:fixed;left:0;top:300px;width:200px;height:60px" onmousedown="alert(1)">d</button>')` });
    const press = b.command({ type: 'mouse', kind: 'mousePressed', x: 50, y: 320, button: 'left', buttons: 1 });
    await until(() => states.some(m => m.type === 'dialog'), 'dialog surfaced');
    await b.command({ type: 'dialog', accept: true });
    await press;
    await until(() => states.some(m => m.type === 'dialogClosed'), 'dialog close reported');
    await b.command({ type: 'mouse', kind: 'mouseReleased', x: 50, y: 320, button: 'left', buttons: 0 });
    await b.cdp('Runtime.evaluate', { expression: `window.open(${JSON.stringify(origin + '/popup')})` });
    await until(() => states.some(m => m.type === 'notice' && m.message.includes('popup')), 'blocked popup notice');
    let pages;
    const end = Date.now() + 3000;
    do {
      pages = (await b.proc.send('Target.getTargets')).targetInfos.filter(t => t.type === 'page');
      if (pages.length === 1) break;
      await sleep(30);
    } while (Date.now() < end);
    assert.equal(pages.length, 1, 'popup target is closed');
    ack = false;
    await b.cdp('Runtime.evaluate', { expression: 'window.animate()' });
    await sleep(200); const blocked = frames; await sleep(400);
    assert.equal(frames, blocked, 'unacknowledged frame must stop delivery');
    assert.ok(b.metrics.dropped > 0);
    ack = true; b.acknowledge(b.inFlight);
    await b.command({ type: 'visible', value: false });
    await sleep(200); const hidden = frames; await sleep(600);
    assert.equal(frames, hidden, 'hidden pane must stop frame production/delivery');
    console.log(JSON.stringify({ firstFrameMs, idleObservationMs: 1500, idleFrames, idleBytes, totalFrames: frames, droppedUnderBackpressure: b.metrics.dropped }));
    const profile = b.proc.profile;
    await b.close(); assert.equal(fs.existsSync(profile), false, 'temporary profile removed');
    assert.ok(b.proc.child.exitCode !== null || b.proc.child.signalCode !== null);
  } finally { await b.close(); site.closeAllConnections(); await new Promise(r => site.close(r)); }
});
