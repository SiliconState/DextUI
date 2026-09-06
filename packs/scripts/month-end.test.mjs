// The four month-end packs, end to end over the runtime protocol. They share
// a workspace so cross-pack reads (.receipts → cashflow/taxprep/reconcile,
// .invoices → followups/cashflow/taxprep) are exercised for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = (p) => path.join(packsRoot, `target/release/${p}-runtime`);
const ALL = ["receipts", "invoice", "reconcile", "cashflow", "taxprep", "followups"];

function ensureBuilt() {
  if (ALL.every((p) => fs.existsSync(bin(p)))) return;
  const r = spawnSync("cargo", ["build", "--release", "--offline", ...ALL.flatMap((p) => ["-p", p])], { cwd: packsRoot, encoding: "utf8", timeout: 600_000 });
  assert.equal(r.status, 0, `cargo build failed:\n${r.stderr}`);
}

function call(pack, cwd, event, extra = {}) {
  const request = { version: 1, event, pack, session_id: "t", cwd, state: {}, context: { turn_id: "t1", iteration: 0, history_messages: 0 }, ...extra };
  const out = execFileSync(bin(pack), [], { input: JSON.stringify(request), encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  const resp = JSON.parse(out.trim());
  assert.equal(resp.version, 1);
  assert.deepEqual(Object.keys(resp).sort(), ["content", "effects", "is_error", "version", ...(resp.state !== undefined ? ["state"] : [])].sort());
  return resp;
}
const tool = (pack, cwd, name, input = {}) => call(pack, cwd, "tool", { tool: name, input });
const view = (resp) => resp.effects.find((e) => e.type === "view")?.markdown ?? "";

/** Seed a workspace through the real receipts/invoice runtimes (no hand-written state files). */
function seed(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "month-end-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const ago = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return iso(d); };
  for (const [days, vendor, amount, cat] of [[3, "Eurostar", "82.50", "Travel"], [10, "Blue Bottle", "5.40", "Meals"], [20, "Adobe", "54.99", "Software"], [40, "Landlord Ltd", "1200.00", "Rent"], [45, "Cinema", "30.00", "Personal"]]) {
    const r = tool("receipts", cwd, "add_receipt", { date: ago(days), vendor, amount, category: cat });
    assert.equal(r.is_error, false, r.content);
  }
  tool("invoice", cwd, "set_business", { name: "Marta's Studio", tax_rate: 0, payment_terms_days: 14, currency: "$" });
  tool("invoice", cwd, "add_client", { name: "Acme Ltd" });
  tool("invoice", cwd, "add_client", { name: "Blue Bakery" });
  // Overdue, unpaid: due 30 days ago.
  assert.equal(tool("invoice", cwd, "create_invoice", { client: "Acme Ltd", date: ago(44), items: [{ description: "Audit", unit_price: 1000 }] }).is_error, false);
  // Paid: revenue this quarter.
  assert.equal(tool("invoice", cwd, "create_invoice", { client: "Blue Bakery", date: ago(15), items: [{ description: "Logo", unit_price: 450 }] }).is_error, false);
  tool("invoice", cwd, "mark_paid", { number: "INV-0002", date: ago(5) });
  // Not yet due: lands in the forecast.
  assert.equal(tool("invoice", cwd, "create_invoice", { client: "Blue Bakery", date: ago(2), due_days: 20, items: [{ description: "Revisions", unit_price: 100 }] }).is_error, false);
  return { cwd, ago };
}

test("reconcile: import (amount col), auto-match by amount+date+description, explain the rest, confinement", (t) => {
  ensureBuilt();
  const { cwd, ago } = seed(t);
  fs.writeFileSync(path.join(cwd, "bank.csv"), [
    "Date,Description,Amount,Balance",
    `${ago(2)},EUROSTAR INTL LONDON,-82.50,900.00`,
    `${ago(5)},BLUE BAKERY PAYMENT,450.00,982.50`,
    `${ago(10)},BLUE BOTTLE COFFEE,-5.40,532.50`,
    `${ago(12)},BANK FEE,-3.00,537.90`,
    `${ago(19)},ADOBE SYSTEMS,-54.99,540.90`,
  ].join("\n"));
  const act = call("reconcile", cwd, "activate");
  assert.match(act.content, /0 statement lines/);
  const bad = tool("reconcile", cwd, "import_statement", { file: "../outside.csv" });
  assert.equal(bad.is_error, true, "traversal refused");
  const imp = tool("reconcile", cwd, "import_statement", { file: "bank.csv" });
  assert.equal(imp.is_error, false, imp.content);
  assert.match(imp.content, /Imported 5 statement lines/);
  assert.match(imp.content, /4 of 5 lines matched/, "Eurostar, Blue Bakery payment, Blue Bottle, Adobe match; the bank fee does not");
  assert.match(view(imp), /```chart[\s\S]*"donut"/);
  assert.match(view(imp), /BANK FEE/);
  assert.match(view(imp), /receipt#4,.*Landlord Ltd/, "rent in the books but not on the statement");
  const ex = tool("reconcile", cwd, "explain_line", { line: "4", note: "monthly bank fee" });
  assert.match(ex.content, /5 of 5 lines matched/);
  const m = JSON.parse(fs.readFileSync(path.join(cwd, ".reconcile", "matches.json"), "utf8"));
  assert.equal(m["4"].kind, "manual");
  assert.equal(m["2"].ref, "invoice:INV-0002", "payment matched to the paid invoice");
  // debit/credit layout
  fs.writeFileSync(path.join(cwd, "bank2.csv"), `Transaction Date,Details,Money Out,Money In\n${ago(2)},Eurostar,82.50,\n${ago(5)},Blue Bakery,,450.00\n`);
  const imp2 = tool("reconcile", cwd, "import_statement", { file: "bank2.csv" });
  assert.match(imp2.content, /2 of 2 lines matched/);
  assert.equal(tool("reconcile", cwd, "explain_line", { line: "9" }).is_error, true, "unknown line");
});

test("cashflow: balance, recurring, 13-week projection with receivables landing on due dates and a negative warning", (t) => {
  ensureBuilt();
  const { cwd } = seed(t);
  const act = call("cashflow", cwd, "activate");
  assert.match(act.content, /Ask for today's bank balance/);
  const sb = tool("cashflow", cwd, "set_balance", { balance: "500", currency: "$" });
  assert.equal(sb.is_error, false, sb.content);
  assert.match(sb.content, /Balance set: \$500\.00/);
  assert.match(sb.content, /2 receivables \(\$1,100\.00\)/, "overdue 1000 + not-yet-due 100");
  assert.equal(tool("cashflow", cwd, "add_recurring", { name: "Rent", amount: "-1200", every_days: 30 }).is_error, false);
  assert.equal(tool("cashflow", cwd, "add_recurring", { name: "Retainer", amount: 800, every_days: 30, next: "2099-01-01" }).is_error, false);
  assert.equal(tool("cashflow", cwd, "add_recurring", { name: "x", amount: 1, every_days: 0 }).is_error, true);
  const fc = tool("cashflow", cwd, "forecast", { weeks: 13 });
  assert.match(fc.content, /13-week forecast/);
  assert.match(fc.content, /2 recurring items/);
  const md = view(fc);
  assert.match(md, /```chart[\s\S]*"line"/, "draggable line chart");
  assert.match(md, /week of,in,out,balance/);
  const rows = md.split("\n").filter((l) => /^\d{4}-\d{2}-\d{2},/.test(l));
  assert.equal(rows.length, 13);
  assert.match(rows[0], /\$1,000\.00/, "overdue receivable lands in week 1");
  assert.match(fc.content, /WARNING: balance goes negative/, "rent every 30 days outruns 500 + receivables");
  assert.match(tool("cashflow", cwd, "remove_recurring", { name: "rent" }).content, /1 recurring item\(s\) left/);
  assert.equal(tool("cashflow", cwd, "remove_recurring", { name: "nope" }).is_error, true);
});

test("taxprep: config (never guessed), quarterly estimate with non-deductible + partial categories, package files", (t) => {
  ensureBuilt();
  const { cwd, ago } = seed(t);
  const act = call("taxprep", cwd, "activate");
  assert.match(act.content, /No tax config yet/);
  assert.match(act.content, /Not tax advice/);
  assert.equal(tool("taxprep", cwd, "set_tax_config", { rate: 120 }).is_error, true);
  const cfg = tool("taxprep", cwd, "set_tax_config", { jurisdiction: "Example", rate: 20, non_deductible: ["Personal"], partial: { Meals: 50 } });
  assert.equal(cfg.is_error, false, cfg.content);
  // Quarter containing "15 days ago" (the paid invoice's date).
  const d = new Date(ago(15));
  const q = `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
  const est = tool("taxprep", cwd, "estimate", { quarter: q });
  assert.equal(est.is_error, false, est.content);
  assert.match(est.content, /revenue \$450\.00/, "paid invoice counted as revenue");
  const md = view(est);
  assert.match(md, /not tax advice/);
  assert.match(md, /Personal,\$30\.00,\$0\.00,0%/, "non-deductible category at 0%");
  assert.match(md, /Meals,\$5\.40,\$2\.70,50%/, "partial category");
  assert.match(md, /Before you file/);
  assert.equal(tool("taxprep", cwd, "estimate", { quarter: "Q3" }).is_error, true, "bad quarter format");
  const pkg = tool("taxprep", cwd, "build_package", { quarter: q });
  assert.equal(pkg.is_error, false, pkg.content);
  const dir = path.join(cwd, ".taxprep", `package-${q}`);
  for (const f of ["expenses.csv", "invoices.csv", "summary.md", "summary.json"]) assert.ok(fs.existsSync(path.join(dir, f)), f);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8"));
  assert.equal(summary.revenue_cents, 45000);
  assert.equal(summary.rate, 20);
  assert.equal(summary.tax_cents, Math.round(summary.taxable_cents * 0.2));
});

test("followups: overdue invoices auto-tracked, add/mark, reminder drafts in three tones, nothing sent", (t) => {
  ensureBuilt();
  const { cwd, ago } = seed(t);
  const act = call("followups", cwd, "activate");
  assert.match(act.content, /1 overdue invoice\(s\) added/, "INV-0001 is 30 days late");
  assert.match(act.content, /Acme Ltd — payment of \$1,000\.00 for INV-0001 \(30 days\)/);
  const add = tool("followups", cwd, "add_followup", { who: "Blue Bakery", what: "signed contract", due: ago(3) });
  assert.match(add.content, /Added #2/);
  const add2 = tool("followups", cwd, "add_followup", { who: "Printer Co", what: "quote" }); // due next week
  assert.match(add2.content, /3 open follow-ups, 2 overdue/);
  const list = view(tool("followups", cwd, "list_followups"));
  assert.match(list.split("\n").find((l) => l.startsWith("1,")) ?? "", /30 days late/);
  assert.match(list, /Printer Co,quote,.*,in 7 days/);
  const drafts = tool("followups", cwd, "draft_reminders", { tone: "firm", sign_as: "Marta" });
  assert.match(drafts.content, /2 reminder draft\(s\) ready \(firm\)/);
  const dmd = view(drafts);
  assert.match(dmd, /nothing is sent for you/);
  assert.match(dmd, /Hi Acme,[\s\S]*30 days overdue[\s\S]*Thanks,\nMarta/);
  assert.match(dmd, /Hi Blue,[\s\S]*signed contract/);
  assert.doesNotMatch(dmd, /Printer Co/, "not overdue → no draft");
  assert.match(tool("followups", cwd, "mark_followup", { id: "1", status: "sent" }).content, /#1 → sent/);
  assert.match(tool("followups", cwd, "mark_followup", { id: "2", status: "done" }).content, /2 open follow-ups, 1 overdue/);
  assert.equal(tool("followups", cwd, "mark_followup", { id: "9", status: "done" }).is_error, true);
  assert.equal(tool("followups", cwd, "mark_followup", { id: "1", status: "lost" }).is_error, true);
  // Re-activation must not duplicate the invoice follow-up (still open, status sent).
  assert.doesNotMatch(call("followups", cwd, "activate").content, /added/);
  const csv = fs.readFileSync(path.join(cwd, ".followups", "items.csv"), "utf8");
  assert.match(csv, /^1,Acme Ltd,"payment of \$1,000\.00 for INV-0001",.*,sent,invoice:INV-0001,reminder sent/m, "comma in the amount → quoted field");
});
