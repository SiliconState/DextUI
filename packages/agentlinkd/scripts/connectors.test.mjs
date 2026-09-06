// Connectors: registry rules, git materialise/sync/push against a local bare
// repo (kind "git" with allowLocal — the github kind is the same path with a
// normalised URL), secrets never leaking into listings, rclone gated on the
// binary, and the host command surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { CONNECTED_DIR, createConnectors, normaliseRemote } from "../src/connectors.mjs";

const root = path.resolve("packages/agentlinkd");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Pairing token for the throwaway host under test (not a real credential). */
const TEST_TOKEN = "connectors-test-token";
const git = (args, cwd) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: cwd } }).toString();

function bareRepo(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "conn-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const bare = path.join(base, "remote.git");
  const work = path.join(base, "seed");
  git(["init", "--bare", "-q", "-b", "main", bare], base);
  git(["init", "-q", "-b", "main", work], base);
  fs.writeFileSync(path.join(work, "README.md"), "# seed\n");
  git(["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], work);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"], work);
  git(["remote", "add", "origin", bare], work);
  git(["push", "-q", "origin", "main"], work);
  const home = path.join(base, "dext");
  const picker = path.join(base, "home");
  fs.mkdirSync(picker);
  return { base, bare, work, home, picker };
}

test("normaliseRemote: github short/long forms, https-only git, drive paths, junk refused", () => {
  assert.equal(normaliseRemote("github", "acme/site").remote, "https://github.com/acme/site");
  assert.equal(normaliseRemote("github", "https://github.com/acme/site.git/").remote, "https://github.com/acme/site");
  assert.equal(normaliseRemote("github", "https://evil.example/acme/site").error, "bad_remote");
  assert.equal(normaliseRemote("github", "acme/site; rm -rf /").error, "bad_remote");
  assert.equal(normaliseRemote("git", "https://gitlab.com/a/b.git").remote, "https://gitlab.com/a/b.git");
  assert.equal(normaliseRemote("git", "https://user:pw@gitlab.com/a/b").error, "bad_remote", "credentials never ride in the URL");
  assert.equal(normaliseRemote("git", "/tmp/x").error, "bad_remote");
  assert.equal(normaliseRemote("git", "/tmp/x", { allowLocal: true }).remote, "/tmp/x");
  assert.equal(normaliseRemote("gdrive", "/Projects/Acme/").remote, "Projects/Acme");
  assert.equal(normaliseRemote("gdrive", "").remote, "");
  assert.equal(normaliseRemote("dropbox", "../x").error, "bad_remote");
  assert.equal(normaliseRemote("nope", "x").error, "bad_kind");
});

