// Folder picker: confinement (root, dot-dirs, symlinks), listing shape,
// creation rules, and the host command surface (hello_ok.home, dirs.list/create).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DIR_NAME_RE, confine, createDir, listDirs } from "../src/dirs.mjs";

const root = path.resolve("packages/agentlinkd");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Pairing token for the throwaway host under test (not a real credential). */
const TEST_TOKEN = "dirs-test-pairing";

function tree(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dirs-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(base, "Books", "2026"), { recursive: true });
  fs.mkdirSync(path.join(base, "Clients"));
  fs.mkdirSync(path.join(base, ".secrets"));
  fs.writeFileSync(path.join(base, "notes.txt"), "x");
  fs.writeFileSync(path.join(base, "Books", "ledger.csv"), "a,b");
  fs.symlinkSync("/", path.join(base, "escape"));
  return base;
}

test("confine: root and children ok; outside, hidden, symlinked, missing and files refused", (t) => {
  const base = tree(t);
  assert.deepEqual(confine(base, undefined), { abs: base, rel: "" });
  assert.deepEqual(confine(base, "Books/2026"), { abs: path.join(base, "Books", "2026"), rel: "Books/2026" });
  assert.deepEqual(confine(base, path.join(base, "Clients")), { abs: path.join(base, "Clients"), rel: "Clients" });
  assert.equal(confine(base, "..").error, "outside_root");
  assert.equal(confine(base, "/etc").error, "outside_root");
  assert.equal(confine(base, "Books/../..").error, "outside_root");
  assert.equal(confine(base, ".secrets").error, "hidden");
  assert.equal(confine(base, "escape").error, "refused", "symlink on the path is refused, never followed");
  assert.equal(confine(base, "escape/etc").error, "refused");
  assert.equal(confine(base, "nope").error, "missing");
  assert.equal(confine(base, "notes.txt").error, "not_dir");
});

test("listDirs: sorted folders only, dot-dirs and symlinks omitted, file count, parent/rel", (t) => {
  const base = tree(t);
  const top = listDirs(base);
  assert.equal(top.path, base);
  assert.equal(top.rel, "");
  assert.equal(top.parent, null);
  assert.equal(top.root, base);
  assert.deepEqual(top.dirs.map((d) => d.name), ["Books", "Clients"], "no .secrets, no escape symlink");
  assert.ok(top.dirs.every((d) => Number.isFinite(d.mtime)), "folders carry mtime for age and recent sort");
  assert.equal(top.files, 1);
  assert.equal(top.truncated, false);
  const books = listDirs(base, "Books");
  assert.deepEqual(books.dirs.map((d) => d.name), ["2026"]);
  assert.equal(books.parent, base);
  assert.equal(books.rel, "Books");
  assert.equal(books.files, 1);
  assert.equal(listDirs(base, "/tmp").error, "outside_root");
});

test("createDir: names validated, no parents created, no dot-dirs, exists reported", (t) => {
  const base = tree(t);
  assert.ok(DIR_NAME_RE.test("Q3 receipts (2026)"));
  assert.equal(createDir(base, "Books", "2027").path, path.join(base, "Books", "2027"));
  assert.equal(createDir(base, "Books", "2027").error, "exists");
  assert.equal(createDir(base, "Books", ".hidden").error, "bad_name");
  assert.equal(createDir(base, "Books", "../x").error, "bad_name");
  assert.equal(createDir(base, "Books", "a/b").error, "bad_name");
  assert.equal(createDir(base, "Books", "").error, "bad_name");
  assert.equal(createDir(base, "nope", "x").error, "missing");
  assert.equal(createDir(base, "..", "x").error, "outside_root");
  assert.equal(fs.existsSync(path.join(base, "Books", "2027")), true);
});

// ---------- host surface ----------

