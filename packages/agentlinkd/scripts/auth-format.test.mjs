// Auth output contract: the host's provider/model discovery must survive the
// real binary's output. JSON path (patches/dext/0001) is asserted when the
// binary supports it; the prose parsers are pinned against a fixed sample so
// an upstream reformat fails here instead of silently emptying the dialog.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEXT = process.env.DEXT_BIN ?? path.join(os.homedir(), "Dext", "target", "release", "dext");
const have = fs.existsSync(DEXT);
const run = (args) => {
  const r = spawnSync(DEXT, args, { encoding: "utf8", env: { ...process.env, DEXT_NO_TUI: "1" }, timeout: 15_000 });
  return r.status === 0 ? r.stdout : "";
};

// Same regexes as server.mjs parseModels/parseProviderStatus (kept in sync by
// this test's prose sample; server.mjs is not importable without booting).
function parseModels(text) {
  const groups = [];
  let current = null;
  let reading = false;
  for (const line of text.split("\n")) {
    const header = /^\s*\*?\s*provider '([^']+)' models:/.exec(line);
    const fallback = /^\s*\*?\s*provider '([^']+)' default model:\s*(\S+)/.exec(line);
    if (header) { current = { provider: header[1], models: [] }; groups.push(current); reading = true; continue; }
    if (fallback) { current = { provider: fallback[1], models: [fallback[2]] }; groups.push(current); reading = false; continue; }
    if (reading && current) {
      const m = /^-\s+(\S+)\s*$/.exec(line);
      if (m) current.models.push(m[1]);
      else if (line.trim()) reading = false;
    }
  }
  return groups.filter((g) => g.models.length > 0);
}
function parseStatus(text) {
  const active = /^active provider:\s*(\S+)/m.exec(text)?.[1] ?? null;
  const providers = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\*)?\s*(\S+)\s+(.*?)\s+model=(\S+)(.*)$/.exec(line);
    if (m) providers.push({ id: m[2], model: m[4], active: !!m[1] || m[2] === active });
  }
  return { active, providers };
}

test("prose parsers pin the documented dext auth format", () => {
  const models = "* provider 'anthropic' models:\n- claude-a\n- claude-b\naliases:\n- b -> claude-b\n\n  provider 'local' default model: llama (no curated model list configured)\n";
  assert.deepEqual(parseModels(models), [
    { provider: "anthropic", models: ["claude-a", "claude-b"] },
    { provider: "local", models: ["llama"] },
  ]);
  const status = "active provider: anthropic\n* anthropic    Anthropic          model=claude-a contract=x api=y spec=z auth=auth base=https://a\n  openai       OpenAI             model=gpt contract=x api=y spec=z auth=missing base=https://o\n";
  const s = parseStatus(status);
  assert.equal(s.active, "anthropic");
  assert.deepEqual(s.providers.map((p) => [p.id, p.model, p.active]), [["anthropic", "claude-a", true], ["openai", "gpt", false]]);
});

test("real dext: auth status/models yield >=1 provider via JSON or prose", { skip: !have && "dext binary not found" }, () => {
  const statusJson = run(["auth", "status", "--json"]);
  const modelsJson = run(["auth", "models", "--json"]);
  let sj = null;
  let mj = null;
  try { sj = JSON.parse(statusJson); } catch { /* prose binary */ }
  try { mj = JSON.parse(modelsJson); } catch { /* prose binary */ }
  if (sj && mj) {
    assert.equal(sj.version, 1);
    assert.equal(typeof sj.active_provider, "string");
    assert.ok(Array.isArray(sj.providers) && sj.providers.length >= 1, "status --json providers");
    for (const p of sj.providers) {
      assert.equal(typeof p.id, "string");
      assert.equal(typeof p.default_model, "string");
      assert.equal(typeof p.auth, "string");
      assert.equal(typeof p.active, "boolean");
    }
    assert.equal(mj.version, 1);
    assert.ok(mj.providers.some((p) => Array.isArray(p.models) && p.models.length > 0), "models --json has models");
  } else {
    const s = parseStatus(run(["auth", "status"]));
    assert.ok(s.providers.length >= 1, "prose status yields providers — dext auth format changed?");
    assert.ok(parseModels(run(["auth", "models"])).length >= 1, "prose models yields groups — dext auth format changed?");
  }
});
