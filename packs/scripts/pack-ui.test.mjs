// Pack UI channel, end to end over the runtime protocol: spawn the real pack
// binaries, answer their forms by re-invoking with event "ui_response" (the
// same loop dext core runs), and gate every emitted form on the REAL host
// validator (packages/agentlinkd/src/pack-ui.mjs) so drift fails here, not in
// the browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = (p) => path.join(packsRoot, `target/release/${p}-runtime`);
const { normalizeUiRequest } = await import(path.join(packsRoot, "../packages/agentlinkd/src/pack-ui.mjs"));

function ensureBuilt() {
  if (["receipts", "invoice", "reconcile"].every((p) => fs.existsSync(bin(p)))) return;
  const r = spawnSync("cargo", ["build", "--release", "--offline", ...["receipts", "invoice", "reconcile"].flatMap((p) => ["-p", p])], { cwd: packsRoot, encoding: "utf8", timeout: 600_000 });
  assert.equal(r.status, 0, `cargo build failed:\n${r.stderr}`);
}

function call(pack, cwd, event, extra = {}, { forms = true } = {}) {
  const context = { turn_id: "t1", iteration: 0, history_messages: 0 };
  if (forms) context.ui_methods = ["form", "progress"];
  const request = { version: 1, event, pack, session_id: "t", cwd, state: {}, context, ...extra };
  const out = execFileSync(bin(pack), [], { input: JSON.stringify(request), encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  const resp = JSON.parse(out.trim());
  assert.equal(resp.version, 1);
  const keys = Object.keys(resp).sort();
  const allowed = ["content", "effects", "is_error", "version", ...(resp.state !== undefined ? ["state"] : []), ...(resp.ui_request !== undefined ? ["ui_request"] : [])];
  assert.deepEqual(keys, allowed.sort());
  return resp;
}
const tool = (pack, cwd, name, input = {}, opts) => call(pack, cwd, "tool", { tool: name, input }, opts);
const answer = (pack, cwd, round, state) => call(pack, cwd, "ui_response", { ui: round, ...(state === undefined ? {} : { state }) });

/** Drive a ui_request chain like dext core's resolve_pack_runtime_ui,
 * carrying Response.state into the next invocation like dext does. */
function drive(pack, cwd, first, script) {
  let resp = first;
  let state = resp.state ?? {};
  const seen = [];
  for (let rounds = 0; resp.ui_request && rounds < 20; rounds++) {
    const ask = resp.ui_request;
    const host = normalizeUiRequest({ id: ask.id, request_id: ask.id, pack, method: ask.method, params: ask.params });
    if (ask.method === "form") assert.ok(!host.error, `host rejected form: ${host.error}`);
    seen.push(ask);
    resp = call(pack, cwd, "ui_response", { ui: { request_id: ask.id, method: ask.method, response: script(ask, rounds + 1) }, ...(state === undefined ? {} : { state }) });
    state = resp.state ?? state;
  }
  return { final: resp, seen };
}

/** 11-row statement: 4 auto-matched, 7 left for review (one with a ranked
 * candidate just outside the auto-match window). */
function seed(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pack-ui-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const iso = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  for (const [days, vendor, amount, cat] of [[3, "Eurostar", "82.50", "Travel"], [10, "Blue Bottle", "5.40", "Meals"], [20, "Adobe", "54.99", "Software"], [10, "Widgets", "30.00", "Parts"]]) {
    assert.equal(tool("receipts", cwd, "add_receipt", { date: iso(days), vendor, amount, category: cat }).is_error, false);
  }
  tool("invoice", cwd, "set_business", { name: "Marta's Studio", tax_rate: 0, payment_terms_days: 14, currency: "$" });
  tool("invoice", cwd, "add_client", { name: "Blue Bakery" });
  assert.equal(tool("invoice", cwd, "create_invoice", { client: "Blue Bakery", date: iso(15), items: [{ description: "Logo", unit_price: 450 }] }).is_error, false);
  tool("invoice", cwd, "mark_paid", { number: "INV-0001", date: iso(5) });
  const rows = [
    [iso(3), "EUROSTAR TICKET", "-82.50"],
    [iso(20), "ADOBE SUBSCRIPTION", "-54.99"],
    [iso(3), "BANK FEE", "-12.00"],
    [iso(10), "BLUE BOTTLE COFFEE", "-5.40"],
    [iso(5), "PAYMENT FROM BLUE BAKERY", "450.00"],
    [iso(2), "TRANSFER TO SAVINGS", "-500.00"],
    [iso(2), "WIDGETS STORE PURCHASE", "-30.00"],
    [iso(1), "COFFEE SHOP", "-3.20"],
    [iso(1), "SNACKS", "-7.77"],
    [iso(1), "PARKING", "-15.00"],
    [iso(1), "LOTTERY TICKET", "-2.00"],
  ];
  fs.writeFileSync(path.join(cwd, "bank.csv"), `Date,Description,Amount\n${rows.map((r) => r.map((v) => `"${v}"`).join(",")).join("\n")}\n`);
  const imported = tool("reconcile", cwd, "import_statement", { file: "bank.csv" });
  assert.equal(imported.is_error, false, imported.content);
  const matches = JSON.parse(fs.readFileSync(path.join(cwd, ".reconcile/matches.json"), "utf8"));
  assert.equal(Object.keys(matches).length, 4, `auto-match should explain 4, got ${JSON.stringify(matches)}`);
  return { cwd, matches: () => JSON.parse(fs.readFileSync(path.join(cwd, ".reconcile/matches.json"), "utf8")) };
}

test("reconcile review: falls back to a plain list when the host has no forms", (t) => {
  ensureBuilt();
  const { cwd } = seed(t);
  const resp = tool("reconcile", cwd, "review_unexplained", {}, { forms: false });
  assert.equal(resp.is_error, false);
  assert.equal(resp.ui_request, undefined);
  assert.match(resp.content, /7 statement lines are unexplained/);
  assert.match(resp.content, /BANK FEE/);
  assert.match(resp.content, /explain_line/);
});

test("reconcile review: emits host-valid forms with ranked defaults, applies batches atomically, resumes after cancel", (t) => {
  ensureBuilt();
  const { cwd, matches } = seed(t);
  const first = tool("reconcile", cwd, "review_unexplained", {});
  assert.equal(first.is_error, false);
  assert.equal(first.ui_request.method, "form");
  assert.equal(first.ui_request.id, "review-1-w14");

  // Form 1 covers the first 5 unexplained lines; only the widgets line has a
  // candidate, so it defaults to receipt#4 and the rest to "leave".
  const fields = Object.fromEntries(first.ui_request.params.fields.map((f) => [f.id, f]));
  assert.deepEqual(first.ui_request.params.fields.filter((f) => f.type === "select").map((f) => f.id), ["l3", "l6", "l7", "l8", "l9"]);
  assert.equal(fields.l7.default, "receipt#4");
  assert.equal(fields.l7.options[0].value, "receipt#4");
  assert.equal(fields.l3.default, "__skip__");
  assert.match(fields.n3.label, /note/i);

  // Answer batch 1: note the fee, leave the transfer/coffee/snacks, accept the
  // widgets match. Batch 2 (parking, lottery) is cancelled.
  const r1 = answer("reconcile", cwd, { request_id: first.ui_request.id, method: "form", response: { status: "ok", value: { l3: "__note__", n3: "bank monthly fee", l6: "__skip__", l7: "receipt#4", l8: "__skip__", l9: "__skip__" } } });
  assert.equal(r1.is_error, false);
  assert.match(r1.content, /line 3 explained \(bank monthly fee\)/);
  assert.match(r1.content, /line 7 → receipt#4/);
  assert.match(r1.content, /line 6 left unexplained/);
  const afterBatch1 = matches();
  assert.deepEqual(Object.keys(afterBatch1).sort(), ["1", "2", "3", "4", "5", "6", "7", "8", "9"].sort());
  assert.equal(afterBatch1["3"].kind, "manual");
  assert.equal(afterBatch1["6"].kind, "skipped");
  assert.equal(afterBatch1["7"].ref, "receipt#4");
  assert.equal(r1.ui_request.id, "review-2-w14");
  assert.deepEqual(r1.ui_request.params.fields.filter((f) => f.type === "select").map((f) => f.id), ["l10", "l11"]);

  const r2 = answer("reconcile", cwd, { request_id: r1.ui_request.id, method: "form", response: { status: "cancelled" } });
  assert.equal(r2.is_error, false);
  assert.equal(r2.ui_request, undefined);
  assert.match(r2.content, /Review stopped \(cancelled\)/);
  assert.match(r2.content, /2 line\(s\) still unexplained/);
  assert.deepEqual(Object.keys(matches()).length, 9); // batch 2 was NOT applied

  // Resume: a fresh review asks only for the leftovers; finishing renders the
  // reconciliation view with skipped lines counted separately.
  const resume = tool("reconcile", cwd, "review_unexplained", {});
  assert.deepEqual(resume.ui_request.params.fields.filter((f) => f.type === "select").map((f) => f.id), ["l10", "l11"]);
  const done = drive("reconcile", cwd, resume, () => ({ status: "ok", value: { l10: "__note__", n10: "parking cash", l11: "__skip__" } })).final;
  assert.equal(done.is_error, false);
  assert.match(done.content, /Review complete\./);
  assert.match(done.content, /7 of 11 lines matched/);
  assert.match(done.content, /4 line\(s\) marked leave-unexplained/);
  assert.ok(done.effects.some((e) => e.type === "view"));

  // Nothing left: re-running is a no-op summary.
  const again = tool("reconcile", cwd, "review_unexplained", {});
  assert.equal(again.ui_request, undefined);
  assert.match(again.content, /Nothing to review/);
});

test("reconcile review: crafted refs that do not match a candidate amount are ignored, not applied", (t) => {
  ensureBuilt();
  const { cwd, matches } = seed(t);
  const first = tool("reconcile", cwd, "review_unexplained", {});
  const r1 = answer("reconcile", cwd, { request_id: first.ui_request.id, method: "form", response: { status: "ok", value: { l3: "receipt#1", l6: "__skip__", l7: "__skip__", l8: "__skip__", l9: "__skip__" } } });
  assert.equal(r1.is_error, false);
  assert.doesNotMatch(r1.content, /line 3 →/);
  const after = matches();
  assert.equal(after["3"], undefined); // receipt#1 is Eurostar $82.50, not $12
  // The ignored line is re-asked in the next batch.
  assert.deepEqual(r1.ui_request.params.fields.filter((f) => f.type === "select").map((f) => f.id), ["l3", "l10", "l11"]);
});

/** Seed a receipts workspace with pending text receipts. */
function seedFiles(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pack-ui-files-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const iso = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  fs.writeFileSync(path.join(cwd, "hardware.txt"), `Hardware Store\n${iso(4)}\nTotal: $45.20\n`);
  fs.writeFileSync(path.join(cwd, "lunch.md"), `# Cafe Luna\n${iso(2)} lunch\nAmount 12.90 EUR\n`);
  fs.writeFileSync(path.join(cwd, "photo.jpg"), "not really a jpg");
  return { cwd, iso };
}

const ledger = (cwd) => fs.readFileSync(path.join(cwd, ".receipts/ledger.csv"), "utf8");

test("receipts review: prefilled verify forms record corrected receipts and skip for later", (t) => {
  ensureBuilt();
  const { cwd, iso } = seedFiles(t);
  const first = tool("receipts", cwd, "review_text_receipts", {});
  assert.equal(first.is_error, false);
  assert.equal(first.ui_request.id, "files-1");
  const fields = Object.fromEntries(first.ui_request.params.fields.map((f) => [f.id, f]));
  // Two text files on this batch; the jpg is for the agent to read, not a form.
  assert.deepEqual(first.ui_request.params.fields.filter((f) => f.type === "select").map((f) => f.id), ["s1", "s2"]);
  assert.equal(fields.s1.default, "add|hardware.txt");
  assert.equal(fields.v1.default, "Hardware Store");
  assert.equal(fields.d1.default, iso(4));
  assert.equal(fields.a1.default, "45.20");
  assert.match(fields.s1.description, /Hardware Store/);
  assert.equal(fields.s2.default, "add|lunch.md");

  // Correct the vendor on hardware, fix the amount on lunch, keep both.
  const done = drive("receipts", cwd, first, () => ({
    status: "ok",
    value: { s1: "add|hardware.txt", v1: "Hardware Store Ltd", d1: iso(4), a1: "45.20", s2: "add|lunch.md", v2: "Cafe Luna", d2: iso(2), a2: "12.90" },
  })).final;
  assert.equal(done.is_error, false);
  assert.equal(done.ui_request, undefined);
  assert.match(done.content, /hardware\.txt → /);
  const csv = ledger(cwd);
  assert.match(csv, /Hardware Store Ltd/);
  assert.match(csv, /45\.20/);
  assert.match(csv, /hardware\.txt/);

  // Everything recorded: re-running is a no-op.
  const again = tool("receipts", cwd, "review_text_receipts", {});
  assert.equal(again.ui_request, undefined);
  assert.match(again.content, /No pending text receipts/);
});

test("receipts review: leave-for-later is session state, crafted file values are ignored", (t) => {
  ensureBuilt();
  const { cwd } = seedFiles(t);
  const first = tool("receipts", cwd, "review_text_receipts", {});
  // Leave lunch.md for later, try to smuggle a file that was never offered.
  const r1 = answer("receipts", cwd, { request_id: "files-1", method: "form", response: { status: "ok", value: { s1: "add|hardware.txt", v1: "Hardware Store", d1: "2026-01-01", a1: "45.20", s2: "skip|lunch.md", s3: "add|.receipts/ledger.csv" } } });
  assert.equal(r1.is_error, false);
  assert.match(r1.content, /lunch\.md left for later/);
  assert.deepEqual(r1.state.review.skip, ["lunch.md"]);
  assert.doesNotMatch(r1.content, /ledger\.csv/);
  // Loop ends: the only pending text file was skipped this session.
  assert.equal(r1.ui_request, undefined);

  // Same session (state round-tripped): still nothing to review.
  const sameSession = tool("receipts", cwd, "review_text_receipts", {}, { forms: true });
  const withState = call("receipts", cwd, "tool", { tool: "review_text_receipts", input: {}, state: r1.state });
  assert.equal(withState.ui_request, undefined);
  assert.match(withState.content, /No pending text receipts/);

  // Fresh session (no state): lunch.md is offered again.
  assert.equal(sameSession.ui_request.id, "files-1");
  assert.deepEqual(sameSession.ui_request.params.fields.filter((f) => f.type === "select").map((f) => f.id), ["s1"]);
  assert.equal(sameSession.ui_request.params.fields.find((f) => f.id === "s1").default, "add|lunch.md");
});

test("receipts review: falls back to guidance on hosts without forms", (t) => {
  ensureBuilt();
  const { cwd } = seedFiles(t);
  const resp = tool("receipts", cwd, "review_text_receipts", {}, { forms: false });
  assert.equal(resp.is_error, false);
  assert.equal(resp.ui_request, undefined);
  assert.match(resp.content, /2 text receipt file\(s\) pending/);
  assert.match(resp.content, /list_receipt_files/);
});
