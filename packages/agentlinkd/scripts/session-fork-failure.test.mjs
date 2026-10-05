import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { durableHost, until } from "./durable-harness.mjs";

for (const output of ["malformed", "nonzero"]) test(`fork cleans a saved target seat after ${output} core reply without changing source`, async (t) => {
  const binRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fork-failure-bin-"));
  t.after(() => fs.rmSync(binRoot, { recursive: true, force: true }));
  const bin = path.join(binRoot, "fork-core"), env = {};
  let source, target;
  const h = await durableHost(t, { bin, env, setup({ temp, home, state, cwd }) {
    target = path.join(temp, "target-seat");
    const fake = path.resolve("packages/agentlinkd/scripts/fake-dext.mjs");
    fs.writeFileSync(bin, `#!/usr/bin/env node\nimport fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';\nconst args=process.argv.slice(2);if(args.includes('--help')){console.log('--fork-to');process.exit(0);}if(args.includes('--fork-to')){const seat=args[args.indexOf('--fork-to')+1],root=path.join(process.env.DEXT_HOME,'projects','fixture'),dir=path.join(root,'sessions','target');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'_latest.jsonl'),JSON.stringify({seat:{id:seat}})+'\\n');fs.mkdirSync(path.join(root,'seats',seat),{recursive:true});fs.writeFileSync(${JSON.stringify(target)},seat);console.log('invalid fork output');process.exit(${output === "nonzero" ? 1 : 0});}const r=spawnSync(process.execPath,[${JSON.stringify(fake)},...args],{stdio:'inherit'});process.exit(r.status??1);\n`, { mode: 0o700 });
    const dir = path.join(home, "projects/fixture/sessions/source"); fs.mkdirSync(dir, { recursive: true });
    source = path.join(dir, "_latest.jsonl");
    fs.writeFileSync(source, JSON.stringify({ version: 4, session_id: "source", sandbox: cwd, seat: { id: "dextui-1234" } }) + "\n");
    fs.mkdirSync(state); fs.writeFileSync(path.join(state, "sessions.json"), JSON.stringify([{ id: "sess_123", cwd, seat: "dextui-1234", turns: 1 }]));
  } });
  const before = fs.readFileSync(source, "utf8"), c = await h.client();
  c.send("session.fork", { id: "sess_123" });
  await c.wait((e) => e.event === "error" && e.data.code === "fork_failed");
  await until(() => fs.existsSync(target));
  const seat = fs.readFileSync(target, "utf8");
  assert.equal(fs.existsSync(path.join(h.home, "projects/fixture/sessions/target")), false);
  assert.equal(fs.existsSync(path.join(h.home, "projects/fixture/seats", seat)), false);
  assert.equal(fs.readFileSync(source, "utf8"), before);
  assert.equal(h.index().length, 1);
  assert.ok(!fs.readdirSync(h.state).some((name) => name.startsWith(".fork-")));
});
