//! taxprep — a quarterly estimate and an accountant package from the books.
//! Revenue = invoice payments received in the quarter (.invoices/register.csv,
//! paid column); deductible expenses = ledger rows in the quarter whose category
//! is not in `non_deductible`. Rates and rules come from `.taxprep/config.json`
//! (the user's, never guessed). This is arithmetic, not tax advice; the views
//! say so and the package is for the accountant to review.
use dextui_pack_sdk::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Config {
    #[serde(default)] jurisdiction: String,
    /// Percent applied to (revenue - deductible expenses).
    #[serde(default)] rate: f64,
    #[serde(default = "sym")] symbol: String,
    #[serde(default = "nondeduct")] non_deductible: Vec<String>,
    /// Categories only partly deductible: name -> percent.
    #[serde(default)] partial: BTreeMap<String, f64>,
    #[serde(default = "fy")] fiscal_year_start_month: u32,
}
fn sym() -> String { "$".into() }
fn nondeduct() -> Vec<String> { vec!["Personal".into(), "Drawings".into(), "Fines".into()] }
fn fy() -> u32 { 1 }
impl Default for Config { fn default() -> Self { Config { jurisdiction: String::new(), rate: 0.0, symbol: sym(), non_deductible: nondeduct(), partial: BTreeMap::new(), fiscal_year_start_month: fy() } } }

struct Store { root: PathBuf, dir: PathBuf }
impl Store {
    fn open(cwd: &str) -> Result<Store, String> {
        let root = fs::canonicalize(cwd).map_err(|e| format!("folder: {e}"))?;
        let dir = confined(&root, ".taxprep")?;
        ensure_dir(&dir)?;
        Ok(Store { root, dir })
    }
    fn config(&self) -> Config { read_text(&self.dir.join("config.json"), 64 << 10).ok().flatten().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default() }
    fn save_config(&self, c: &Config) -> Result<(), String> { write_atomic(&self.dir.join("config.json"), &serde_json::to_string_pretty(c).map_err(|e| e.to_string())?) }
    fn ledger(&self) -> Vec<Vec<String>> { read_text(&self.root.join(".receipts").join("ledger.csv"), 8 << 20).ok().flatten().map(|t| csv_parse(&t).into_iter().skip(1).filter(|r| r.len() >= 5).collect()).unwrap_or_default() }
    fn invoices(&self) -> Vec<Vec<String>> { read_text(&self.root.join(".invoices").join("register.csv"), 8 << 20).ok().flatten().map(|t| csv_parse(&t).into_iter().skip(1).filter(|r| r.len() >= 7).collect()).unwrap_or_default() }
}

fn s(input: &Value, key: &str) -> String { input.get(key).and_then(|v| v.as_str()).map(|x| x.trim().to_string()).unwrap_or_default() }

/// "2026-Q3" → (start, end) ISO dates, honouring the fiscal year start month.
fn quarter_range(q: &str, fy_start: u32) -> Option<(String, String, String)> {
    let (y, n) = q.trim().to_uppercase().split_once("-Q").map(|(a, b)| (a.parse::<u32>().ok(), b.parse::<u32>().ok()))?;
    let (y, n) = (y?, n?);
    if !(1..=4).contains(&n) || !(1990..=2200).contains(&y) { return None; }
    let m0 = (fy_start - 1 + (n - 1) * 3) % 12 + 1;
    let y0 = y + ((fy_start - 1 + (n - 1) * 3) / 12);
    let m1 = (m0 - 1 + 3) % 12 + 1;
    let y1 = if m1 <= m0 { y0 + 1 } else { y0 };
    let start = format!("{y0:04}-{m0:02}-01");
    let end = add_days(&format!("{y1:04}-{m1:02}-01"), -1)?;
    Some((start, end, format!("{y}-Q{n}")))
}

fn current_quarter(fy_start: u32) -> String {
    let t = today();
    let y: u32 = t[..4].parse().unwrap_or(2026);
    let m: u32 = t[5..7].parse().unwrap_or(1);
    let offset = (m + 12 - fy_start) % 12;
    format!("{y}-Q{}", offset / 3 + 1)
}