test("registry: add materialises under Connected/<label>, secrets stay out of listings, sync ff-only, push round-trips, remove keeps the folder unless purged", { timeout: 60000 }, async (t) => {
  const r = bareRepo(t);
  const conn = createConnectors({ home: r.home, root: r.picker, allowLocal: true });
  const changes = [];
  conn.onChange((l) => changes.push(l.connectors.map((c) => c.status).join(",")));

  assert.equal((await conn.add({ kind: "git", label: "../x", remote: r.bare })).error, "bad_label");
  assert.equal((await conn.add({ kind: "git", label: "Site", remote: "https://x.example/a", secret: "a\nb" })).error, "bad_secret");
  assert.equal((await conn.add({ kind: "gdrive", label: "Drive", remote: "" })).error, "bad_secret", "drive needs the pasted rclone token");

  const added = await conn.add({ kind: "git", label: "Site", remote: r.bare, secret: "ghp_secret123" });
  assert.ok(added.added, JSON.stringify(added));
  const local = path.join(r.picker, CONNECTED_DIR, "Site");
  assert.equal(fs.readFileSync(path.join(local, "README.md"), "utf8"), "# seed\n", "cloned into the picker root");
  const [c] = added.connectors;
  assert.equal(c.local, local);
  assert.equal(c.status, "idle");
  assert.equal(c.has_secret, true);
  assert.equal(c.secret, undefined, "listing never carries the secret");
  assert.ok(Number.isFinite(c.last_sync));
  assert.ok(changes.includes("syncing"), "listeners saw the syncing state");
  const st = fs.statSync(path.join(r.home, "connectors.json"));
  assert.equal(st.mode & 0o777, 0o600, "registry is private");
  assert.ok(!fs.readFileSync(path.join(local, ".git", "config"), "utf8").includes("ghp_"), "token never lands in .git/config");
  assert.equal((await conn.add({ kind: "git", label: "site", remote: r.bare })).error, "exists", "labels are case-insensitively unique");

  // Remote moves on → sync fast-forwards.
  fs.writeFileSync(path.join(r.work, "NEW.md"), "new\n");
  git(["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], r.work);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "more"], r.work);
  git(["push", "-q", "origin", "main"], r.work);
  const synced = await conn.sync({ id: c.id });
  assert.equal(synced.synced, c.id);
  assert.ok(fs.existsSync(path.join(local, "NEW.md")));

  // Local work → push commits everything and lands on the remote.
  fs.writeFileSync(path.join(local, "notes.txt"), "from dextui\n");
  const pushed = await conn.push({ id: c.id, message: "notes" });
  assert.equal(pushed.pushed, c.id, JSON.stringify(pushed));
  assert.match(git(["log", "--oneline", "-1", "main"], r.bare), /notes/);
  const again = await conn.push({ id: c.id });
  assert.equal(again.pushed, c.id, "nothing to commit is not an error");

  assert.equal(conn.owner(path.join(local, "sub"))?.id, c.id);
  assert.equal(conn.owner(r.picker), null);
  assert.equal((await conn.sync({ id: "ffffffff" })).error, "no_connector");
  assert.equal((await conn.sync({ id: "nope" })).error, "bad_request");

  const removed = await conn.remove({ id: c.id });
  assert.equal(removed.removed, c.id);
  assert.equal(removed.connectors.length, 0);
  assert.ok(fs.existsSync(local), "remove keeps the user's folder");
  const re = await conn.add({ kind: "git", label: "Site", remote: r.bare });
  assert.equal(re.error, "exists", "a leftover folder blocks re-adding under the same label");
  fs.rmSync(local, { recursive: true, force: true });
  const re2 = await conn.add({ kind: "git", label: "Site", remote: r.bare });
  assert.ok(re2.added);
  const purged = await conn.remove({ id: re2.added, purge: true });
  assert.equal(purged.connectors.length, 0);
  assert.equal(fs.existsSync(local), false);
});

test("failure: a bad remote leaves a visible error and no half-clone; drive kinds are gated on rclone", { timeout: 30000 }, async (t) => {
  const r = bareRepo(t);
  const conn = createConnectors({ home: r.home, root: r.picker, allowLocal: true, bins: { git: "git", rclone: null, gh: null } });
  const bad = await conn.add({ kind: "git", label: "Broken", remote: path.join(r.base, "missing.git") });
  assert.ok(bad.added);
  const [c] = bad.connectors;
  assert.equal(c.status, "error");
  assert.ok(c.error, "the tool's last line is surfaced");
  assert.equal(fs.existsSync(path.join(r.picker, CONNECTED_DIR, "Broken")), false);
  assert.equal(bad.tools.rclone, false);
  assert.equal((await conn.add({ kind: "gdrive", label: "Drive", remote: "", secret: "{}" })).error, "no_rclone");
});

// ---------- host surface ----------

async function host(t, dirsRoot, dextHome) {
  const temp = fs.mkdtempSync(path.join(root, ".conn-test-"));
  const cwd = path.join(temp, "workspace");
  fs.mkdirSync(cwd, { recursive: true });
  const child = spawn(process.execPath, [path.join(root, "src/server.mjs"), "--port=0", `--token=${TEST_TOKEN}`, `--cwd=${cwd}`, `--state-dir=${path.join(temp, "state")}`, `--dext=${path.join(root, "scripts/fake-dext.mjs")}`, "--approval=auto-read", `--dirs-root=${dirsRoot}`], {
    env: { ...process.env, DEXT_HOME: dextHome, FAKE_PACKS_ROOT: path.join(temp, "shelves"), DEXTUI_CONNECTORS_ALLOW_LOCAL: "1" },
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
    for (let i = 0; i < 800; i++) {
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

test("host: connectors capability; add/sync/remove over the wire; listing is secret-free; auth.status/login/logout drive the provider store", { timeout: 60000 }, async (t) => {
  const r = bareRepo(t);
  const c = await host(t, r.picker, r.home);
  assert.ok(c.hello.data.capabilities.includes("connectors"));
  assert.ok(c.hello.data.capabilities.includes("provider_auth"));

  c.send("x-agentlinkd.connectors.list");
  const empty = await c.wait((e) => e.event === "x-agentlinkd.connectors.list");
  assert.deepEqual(empty.data.connectors, []);
  assert.equal(typeof empty.data.tools.git, "boolean");

  let mark = c.events.length;
  c.send("x-agentlinkd.connectors.add", { kind: "git", label: "Site", remote: r.bare, secret: "ghp_wire" });
  const added = await c.wait((e) => e.event === "x-agentlinkd.connectors.list" && e.data.added, mark);
  assert.equal(added.data.connectors[0].label, "Site");
  assert.equal(added.data.connectors[0].secret, undefined);
  assert.ok(!JSON.stringify(c.events).includes("ghp_wire"), "no frame ever echoes the secret");
  const id = added.data.added;

  mark = c.events.length;
  c.send("x-agentlinkd.connectors.add", { kind: "git", label: "Site", remote: r.bare });
  const dup = await c.wait((e) => e.event === "error", mark);
  assert.equal(dup.data.code, "exists");
  assert.equal(dup.data.cmd, "x-agentlinkd.connectors.add");

  mark = c.events.length;
  c.send("x-agentlinkd.connectors.sync", { id });
  const synced = await c.wait((e) => e.event === "x-agentlinkd.connectors.list" && e.data.synced === id, mark);
  assert.equal(synced.data.connectors[0].status, "idle");

  // Sessions opened inside a connected folder are the ordinary kind.
  mark = c.events.length;
  c.send("session.open", { cwd: path.join(r.picker, CONNECTED_DIR, "Site"), approval: "auto-write" });
  const list = await c.wait((e) => e.event === "session.list" && e.data.sessions.length === 1, mark);
  assert.equal(list.data.sessions[0].cwd, path.join(r.picker, CONNECTED_DIR, "Site"));

  mark = c.events.length;
  c.send("x-agentlinkd.connectors.remove", { id });
  const removed = await c.wait((e) => e.event === "x-agentlinkd.connectors.list" && e.data.removed === id, mark);
  assert.equal(removed.data.connectors.length, 0);

  // Provider sign-in: the fake dext records logins in DEXT_HOME.
  mark = c.events.length;
  c.send("x-agentlinkd.auth.status");
  const status = await c.wait((e) => e.event === "x-agentlinkd.auth.status", mark);
  assert.equal(status.data.active, "fake-a");
  assert.deepEqual(status.data.providers.map((p) => p.id), ["fake-a", "fake-b"]);
  assert.ok(Array.isArray(status.data.model_catalog));

  mark = c.events.length;
  c.send("x-agentlinkd.auth.login", { provider: "fake-b", credential: "sk-wire-secret" });
  const logged = await c.wait((e) => e.event === "x-agentlinkd.auth.status" && e.data.changed === "fake-b", mark);
  assert.equal(logged.data.providers.find((p) => p.id === "fake-b").auth, "key");
  assert.ok(!JSON.stringify(c.events).includes("sk-wire-secret"), "credential never echoed");

  mark = c.events.length;
  c.send("x-agentlinkd.auth.login", { provider: "fake-b", credential: "web" });
  assert.equal((await c.wait((e) => e.event === "error", mark)).data.code, "bad_request", "browser flows are refused: paste a credential");

  mark = c.events.length;
  c.send("x-agentlinkd.auth.logout", { provider: "fake-b" });
  const out = await c.wait((e) => e.event === "x-agentlinkd.auth.status" && e.data.changed === "fake-b", mark);
  assert.equal(out.data.providers.find((p) => p.id === "fake-b").auth, "none");
});
