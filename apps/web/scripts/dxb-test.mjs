// Test-only compatibility driver: real dxb browser, commands and native inputs.
// Kept in one fixture-owned process; no daemon, personal profile or global close.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

const socketPath = process.env.DXB_TEST_SOCKET;
if (!socketPath) throw Error('DXB_TEST_SOCKET is required. Source scripts/dxb-test.sh.');
const pack = process.env.DEXT_PACK_DXB_DIR || path.join(os.homedir(), '.dext/shelves/automation/packs/dxb');
const load = name => import(pathToFileURL(path.join(pack, 'src', name)).href);

if (process.argv[2] !== '--server') {
  const socket = net.connect(socketPath);
  let text = '';
  socket.setEncoding('utf8');
  socket.on('connect', () => socket.end(JSON.stringify(process.argv.slice(2)) + '\n'));
  socket.on('data', part => text += part);
  socket.on('error', error => { console.error(error.message); process.exitCode = 1; });
  socket.on('end', () => {
    try {
      const result = JSON.parse(text);
      if (result.out) console.log(result.out);
      if (result.error) console.error(result.error);
      process.exitCode = result.code;
    } catch { console.error('dxb fixture driver did not return a result'); process.exitCode = 1; }
  });
} else {
  // Import the installed pack, never download or install an automation engine.
  const { Browser, Session } = await load('session.mjs');
  const { commands, releaseObjects } = await load('commands.mjs');
  const { parseArgs } = await load('args.mjs');
  let browser, session, closing, browserStderr = '', transportClose, lastMouse = { x: 0, y: 0, buttons: 0 };
  const diagnostic = error => [error.message, browser?.dead ? `Fixture browser connection ended: code=${browser.proc?.exitCode} signal=${browser.proc?.signalCode} transport=${JSON.stringify(transportClose)}\n${browserStderr}` : ''].filter(Boolean).join('\n');
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    let text = '', handled = false;
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', part => {
      if (handled) return;
      text += part;
      if (text.length > 256 * 1024) { socket.destroy(); return; }
      if (!text.includes('\n')) return;
      handled = true;
      let argv;
      try { argv = JSON.parse(text); } catch { socket.destroy(); return; }
      void dispatch(argv).then(out => socket.end(JSON.stringify({ code: 0, out }) + '\n'))
        .catch(error => socket.end(JSON.stringify({ code: 1, error: diagnostic(error) }) + '\n'));
    });
  });
  async function end() {
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      try { await session?.close(); }
      finally {
        try { await browser?.close(); }
        finally { server.close(); fs.rmSync(socketPath, { force: true }); }
      }
    });
    return closing;
  }
  async function evaluate(js, timeout = 15000) {
    const result = await session.tab.send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true, userGesture: true }, timeout);
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  async function dispatch(argv) {
    if (!Array.isArray(argv) || argv.some(arg => typeof arg !== 'string')) throw Error('Invalid test arguments');
    const { flags, pos } = parseArgs(argv);
    const [command, ...args] = pos;
    if (command === 'close') { await end(); return 'closed fixture browser'; }
    if (command === 'reset') {
      await session?.close(); await browser?.close();
      session = browser = undefined; browserStderr = ''; transportClose = undefined;
      lastMouse = { x: 0, y: 0, buttons: 0 };
      return 'reset fixture browser';
    }
    if (!session) {
      const spec = { kind: 'shared', headed: false };
      browser = await Browser.open('dextui-fixture', spec);
      browser.proc?.stderr.on('data', part => browserStderr = (browserStderr + part).slice(-4000));
      browser.cdp.ws.addEventListener('close', event => { transportClose = { code: event.code, reason: event.reason }; });
      browser.cdp.ws.addEventListener('error', event => { transportClose = { error: event.message }; });
      session = await Session.create('dextui-fixture', browser, spec);
      // Gates assert explicit conditions and use quiet actions. Do not build an
      // unused full accessibility baseline before every streaming action.
      session.tab.lastLines = [];
    }
    return session.run(async () => {
      session.tab.lastLines ??= [];
      const ctx = { s: session, flags: { ...flags, quiet: true }, pos: args, cwd: process.cwd() };
      const run = (name, values = args, options = {}) => commands[name]({ ...ctx, pos: values, flags: { ...ctx.flags, ...options } });
      const selector = value => /^(css=|text=|@?e\d+$)/.test(value) ? value : `css=${value}`;
      try {
        if (command === 'set') {
          if (args[0] === 'viewport') return (await run('emulate', [], { viewport: `${args[1]}x${args[2]}` })).join('\n');
          if (args[0] === 'offline') return (await run('emulate', [], args[1] === 'on' ? { offline: true } : { online: true })).join('\n');
          if (args[0] === 'media') {
            await session.tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: args[1] }, ...(args.includes('reduced-motion') ? [{ name: 'prefers-reduced-motion', value: 'reduce' }] : [])] });
            return 'media set';
          }
          throw Error(`Unsupported test emulation: ${args[0]}`);
        }
        if (command === 'wait' && flags.fn) {
          const timeout = Number(flags.timeout) || 10000;
          await evaluate(`(async()=>{const end=Date.now()+${timeout};while(!(${args.join(' ')})){if(Date.now()>end)throw Error('Fixture condition timed out');await new Promise(r=>setTimeout(r,50));}return true})()`, timeout + 2000);
          return 'true';
        }
        if (command === 'wait') return (await run('wait', args.map(arg => /^\d+$|^idle$|^load$/.test(arg) ? arg : selector(arg)))).join('\n');
        if (command === 'focus' || command === 'is') {
          const target = command === 'is' ? args[1] : args[0];
          if (command === 'is' && args[0] !== 'visible') throw Error('Unsupported fixture visibility query');
          const js = command === 'focus'
            ? `(()=>{const e=document.querySelector(${JSON.stringify(target)});if(!e)throw Error('Focus target missing');e.scrollIntoView({block:'nearest'});e.focus();return document.activeElement===e})()`
            : `(()=>{const e=document.querySelector(${JSON.stringify(target)});if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&!e.closest('[inert]')})()`;
          return String(await evaluate(js));
        }
        if (command === 'mouse') {
          if (args[0] === 'move') Object.assign(lastMouse, { x: Number(args[1]), y: Number(args[2]) });
          else if (args[0] === 'down') lastMouse.buttons = 1;
          else if (args[0] === 'up') lastMouse.buttons = 0;
          else throw Error('Unsupported fixture mouse action');
          if (!Number.isFinite(lastMouse.x) || !Number.isFinite(lastMouse.y)) throw Error('Invalid mouse coordinates');
          await session.tab.send('Input.dispatchMouseEvent', { type: { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' }[args[0]], ...lastMouse, button: args[0] === 'move' && !lastMouse.buttons ? 'none' : 'left', clickCount: args[0] === 'move' ? 0 : 1 });
          return 'mouse sent';
        }
        if (command === 'errors') {
          const output = (await run('errors')).join('\n');
          return /^no errors/.test(output) ? '' : output;
        }
        if (command === 'snapshot') return (await run('snap')).join('\n');
        if (command === 'screenshot') return (await run('shot')).join('\n');
        if (command === 'scrollintoview') return (await run('scroll', [selector(args[0])])).join('\n');
        if (['click', 'fill', 'select', 'check', 'uncheck'].includes(command)) return (await run(command, [selector(args[0]), ...args.slice(1)])).join('\n');
        if (!Object.hasOwn(commands, command) || command.startsWith('__')) throw Error(`Unsupported fixture command: ${command}`);
        return (await run(command)).join('\n');
      } finally { await releaseObjects(session); }
    });
  }
  process.once('SIGTERM', () => void end().catch(error => { console.error(error.message); process.exitCode = 1; }));
  process.once('SIGINT', () => void end().catch(error => { console.error(error.message); process.exitCode = 1; }));
  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
}
