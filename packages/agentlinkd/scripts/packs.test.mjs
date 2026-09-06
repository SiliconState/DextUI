// Pack catalog + routing: pure parsers, then a live agentlinkd against the fake
// dext. No real provider, no operator state.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  buildCatalog, listPackFiles, listPackTree, packCommands, parsePackListing, parsePackSlash, parsePackUi, readPackFile, readPackUi, renderPackList, resolvePackPath, unmetRequirements, writePackFile,
} from "../src/packs.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.resolve("packages/agentlinkd");

const LISTING = `Packs  2 found
  report
    Generate self-contained interactive HTML5 reports from a
    small JSON spec.
    source: user:~/.dext/shelves/research
    shelf: research
    path: /x/research/packs/report

  weird name!
    should be skipped
    path: /x/skip

  mesh
    Peer-to-peer mailbox.
    source: user:~/.dext/shelves/orchestration
    shelf: orchestration
    path: /x/orchestration/packs/mesh
`;

test("parsePackListing: joins wrapped descriptions, keeps fields, skips invalid names", () => {
  const packs = parsePackListing(LISTING);
  assert.deepEqual(packs.map((p) => p.name), ["report", "mesh"]);
  assert.equal(packs[0].description, "Generate self-contained interactive HTML5 reports from a small JSON spec.");
  assert.equal(packs[0].shelf, "research");
  assert.equal(packs[0].path, "/x/research/packs/report");
  assert.equal(packs[0].source, "user:~/.dext/shelves/research");
  assert.deepEqual(parsePackListing(""), []);
  assert.deepEqual(parsePackListing("garbage\n  nopath\n    desc only\n"), []);
});

test("parsePackUi: flat ui-* front-matter keys; unknown keys and bad values ignored", () => {
  const ui = parsePackUi(`---
name: x
description: y
ui-starter-prompt: "Run it"
ui-artifact: HTML
ui-time-to-first-artifact: 12.6
ui-requires: [approval:auto-write, chromium]
ui_gallery: yes
ui-tags: a, b
ui-icon: chart
ui-bogus: 1
---
body`);
  assert.deepEqual(ui, { starter_prompt: "Run it", artifact: "html", time_to_first_artifact: 13, requires: ["approval:auto-write", "chromium"], gallery: true, tags: ["a", "b"], icon: "chart" });
  assert.deepEqual(parsePackUi("no front matter"), {});
  assert.deepEqual(parsePackUi("---\nui-artifact: bogus\nui-time-to-first-artifact: -3\n---"), {});
});

test("unmetRequirements: approval rank, PATH probes, connectors never satisfiable locally", () => {
  const env = { PATH: "/definitely/not/here" };
  assert.deepEqual(unmetRequirements(["approval:auto-write"], { approval: "auto-read", env }), ["approval:auto-write"]);
  assert.deepEqual(unmetRequirements(["approval:auto-write"], { approval: "auto-write", env }), []);
  assert.deepEqual(unmetRequirements(["approval:auto-write"], { approval: "always", env }), []);
  assert.deepEqual(unmetRequirements(["approval:auto-read"], { approval: "never", env }), ["approval:auto-read"]);
  assert.deepEqual(unmetRequirements(["chromium", "lightpanda", "connector:slack", "mystery"], { env }), ["chromium", "lightpanda", "connector:slack"]);
});

test("buildCatalog: defaults < GALLERY_DEFAULTS < PACK.md, gallery first, unmet computed", () => {
  const readUi = (p) => (p.endsWith("/report") ? { starter_prompt: "custom", gallery: false } : {});
  const cat = buildCatalog(LISTING, { approval: "auto-read", env: { PATH: "" }, readUi });
  assert.deepEqual(cat.map((p) => p.name), ["mesh", "report"], "PACK.md turned report's gallery off, so mesh sorts first alphabetically");
  const report = cat.find((p) => p.name === "report");
  assert.equal(report.ui.starter_prompt, "custom");
  assert.deepEqual(report.ui.requires, ["approval:auto-write"], "GALLERY_DEFAULTS requirement survives a partial PACK.md override");
  assert.deepEqual(report.unmet, ["approval:auto-write"]);
  const mesh = cat.find((p) => p.name === "mesh");
  assert.equal(mesh.ui.starter_prompt, "/pack run mesh ");
  assert.equal(mesh.ui.gallery, false);
});