fn estimate(st: &Store, q: &str) -> Result<(String, String, Value), String> {
    let cfg = st.config();
    let (start, end, label) = quarter_range(q, cfg.fiscal_year_start_month).ok_or_else(|| format!("quarter must look like 2026-Q3 (got '{q}')"))?;
    let (ds, de) = (day_number(&start).unwrap_or(0), day_number(&end).unwrap_or(0));
    let in_q = |d: &str| day_number(d).map(|x| x >= ds && x <= de).unwrap_or(false);
    let sym = &cfg.symbol;
    let mut revenue = 0i64;
    let mut rev_rows: Vec<Vec<String>> = Vec::new();
    for r in st.invoices() {
        // Cash basis: a payment counts when it was received; the register has
        // paid_on only inside the per-invoice JSON, so use the invoice date when
        // paid > 0 and the invoice is within the quarter (documented simplification).
        let paid = Money::parse(&r[5]).map(|m| m.0).unwrap_or(0);
        if paid > 0 && in_q(&r[2]) { revenue += paid; rev_rows.push(vec![r[0].clone(), r[1].clone(), r[2].clone(), Money(paid).fmt(sym)]); }
    }
    let mut by_cat: BTreeMap<String, (i64, i64)> = BTreeMap::new(); // (spent, deductible)
    for r in st.ledger() {
        if !in_q(&r[1]) { continue; }
        let cents = Money::parse(&r[3]).map(|m| m.0).unwrap_or(0);
        let cat = if r[4].is_empty() { "Uncategorised".to_string() } else { r[4].clone() };
        let pct = if cfg.non_deductible.iter().any(|c| c.eq_ignore_ascii_case(&cat)) { 0.0 } else { *cfg.partial.get(&cat).unwrap_or(&100.0) };
        let ded = Money::from_f64(Money(cents).as_f64() * pct / 100.0).0;
        let e = by_cat.entry(cat).or_default();
        e.0 += cents;
        e.1 += ded;
    }
    let spent: i64 = by_cat.values().map(|v| v.0).sum();
    let deductible: i64 = by_cat.values().map(|v| v.1).sum();
    let taxable = (revenue - deductible).max(0);
    let tax = Money::from_f64(Money(taxable).as_f64() * cfg.rate / 100.0).0;
    let mut md = format!("_Arithmetic from your books, not tax advice — your accountant decides what applies{}._\n\n", if cfg.jurisdiction.is_empty() { String::new() } else { format!(" ({})", cfg.jurisdiction) });
    md.push_str(&format!("**{label}** ({start} → {end})\n\n| | |\n|---|---:|\n| Revenue received | {} |\n| Expenses | {} |\n| Deductible | {} |\n| **Taxable** | **{}** |\n| Estimated tax at {}% | **{}** |\n\n", Money(revenue).fmt(sym), Money(spent).fmt(sym), Money(deductible).fmt(sym), Money(taxable).fmt(sym), fmt_pct(cfg.rate), Money(tax).fmt(sym)));
    if cfg.rate == 0.0 { md.push_str("> No rate set yet — `set_tax_config` with your rate to see an estimate.\n\n"); }
    let cl: Vec<String> = by_cat.keys().cloned().collect();
    if !cl.is_empty() {
        md.push_str(&chart_fence("hbar", "Deductible by category", &cl, &by_cat.values().map(|v| Money(v.1).as_f64()).collect::<Vec<_>>(), sym));
        md.push_str("\n\n");
    }
    let rows: Vec<Vec<String>> = by_cat.iter().map(|(k, v)| vec![k.clone(), Money(v.0).fmt(sym), Money(v.1).fmt(sym), if v.0 == 0 { "-".into() } else { format!("{}%", fmt_pct(v.1 as f64 * 100.0 / v.0 as f64)) }]).collect();
    md.push_str(&csv_fence(&["category", "spent", "deductible", "rate"], &rows));
    let checklist = ["Receipts recorded for every expense (Uncategorised = 0)", "Bank statement reconciled for the quarter", "Invoices marked paid on the date money arrived", "Personal spending excluded (non_deductible list)", "Mileage / home-office logged if you claim them"];
    md.push_str("\n\n**Before you file**\n\n");
    for c in checklist { md.push_str(&format!("- [ ] {c}\n")); }
    let content = format!("{label}: revenue {}, deductible {} of {} spent, taxable {}, estimated tax {} at {}%.{}", Money(revenue).fmt(sym), Money(deductible).fmt(sym), Money(spent).fmt(sym), Money(taxable).fmt(sym), Money(tax).fmt(sym), fmt_pct(cfg.rate), if by_cat.contains_key("Uncategorised") { " Uncategorised expenses exist — fix them first." } else { "" });
    let data = serde_json::json!({ "quarter": label, "start": start, "end": end, "revenue_cents": revenue, "spent_cents": spent, "deductible_cents": deductible, "taxable_cents": taxable, "tax_cents": tax, "rate": cfg.rate, "by_category": by_cat.iter().map(|(k, v)| serde_json::json!({"category": k, "spent": v.0, "deductible": v.1})).collect::<Vec<_>>(), "revenue_rows": rev_rows });
    Ok((content, md, data))
}

fn fmt_pct(p: f64) -> String { if (p - p.round()).abs() < 1e-9 { format!("{}", p.round() as i64) } else { format!("{p:.1}") } }

