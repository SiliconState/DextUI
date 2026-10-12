import { BrowserProcess } from './browser-process.mjs';

// An isolated-world observer reports title text only, without polling or access
// to the paired UI. Headless targets/history do not reliably report live titles.
const TITLE_OBSERVER = `(() => {
  let previous;
  const update = () => {
    const title = document.title.slice(0, 4096);
    if (title !== previous) { previous = title; dextPageTitle(title); }
  };
  const observe = () => {
    update();
    if (document.head) new MutationObserver(update).observe(document.head, { subtree: true, childList: true, characterData: true });
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', observe, { once: true });
  else observe();
})()`;

// Errors safe and useful to show the operator verbatim (validation, net:: codes).
const userError = message => Object.assign(new Error(message), { user: true });

export function browseURL(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\\x00-\x1f]/.test(value)) throw userError('Enter an HTTP or HTTPS address.');
  // `devbox:3000` parses like a `devbox:` scheme. A digits-only suffix is a port.
  const hostPort = /^[a-z0-9.-]+:\d{1,5}(?:[/?#]|$)/i.test(value);
  const scheme = hostPort ? undefined : /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  if (scheme && scheme !== 'http' && scheme !== 'https') throw userError('Only HTTP and HTTPS are supported.');
  let text = value;
  if (!scheme) {
    const host = (/^(\[[^\]]*\]|[^/?#:]*)/.exec(value)?.[1] ?? '').toLowerCase();
    // Loopback, LAN-IP and single-label dev servers rarely have certificates.
    const local = host === 'localhost' || host.endsWith('.localhost') || host.startsWith('[') ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || (hostPort && !host.includes('.'));
    text = `${local ? 'http' : 'https'}://${value}`;
  }
  let url;
  try { url = new URL(text); } catch { throw userError('That address is not valid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw userError('Only HTTP and HTTPS addresses without embedded credentials are supported.');
  return url.href;
}

export function allowedRequest(value, protectedPort) {
  try {
    const u = new URL(value);
    if (['data:', 'blob:'].includes(u.protocol) || value === 'about:blank') return true;
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return false;
    // No requests to the control-plane port, regardless of loopback/DNS alias.
    // This is not a general local-network firewall: explicitly opened local apps
    // are supported. Their unauthenticated endpoints must be safe to browse.
    if (Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === protectedPort) return false;
    return !['169.254.169.254', 'metadata.google.internal'].includes(u.hostname);
  } catch { return false; }
}

export class BrowserSession {
  constructor({ send, frame, protectedPort, onClosed = () => {}, launch = () => BrowserProcess.launch() }) {
    this.send = send; this.frame = frame; this.protectedPort = protectedPort; this.launch = launch; this.onClosed = onClosed;
    this.heldKeys = new Map(); this.heldButtons = new Map();
    this.width = 1100; this.height = 760; this.visible = true; this.closed = false;
    this.pendingFrame = null; this.frameId = 0; this.inFlight = 0; this.lastSent = 0;
    this.metrics = { frames: 0, bytes: 0, dropped: 0, commands: 0 };
    this.url = 'about:blank'; this.title = ''; this.history = []; this.historyIndex = -1;
    this.loading = false; this.refreshTimer = null; this.frameTimer = null;
  }
  async start() {
    this.launching = this.launch();
    this.proc = await this.launching;
    if (this.closed) { await this.proc.close(); return; }
    this.proc.on('closed', () => { if (!this.closed) { this.send({ type: 'error', message: 'Browser process stopped. Close and start a new session.' }); void this.close().catch(() => {}); } });
    const { targetInfos } = await this.proc.send('Target.getTargets');
    const target = targetInfos.find(t => t.type === 'page');
    this.targetId = target?.targetId;
    this.title = target?.title ?? '';
    if (!this.targetId) throw new Error('Browser did not create a page.');
    this.sessionId = (await this.proc.send('Target.attachToTarget', { targetId: this.targetId, flatten: true })).sessionId;
    this.proc.on('event', m => this.event(m));
    // Headless Chrome announces itself as "HeadlessChrome", which bot filters
    // (X.com, many CDNs) answer with HTTP 403. A person drives this browser, so
    // present the ordinary Chrome product token of the same installed version.
    const { userAgent } = await this.proc.send('Browser.getVersion');
    if (/HeadlessChrome/.test(userAgent)) await this.cdp('Network.setUserAgentOverride', { userAgent: userAgent.replace('HeadlessChrome', 'Chrome') });
    await this.proc.send('Browser.setDownloadBehavior', { behavior: 'deny' });
    await this.proc.send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'denied' });
    await this.proc.send('Target.setDiscoverTargets', { discover: true });
    await this.cdp('Page.enable');
    await this.cdp('Runtime.enable');
    await this.cdp('Runtime.addBinding', { name: 'dextPageTitle', executionContextName: 'dextui-metadata' });
    await this.cdp('Page.addScriptToEvaluateOnNewDocument', { source: TITLE_OBSERVER, worldName: 'dextui-metadata' });
    await this.cdp('Page.setInterceptFileChooserDialog', { enabled: true });
    // Browser-wide interception covers the page, cross-site iframes (other
    // renderer processes) and dedicated/shared/service workers. Page-level
    // interception alone misses the latter, and auto-attaching to them paused
    // stalls window.open() after user gestures. WebSockets are not covered.
    await this.proc.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await this.cdp('Emulation.setDeviceMetricsOverride', { width: this.width, height: this.height, deviceScaleFactor: 1, mobile: false });
    await this.cdp('Page.bringToFront');
    await this.streaming(true);
    await this.refresh();
    if (!this.closed) this.send({ type: 'ready', width: this.width, height: this.height });
  }
  cdp(method, params = {}) { return this.proc.send(method, params, this.sessionId); }
  safe(method, params = {}) { this.proc.post(method, params, this.sessionId); }
  event(m) {
    if (this.closed) return;
    const p = m.params ?? {};
    if (m.method === 'Target.targetCreated' && p.targetInfo.type === 'page' && p.targetInfo.targetId !== this.targetId) {
      void this.proc.send('Target.closeTarget', { targetId: p.targetInfo.targetId }).catch(() => {});
      this.send({ type: 'notice', message: 'A popup was blocked. Open the site in your regular browser for multi-window sign-in.' });
    }
    if (m.method === 'Target.targetInfoChanged' && p.targetInfo.targetId === this.targetId) this.scheduleRefresh();
    if (m.method === 'Fetch.requestPaused') {
      // Browser-wide interception: answer on the (browser) session that asked.
      const ok = allowedRequest(p.request.url, this.protectedPort);
      this.proc.post(ok ? 'Fetch.continueRequest' : 'Fetch.failRequest', ok ? { requestId: p.requestId } : { requestId: p.requestId, errorReason: 'BlockedByClient' }, m.sessionId);
      return;
    }
    if (m.sessionId !== this.sessionId) return;
    if (m.method === 'Runtime.executionContextCreated' && p.context.name === 'dextui-metadata' && p.context.auxData?.frameId === this.mainFrameId) this.titleContextId = p.context.id;
    if (m.method === 'Runtime.bindingCalled' && p.name === 'dextPageTitle' && p.executionContextId === this.titleContextId && typeof p.payload === 'string' && p.payload.length <= 4096) {
      this.title = p.payload;
      this.scheduleRefresh();
    } else if (m.method === 'Page.screencastFrame') {
      // Acknowledge Chrome immediately, retain only newest frame. UI ACKs gate
      // delivery separately, so animations never accumulate in a socket queue.
      this.safe('Page.screencastFrameAck', { sessionId: p.sessionId });
      if (!this.visible || p.data.length > 4 * 1024 * 1024) { this.metrics.dropped++; return; }
      if (this.pendingFrame) this.metrics.dropped++;
      this.pendingFrame = p.data;
      this.flushFrame();
    } else if (m.method === 'Page.frameNavigated' && !p.frame.parentId) {
      this.mainFrameId = p.frame.id;
      this.titleContextId = undefined;
      this.url = p.frame.url;
      this.scheduleRefresh();
    } else if (m.method === 'Page.loadEventFired') {
      // Chrome can leave an about:blank screencast inactive after navigation.
      // Restart on actual document loads, not a polling screenshot timer.
      if (this.visible) void this.restartStream().catch(() => {});
    } else if (m.method === 'Page.frameStartedLoading') { this.loading = true; this.scheduleRefresh(); }
    else if (m.method === 'Page.frameStoppedLoading' || m.method === 'Page.navigatedWithinDocument') { this.loading = false; this.scheduleRefresh(); }
    else if (m.method === 'Page.javascriptDialogOpening') {
      this.dialog = true;
      this.send({ type: 'dialog', kind: p.type, message: String(p.message).slice(0, 4000), defaultPrompt: String(p.defaultPrompt ?? '').slice(0, 2000) });
    } else if (m.method === 'Page.javascriptDialogClosed') {
      // Navigation or page script can dismiss a dialog; drop the stale prompt.
      this.dialog = false;
      this.send({ type: 'dialogClosed' });
    } else if (m.method === 'Page.fileChooserOpened') {
      this.send({ type: 'notice', message: 'File upload is not available in this streamed session. Use Open externally.' });
    }
  }
  flushFrame() {
    if (this.closed || !this.visible || !this.pendingFrame || this.frameTimer) return;
    if (this.inFlight) {
      // A client can lose an ACK (dropped send, decode skip, tab throttling).
      // Bound the stall instead of freezing the stream until the next resize.
      const wait = 2000 - (Date.now() - this.inFlightAt);
      if (wait > 0) { this.frameTimer = setTimeout(() => { this.frameTimer = null; this.flushFrame(); }, wait); return; }
      this.inFlight = 0; this.metrics.dropped++;
    }
    const delay = Math.max(0, 66 - (Date.now() - this.lastSent)); // <=15fps, no idle timer
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null;
      if (this.closed || !this.visible || this.inFlight || !this.pendingFrame) return;
      const data = this.pendingFrame;
      const bytes = Buffer.from(data, 'base64'); this.pendingFrame = null;
      const id = ++this.frameId;
      const packet = Buffer.allocUnsafe(4 + bytes.length); packet.writeUInt32BE(id); bytes.copy(packet, 4);
      if (!this.frame(packet)) {
        // Socket backpressure: keep the newest frame and retry. A static page
        // sends no further frames, so dropping it would leave a stale canvas.
        this.metrics.dropped++; this.pendingFrame ??= data;
        this.frameTimer = setTimeout(() => { this.frameTimer = null; this.flushFrame(); }, 250);
        return;
      }
      this.inFlight = id; this.inFlightAt = this.lastSent = Date.now(); this.metrics.frames++; this.metrics.bytes += packet.length;
    }, delay);
  }
  acknowledge(id) {
    if (id !== this.inFlight) return;
    this.inFlight = 0;
    // Replace any ACK-stall wait; flushFrame recomputes the 15fps pacing delay.
    clearTimeout(this.frameTimer); this.frameTimer = null;
    this.flushFrame();
  }
  async streaming(visible) {
    this.visible = visible;
    return this.restartStream();
  }
  restartStream() {
    // Serialize load/resize/visibility changes to prevent late starts after hide.
    this.streamChain = (this.streamChain ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (this.closed) return;
      this.pendingFrame = null; this.inFlight = 0;
      clearTimeout(this.frameTimer); this.frameTimer = null;
      await this.cdp('Page.stopScreencast');
      if (this.visible && !this.closed) {
        await this.cdp('Page.bringToFront');
        await this.cdp('Page.startScreencast', { format: 'jpeg', quality: 78, maxWidth: this.width, maxHeight: this.height, everyNthFrame: 1 });
      }
    });
    return this.streamChain;
  }
  scheduleRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; void this.refresh().catch(() => {}); }, 100);
  }
  async refresh() {
    if (this.closed) return;
    const h = await this.cdp('Page.getNavigationHistory');
    this.history = h.entries; this.historyIndex = h.currentIndex;
    const entry = h.entries[h.currentIndex];
    this.url = entry?.url ?? this.url;
    this.send({ type: 'state', url: this.url, title: this.title, loading: this.loading,
      back: h.currentIndex > 0, forward: h.currentIndex < h.entries.length - 1, metrics: this.metrics });
  }
  async command(m) {
    if (this.closed || !this.sessionId) throw new Error('Browser is not ready.');
    if (m.type === 'resetInput') { await this.releaseInput(); return; }
    // Input already in flight when the pane was covered is dropped quietly. While
    // a JavaScript dialog is open the page cannot receive input; each event
    // would otherwise block the command queue until the CDP timeout.
    if ((!this.visible || this.dialog) && ['mouse', 'key', 'text'].includes(m.type)) return;
    this.metrics.commands++;
    switch (m.type) {
      case 'navigate': {
        const url = browseURL(m.url);
        if (!allowedRequest(url, this.protectedPort)) throw userError('That address is reserved for the DextUI host and cannot be browsed.');
        let result;
        // Heavy sites can take longer than the CDP command timeout to commit.
        // The page keeps loading and state updates report it; that is not an error.
        try { result = await this.cdp('Page.navigate', { url }); }
        catch (error) { if (/timed out\.$/.test(error.message)) break; throw error; }
        if (result.errorText) throw userError(result.errorText === 'net::ERR_HTTP_RESPONSE_CODE_FAILURE'
          ? 'The site refused the request (HTTP error). Some sites block remote or automated browsers; use Open externally.'
          : `Could not open the page (${String(result.errorText).slice(0, 120)}).`);
        break;
      }
      case 'back': case 'forward': {
        const entry = this.history[this.historyIndex + (m.type === 'back' ? -1 : 1)];
        if (entry) await this.cdp('Page.navigateToHistoryEntry', { entryId: entry.id });
        break;
      }
      case 'reload': await this.cdp('Page.reload'); break;
      case 'stop': await this.cdp('Page.stopLoading'); break;
      case 'visible':
        if (typeof m.value !== 'boolean') throw new Error('Invalid visibility.');
        if (!m.value) await this.releaseInput();
        if (this.visible !== m.value) await this.streaming(m.value);
        break;
      case 'resize': {
        if (!Number.isInteger(m.width) || !Number.isInteger(m.height)) throw new Error('Invalid viewport.');
        const width = Math.min(1600, Math.max(360, m.width)), height = Math.min(1200, Math.max(240, m.height));
        if (width === this.width && height === this.height) break;
        this.width = width; this.height = height;
        await this.cdp('Emulation.setDeviceMetricsOverride', { width: this.width, height: this.height, deviceScaleFactor: 1, mobile: false });
        await this.streaming(this.visible);
        this.send({ type: 'size', width: this.width, height: this.height });
        break;
      }
      case 'mouse': {
        if (!['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'].includes(m.kind)) throw new Error('Invalid pointer.');
        const x = Math.max(0, Math.min(this.width, Number(m.x))); const y = Math.max(0, Math.min(this.height, Number(m.y)));
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid pointer coordinates.');
        const params = { type: m.kind, x, y, modifiers: this.modifiers(m.modifiers) };
        if (m.kind === 'mouseWheel') {
          if (!Number.isFinite(m.dx) || !Number.isFinite(m.dy)) throw new Error('Invalid scroll.');
          Object.assign(params, { deltaX: Math.max(-2000, Math.min(2000, m.dx)), deltaY: Math.max(-2000, Math.min(2000, m.dy)) });
        } else Object.assign(params, { button: ['left', 'right', 'middle'].includes(m.button) ? m.button : 'none', buttons: Number.isInteger(m.buttons) ? m.buttons & 7 : 0, clickCount: m.kind === 'mouseMoved' ? 0 : [1, 2, 3].includes(m.count) ? m.count : 1 });
        await this.input('Input.dispatchMouseEvent', params);
        if (m.kind === 'mousePressed' && params.button !== 'none') this.heldButtons.set(params.button, { x, y });
        if (m.kind === 'mouseReleased') this.heldButtons.delete(params.button);
        break;
      }
      case 'key': {
        if (!['keyDown', 'keyUp'].includes(m.kind) || typeof m.key !== 'string' || m.key.length > 40 || typeof m.code !== 'string' || m.code.length > 40) throw new Error('Invalid key.');
        const modifiers = this.modifiers(m.modifiers);
        const id = m.code || m.key;
        if (m.kind === 'keyDown' && !this.heldKeys.has(id) && this.heldKeys.size >= 64) throw new Error('Too many held keys.');
        const params = { type: m.kind, key: m.key, code: m.code, modifiers,
          windowsVirtualKeyCode: Number.isInteger(m.keyCode) ? Math.max(0, Math.min(255, m.keyCode)) : 0,
          ...(m.kind === 'keyDown' && m.key === 'Enter' ? { text: '\r' }
            // Shift, macOS Option and AltGr (Ctrl+Alt) produce characters;
            // Ctrl or Meta alone are shortcuts and must not insert text.
            : m.kind === 'keyDown' && [...m.key].length === 1 && !(modifiers & 4) && (modifiers & 3) !== 2 ? { text: m.key, unmodifiedText: m.key } : {}) };
        await this.input('Input.dispatchKeyEvent', params);
        if (m.kind === 'keyDown') this.heldKeys.set(id, { key: m.key, code: m.code, windowsVirtualKeyCode: params.windowsVirtualKeyCode });
        else this.heldKeys.delete(id);
        break;
      }
      case 'text':
        if (typeof m.text !== 'string' || m.text.length > 8192) throw new Error('Text exceeds limit.');
        await this.input('Input.insertText', { text: m.text }); break;
      case 'dialog':
        if (!this.dialog || typeof m.accept !== 'boolean') throw new Error('No pending dialog.');
        await this.cdp('Page.handleJavaScriptDialog', { accept: m.accept, promptText: typeof m.text === 'string' ? m.text.slice(0, 2000) : '' }); this.dialog = false; break;
      default: throw new Error('Unsupported browser command.');
    }
  }
  // Input that opens a JavaScript dialog does not complete until the dialog is
  // answered (the host answers dialogs outside the input queue). A timeout
  // while the dialog is still open is expected, not an action failure.
  async input(method, params) {
    try { await this.cdp(method, params); }
    catch (error) { if (!this.dialog) throw error; }
  }
  releaseInput() {
    const keys = [...this.heldKeys.values()], buttons = [...this.heldButtons];
    this.heldKeys.clear(); this.heldButtons.clear();
    // Fire-and-forget: a pending dialog must not stall release by 10s per key.
    for (const key of keys) this.safe('Input.dispatchKeyEvent', { type: 'keyUp', ...key, modifiers: 0 });
    for (const [button, point] of buttons) this.safe('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, buttons: 0, clickCount: 1, modifiers: 0 });
  }
  modifiers(value) { return Number.isInteger(value) ? value & 15 : 0; }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    clearTimeout(this.refreshTimer); clearTimeout(this.frameTimer);
    this.pendingFrame = null;
    this.heldKeys.clear(); this.heldButtons.clear();
    this.closing = Promise.resolve().then(async () => {
      try {
        const proc = this.proc ?? await this.launching?.catch(() => null);
        await proc?.close();
      } finally { this.onClosed(); }
    });
    return this.closing;
  }
}
