import test from 'node:test';
import assert from 'node:assert/strict';
import { CrewTranscript } from '../dist/index.js';
const record = (seq, event = 'text_delta', data = 'hello 🚀', attempt = 'one') => ({ v: 1, run: 'run', worker: '0', attempt, seq, ts: 1, event, data });
const chunk = (events = [], extra = {}) => ({ run: 'run', worker: '0', subscription: 'current', attempt: 'one', seq: events.at(-1)?.seq ?? 0, reset: false, gap: false, ended: false, interactive: true, events, ...extra });
test('worker projection ignores stale subscriptions and duplicates, resets attempts without parent state', () => {
  const transcript = new CrewTranscript();
  assert.equal(transcript.accept(chunk([record(1)], { subscription: 'old' }), 'current'), false);
  transcript.accept(chunk([record(1)]), 'current');
  transcript.accept(chunk([record(1)]), 'current');
  assert.equal(transcript.store.state.blocks[0].text, 'hello 🚀');
  transcript.accept(chunk([record(1, 'text_delta', 'new', 'two')], { attempt: 'two' }), 'current');
  assert.equal(transcript.store.state.blocks.length, 1);
  assert.equal(transcript.store.state.blocks[0].text, 'new');
});
test('pending permissions recover from metadata, clear on loss and exit, and await receipt', () => {
  const transcript = new CrewTranscript();
  const permission = { id: 'p', tool: 'bash', summary: 'test', choices: ['once', 'deny'], sent: true };
  transcript.accept(chunk([], { permission }), 'current');
  assert.equal(transcript.permissions[0].sent, true);
  transcript.accept({ subscription: 'current', unavailable: true }, 'current');
  assert.deepEqual(transcript.permissions, []);
  transcript.accept(chunk([], { permission }), 'current');
  assert.equal(transcript.permissions.length, 1);
  transcript.accept(chunk([record(1, 'permission_resolved', { id: 'p' })], { permission: null }), 'current');
  assert.deepEqual(transcript.permissions, []);
  transcript.accept(chunk([], { ended: true, permission }), 'current');
  assert.deepEqual(transcript.permissions, []);
});
test('gaps are visible and retained renderer state is bounded', () => {
  const transcript = new CrewTranscript();
  transcript.accept(chunk([record(1, 'transcript_gap', { reason: 'oversized' })]), 'current');
  assert.equal(transcript.gap, true);
  const events = Array.from({ length: 250 }, (_, i) => record(i + 2, 'text_block_complete', 'x'.repeat(4000)));
  transcript.accept(chunk(events), 'current');
  assert.ok(transcript.store.state.blocks.length <= 200);
  assert.ok(JSON.stringify(transcript.store.state.blocks).length < 530000);
});
