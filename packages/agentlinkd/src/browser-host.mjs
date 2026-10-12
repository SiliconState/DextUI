import crypto from 'node:crypto';
import { acceptKey, FrameParser, encodeFrame, OP_TEXT, OP_PONG, OP_CLOSE } from '../../mock-server/src/ws.mjs';
import { BrowserSession } from './browser-session.mjs';

// One operator-owned session, separate from AgentLink events/journals. Tickets
// live only in memory and are consumed once; the pairing token never enters a URL.
export function createBrowserHost({ checkAuth, port, Session = BrowserSession }) {
  const tickets = new Map();
  let active = null;
  let shuttingDown = false;
  function originOK(req) {
    try {
      const origin = new URL(req.headers.origin);
      if (!['http:', 'https:'].includes(origin.protocol)) return false;
      // Reverse proxies (nginx by default) may rewrite Host to the upstream.
      // Browsers cannot set X-Forwarded-Host on cross-site fetches without a
      // failing preflight, nor on WebSocket upgrades, so this stays origin-bound.
      const forwarded = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim();
      return origin.host === req.headers.host || (!!forwarded && origin.host === forwarded);
    } catch { return false; }
  }
  function reply(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }
  function http(req, res) {
    if (!checkAuth(req, res)) return;
    if (req.method !== 'POST') { reply(res, 405, { error: 'Use POST.' }); return; }
    if (!originOK(req)) { reply(res, 403, { error: 'Same-origin request required.' }); return; }
    if (shuttingDown || active) { reply(res, 409, { error: 'A browser is already open. Close it on the other device first.' }); return; }
    const now = Date.now();
    for (const [key, value] of tickets) if (value.expires < now) tickets.delete(key);
    if (tickets.size >= 8) { reply(res, 429, { error: 'Too many pending browser opens. Try again shortly.' }); return; }
    const ticket = crypto.randomBytes(24).toString('hex');
    tickets.set(ticket, { origin: req.headers.origin, expires: now + 30000 });
    reply(res, 200, { ticket });
  }
  function upgrade(req, socket, head) {
    socket.on('error', () => socket.destroy());
    const reject = (code = 403) => { socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(s => s.trim());
    const ticket = protocols.find(s => /^dext-browser\.[a-f0-9]{48}$/.test(s))?.slice(13);
    const grant = tickets.get(ticket);
    if (ticket) tickets.delete(ticket);
    if (!originOK(req) || !grant || grant.expires < Date.now() || grant.origin !== req.headers.origin) { reject(); return; }
    if (active || shuttingDown) { reject(409); return; }
    const key = req.headers['sec-websocket-key'];
    if (req.headers['sec-websocket-version'] !== '13' || !/^[A-Za-z0-9+/]{22}==$/.test(key ?? '') ||
        !/^websocket$/i.test(req.headers.upgrade ?? '') || !/\bupgrade\b/i.test(req.headers.connection ?? '')) { reject(400); return; }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\nSec-WebSocket-Protocol: dext-browser.${ticket}\r\n\r\n`);
    socket.setNoDelay(true);
    let ended = false, ready = false, queued = 0, budget = 240, budgetAt = Date.now();
    let lastActivity = Date.now(), lastPong = Date.now(), hiddenAt = 0;
    let chain = Promise.resolve();
    // One pending slot each for pointer moves and wheel deltas. A slow command
    // (navigation, a dialog-blocked click) must not let 60Hz pointer traffic
    // overflow the queue and kill the session. Any other command closes the
    // slot, so moves after it stay ordered after it.
    let moveSlot = null, wheelSlot = null;
    const enqueue = run => {
      if (queued >= 64) { void close(); return; }
      queued++;
      chain = chain.then(() => ended ? undefined : run())
        .catch(error => send({ type: 'error', message: error?.user ? error.message : 'Browser action failed. Retry, or use Open externally for unsupported actions.' }))
        .finally(() => queued--);
    };
    const send = message => {
      if (ended || socket.destroyed) return;
      // One JPEG frame may legitimately exceed 256 KiB of buffered output; only
      // a peer that has stopped reading entirely is disconnected.
      if (socket.writableLength > 8 * 1024 * 1024) { void close(); return; }
      socket.write(encodeFrame(OP_TEXT, Buffer.from(JSON.stringify(message))));
    };
    const session = new Session({ protectedPort: typeof port === 'function' ? port() : port, send, onClosed: () => void close(), frame: bytes => {
      if (ended || socket.destroyed || socket.writableLength > 256 * 1024) return false;
      socket.write(encodeFrame(2, bytes)); return true;
    } });
    let closing;
    const close = () => {
      if (closing) return closing;
      ended = true; clearInterval(reaper);
      // Flush queued text (for example a crash explanation) with a normal close
      // frame; a destroy would discard it. Force-destroy if the peer stalls.
      if (!socket.destroyed) {
        socket.end(encodeFrame(OP_CLOSE, Buffer.from([0x03, 0xe8])));
        setTimeout(() => socket.destroy(), 1000).unref?.();
      }
      closing = Promise.resolve().then(async () => {
        try { await session.close(); }
        finally { if (active?.session === session) active = null; }
      });
      // Socket callbacks have no promise consumer; cleanup failures must not
      // become unhandled rejections or retain ownership forever.
      void closing.catch(() => {});
      return closing;
    };
    active = { session, close };
    const reaper = setInterval(() => {
      const now = Date.now();
      if (now - lastActivity > 15 * 60000 || now - lastPong > 45000 || (hiddenAt && now - hiddenAt > 2 * 60000)) { void close(); return; }
      send({ type: 'ping' });
    }, 15000);
    reaper.unref?.();
    socket.on('end', () => void close());
    socket.on('close', () => void close());
    socket.on('error', () => void close());
    const parser = new FrameParser({ maxMessage: 16384,
      onClose: () => void close(), onPing: p => socket.write(encodeFrame(OP_PONG, p)),
      onMessage: payload => {
        if (ended) return;
        let message; try { message = JSON.parse(payload.toString()); } catch { void close(); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { void close(); return; }
        if (Date.now() - budgetAt >= 1000) { budgetAt = Date.now(); budget = 240; }
        if (--budget < 0) { void close(); return; }
        if (message.type === 'pong') { lastPong = Date.now(); return; }
        if (message.type === 'ack') { session.acknowledge(message.id); return; }
        if (message.type === 'close') { void close(); return; }
        if (!ready) { send({ type: 'error', message: 'Browser is still starting.' }); return; }
        // Input resets come from blur/focus loss, not user activity.
        if (message.type !== 'resetInput') lastActivity = Date.now();
        // A covered pane pauses capture without expiring; only a hidden tab does.
        if (message.type === 'visible') hiddenAt = message.value === false && message.hidden !== false ? hiddenAt || Date.now() : 0;
        // The page is blocked until its dialog is answered: never queue the answer
        // behind the input that opened the dialog.
        if (message.type === 'dialog') { void session.command(message).catch(() => send({ type: 'error', message: 'The website dialog is no longer open.' })); return; }
        if (message.type === 'mouse' && message.kind === 'mouseMoved') {
          wheelSlot = null; // a later wheel must not jump ahead of this move
          if (moveSlot) { moveSlot.message = message; return; }
          const slot = moveSlot = { message };
          enqueue(() => { if (moveSlot === slot) moveSlot = null; return session.command(slot.message); });
          return;
        }
        if (message.type === 'mouse' && message.kind === 'mouseWheel') {
          moveSlot = null;
          if (wheelSlot && Number.isFinite(message.dx) && Number.isFinite(message.dy)) {
            const m = wheelSlot.message;
            wheelSlot.message = { ...message, dx: m.dx + message.dx, dy: m.dy + message.dy };
            return;
          }
          const slot = wheelSlot = { message };
          enqueue(() => { if (wheelSlot === slot) wheelSlot = null; return session.command(slot.message); });
          return;
        }
        moveSlot = null; wheelSlot = null;
        enqueue(() => session.command(message));
      },
    });
    function receive(chunk) {
      if (ended) return;
      // FrameParser caps assembled messages; also bound incomplete wire frames.
      if (parser.buf.length + chunk.length > 32768) { void close(); return; }
      parser.push(chunk);
    }
    socket.on('data', receive);
    if (head?.length) receive(head);
    void session.start().then(() => { ready = !ended; }).catch(error => {
      send({ type: 'error', message: typeof error?.message === 'string' && error.message.startsWith('No supported browser') ? error.message : 'Could not start the host browser. Check its installation and OS sandbox support.' });
      // Give the explanatory text a chance to flush before releasing ownership.
      setTimeout(() => void close(), 100);
    });
  }
  async function close() { shuttingDown = true; tickets.clear(); await active?.close(); }
  return { http, upgrade, close };
}
