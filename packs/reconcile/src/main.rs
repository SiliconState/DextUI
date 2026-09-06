//! reconcile — match a bank statement CSV against the ledger (.receipts) and
//! paid invoices (.invoices/register.csv). State in `<folder>/.reconcile/`:
//!   statement.csv   normalised import: id,date,description,amount
//!   matches.json    { "<stmt id>": { "kind": "receipt|invoice|manual", "ref": "...", "note": "..." } }
//! Matching: exact amount, date within ±N days, then description similarity.
use dextui_pack_sdk::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Line { id: u64, date: String, description: String, amount: i64 }

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Match { kind: String, r#ref: String, #[serde(default)] note: String }

struct Store { root: PathBuf, dir: PathBuf, symbol: String }

impl Store {
    fn open(cwd: &str) -> Result<Store, String> {
        let root = fs::canonicalize(cwd).map_err(|e| format!("folder: {e}"))?;
        let dir = confined(&root, ".reconcile")?;
        ensure_dir(&dir)?;
        Ok(Store { root, dir, symbol: std::env::var("RECEIPTS_CURRENCY").unwrap_or_else(|_| "$".into()) })
    }
    fn lines(&self) -> Vec<Line> {
        let text = read_text(&self.dir.join("statement.csv"), 8 << 20).ok().flatten().unwrap_or_default();
        csv_parse(&text).into_iter().skip(1).filter(|r| r.len() >= 4).map(|r| Line { id: r[0].parse().unwrap_or(0), date: r[1].clone(), description: r[2].clone(), amount: Money::parse(&r[3]).map(|m| m.0).unwrap_or(0) }).collect()
    }
    fn save_lines(&self, lines: &[Line]) -> Result<(), String> {
        let mut t = String::from("id,date,description,amount\n");
        for l in lines { t.push_str(&csv_row(&[&l.id.to_string(), &l.date, &l.description, &Money(l.amount).plain()])); t.push('\n'); }
        write_atomic(&self.dir.join("statement.csv"), &t)
    }
    fn matches(&self) -> BTreeMap<String, Match> {
        read_text(&self.dir.join("matches.json"), 4 << 20).ok().flatten().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }
    fn save_matches(&self, m: &BTreeMap<String, Match>) -> Result<(), String> {
        write_atomic(&self.dir.join("matches.json"), &serde_json::to_string_pretty(m).map_err(|e| e.to_string())?)
    }
    /// Candidates from the ledger (negative = money out) and paid invoices (positive = money in).
    fn candidates(&self) -> Vec<(String, String, String, i64)> {
        let mut out = Vec::new();
        if let Ok(Some(t)) = read_text(&self.root.join(".receipts").join("ledger.csv"), 8 << 20) {
            for r in csv_parse(&t).into_iter().skip(1).filter(|r| r.len() >= 4) {
                if let Some(m) = Money::parse(&r[3]) { out.push((format!("receipt#{}", r[0]), r[1].clone(), r[2].clone(), -m.0.abs())); }
            }
        }
        if let Ok(Some(t)) = read_text(&self.root.join(".invoices").join("register.csv"), 8 << 20) {
            for r in csv_parse(&t).into_iter().skip(1).filter(|r| r.len() >= 7) {
                if let Some(paid) = Money::parse(&r[5]) {
                    if paid.0 > 0 {
                        // The register has no payment date; the per-invoice JSON does
                        // (paid_on). Fall back to the due date when it is missing.
                        let paid_on = read_text(&self.root.join(".invoices").join(format!("{}.json", r[0])), 1 << 20)
                            .ok().flatten()
                            .and_then(|j| serde_json::from_str::<Value>(&j).ok())
                            .and_then(|v| v.get("paid_on").and_then(|p| p.as_str()).filter(|p| !p.is_empty()).map(str::to_string))
                            .unwrap_or_else(|| r[3].clone());
                        out.push((format!("invoice:{}", r[0]), paid_on, r[1].clone(), paid.0));
                    }
                }
            }
        }
        out
    }
}

fn s(input: &Value, key: &str) -> String { input.get(key).and_then(|v| v.as_str()).map(|x| x.trim().to_string()).unwrap_or_default() }

/// Detect date/description/amount columns from a header row (bank exports vary).
fn detect(header: &[String]) -> Option<(usize, usize, Option<usize>, Option<usize>, Option<usize>)> {
    let l: Vec<String> = header.iter().map(|h| h.to_ascii_lowercase()).collect();
    let find = |keys: &[&str]| l.iter().position(|h| keys.iter().any(|k| h.contains(k)));
    let date = find(&["date"])?;
    let desc = find(&["description", "memo", "narrative", "details", "payee", "name"])?;
    let amount = find(&["amount"]);
    let debit = find(&["debit", "withdrawal", "money out", "paid out"]);
    let credit = find(&["credit", "deposit", "money in", "paid in"]);
    if amount.is_none() && (debit.is_none() || credit.is_none()) { return None; }
    Some((date, desc, amount, debit, credit))
}

fn similarity(a: &str, b: &str) -> f64 {
    let toks = |x: &str| x.to_ascii_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|t| t.len() > 2).map(str::to_string).collect::<std::collections::BTreeSet<_>>();
    let (ta, tb) = (toks(a), toks(b));
    if ta.is_empty() || tb.is_empty() { return 0.0; }
    let inter = ta.intersection(&tb).count() as f64;
    inter / (ta.len().max(tb.len()) as f64)
}