async function host(t, dirsRoot) {
  const temp = fs.mkdtempSync(path.join(root, ".dirs-test-"));
  const cwd = path.join(temp, "workspace");
  fs.mkdirSync(cwd, { recursive: true });
  const child = spawn(process.execPath, [path.join(root, "src/server.mjs"), "--port=0", `--token=${TEST_TOKEN}`, `--cwd=${cwd}`, `--state-dir=${path.join(temp, "state")}`, `--dext=${path.join(root, "scripts/fake-dext.mjs")}`, "--approval=auto-read", `--dirs-root=${dirsRoot}`], {
    env: { ...process.env, DEXT_HOME: path.join(temp, "dext"), FAKE_PACKS_ROOT: path.join(temp, "shelves"), PATH: path.dirname(process.execPath) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) try { ws.close(); } catch { /* closed */ }
    if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([exited, sleep(4000)]); }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  let base = "";
  for (;;) {
    const [chunk] = await once(child.stdout, "data");
    const m = /listening on (http:\/\/[^\s]+)/.exec(chunk.toString());
    if (m) { base = m[1]; break; }
  }
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(ws);
  const events = [];
  ws.addEventListener("message", (m) => events.push(JSON.parse(m.data)));
  await once(ws, "open");
  const send = (cmd, extra = {}) => ws.send(JSON.stringify({ v: 1, cmd, ...extra }));
  const wait = async (pred, from = 0) => {
    for (let i = 0; i < 400; i++) {
      const hit = events.slice(from).find(pred);
      if (hit) return hit;
      await sleep(25);
    }
    throw new Error(`timeout; last events: ${JSON.stringify(events.slice(-5))}`);
  };
  send("hello", { token: TEST_TOKEN });
  const hello = await wait((e) => e.event === "hello_ok");
  return { events, send, wait, hello };
}

test("host: dirs capability + hello_ok.home; list/create round-trip; refusals are cmd-tagged errors; picked folder opens a session", { timeout: 30000 }, async (t) => {
  const base = tree(t);
  const c = await host(t, base);
  assert.ok(c.hello.data.capabilities.includes("dirs"));
  assert.equal(c.hello.data.home, base);

  c.send("x-agentlinkd.dirs.list");
  const top = await c.wait((e) => e.event === "x-agentlinkd.dirs.list");
  assert.deepEqual(top.data.dirs.map((d) => d.name), ["Books", "Clients"]);
  assert.equal(top.data.parent, null);
  assert.ok(top.data.dirs.every((d) => Number.isFinite(d.mtime)), "mtime survives the wire");

  let mark = c.events.length;
  c.send("x-agentlinkd.dirs.list", { path: "/etc" });
  const bad = await c.wait((e) => e.event === "error", mark);
  assert.equal(bad.data.code, "bad_path");
  assert.equal(bad.data.cmd, "x-agentlinkd.dirs.list", "errors carry the cmd so the picker can scope them");

  mark = c.events.length;
  c.send("x-agentlinkd.dirs.list", { path: ".secrets" });
  assert.equal((await c.wait((e) => e.event === "error", mark)).data.code, "bad_path");

  mark = c.events.length;
  c.send("x-agentlinkd.dirs.create", { path: "Clients", name: "Acme Ltd" });
  const created = await c.wait((e) => e.event === "x-agentlinkd.dirs.list", mark);
  assert.equal(created.data.created, path.join(base, "Clients", "Acme Ltd"));
  assert.deepEqual(created.data.dirs.map((d) => d.name), ["Acme Ltd"], "reply is the refreshed parent listing");

  mark = c.events.length;
  c.send("x-agentlinkd.dirs.create", { path: "Clients", name: "Acme Ltd" });
  assert.equal((await c.wait((e) => e.event === "error", mark)).data.code, "exists");

  // What the picker does on "use this folder": a session whose cwd is the folder.
  mark = c.events.length;
  c.send("session.open", { cwd: path.join(base, "Clients", "Acme Ltd"), approval: "auto-write" });
  const list = await c.wait((e) => e.event === "session.list" && e.data.sessions.length === 1, mark);
  assert.equal(list.data.sessions[0].cwd, path.join(base, "Clients", "Acme Ltd"));
  assert.equal(list.data.sessions[0].approval_profile, "auto-write");
});