test("readPackUi: refuses symlinked PACK.md and unreadable dirs", (t) => {
  const temp = fs.mkdtempSync(path.join(root, ".packs-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const real = path.join(temp, "real");
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, "PACK.md"), "---\nui-gallery: true\n---\n");
  assert.deepEqual(readPackUi(real), { gallery: true });
  const linked = path.join(temp, "linked");
  fs.mkdirSync(linked);
  fs.symlinkSync(path.join(real, "PACK.md"), path.join(linked, "PACK.md"));
  assert.deepEqual(readPackUi(linked), {}, "symlink refused");
  assert.deepEqual(readPackUi(path.join(temp, "missing")), {});
});

test("parsePackSlash + packCommands + renderPackList", () => {
  assert.deepEqual(parsePackSlash("/pack run report  do the   thing "), { sub: "run", name: "report", task: "do the   thing" });
  assert.deepEqual(parsePackSlash("/packs use report x"), { sub: "run", name: "report", task: "x" });
  assert.deepEqual(parsePackSlash("/pack report quick"), { sub: "run", name: "report", task: "quick" });
  assert.deepEqual(parsePackSlash("/pack run report"), { sub: "run", name: "report", task: "" });
  assert.deepEqual(parsePackSlash("/pack run"), { sub: "run", name: "", task: "" });
  assert.deepEqual(parsePackSlash("/pack"), { sub: "list" });
  assert.deepEqual(parsePackSlash("/pack ls"), { sub: "list" });
  assert.deepEqual(parsePackSlash("/pack inspect mesh"), { sub: "inspect", name: "mesh" });
  assert.deepEqual(parsePackSlash("/pack create research/foo"), { sub: "create", selector: "research/foo" });
  assert.deepEqual(parsePackSlash("/pack frobnicate"), { sub: "unknown", verb: "frobnicate" });
  assert.equal(parsePackSlash("/packrat"), null);
  assert.equal(parsePackSlash("/approval always"), null);
  const cat = buildCatalog(LISTING, { approval: "auto-read", env: { PATH: "" }, readUi: () => ({}) });
  const cmds = packCommands(cat);
  assert.ok(cmds.some((c) => c.cmd === "/pack run report") && cmds.some((c) => c.cmd === "/pack list"));
  const text = renderPackList(cat);
  assert.match(text, /^packs {2}2 installed/);
  assert.match(text, /report .*\[gallery, needs approval:auto-write\]/);
});

test("parsePackSlash: tokens are stripped positionally, never by substring search", () => {
  // A pack named "un" under verb "run": indexOf("un") === 1 in the verb itself.
  assert.deepEqual(parsePackSlash("/pack run un do x"), { sub: "run", name: "un", task: "do x" });
  assert.deepEqual(parsePackSlash("/pack run un"), { sub: "run", name: "un", task: "" });
  assert.deepEqual(parsePackSlash("/pack use  mesh   two  spaces"), { sub: "run", name: "mesh", task: "two  spaces" });
  // A pack named "list" is still runnable via the explicit verb.
  assert.deepEqual(parsePackSlash("/pack run list inventory"), { sub: "run", name: "list", task: "inventory" });
});

