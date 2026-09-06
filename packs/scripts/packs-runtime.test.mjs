// Consumer pack runtimes, end to end: each binary is driven exactly like
// dext's pack_runtime.rs drives it — one JSON request on stdin, one JSON
// response on stdout. Covers protocol framing, the receipts and invoice
// workflows, duplicate refusal, path confinement, and money math.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Resolve from this file, not the cwd (npm test runs from the repo root; a
// manual `node --test` from packs/ must not look for packs/packs).
const packsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bins = {
  receipts: path.join(packsRoot, "target/release/receipts-runtime"),
  invoice: path.join(packsRoot, "target/release/invoice-runtime"),
};

function ensureBuilt() {
  if (fs.existsSync(bins.receipts) && fs.existsSync(bins.invoice)) return;
  const r = spawnSync("cargo", ["build", "--release", "-p", "receipts", "-p", "invoice", "--offline"], { cwd: packsRoot, encoding: "utf8", timeout: 600_000 });
  assert.equal(r.status, 0, `cargo build failed:\n${r.stderr}`);
}

/** Build the TS panels once (esbuild from the repo toolchain). */
async function ensurePanels() {
  if (fs.existsSync(path.join(packsRoot, "receipts/ui/panel.html")) && fs.existsSync(path.join(packsRoot, "invoice/ui/panel.html"))) return;
  const { buildPanel } = await import("./build-panel.mjs");
  for (const p of ["receipts", "invoice"]) {
    const r = buildPanel(path.join(packsRoot, p));
    assert.equal(r.built, true, `panel build for ${p}`);
    assert.equal(r.marker, true, "data marker present");
  }
}

/** One protocol round-trip; fails the test unless the response parses. */
function call(bin, cwd, event, extra = {}, env = {}) {
  const request = { version: 1, event, pack: "test", session_id: "t", cwd, state: {}, context: { turn_id: "t1", iteration: 0, history_messages: 0 }, ...extra };
  const out = execFileSync(bin, [], { input: JSON.stringify(request), encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...env } });
  const resp = JSON.parse(out.trim());
  assert.equal(resp.version, 1, "protocol version");
  assert.ok(typeof resp.content === "string");
  assert.ok(Array.isArray(resp.effects), "effects array");
  // dext core rejects unknown fields; lock the shape here.
  assert.deepEqual(Object.keys(resp).sort(), ["content", "effects", "is_error", "version", ...(resp.state !== undefined ? ["state"] : [])].sort());
  return resp;
}

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pack-rt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const views = (resp) => resp.effects.filter((e) => e.type === "view");