fn import(st: &Store, input: &Value) -> Result<Response, String> {
    let rel = s(input, "file");
    let path = confined(&st.root, &rel)?;
    let text = read_text(&path, 16 << 20)?.ok_or_else(|| format!("no such file: {rel}"))?;
    let rows = csv_parse(&text);
    let header = rows.first().ok_or("empty CSV")?;
    let (di, ni, ai, dbi, cri) = detect(header).ok_or_else(|| format!("could not find date/description/amount columns in: {}", header.join(", ")))?;
    let mut lines = Vec::new();
    let mut skipped = 0;
    for (i, r) in rows.iter().enumerate().skip(1) {
        let date = r.get(di).and_then(|d| parse_date(d));
        let amount = match ai {
            Some(a) => r.get(a).and_then(|v| Money::parse(v)).map(|m| m.0),
            None => {
                let d = dbi.and_then(|k| r.get(k)).and_then(|v| Money::parse(v)).map(|m| -m.0.abs()).unwrap_or(0);
                let c = cri.and_then(|k| r.get(k)).and_then(|v| Money::parse(v)).map(|m| m.0.abs()).unwrap_or(0);
                if d == 0 && c == 0 { None } else { Some(d + c) }
            }
        };
        match (date, amount) {
            (Some(date), Some(amount)) if amount != 0 => lines.push(Line { id: i as u64, date, description: r.get(ni).cloned().unwrap_or_default().chars().take(120).collect(), amount }),
            _ => skipped += 1,
        }
    }
    if lines.is_empty() { return Err("no usable rows (need a date and a non-zero amount per row)".into()); }
    st.save_lines(&lines)?;
    st.save_matches(&BTreeMap::new())?;
    let (content, md) = reconcile(st, 3)?;
    Ok(Response::ok(format!("Imported {} statement lines ({skipped} skipped) from {rel}. {content}", lines.len())).view("Reconciliation", md))
}

