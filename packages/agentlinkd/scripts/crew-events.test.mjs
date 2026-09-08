import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { readEvents, replyPermission, subscribeEvents } from '../src/crew-events.mjs';
import { createContinuationMonitor } from '../src/crew-continuation.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-events-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = { run: 'run-123456789abc', registration: path.join(dir, 'worker.json'), events: path.join(dir, 'events.jsonl') };
  const meta = { v: 1, run: source.run, worker: 'chain/step-0', attempt: 'a'.repeat(48), first_seq: 1, last_seq: 2, interactive: true };
  const event = (seq, text = 'hello 🚀') => ({ v: 1, run: meta.run, worker: meta.worker, attempt: meta.attempt, seq, ts: 1, event: 'text_delta', data: text });
  const save = () => fs.writeFileSync(source.registration, JSON.stringify(meta));
  save();
  fs.writeFileSync(source.events, [event(1), event(2)].map(JSON.stringify).join('\n') + '\n');
  return { dir, source, meta, event, save };
}
test('event replay deduplicates and resets attempts, reports rotation and ignores partial records', (t) => {
  const f = fixture(t);
  const first = readEvents(f.source);
  assert.equal(first.events.length, 2);
  assert.equal(first.events[0].data, 'hello 🚀');
  assert.equal(first.gap, false);
  const cursor = { attempt: first.attempt, seq: first.seq };
  assert.equal(readEvents(f.source, cursor).events.length, 0);
  fs.appendFileSync(f.source.events, '{"event":');
  assert.equal(readEvents(f.source, cursor).events.length, 0);
  f.meta.last_seq = 10; f.meta.first_seq = 10; f.save();
  fs.writeFileSync(f.source.events, JSON.stringify(f.event(10)) + '\n');
  assert.equal(readEvents(f.source, cursor).gap, true);
  f.meta.attempt = 'b'.repeat(48); f.meta.last_seq = 1; f.meta.first_seq = 1; f.save();
  fs.writeFileSync(f.source.events, JSON.stringify(f.event(1)) + '\n');
  assert.equal(readEvents(f.source, cursor).reset, true);
});
test('registration secrets never leave event replay; pending approval survives empty replay', (t) => {
  const f = fixture(t);
  f.meta.token = 'secret-token'; f.meta.socket = '/private/socket';
  f.meta.permission = { id: 'p1', tool: 'bash', summary: 'run', choices: ['once', 'deny'], input: { secret: 'private-arguments' }, sent: true };
  f.save();
  const reply = readEvents(f.source, { attempt: f.meta.attempt, seq: 2 });
  assert.equal(reply.permission.id, 'p1');
  assert.equal(reply.permission.sent, true);
  assert.ok(!JSON.stringify(reply).includes('secret-token'));
  assert.ok(!JSON.stringify(reply).includes('private-arguments'));
});
test('worker files refuse symlinks', (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.source.events);
  fs.symlinkSync(f.source.registration, f.source.events);
  assert.throws(() => readEvents(f.source));
});
test('subscription is bounded, respects backpressure and closes its timer', async (t) => {
  const f = fixture(t);
  let writable = false;
  const chunks = [];
  const close = subscribeEvents({ source: () => f.source, writable: () => writable, send: (chunk) => chunks.push(chunk) });
  t.after(close);
  await new Promise((r) => setTimeout(r, 280));
  assert.equal(chunks.length, 0);
  writable = true;
  await new Promise((r) => setTimeout(r, 280));
  assert.equal(chunks.length, 1);
  close();
  fs.appendFileSync(f.source.events, JSON.stringify(f.event(3)) + '\n');
  await new Promise((r) => setTimeout(r, 280));
  assert.equal(chunks.length, 1);
});
test('permission relay validates attempt and only reports owner acceptance', async (t) => {
  const f = fixture(t);
  const socketDir = '/tmp/dext-crew-' + 'c'.repeat(48);
  fs.mkdirSync(socketDir, { mode: 0o700 });
  t.after(() => fs.rmSync(socketDir, { recursive: true, force: true }));
  f.meta.socket = path.join(socketDir, 'control.sock'); f.meta.token = 'd'.repeat(48); f.save();
  let calls = 0;
  const server = net.createServer((socket) => socket.on('data', (data) => {
    const reply = JSON.parse(data);
    assert.equal(reply.token, f.meta.token);
    socket.end(JSON.stringify({ accepted: ++calls === 1 }) + '\n');
  }));
  await new Promise((r) => server.listen(f.meta.socket, r));
  t.after(() => server.close());
  assert.equal((await replyPermission(f.source, { attempt: 'stale', id: 'p', choice: 'once' })).accepted, false);
  assert.equal(calls, 0);
  assert.equal((await replyPermission(f.source, { attempt: f.meta.attempt, id: 'p', choice: 'once' })).accepted, true);
  assert.equal((await replyPermission(f.source, { attempt: f.meta.attempt, id: 'p', choice: 'once' })).accepted, false);
});
test('continuation reconciliation persists supervisor failure and never launches on restart', async (t) => {
  const f = fixture(t);
  const record = { unit: 'dext-crew-run-123456789abc-resume-run-abcdef123456', state: 'pending', created: 1 };
  fs.writeFileSync(path.join(f.dir, 'continuation.json'), JSON.stringify(record));
  const commands = [];
  const exec = (bin, args, _options, cb) => {
    commands.push([bin, args]);
    queueMicrotask(() => cb(null, bin === 'systemctl' ? 'LoadState=loaded\nActiveState=failed\nResult=exit-code\nExecMainCode=1\nExecMainStatus=7\n' : 'worker crashed', ''));
  };
  const monitor = createContinuationMonitor({ exec });
  monitor.inspect(f.dir);
  await new Promise((r) => setImmediate(r));
  const result = monitor.inspect(f.dir);
  assert.equal(result.state, 'failed'); assert.equal(result.exit_code, 7);
  assert.equal(result.stderr, 'worker crashed');
  monitor.close();
  const restarted = createContinuationMonitor({ exec });
  t.after(() => restarted.close());
  assert.equal(restarted.inspect(f.dir).state, 'failed');
  assert.ok(commands.every(([bin]) => bin === 'systemctl' || bin === 'journalctl'));
});
