// Private CDP pipe: never opens a debugging TCP port or attaches to user profiles.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export function browserExecutable(env = process.env) {
  const explicit = env.DEXTUI_BROWSER_BIN;
  const candidates = explicit ? [explicit] : [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ...[env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean).flatMap(base => [
      path.join(base, 'Google/Chrome/Application/chrome.exe'),
      path.join(base, 'Microsoft/Edge/Application/msedge.exe'),
      path.join(base, 'BraveSoftware/Brave-Browser/Application/brave.exe'),
    ]),
    ...['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'microsoft-edge', 'brave-browser', 'brave', 'msedge.exe'].flatMap(name =>
      (env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name))),
  ];
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  throw new Error('No supported browser installed on the host. Set DEXTUI_BROWSER_BIN to installed Chrome, Edge, Brave or Chromium. Safari cannot provide this streaming protocol. Nothing is downloaded automatically.');
}

export class BrowserProcess extends EventEmitter {
  static async launch(options = {}) {
    const executable = options.executable ?? browserExecutable();
    const profile = fs.mkdtempSync(path.join(options.tmpRoot ?? os.tmpdir(), 'dextui-browser-'));
    fs.chmodSync(profile, 0o700);
    const env = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TEMP', 'LANG', 'DISPLAY', 'XDG_RUNTIME_DIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    const child = spawn(executable, [
      '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--headless=new',
      '--no-first-run', '--no-default-browser-check', '--disable-sync',
      '--disable-background-networking', '--disable-extensions', '--mute-audio',
      '--password-store=basic', '--use-mock-keychain', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], env });
    const proc = new BrowserProcess(child, profile);
    try { await proc.send('Browser.getVersion'); return proc; }
    catch (e) { await proc.close(); throw e; }
  }

  constructor(child, profile) {
    super();
    this.child = child; this.profile = profile; this.pending = new Map(); this.seq = 0;
    this.parts = []; this.bytes = 0; this.closed = false; this.stderr = '';
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-2048); });
    child.once('error', () => this.fail(new Error('Could not launch host browser.')));
    child.once('exit', () => this.fail(new Error('Host browser exited.')));
    child.stdio[3].on('error', () => this.fail(new Error('Browser pipe closed.')));
    child.stdio[4].on('error', () => this.fail(new Error('Browser pipe closed.')));
    child.stdio[4].once('end', () => this.fail(new Error('Browser pipe ended.')));
    child.stdio[4].once('close', () => this.fail(new Error('Browser pipe closed.')));
    child.stdio[4].on('data', chunk => {
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 0) continue;
        this.parts.push(chunk.subarray(start, i)); this.bytes += i - start;
        if (this.bytes > 12 * 1024 * 1024) { void this.close(); return; }
        const text = Buffer.concat(this.parts, this.bytes).toString('utf8');
        this.parts = []; this.bytes = 0; start = i + 1;
        try { this.dispatch(JSON.parse(text)); } catch { this.fail(new Error('Invalid browser pipe message.')); void this.close(); return; }
      }
      if (start < chunk.length) { this.parts.push(chunk.subarray(start)); this.bytes += chunk.length - start; }
      if (this.bytes > 12 * 1024 * 1024) void this.close();
    });
  }

  dispatch(message) {
    if (message.id) {
      const job = this.pending.get(message.id); if (!job) return;
      clearTimeout(job.timer); this.pending.delete(message.id);
      if (message.error) job.reject(new Error(`${job.method}: ${message.error.message}`));
      else job.resolve(message.result);
    } else this.emit('event', message);
  }

  send(method, params = {}, sessionId) {
    if (this.closed || this.pending.size >= 128) return Promise.reject(new Error('Browser unavailable or busy.'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out.`)); }, 10000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0', err => {
        if (err) this.fail(new Error('Browser pipe write failed.'));
      });
    });
  }

  // Fire-and-forget acknowledgements (request continuation, frame ACKs). These
  // must never hit the pending-command cap: a page that starts hundreds of
  // requests at once would otherwise leave the overflow paused forever.
  post(method, params = {}, sessionId) {
    if (this.closed) return;
    this.child.stdio[3].write(JSON.stringify({ id: ++this.seq, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0', err => {
      if (err) this.fail(new Error('Browser pipe write failed.'));
    });
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(error); }
    this.pending.clear(); this.emit('closed');
    // A broken pipe does not guarantee the child exited. Reap it even when
    // nobody has yet attached a session-level closed listener.
    queueMicrotask(() => { void this.close().catch(() => {}); });
  }

  close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.fail(new Error('Browser closed.'));
      if (this.child.pid && this.child.exitCode === null && this.child.signalCode === null) {
        await new Promise(resolve => {
          const timer = setTimeout(() => this.child.kill('SIGKILL'), 1500);
          this.child.once('exit', () => { clearTimeout(timer); resolve(); });
          this.child.kill('SIGTERM');
        });
      }
      this.parts = []; this.bytes = 0;
      await fs.promises.rm(this.profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
    })();
    return this.closing;
  }
}