fn reconcile(st: &Store, window: i64) -> Result<(String, String), String> {
    let lines = st.lines();
    let mut matches = st.matches();
    let cands = st.candidates();
    let mut used: std::collections::HashSet<String> = matches.values().map(|m| m.r#ref.clone()).collect();
    for l in &lines {
        if matches.contains_key(&l.id.to_string()) { continue; }
        let ld = day_number(&l.date).unwrap_or(0);
        let mut best: Option<(f64, &(String, String, String, i64))> = None;
        for c in &cands {
            if used.contains(&c.0) || c.3 != l.amount { continue; }
            let cd = day_number(&c.1).unwrap_or(i64::MIN / 2);
            if (cd - ld).abs() > window { continue; }
            let score = 1.0 + similarity(&l.description, &c.2) - (cd - ld).abs() as f64 * 0.05;
            if best.map(|b| score > b.0).unwrap_or(true) { best = Some((score, c)); }
        }
        if let Some((_, c)) = best {
            used.insert(c.0.clone());
            matches.insert(l.id.to_string(), Match { kind: if c.0.starts_with("receipt") { "receipt".into() } else { "invoice".into() }, r#ref: c.0.clone(), note: c.2.clone() });
        }
    }
    st.save_matches(&matches)?;
    let unmatched: Vec<&Line> = lines.iter().filter(|l| !matches.contains_key(&l.id.to_string())).collect();
    let matched_refs: std::collections::HashSet<&str> = matches.values().map(|m| m.r#ref.as_str()).collect();
    let missing: Vec<&(String, String, String, i64)> = cands.iter().filter(|c| !matched_refs.contains(c.0.as_str())).collect();
    let (m_in, m_out): (i64, i64) = lines.iter().fold((0, 0), |(i, o), l| if l.amount > 0 { (i + l.amount, o) } else { (i, o + l.amount) });
    let mut md = format!("**{}** of **{}** statement lines matched · in {} · out {}\n\n", matches.len(), lines.len(), Money(m_in).fmt(&st.symbol), Money(m_out).fmt(&st.symbol));
    md.push_str(&chart_fence("donut", "Statement lines", &["matched".into(), "unmatched".into()], &[matches.len() as f64, unmatched.len() as f64], ""));
    md.push_str("\n\n**On the statement but not in your books** (add a receipt or explain):\n\n");
    let rows: Vec<Vec<String>> = unmatched.iter().map(|l| vec![l.id.to_string(), l.date.clone(), l.description.clone(), Money(l.amount).fmt(&st.symbol)]).collect();
    md.push_str(&csv_fence(&["line", "date", "description", "amount"], &rows));
    md.push_str("\n\n**In your books but not on the statement** (not yet cleared, or wrong amount/date):\n\n");
    let rows2: Vec<Vec<String>> = missing.iter().map(|c| vec![c.0.clone(), c.1.clone(), c.2.clone(), Money(c.3).fmt(&st.symbol)]).collect();
    md.push_str(&csv_fence(&["ref", "date", "who", "amount"], &rows2));
    let content = format!("{} of {} lines matched (±{window} days). {} statement lines unexplained ({}), {} book entries not on the statement.", matches.len(), lines.len(), unmatched.len(), Money(unmatched.iter().map(|l| l.amount).sum::<i64>()).fmt(&st.symbol), missing.len());
    Ok((content, md))
}

fn mark(st: &Store, input: &Value) -> Result<Response, String> {
    let line = s(input, "line");
    let lines = st.lines();
    if !lines.iter().any(|l| l.id.to_string() == line) { return Err(format!("no statement line {line}")); }
    let mut m = st.matches();
    let r#ref = s(input, "ref");
    if r#ref.is_empty() && s(input, "note").is_empty() { return Err("give a ref (receipt#N / invoice:INV-0001) or a note explaining the line".into()); }
    m.insert(line.clone(), Match { kind: if r#ref.is_empty() { "manual".into() } else if r#ref.starts_with("receipt") { "receipt".into() } else { "invoice".into() }, r#ref, note: s(input, "note").chars().take(200).collect() });
    st.save_matches(&m)?;
    let (content, md) = reconcile(st, 3)?;
    Ok(Response::ok(format!("Line {line} explained. {content}")).view("Reconciliation", md))
}

struct Reconcile;
impl Runtime for Reconcile {
    fn activate(&mut self, req: &Request) -> Response {
        let st = match Store::open(&req.cwd) { Ok(s) => s, Err(e) => return Response::error(e) };
        let n = st.lines().len();
        Response::ok(format!("reconcile ready in {} — {n} statement lines on file. Tools: import_statement (bank CSV path), reconcile [window_days], explain_line (line, ref|note). Books come from .receipts/ledger.csv and .invoices/register.csv.", st.root.display()))
    }
    fn tool(&mut self, req: &Request, tool: &str, input: &Value) -> Response {
        let st = match Store::open(&req.cwd) { Ok(s) => s, Err(e) => return Response::error(e) };
        let r = match tool {
            "import_statement" => import(&st, input),
            "reconcile" => reconcile(&st, input.get("window_days").and_then(|v| v.as_i64()).unwrap_or(3).clamp(0, 30)).map(|(c, md)| Response::ok(c).view("Reconciliation", md)),
            "explain_line" => mark(&st, input),
            other => Err(format!("unknown tool '{other}'")),
        };
        r.unwrap_or_else(Response::error)
    }
}

fn main() { let _ = json!(null); run(&mut Reconcile); }