test("receipts: activate → list → add (dup refused) → rule → summary charts → export → confinement", async (t) => {
  ensureBuilt();
  await ensurePanels();
  const env = { DEXT_PACK_RECEIPTS_DIR: path.join(packsRoot, "receipts") };
  const cwd = workspace(t);
  fs.mkdirSync(path.join(cwd, "travel"));
  fs.writeFileSync(path.join(cwd, "travel", "train.txt"), "Eurostar\n2026-09-02 total $82.50");
  fs.writeFileSync(path.join(cwd, "coffee.txt"), "Blue Bottle\nSep 3, 2026\nTOTAL $5.40");
  fs.writeFileSync(path.join(cwd, "receipt-photo.jpg"), "not-a-real-image");

  const act = call(bins.receipts, cwd, "activate", {}, env);
  assert.equal(act.is_error, false);
  assert.match(act.content, /receipts ready/);
  assert.ok(fs.existsSync(path.join(cwd, ".receipts")));

  const list = call(bins.receipts, cwd, "tool", { tool: "list_receipt_files", input: {} }, env);
  assert.match(list.content, /2 file\(s\) not yet/, "root files pending (travel/ is not the root scan)");
  const deep = call(bins.receipts, cwd, "tool", { tool: "list_receipt_files", input: { folder: "travel" } }, env);
  assert.match(deep.content, /train\.txt/);
  assert.match(deep.content, /"guess"/);
  assert.match(deep.content, /82\.50/, "guess picks the biggest amount");

  const bad = call(bins.receipts, cwd, "tool", { tool: "list_receipt_files", input: { folder: "../.." } }, env);
  assert.equal(bad.is_error, true, "traversal refused");

  const add = call(bins.receipts, cwd, "tool", { tool: "add_receipt", input: { date: "Sep 3, 2026", vendor: "Blue Bottle", amount: "5.40", category: "Meals", source: "coffee.txt" } }, env);
  assert.equal(add.is_error, false);
  assert.match(add.content, /Added #1: 2026-09-03 Blue Bottle \$5\.40 → Meals/);
  const month = new Date().toISOString().slice(0, 7);
  assert.ok(views(add).length >= 1, "a view card comes back");
  assert.match(views(add)[0].markdown, /```chart/, "chart fence in the view");
  assert.match(views(add)[0].markdown, /```csv/, "ledger table in the view");
  assert.match(views(add)[0].title, new RegExp(month.replace("-", "-")));

  const dup = call(bins.receipts, cwd, "tool", { tool: "add_receipt", input: { date: "2026-09-03", vendor: "blue bottle", amount: 5.4 } }, env);
  assert.equal(dup.is_error, false);
  assert.match(dup.content, /Looks like a duplicate of receipt #1/, "duplicate refused politely");

  const forced = call(bins.receipts, cwd, "tool", { tool: "add_receipt", input: { date: "2026-09-03", vendor: "Blue Bottle", amount: "5.40", category: "Meals", force: true } }, env);
  assert.match(forced.content, /Added #2/);

  // Rule: substring match recategorises existing and future rows.
  call(bins.receipts, cwd, "tool", { tool: "set_category_rule", input: { vendor: "eurostar", category: "Travel" } }, env);
  const addTrain = call(bins.receipts, cwd, "tool", { tool: "add_receipt", input: { date: "2026-09-02", vendor: "Eurostar", amount: "82.50", source: "travel/train.txt" } }, env);
  assert.match(addTrain.content, /→ Travel/, "rule applied without an explicit category");

  const summary = call(bins.receipts, cwd, "tool", { tool: "receipts_summary", input: { month: "2026-09" } }, env);
  assert.match(summary.content, /\$93\.30/, "5.40 + 5.40 + 82.50 = 93.30, in cents");
  assert.match(views(summary)[0].markdown, /"type":"hbar"/);

  const exp = call(bins.receipts, cwd, "tool", { tool: "export_ledger", input: {} }, env);
  assert.match(exp.content, /ledger-all\.csv/);
  const csv = fs.readFileSync(path.join(cwd, ".receipts", "exports", "ledger-all.csv"), "utf8");
  assert.match(csv, /^id,date,vendor,amount,category,note,source/m);
  assert.match(csv, /3,2026-09-02,Eurostar,82.50,Travel,,travel\/train.txt/);

  const ledger = fs.readFileSync(path.join(cwd, ".receipts", "ledger.csv"), "utf8");
  assert.match(ledger, /1,2026-09-03,Blue Bottle,5.40,Meals,,coffee.txt/);

  // Live panel: written per run with the same numbers, safely embedded.
  assert.match(views(summary)[0].markdown, /!\[dashboard\]\(\.receipts\/panel\.html\)/, "view links the panel");
  const panel = fs.readFileSync(path.join(cwd, ".receipts", "panel.html"), "utf8");
  assert.ok(!panel.includes("@@PACK_DATA@@"), "marker replaced");
  assert.match(panel, /window\.__PACK_DATA__ = \{/);
  assert.match(panel, /"total_cents":9330/, "panel carries the exact cents total");
  assert.match(panel, /"cents":8250,"label":"Travel"/, "serde_json sorts object keys");
  assert.ok(!/window\.__PACK_DATA__ = [^;]*<\/script>/.test(panel), "embedded JSON cannot close the script tag");
});

test("invoice: activate → business → client → create (html) → partial pay → aging → paid", async (t) => {
  ensureBuilt();
  await ensurePanels();
  const env = { DEXT_PACK_INVOICE_DIR: path.join(packsRoot, "invoice") };
  const cwd = workspace(t);

  const act = call(bins.invoice, cwd, "activate", {}, env);
  assert.match(act.content, /No business details yet/);
  assert.match(act.content, /set_business/);

  const early = call(bins.invoice, cwd, "tool", { tool: "create_invoice", input: { client: "Nobody", items: [{ description: "x", unit_price: 1 }] } }, env);
  assert.equal(early.is_error, true, "no business → refused");

  const biz = call(bins.invoice, cwd, "tool", { tool: "set_business", input: { name: "Marta's Studio", address: "12 Oak Lane\nLisbon", email: "marta@studio.pt", tax_rate: 23, payment_terms_days: 30, currency: "€" } }, env);
  assert.match(biz.content, /tax 23% · terms 30 days/);
  assert.match(biz.content, /next number INV-0001/);

  call(bins.invoice, cwd, "tool", { tool: "add_client", input: { name: "Blue Bakery", email: "accounts@bluebakery.pt", address: "4 River St" } }, env);

  const inv = call(bins.invoice, cwd, "tool", { tool: "create_invoice", input: { client: "blue bakery", date: "2026-09-01", items: [{ description: "Logo design", qty: 1, unit_price: "450.00" }, { description: "Revisions", qty: 2, unit_price: 50 }] } }, env);
  assert.equal(inv.is_error, false, inv.content);
  assert.match(inv.content, /Created INV-0001 for Blue Bakery — total €676\.50/, "550 × 1.23 = 676.50");
  assert.match(inv.content, /due 2026-10-01/);
  const view = views(inv)[0];
  assert.match(view.markdown, /!\[invoice\]\(\.invoices\/INV-0001\.html\)/, "card shows the printable file inline");

  const html = fs.readFileSync(path.join(cwd, ".invoices", "INV-0001.html"), "utf8");
  assert.match(html, /Marta's Studio/);
  assert.match(html, /Blue Bakery/);
  assert.match(html, /€676\.50/);
  assert.doesNotMatch(html, /<script/, "static printable, no scripts");
  assert.match(fs.readFileSync(path.join(cwd, ".invoices", "register.csv"), "utf8"), /INV-0001,Blue Bakery,2026-09-01,2026-10-01,676.50,0.00,sent/);

  const part = call(bins.invoice, cwd, "tool", { tool: "mark_paid", input: { number: "inv-0001", amount: "276.50", date: "2026-09-05" } }, env);
  assert.match(part.content, /INV-0001 is now partial \(€276\.50 of €676\.50 received\)/);
  const aging = views(part)[0];
  assert.match(aging.markdown, /```chart/, "aging chart");

  // Second invoice → numbering advances; overdue math shows in aging.
  call(bins.invoice, cwd, "tool", { tool: "add_client", input: { name: "Acme Ltd" } }, env);
  const inv2 = call(bins.invoice, cwd, "tool", { tool: "create_invoice", input: { client: "Acme Ltd", date: "2026-06-01", due_days: 7, items: [{ description: "Audit", qty: 1, unit_price: 1000 }] } }, env);
  assert.match(inv2.content, /Created INV-0002/);
  const ag = call(bins.invoice, cwd, "tool", { tool: "aging", input: { as_of: "2026-09-06" } }, env);
  assert.match(ag.content, /Outstanding €1,630\.00/, "400 balance + 1230 = 1630");
  assert.match(views(ag)[0].markdown, /90\+ days|61-90 days/, "old invoice lands in a late bucket");
  assert.match(views(ag)[0].markdown, /Acme Ltd,2026-06-08/);
  assert.match(views(ag)[0].markdown, /!\[dashboard\]\(\.invoices\/panel\.html\)/, "aging links the panel");
  const panel = fs.readFileSync(path.join(cwd, ".invoices", "panel.html"), "utf8");
  assert.match(panel, /"outstanding_cents":163000/);
  assert.match(panel, /"cents":123000,"label":"61-90 days"/);
  assert.ok(!panel.includes("@@PACK_DATA@@"));

  const full = call(bins.invoice, cwd, "tool", { tool: "mark_paid", input: { number: "INV-0002" } }, env);
  assert.match(full.content, /INV-0002 is now paid/);
  const reg = fs.readFileSync(path.join(cwd, ".invoices", "register.csv"), "utf8");
  assert.match(reg, /INV-0002,Acme Ltd,2026-06-01,2026-06-08,1230.00,1230.00,paid/);
  const paidHtml = fs.readFileSync(path.join(cwd, ".invoices", "INV-0002.html"), "utf8");
  assert.match(paidHtml, /PAID/, "HTML re-renders with the paid stamp");
});
