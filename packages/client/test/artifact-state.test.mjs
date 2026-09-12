import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../../../apps/web/src/lib/artifact-state.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { validateArtifactState, artifactStateName, validateStateReceipt } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
test('save receipts require a data snapshot path and exact byte count', () => {
  for (const path of ['uploads/plan.state.json', 'uploads/plan.state-2.json']) {
    assert.equal(validateStateReceipt({ path, bytes: 2 }, 2), path);
  }
  for (const value of [null, {}, { path: 'uploads/../secret', bytes: 2 }, { path: 'uploads/x.html', bytes: 2 }, { path: 'uploads/x.state.json', bytes: 1 }]) assert.throws(() => validateStateReceipt(value, 2));
});

test('JSON byte boundary is exact, including multibyte input', () => {
  const text = JSON.stringify({ x: 'a'.repeat(1048576 - 8) });
  assert.equal(validateArtifactState(text), text);
  assert.throws(() => validateArtifactState(text + ' '));
  assert.equal(validateArtifactState('[]'), '[]');
});

test('artifact snapshots are bounded data, never executable files or report-selected paths', () => {
  assert.equal(validateArtifactState('{"points":[1,2]}'), '{"points":[1,2]}');
  for (const value of [null, {}, 'null', '42', '<script>x</script>', 'x'.repeat(1048577), JSON.stringify(['é'.repeat(600000)])]) assert.throws(() => validateArtifactState(value));
  assert.equal(artifactStateName('../../plan.html'), 'plan.state.json');
  assert.equal(artifactStateName(''), 'report.state.json');
  assert.ok(artifactStateName('a'.repeat(1000)).length < 80);
});
