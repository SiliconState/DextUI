#!/usr/bin/env node
// Standalone documentation gate: no packages or network access required.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const file = path.join(root, 'docs/DextUISpec.html');
const html = fs.readFileSync(file, 'utf8');
const fail = message => { throw new Error(message); };
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
if (new Set(ids).size !== ids.length) fail('Duplicate document IDs');
if (!html.startsWith('<!doctype html>') || !/<html lang="en">/.test(html)) fail('Missing HTML language/doctype');
if ([...html.matchAll(/<h1\b/g)].length !== 1) fail('Expected one page h1');
const sections = [...html.matchAll(/<section\b[^>]*data-title="([^"]+)"/g)];
if (sections.length !== 19) fail(`Expected overview + 18 chapters, got ${sections.length}`);
const diagrams = [...html.matchAll(/<svg\b[^>]*role="img"[\s\S]*?<\/svg>/g)];
if (diagrams.length !== 6) fail('Expected six architecture/lifecycle diagrams');
for (const [i, match] of diagrams.entries()) {
 const svg = match[0];
 if (!/viewBox=/.test(svg) || !/<title id=/.test(svg) || !/<desc id=/.test(svg)) fail(`Diagram ${i+1} missing accessible metadata`);
 const labels = /aria-labelledby="([^"]+)"/.exec(svg)?.[1].split(' ') ?? [];
 if (labels.length !== 2 || labels.some(id => !ids.includes(id))) fail(`Diagram ${i+1} has invalid label refs`);
}
let links = 0;
for (const match of html.matchAll(/\bhref="([^"]+)"/g)) {
 const href = match[1];
 if (/^(https?:|mailto:)/.test(href)) continue;
 const [rel, anchor] = href.split('#');
 const target = rel ? path.resolve(path.dirname(file), rel) : file;
 if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) fail(`Broken/local-escape link: ${href}`);
 if (anchor && target === file && !ids.includes(anchor)) fail(`Broken anchor: ${href}`);
 links++;
}
for (const match of html.matchAll(/(?:src|href)="(https?:[^\"]+)"/g)) fail(`Unexpected external dependency: ${match[1]}`);
for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
const sourceChecks = [
 ['packages/agentlinkd/src/server.mjs', /server\.listen\(PORT, "127\.0\.0\.1"/, 'loopback binding'],
 ['packages/agentlinkd/src/server.mjs', /JOURNAL_TRUNCATE_BYTES = 64 \* 1024 \* 1024/, '64 MiB restore tail'],
 ['packages/agentlinkd/src/server.mjs', /NONCE_CAP = 4096/, 'dedup count'],
 ['packages/agentlinkd/src/server.mjs', /MAX_STDOUT_BUFFER = 16 \* 1024 \* 1024/, 'stdout bound'],
 ['packages/client/src/connection.ts', /OUTBOX_TTL_MS = 120_000/, 'outbox TTL'],
 ['packages/client/src/connection.ts', /OUTBOX_MAX = 32/, 'outbox frames'],
 ['apps/web/src/lib/state.svelte.ts', /OUTGOING_TTL_MS = 20_000/, 'UI acknowledgement deadline'],
 ['packages/agentlinkd/src/bridge.mjs', /bytes > 256 \* 1024/, 'bridge input'],
 ['packages/mock-server/src/ws.mjs', /big > 64n \* 1024n \* 1024n/, 'WS extended frame'],
 ['packages/mock-server/src/ws.mjs', /maxMessage = 8 \* 1024 \* 1024/, 'WS assembled message'],
 ['packages/agentlinkd/src/selfedit.mjs', /RESTART_EXIT_CODE = 75/, 'supervisor restart code'],
 ['packages/agentlinkd/src/flows.mjs', /FLOW_FILE_CAP = 256 \* 1024/, 'flow size'],
 ['packages/agentlinkd/src/tasks.mjs', /TASK_FILE_CAP = 128 \* 1024/, 'task size'],
 ['packages/agentlinkd/src/uploads.mjs', /UPLOAD_MAX_BYTES = 64 \* 1024 \* 1024/, 'upload size'],
 ['apps/web/src/components/ArtifactSheet.svelte', /REPORT_MAX_BYTES = 8 \* 1024 \* 1024/, 'report size'],
 ['apps/web/src/lib/artifact-state.ts', /ARTIFACT_STATE_MAX = 1024 \* 1024/, 'report state size'],
 ['apps/web/src/components/Scrollback.svelte', /WINDOW = 300/, 'initial DOM window'],
 ['packages/agentlinkd/src/triggers.mjs', /MAX_WORKSPACES = 64/, 'scheduler workspace cap'],
 ['packages/agentlinkd/src/flows.mjs', /for \(const id of topoOrder\(flow\)\)/, 'sequential compiler'],
 ['apps/web/public/sw.js', /const CACHEABLE =/, 'cache allowlist'],
];
for (const [rel, pattern, label] of sourceChecks) if (!pattern.test(fs.readFileSync(path.join(root, rel), 'utf8'))) fail(`Implementation contract drift: ${label} (${rel})`);
const scripts = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts);
for (const match of html.matchAll(/npm run ([\w:-]+)/g)) if (!scripts.includes(match[1])) fail(`Unknown npm script ${match[1]}`);
console.log(`PASS: ${sections.length} chapters, ${diagrams.length} accessible SVG diagrams, ${links} local links, unique IDs and valid script syntax.`);
console.log(`PASS: ${sourceChecks.length} implementation checks, documented npm commands, zero external dependencies.`);
