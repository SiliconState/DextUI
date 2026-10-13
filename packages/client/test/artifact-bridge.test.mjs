import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../../../apps/web/src/lib/artifact-bridge.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { ARTIFACT_BRIDGE } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

function fixture() {
  const listeners = new Map();
  const messages = [];
  const parent = { postMessage: (data) => messages.push(data) };
  const root = { dataset: { theme: 'light' }, style: {} };
  const context = { parent, document: { documentElement: root }, addEventListener: (name, callback) => listeners.set(name, callback) };
  vm.runInNewContext(ARTIFACT_BRIDGE, context);
  return { root, messages, parent, dispatch: (name, event) => listeners.get(name)?.(event) };
}

test('bridge updates all three themes in place without touching report state', () => {
  const f = fixture();
  f.root.unsavedState = { value: 42 };
  for (const theme of ['dark', 'dim', 'light']) {
    f.dispatch('message', { source: f.parent, data: { dextArtifact: 'theme', theme } });
    assert.equal(f.root.dataset.theme, theme);
    assert.equal(f.root.style.colorScheme, theme === 'light' ? 'light' : 'dark');
    assert.equal(f.root.unsavedState.value, 42);
  }
});

test('bridge ignores non-parent messages, invalid themes and unrelated state traffic', () => {
  const f = fixture();
  for (const event of [
    { source: {}, data: { dextArtifact: 'theme', theme: 'dark' } },
    { source: f.parent, data: { dextArtifact: 'theme', theme: 'sepia' } },
    { source: f.parent, data: { dextArtifact: 'state.restore', theme: 'dark' } },
    { source: f.parent, data: null },
  ]) f.dispatch('message', event);
  assert.equal(f.root.dataset.theme, 'light');
});

test('ready handshake and Escape remain presentation-only messages', () => {
  const f = fixture();
  f.dispatch('DOMContentLoaded');
  f.dispatch('keydown', { key: 'a' });
  f.dispatch('keydown', { key: 'Escape' });
  assert.deepEqual(f.messages.map(m => m.dextArtifact), ['ready', 'close']);
});
