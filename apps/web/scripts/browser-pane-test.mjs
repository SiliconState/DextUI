// Real Chromium client + real host browser, isolated from paired hosts/provider state.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBrowserHost } from '../../../packages/agentlinkd/src/browser-host.mjs';
import { BrowserSession } from '../../../packages/agentlinkd/src/browser-session.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const pack = process.env.DEXT_PACK_DXB_DIR || path.join(os.homedir(), '.dext/shelves/automation/packs/dxb');
if (!fs.existsSync(path.join(pack, 'src/session.mjs'))) throw Error('Installed dxb required; browser pane gate does not skip.');
// The fixture-owned in-process driver: no shared dxb daemon outlives this test.
const driver = path.join(root, 'apps/web/scripts/dxb-test.mjs');
const driverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbp-'));
const driverEnv = { ...process.env, DXB_TEST_SOCKET: path.join(driverDir, 'b.sock') };
const out = fs.mkdtempSync(path.join(root, 'apps/web/dist.staging.browser-review.'));
async function run(cmd, args, cwd = root, env = process.env) {
  const p = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '', err = '';
  p.stdout.on('data', b => text = (text + b).slice(-12000)); p.stderr.on('data', b => err = (err + b).slice(-4000));
  const timer = setTimeout(() => p.kill('SIGKILL'), 180000);
  try { await new Promise((resolve, reject) => { p.on('error', reject); p.on('exit', code => code === 0 ? resolve() : reject(Error(`${cmd} failed (${code}): ${text}\n${err}`))); }); }
  finally { clearTimeout(timer); }
  return text.trim();
}
const browser = (...args) => run(process.execPath, [driver, ...args], root, driverEnv);
const evaluate = js => browser('eval', js);
async function hostUntil(fn, label) {
  const end = Date.now() + 5000;
  while (!fn()) { if (Date.now() > end) throw Error(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 30)); }
}
const wait = async js => {
  console.log('CHECK:', js.slice(0, 120));
  try { return await evaluate(`(async()=>{const end=Date.now()+8000;while(!(${js})){if(Date.now()>end)throw Error(${JSON.stringify('Timed out: ' + js)});await new Promise(r=>setTimeout(r,50));}return true})()`); }
  catch (error) {
    console.error(await evaluate('JSON.stringify({text:document.body.innerText.slice(-1800),focus:document.activeElement?.tagName,canvas:(()=>{const c=document.querySelector("canvas");if(!c)return null;const r=c.getBoundingClientRect();return {width:c.width,height:c.height,x:r.x,y:r.y,w:r.width,h:r.height}})()})').catch(() => 'No DOM'));
    if (lastSession?.sessionId && !lastSession.closed) console.error('HOST:', JSON.stringify((await lastSession.cdp('Runtime.evaluate', { expression: 'JSON.stringify({title:document.title,value:document.querySelector("input")?.value,focus:document.activeElement?.tagName,width:innerWidth,height:innerHeight})', returnByValue: true })).result.value), 'COMMANDS:', JSON.stringify(lastSession.commands));
    console.error(await browser('errors').catch(() => 'No errors available')); throw error;
  }
};
let host, lastSession, launches = 0, driverProc;
class MeasuredSession extends BrowserSession {
  commands = [];
  async start() { launches++; lastSession = this; return super.start(); }
  async command(message) { this.commands.push(message); if (this.commands.length > 20) this.commands.shift(); return super.command(message); }
}
const server = http.createServer((req, res) => {
  if (req.url === '/browser/ticket') { host.http(req, res); return; }
  const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(out, '.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(out + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.setHeader('content-type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
server.on('upgrade', (req, socket, head) => host.upgrade(req, socket, head));
const site = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'cache-control': 'no-store' });
  res.end('<title>Stream ready</title><style>body{margin:0;background:#faf4df;color:#111}input{position:absolute;left:calc(50% - 100px);top:calc(50% - 20px);width:200px;height:40px;box-sizing:border-box}</style><input aria-label="Fixture text" oninput="document.title=this.value"><h1>Not an iframe</h1><p>This site refuses embedding.</p>');
});
try {
  driverProc = spawn(process.execPath, [driver, '--server'], { env: driverEnv, stdio: ['ignore', 'ignore', 'inherit'] });
  for (let i = 0; !fs.existsSync(driverEnv.DXB_TEST_SOCKET); i++) {
    if (i > 200 || driverProc.exitCode !== null) throw Error('dxb fixture driver did not start');
    await new Promise(r => setTimeout(r, 25));
  }
  await run('npm', ['exec', '--', 'vite', 'build', '--config', 'scripts/header-review.vite.ts', '--outDir', path.relative(path.join(root, 'apps/web'), out), '--minify', 'false'], path.join(root, 'apps/web'));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); await new Promise(r => site.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  host = createBrowserHost({ port: server.address().port, Session: MeasuredSession, checkAuth(req, res) { if (req.headers.authorization === 'Bearer browser-fixture') return true; res.writeHead(401); res.end(); return false; } });
  await browser('emulate', '--viewport', '1440x900');
  await browser('open', origin); await wait('!!window.__headerReview');
  await evaluate('localStorage.setItem("dextui.token","browser-fixture")');
  await browser('click', 'css=[data-agent-id="browser.open"]');
  await wait('!!document.querySelector(`[data-agent-id="browser.start"]`)');
  if (launches !== 0) throw Error('Browser launched before user consent');
  await browser('click', 'css=[data-agent-id="browser.start"]');
  await wait('!document.querySelector(`[data-agent-id="browser.address"]`).disabled');
  await browser('fill', 'css=[data-agent-id="browser.address"]', `http://127.0.0.1:${site.address().port}/`);
  await browser('press', 'css=[data-agent-id="browser.address"]', 'Enter');
  await wait('document.querySelector(`[data-agent-id="browser.pane"] footer span`)?.textContent === "Stream ready"');
  await wait('(()=>{const c=document.querySelector(`[data-agent-id="browser.pane"] canvas`);return c.width>300&&c.getContext("2d").getImageData(250,80,1,1).data[0]>150})()');
  await browser('click', 'css=[data-agent-id="browser.pane"] canvas');
  await browser('press', 'css=[data-agent-id="browser.pane"] canvas', 'Z');
  await wait('document.querySelector(`[data-agent-id="browser.pane"] footer span`)?.textContent === "Z"');
  await evaluate('(()=>{const pane=document.querySelector(`[data-agent-id="browser.pane"]`).getBoundingClientRect(),chat=document.querySelector(".main").getBoundingClientRect();if(pane.left<chat.right-1||chat.width<300)throw Error("Desktop split overlaps chat");return true})()');
  for (const width of [390, 1280]) {
    await browser('emulate', '--viewport', `${width}x844`);
    await wait(`(()=>{const r=document.querySelector('[data-agent-id="browser.pane"]').getBoundingClientRect();return r.right<=innerWidth+1&&r.left>=0&&r.bottom<=innerHeight+1})()`);
  }
  await browser('emulate', '--viewport', '390x844');
  await browser('click', 'css=[data-agent-id="index.toggle"]');
  await wait('document.querySelector(`[data-agent-id="browser.pane"]`).inert');
  await hostUntil(() => !lastSession.visible, 'drawer pauses capture');
  await browser('press', 'Escape');
  await wait('!document.querySelector(`[data-agent-id="browser.pane"]`).inert');
  await hostUntil(() => lastSession.visible, 'drawer close resumes capture');
  await evaluate('window.__headerReview.shareReport()');
  await wait('!!document.querySelector(`[data-agent-id="artifact.frame"]`)');
  await hostUntil(() => !lastSession.visible, 'report pauses capture');
  await evaluate('(()=>{if(document.querySelector(`[data-agent-id="artifact.frame"]`).getAttribute("sandbox")!=="allow-scripts")throw Error("Report sandbox changed");return true})()');
  await browser('press', 'Escape');
  await wait('!document.querySelector(`[data-agent-id="artifact.frame"]`)');
  await hostUntil(() => lastSession.visible, 'report close resumes capture');
  const profile = lastSession.proc.profile;
  await browser('click', 'css=[data-agent-id="browser.close"]');
  await wait('!document.querySelector(`[data-agent-id="browser.pane"]`)');
  const end = Date.now() + 5000; while (fs.existsSync(profile) && Date.now() < end) await new Promise(r => setTimeout(r,50));
  if (fs.existsSync(profile)) throw Error('Browser profile survived Close');
  console.log('PASS: explicit launch, authenticated stream, anti-iframe site, painted canvas, pointer/keyboard input, desktop split, 390px layout, drawer/report isolation, close cleanup');
} finally {
  await browser('close').catch(() => {}); await host?.close();
  if (driverProc && driverProc.exitCode === null && driverProc.signalCode === null) {
    const exited = new Promise(r => driverProc.once('exit', r));
    driverProc.kill('SIGTERM');
    await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
  }
  fs.rmSync(driverDir, { recursive: true, force: true });
  server.closeAllConnections(); server.close(); site.closeAllConnections(); site.close();
  fs.rmSync(out, { recursive: true, force: true });
}
