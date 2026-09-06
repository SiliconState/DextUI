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
import { CONNECTED_DIR, createConnectors, extractRcloneToken, normaliseRemote, relayTarget } from "../src/connectors.mjs";

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

test("extractRcloneToken: accepts the whole `rclone authorize` paste, keeps just the token JSON, rejects junk", () => {
  const tok = '{"access_token":"ya29.abc","token_type":"Bearer","refresh_token":"1//r","expiry":"2026-01-01T00:00:00Z"}';
  const paste = `Paste the following into your remote machine --->\n${tok}\n<---End paste\n`;
  assert.equal(extractRcloneToken(paste), tok);
  assert.equal(extractRcloneToken(tok), tok);
  assert.equal(extractRcloneToken("ya29.abc"), null, "a bare access token is not what rclone wants");
  assert.equal(extractRcloneToken('{"foo":1}'), null);
  assert.equal(extractRcloneToken("{not json}"), null);
  assert.equal(extractRcloneToken(undefined), null);
});

const HAVE_RCLONE = (() => { try { execFileSync("rclone", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("rclone kinds: banner paste → config create (0600 conf, drive section); copy failure reduced to its reason and token-scrubbed; remove deletes the section", { skip: !HAVE_RCLONE && "rclone not installed", timeout: 60000 }, async (t) => {
  const r = bareRepo(t);
  // Real rclone for `config *`; the network copy is stubbed with the exact
  // line rclone prints for a dead token so the test stays offline.
  const { execFile } = await import("node:child_process");
  const exec = (bin, args, opts = {}) => new Promise((resolve) => {
    if (args.includes("copy")) {
      resolve({ ok: false, code: 1, stdout: "", stderr: `2026/09/06 16:46:02 CRITICAL: Failed to create file system for "dextui-x:Projects": couldn't find root directory ID: Get "https://www.googleapis.com/drive/v3/files/root?alt=json": couldn't fetch token: oauth2: "invalid_grant" "Bad Request" access_token ya29.LEAKED_SECRET\n` });
      return;
    }
    execFile(bin, args, { ...opts, env: { ...process.env, ...(opts.env ?? {}) } }, (err, stdout, stderr) => resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
  });
  const conn = createConnectors({ home: r.home, root: r.picker, exec });
  const tok = '{"access_token":"ya29.abc","token_type":"Bearer","refresh_token":"1//r","expiry":"2026-01-01T00:00:00Z"}';
  assert.equal((await conn.add({ kind: "gdrive", label: "Drive", remote: "Projects", secret: "ya29.bare" })).error, "bad_secret");
  const added = await conn.add({ kind: "gdrive", label: "Drive", remote: "Projects", secret: `Paste the following into your remote machine --->\n${tok}\n<---End paste` });
  assert.ok(added.added, JSON.stringify(added));
  assert.equal(added.connectors[0].status, "syncing", "the first copy runs in the background, not in the request");
  await conn.drain();
  const [c] = conn.list().connectors;
  const conf = path.join(r.home, "rclone.conf");
  assert.equal(fs.statSync(conf).mode & 0o777, 0o600);
  const text = fs.readFileSync(conf, "utf8");
  assert.ok(text.includes(`[dextui-${c.id}]`) && text.includes("type = drive"), "rclone owns the token in its own config");
  assert.equal(c.has_secret, false, "nothing secret in our registry for rclone kinds");
  assert.ok(!fs.readFileSync(path.join(r.home, "connectors.json"), "utf8").includes("ya29"));
  assert.equal(c.status, "error");
  assert.ok(!/\d{4}\/\d\d\/\d\d/.test(c.error), "log timestamp dropped");
  assert.ok(!c.error.includes("LEAKED"), "token scrubbed from the surfaced reason");
  assert.ok(c.error.includes("invalid_grant"), `reason kept: ${c.error}`);
  assert.equal(fs.existsSync(path.join(r.picker, CONNECTED_DIR, "Drive")), false, "no half-made folder");
  await conn.remove({ id: c.id });
  assert.ok(!fs.readFileSync(conf, "utf8").includes("[dextui-"), "remove deletes the rclone section");
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

// Fake rclone mimicking what `rclone authorize <type> --auth-no-open-browser`
// was observed to do (v1.75.1): stderr NOTICE with a loopback redirector URL,
// 307 from that URL to the provider's consent page, and on the callback a
// token banner on stdout + exit 0. `config create` writes a stub conf; `copy`
// fails (no network in tests).
const FAKE_RCLONE = `#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
const a = process.argv.slice(2);
if (a[0] === "authorize") {
  const state = "st_" + Math.random().toString(36).slice(2, 10);
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/auth" && u.searchParams.get("state") === state) { res.writeHead(307, { location: "https://accounts.example/consent?state=" + state }); res.end(); return; }
    if (u.pathname === "/" && u.searchParams.get("state") === state && u.searchParams.get("code")) {
      res.end("Success!");
      process.stdout.write("Paste the following into your remote machine --->\\n{\\"access_token\\":\\"ya29.fake\\",\\"token_type\\":\\"Bearer\\",\\"refresh_token\\":\\"1//r\\",\\"expiry\\":\\"2030-01-01T00:00:00Z\\"}\\n<---End paste\\n");
      srv.close(); setTimeout(() => process.exit(0), 50); return;
    }
    res.writeHead(404); res.end();
  });
  srv.listen(Number(process.env.FAKE_AUTH_PORT), "127.0.0.1", () => {
    process.stderr.write("2026/09/06 16:52:10 NOTICE: Please go to the following link: http://127.0.0.1:" + srv.address().port + "/auth?state=" + state + "\\n2026/09/06 16:52:10 NOTICE: Waiting for code...\\n");
  });
} else if (a.includes("config")) {
  const conf = a[a.indexOf("--config") + 1];
  if (a.includes("create")) fs.appendFileSync(conf, "[" + a[a.indexOf("create") + 1] + "]\\ntype = " + a[a.indexOf("create") + 2] + "\\n", { mode: 0o600 });
  if (a.includes("delete")) fs.writeFileSync(conf, "");
  process.exit(0);
} else if (a.includes("copy")) {
  process.stderr.write("2026/09/06 16:46:02 CRITICAL: Failed to create file system: no network in tests\\n");
  process.exit(1);
} else process.exit(2);
`;

function fakeRclone(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-rclone-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "rclone.mjs");
  fs.writeFileSync(bin, FAKE_RCLONE, { mode: 0o755 });
  return bin;
}

test("relayTarget: accepts exactly rclone's loopback callback for the pending state, nothing else", () => {
  const origin = "http://127.0.0.1:53682";
  assert.equal(relayTarget("http://127.0.0.1:53682/?state=abc&code=4%2Fxyz&scope=drive", "abc", origin), "/?state=abc&code=4%2Fxyz&scope=drive");
  assert.equal(relayTarget("http://localhost:53682/?state=abc&code=c", "abc", origin), "/?state=abc&code=c");
  assert.equal(relayTarget("http://127.0.0.1:53682/?state=other&code=c", "abc", origin), null, "state must match");
  assert.equal(relayTarget("http://127.0.0.1:53682/?state=abc", "abc", origin), null, "code required");
  assert.equal(relayTarget("http://127.0.0.1:53682/evil?state=abc&code=c", "abc", origin), null, "only the root path");
  assert.equal(relayTarget("http://127.0.0.1:9999/?state=abc&code=c", "abc", origin), null, "only rclone's port");
  assert.equal(relayTarget("https://evil.example/?state=abc&code=c", "abc", origin), null);
  assert.equal(relayTarget("not a url", "abc", origin), null);
});

test("sign-in: authorize resolves the consent URL, the callback (direct or relayed) yields a ticket, add consumes it once; cancel refuses", { timeout: 30000 }, async (t) => {
  const r = bareRepo(t);
  const port = 40000 + Math.floor(Math.random() * 20000);
  const bin = fakeRclone(t);
  let fakeErr = "";
  const spawnFn = (_bin, args, opts) => {
    const c = spawn(process.execPath, [bin, ...args], { ...opts, env: { ...process.env, FAKE_AUTH_PORT: String(port) } });
    c.stderr.on("data", (d) => { fakeErr += d; });
    return c;
  };
  const { execFile } = await import("node:child_process");
  const exec = (_b, args, opts = {}) => new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { ...opts, env: { ...process.env, ...(opts.env ?? {}) } }, (err, stdout, stderr) => resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
  });
  const conn = createConnectors({ home: r.home, root: r.picker, bins: { git: "git", rclone: bin, gh: null }, spawnFn, exec, authOrigin: `http://127.0.0.1:${port}` });
  const events = [];
  conn.onAuth((e) => events.push(e));

  assert.equal((await conn.authorize({ kind: "github" })).error, "bad_kind");
  const a = await conn.authorize({ kind: "gdrive" });
  assert.ok(a.ticket && /^[a-f0-9]{16}$/.test(a.ticket), `${JSON.stringify(a)}\nfake rclone stderr:\n${fakeErr}`);
  assert.match(a.url, /^https:\/\/accounts\.example\/consent\?state=/, "the provider's page, not rclone's loopback redirector");
  assert.equal(events.at(-1).url, a.url, "listeners saw the consent URL");

  // Add before sign-in completes → refused.
  assert.equal((await conn.add({ kind: "gdrive", label: "Drive", remote: "", ticket: a.ticket })).error, "no_auth");

  // Browser on another device: relay the landing URL. Wrong state/junk refused.
  assert.equal((await conn.relay({ ticket: a.ticket, landing: "https://evil/?state=x&code=y" })).error, "bad_landing");
  assert.equal((await conn.relay({ ticket: "0000000000000000", landing: `http://127.0.0.1:${port}/?state=${a.state}&code=c` })).error, "no_auth");
  const relayed = await conn.relay({ ticket: a.ticket, landing: `http://127.0.0.1:${port}/?state=${a.state}&code=4%2Fcode` });
  assert.equal(relayed.relayed, true, JSON.stringify(relayed));
  for (let i = 0; i < 100 && !events.some((e) => e.done); i++) await sleep(25);
  assert.ok(events.some((e) => e.ticket === a.ticket && e.done), `token arrived: ${JSON.stringify(events)}`);

  // Ticket → connector. Consumed once.
  const added = await conn.add({ kind: "gdrive", label: "Drive", remote: "Projects", ticket: a.ticket });
  assert.ok(added.added, JSON.stringify(added));
  assert.ok(fs.readFileSync(path.join(r.home, "rclone.conf"), "utf8").includes("type = drive"));
  assert.equal((await conn.add({ kind: "gdrive", label: "Drive2", remote: "", ticket: a.ticket })).error, "no_auth", "a ticket is single-use");
  await conn.drain();

  // A second sign-in can be cancelled; its ticket is then worthless.
  const b = await conn.authorize({ kind: "dropbox" });
  assert.ok(b.ticket);
  conn.cancelAuthorize({ ticket: b.ticket });
  assert.equal((await conn.relay({ ticket: b.ticket, landing: `http://127.0.0.1:${port}/?state=${b.state}&code=c` })).error, "no_auth");
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
  assert.equal((await conn.add({ kind: "gdrive", label: "Drive", remote: "", secret: '{"access_token":"x","token_type":"Bearer"}' })).error, "no_rclone");
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