test("listPackFiles: symlinked ancestor yields an empty listing instead of throwing", (t) => {
  const temp = fs.mkdtempSync(path.join(root, ".packs-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const secret = path.join(temp, "secret");
  fs.mkdirSync(secret);
  fs.writeFileSync(path.join(secret, "x"), "1");
  const linked = path.join(temp, "linked");
  fs.symlinkSync(secret, linked);
  assert.deepEqual(listPackFiles(linked), []);
  assert.ok(listPackFiles(secret).length === 1);
  assert.deepEqual(listPackFiles(path.join(temp, "missing")), []);
});

test("resolvePackPath: only the editable surface, no traversal or dotfiles", () => {
  const d = "/tmp/pack-x";
  assert.equal(resolvePackPath(d, "PACK.md"), path.join(d, "PACK.md"));
  assert.equal(resolvePackPath(d, "src/main.rs"), path.join(d, "src", "main.rs"));
  assert.equal(resolvePackPath(d, "scripts/pack.test.mjs"), path.join(d, "scripts", "pack.test.mjs"));
  assert.equal(resolvePackPath(d, "../PACK.md"), null);
  assert.equal(resolvePackPath(d, "/etc/passwd"), null);
  assert.equal(resolvePackPath(d, "a/../../PACK.md"), null);
  assert.equal(resolvePackPath(d, ".git/config"), null);
  assert.equal(resolvePackPath(d, "src/.hidden.md"), null);
  assert.equal(resolvePackPath(d, "bin/crew"), null); // extension allowlist
  assert.equal(resolvePackPath(d, "x".repeat(600) + ".md"), null);
});

test("parsePackUi: ui-panel path and ui-actions label|prompt list", () => {
  const ui = parsePackUi("---\nui-panel: panel.html\nui-actions: Weekly | /pack run report weekly; Audit | audit this repo\n---\nbody");
  assert.equal(ui.panel, "panel.html");
  assert.deepEqual(ui.actions, [
    { label: "Weekly", prompt: "/pack run report weekly" },
    { label: "Audit", prompt: "audit this repo" },
  ]);
  // Bad paths and pipe-less entries are dropped, never fatal.
  const bad = parsePackUi("---\nui-panel: ../evil.html\nui-actions: no pipe\n---\n");
  assert.equal(bad.panel, undefined);
  assert.deepEqual(bad.actions, []);
  assert.equal(parsePackUi("---\nui-panel: docs/panel.html\n---\n").panel, "docs/panel.html");
});

test("readPackFile/writePackFile: confined, symlink-refusing, size-capped", (t) => {
  const temp = fs.mkdtempSync(path.join(root, ".packs-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(temp, "PACK.md"), "# hello\n");
  fs.mkdirSync(path.join(temp, "src"));
  fs.writeFileSync(path.join(temp, "src", "main.rs"), "fn main() {}\n");
  fs.writeFileSync(path.join(temp, "nul.txt"), Buffer.from("a\0b"));
  fs.symlinkSync(path.join(temp, "PACK.md"), path.join(temp, "link.md"));
  fs.mkdirSync(path.join(temp, "outside"));
  fs.writeFileSync(path.join(temp, "outside", "real.md"), "outside\n");
  fs.symlinkSync(path.join(temp, "outside"), path.join(temp, "src", "linkeddir"));

  // read: happy paths and refusals
  assert.equal(readPackFile(temp, "missing.md").error, "no_file");
  assert.equal(readPackFile(temp, "src/nope/x.md").error, "no_file");
  assert.equal(readPackFile(temp, "link.md").error, "bad_path");
  assert.equal(readPackFile(temp, "src/linkeddir/real.md").error, "bad_path");
  assert.equal(readPackFile(temp, "bin/crew").error, "bad_path");
  assert.equal(readPackFile(temp, "nul.txt").error, "not_text");
  assert.equal(readPackFile(temp, "PACK.md", { cap: 3 }).error, "too_large");
  const ok = readPackFile(temp, "src/main.rs");
  assert.equal(ok.text, "fn main() {}\n");
  assert.equal(ok.path, "src/main.rs");

  // write: create, overwrite, refusals
  assert.equal(writePackFile(temp, "src/main.rs", "fn main() { return; }\n").bytes, 22);
  assert.equal(readPackFile(temp, "src/main.rs").text, "fn main() { return; }\n");
  assert.equal(writePackFile(temp, "new.md", "created").bytes, 7);
  assert.equal(readPackFile(temp, "new.md").text, "created");
  assert.equal(writePackFile(temp, "src/nope/x.md", "x").error, "no_dir");
  assert.equal(writePackFile(temp, "link.md", "x").error, "bad_path");
  assert.equal(writePackFile(temp, "src/linkeddir/evil.md", "x").error, "bad_path");
  assert.equal(writePackFile(temp, "src/linkeddir/real.md", "x").error, "bad_path");
  assert.equal(writePackFile(temp, "PACK.md", "x".repeat(300 * 1024)).error, "too_large");
  assert.equal(writePackFile(temp, "bin/crew", "x").error, "bad_path");
  assert.equal(writePackFile(temp, "PACK.md", 42).error, "bad_request");
});

test("listPackTree: relative paths, dotfiles and symlinks skipped, capped", (t) => {
  const temp = fs.mkdtempSync(path.join(root, ".packs-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(temp, "PACK.md"), "x");
  fs.mkdirSync(path.join(temp, "agents"));
  fs.writeFileSync(path.join(temp, "agents", "worker.md"), "x");
  fs.writeFileSync(path.join(temp, "agents", "run.sh"), "x");
  fs.mkdirSync(path.join(temp, ".git"));
  fs.writeFileSync(path.join(temp, ".git", "config"), "x");
  fs.symlinkSync(path.join(temp, "PACK.md"), path.join(temp, "alias.md"));
  const files = listPackTree(temp);
  assert.deepEqual(files.map((f) => f.path), ["PACK.md", "agents", "agents/run.sh", "agents/worker.md"]);
  const md = files.find((f) => f.path === "PACK.md");
  assert.equal(md.kind, "file");
  assert.equal(md.editable, true);
  assert.equal(files.find((f) => f.path === "agents/run.sh").editable, true);
  assert.equal(listPackTree(temp, { maxEntries: 1 }).length, 1);
  assert.deepEqual(listPackTree(path.join(temp, "alias.md")), []);
});

// ---------- live host ----------

async function host(t) {
  const temp = fs.mkdtempSync(path.join(root, ".packs-test-"));
  const packsRoot = path.join(temp, "shelves");
  const cwd = path.join(temp, "workspace");
  fs.mkdirSync(cwd);
  // Plant a PACK.md for `report` that overrides the curated starter prompt.
  fs.mkdirSync(path.join(packsRoot, "research", "packs", "report"), { recursive: true });
  fs.writeFileSync(path.join(packsRoot, "research", "packs", "report", "PACK.md"), "---\nname: report\nui-starter-prompt: from-pack-md\n---\n");
  let stderr = "", stdout = "";
  const child = spawn(process.execPath, [path.join(root, "src/server.mjs"), "--port=0", "--token=packs-test", `--cwd=${cwd}`, `--state-dir=${path.join(temp, "state")}`, `--dext=${path.join(root, "scripts/fake-dext.mjs")}`, "--approval=auto-read"], {
    // PATH holds only node's dir: the fake-dext shebang resolves, no browser does.
    env: { ...process.env, DEXT_HOME: path.join(temp, "dext"), FAKE_PACKS_ROOT: packsRoot, PATH: path.dirname(process.execPath) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (b) => (stderr += b));
  child.stdout.on("data", (b) => (stdout += b));
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.close();
    if (child.exitCode === null) { const exit = once(child, "exit"); child.kill("SIGTERM"); await exit; }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !/listening on http/.test(stdout); i++) await sleep(30);
  const base = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1];
  assert.ok(base, stderr);
  async function client() {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    sockets.push(ws);
    const events = [];
    ws.addEventListener("message", (e) => events.push(JSON.parse(e.data)));
    await once(ws, "open");
    const send = (cmd, payload = {}) => ws.send(JSON.stringify({ v: 1, cmd, ...payload }));
    const wait = async (pred, from = 0) => {
      for (let i = 0; i < 300; i++) { const hit = events.slice(from).find(pred); if (hit) return hit; await sleep(20); }
      throw new Error(`timeout; stderr: ${stderr}`);
    };
    send("hello", { token: "packs-test", protocol: 1 });
    const hello = await wait((e) => e.event === "hello_ok");
    return { events, send, wait, hello };
  }
  const get = async (p) => { const r = await fetch(base + p, { headers: { Authorization: "Bearer packs-test" } }); return { status: r.status, body: await r.json() }; };
  return { client, get, packsRoot, base, stderr: () => stderr };
}

test("host: catalog in hello_ok, /pack list, guard, profile switch, --pack reaches dext, REST", { timeout: 30000 }, async (t) => {
  const h = await host(t);
  const c = await h.client();
  assert.ok(c.hello.data.capabilities.includes("packs"));
  const names = c.hello.data.packs.map((p) => p.name);
  assert.deepEqual([...names].sort(), ["hello-chart", "mesh", "report"]);
  const report = c.hello.data.packs.find((p) => p.name === "report");
  assert.equal(report.ui.starter_prompt, "from-pack-md", "PACK.md ui-* keys read from the listed path");
  assert.deepEqual(report.unmet, ["approval:auto-write"]);
  assert.ok(c.hello.data.commands.some((x) => x.cmd === "/pack run hello-chart"));
  assert.equal(c.hello.data.packs.find((p) => p.name === "hello-chart").ui.gallery, true, "curated default applies without a PACK.md");

  c.send("session.open");
  const list = await c.wait((e) => e.event === "session.list" && e.data.sessions.length === 1);
  const id = list.data.sessions[0].id;
  c.send("session.subscribe", { id });

  c.send("slash", { session: id, raw: "/pack list" });
  const listing = await c.wait((e) => e.session === id && e.event === "structured_slash");
  assert.match(listing.data, /packs {2}3 installed/);

  c.send("slash", { session: id, raw: "/pack run nope x" });
  await c.wait((e) => e.event === "error" && e.data.code === "no_pack");
  c.send("slash", { session: id, raw: "/pack run report" });
  await c.wait((e) => e.event === "error" && e.data.code === "bad_request");

  let mark = c.events.length;
  c.send("slash", { session: id, raw: "/pack run report summarise" });
  const guard = await c.wait((e) => e.event === "error" && e.data.code === "pack_requires_profile", mark);
  assert.equal(guard.data.data.required, "auto-write");
  assert.equal(guard.data.data.session, id);
  assert.equal(guard.data.data.retry, "/pack run report summarise", "guard hands back the exact command to re-offer");
  assert.equal(c.events.slice(mark).some((e) => e.event === "user_message"), false, "nothing journaled when refused");

  // Management verbs work through prompt.submit too (agents driving /__agent).
  mark = c.events.length;
  c.send("prompt.submit", { session: id, text: "/pack list" });
  await c.wait((e) => e.session === id && e.event === "structured_slash", mark);
  assert.equal(c.events.slice(mark).some((e) => e.event === "user_message"), false, "management verbs never journal a user_message");
  c.send("prompt.submit", { session: id, text: "/pack run" });
  await c.wait((e) => e.event === "error" && e.data.code === "bad_request", mark);

  // Same guard through prompt.submit (agents driving /__agent).
  mark = c.events.length;
  c.send("prompt.submit", { session: id, text: "/pack run report summarise" });
  await c.wait((e) => e.event === "error" && e.data.code === "pack_requires_profile", mark);

  c.send("slash", { session: id, raw: "/approval auto-write" });
  await c.wait((e) => e.session === id && e.event === "approval_profile_changed");
  mark = c.events.length;
  c.send("slash", { session: id, raw: "/pack run report summarise this" });
  const um = await c.wait((e) => e.session === id && e.event === "user_message", mark);
  assert.equal(um.data.text, "/pack run report summarise this", "journaled prompt keeps the /pack prefix for attribution");
  const done = await c.wait((e) => e.session === id && e.event === "text_block_complete", mark);
  assert.match(done.data, /^fake summarise this \[pack=report\]/, "task alone on stdin; --pack report on argv");
  const view = await c.wait((e) => e.session === id && e.event === "runtime_view", mark);
  assert.equal(view.data.pack, "report");
  await c.wait((e) => e.session === id && e.event === "turn_end", mark);

  // No requirement → runs immediately; `/pack <name> <task>` shorthand.
  mark = c.events.length;
  c.send("slash", { session: id, raw: "/pack hello-chart go" });
  const hc = await c.wait((e) => e.session === id && e.event === "text_block_complete", mark);
  assert.match(hc.data, /\[pack=hello-chart\]/);
  await c.wait((e) => e.session === id && e.event === "turn_end", mark);

  mark = c.events.length;
  c.send("slash", { session: id, raw: "/pack inspect mesh" });
  const insp = await c.wait((e) => e.session === id && e.event === "structured_slash", mark);
  assert.match(insp.data, /fake inspect output/);
  c.send("slash", { session: id, raw: "/pack create Bad/Name" });
  await c.wait((e) => e.event === "error" && e.data.code === "bad_request", mark);

  const all = await h.get("/packs");
  assert.equal(all.status, 200);
  assert.equal(all.body.packs.length, 3);
  const one = await h.get("/packs/report");
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.pack.files, [{ name: "PACK.md", kind: "file", bytes: fs.statSync(path.join(h.packsRoot, "research/packs/report/PACK.md")).size }]);
  assert.equal((await h.get("/packs/nope")).status, 404);
  // Encoded traversal stays under /packs/ on the wire (fetch would normalize a raw ../).
  assert.equal((await h.get("/packs/..%2Fetc")).status, 404);
  assert.equal((await h.get("/packs/report%2FPACK.md")).status, 404, "names only; no path segments");
  assert.equal((await h.get("/packs/%")).status, 404, "malformed percent-encoding is 404, not a crash");
  const unauth = await fetch(h.base + "/packs");
  assert.equal(unauth.status, 401, "catalog is a data endpoint: bearer required");
});