fn package(st: &Store, q: &str) -> Result<Response, String> {
    let (content, md, data) = estimate(st, q)?;
    let label = data["quarter"].as_str().unwrap_or(q).to_string();
    let dir = st.dir.join(format!("package-{label}"));
    ensure_dir(&dir)?;
    let (start, end) = (data["start"].as_str().unwrap_or(""), data["end"].as_str().unwrap_or(""));
    let in_q = |d: &str| { let (a, b) = (day_number(start).unwrap_or(0), day_number(end).unwrap_or(0)); day_number(d).map(|x| x >= a && x <= b).unwrap_or(false) };
    let mut led = String::from("id,date,vendor,amount,category,note,source\n");
    for r in st.ledger() { if in_q(&r[1]) { let refs: Vec<&str> = r.iter().map(|x| x.as_str()).collect(); led.push_str(&csv_row(&refs)); led.push('\n'); } }
    write_atomic(&dir.join("expenses.csv"), &led)?;
    let mut inv = String::from("number,client,date,due,total,paid,status\n");
    for r in st.invoices() { if in_q(&r[2]) { let refs: Vec<&str> = r.iter().map(|x| x.as_str()).collect(); inv.push_str(&csv_row(&refs)); inv.push('\n'); } }
    write_atomic(&dir.join("invoices.csv"), &inv)?;
    write_atomic(&dir.join("summary.md"), &format!("# Tax package {label}\n\n{md}\n"))?;
    write_atomic(&dir.join("summary.json"), &serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?)?;
    Ok(Response::ok(format!("Package written to .taxprep/package-{label}/ (expenses.csv, invoices.csv, summary.md, summary.json). {content}")).view(format!("Tax package {label}"), md))
}

struct TaxPrep;
impl Runtime for TaxPrep {
    fn activate(&mut self, req: &Request) -> Response {
        let st = match Store::open(&req.cwd) { Ok(s) => s, Err(e) => return Response::error(e) };
        let cfg = st.config();
        let q = current_quarter(cfg.fiscal_year_start_month);
        let setup = if cfg.rate == 0.0 { "No tax config yet — ask for jurisdiction, rate (%), fiscal year start month and any non-deductible categories, then set_tax_config. " } else { "" };
        match estimate(&st, &q) {
            Ok((content, md, _)) => Response::ok(format!("taxprep ready in {}. {setup}{content} Tools: set_tax_config, estimate (quarter), build_package (quarter). Not tax advice.", st.root.display())).view(format!("Tax estimate {q}"), md),
            Err(e) => Response::error(e),
        }
    }
    fn tool(&mut self, req: &Request, tool: &str, input: &Value) -> Response {
        let st = match Store::open(&req.cwd) { Ok(s) => s, Err(e) => return Response::error(e) };
        let r: Result<Response, String> = match tool {
            "set_tax_config" => (|| {
                let mut c = st.config();
                if !s(input, "jurisdiction").is_empty() { c.jurisdiction = s(input, "jurisdiction").chars().take(80).collect(); }
                if let Some(r) = input.get("rate").and_then(|v| v.as_f64()) { if !(0.0..=100.0).contains(&r) { return Err("rate must be 0..100".into()); } c.rate = r; }
                if !s(input, "currency").is_empty() { c.symbol = s(input, "currency").chars().take(4).collect(); }
                if let Some(m) = input.get("fiscal_year_start_month").and_then(|v| v.as_u64()) { if !(1..=12).contains(&m) { return Err("fiscal_year_start_month must be 1..12".into()); } c.fiscal_year_start_month = m as u32; }
                if let Some(list) = input.get("non_deductible").and_then(|v| v.as_array()) { c.non_deductible = list.iter().filter_map(|x| x.as_str()).map(|x| x.chars().take(40).collect()).take(32).collect(); }
                if let Some(obj) = input.get("partial").and_then(|v| v.as_object()) { c.partial = obj.iter().filter_map(|(k, v)| v.as_f64().filter(|p| (0.0..=100.0).contains(p)).map(|p| (k.chars().take(40).collect(), p))).take(32).collect(); }
                st.save_config(&c)?;
                let q = current_quarter(c.fiscal_year_start_month);
                let (content, md, _) = estimate(&st, &q)?;
                Ok(Response::ok(format!("Tax config saved ({} at {}%, FY starts month {}). {content}", if c.jurisdiction.is_empty() { "no jurisdiction" } else { &c.jurisdiction }, fmt_pct(c.rate), c.fiscal_year_start_month)).view(format!("Tax estimate {q}"), md))
            })(),
            "estimate" => {
                let q = if s(input, "quarter").is_empty() { current_quarter(st.config().fiscal_year_start_month) } else { s(input, "quarter") };
                estimate(&st, &q).map(|(c, md, d)| Response::ok(c).view(format!("Tax estimate {}", d["quarter"].as_str().unwrap_or(&q)), md))
            }
            "build_package" => package(&st, &if s(input, "quarter").is_empty() { current_quarter(st.config().fiscal_year_start_month) } else { s(input, "quarter") }),
            other => Err(format!("unknown tool '{other}'")),
        };
        r.unwrap_or_else(Response::error)
    }
}

fn main() { run(&mut TaxPrep); }
