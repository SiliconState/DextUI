//! receipts — Rust core for the "Receipts & expenses" pack.
//! Files are the state, all under `<folder>/.receipts/`:
//!   ledger.csv   id,date,vendor,amount,category,note,source
//!   rules.json   { "<vendor lowercase>": "<category>" }
//!   exports/     ledger-<month|all>.csv
//! Every tool returns a `view` card (chart + csv) so DextUI shows the result,
//! and plain content so the model can narrate it.
use dextui_pack_sdk::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const LEDGER_CAP: usize = 8 * 1024 * 1024;
const MAX_FILES: usize = 200;
const DEFAULT_CATEGORIES: &[&str] = &["Meals", "Travel", "Office", "Software", "Utilities", "Rent", "Supplies", "Marketing", "Fees", "Other"];

#[derive(Clone, Debug)]
struct Row {
    id: u64,
    date: String,
    vendor: String,
    amount: Money,
    category: String,
    note: String,
    source: String,
}

struct Store {
    root: PathBuf,
    dir: PathBuf,
    symbol: String,
}

impl Store {
    fn open(cwd: &str) -> Result<Store, String> {
        let root = fs::canonicalize(cwd).map_err(|e| format!("folder: {e}"))?;
        let dir = confined(&root, ".receipts")?;
        ensure_dir(&dir)?;
        ensure_dir(&confined(&root, ".receipts/exports")?)?;
        let symbol = std::env::var("RECEIPTS_CURRENCY").unwrap_or_else(|_| "$".into());
        Ok(Store { root, dir, symbol })
    }
    fn ledger_path(&self) -> PathBuf {
        self.dir.join("ledger.csv")
    }
    fn rows(&self) -> Result<Vec<Row>, String> {
        let text = read_text(&self.ledger_path(), LEDGER_CAP)?.unwrap_or_default();
        let mut out = Vec::new();
        for (i, r) in csv_parse(&text).into_iter().enumerate() {
            if i == 0 && r.first().map(|s| s == "id").unwrap_or(false) {
                continue;
            }
            if r.len() < 4 {
                continue;
            }
            let get = |k: usize| r.get(k).cloned().unwrap_or_default();
            out.push(Row {
                id: get(0).parse().unwrap_or(0),
                date: get(1),
                vendor: get(2),
                amount: Money::parse(&get(3)).unwrap_or_default(),
                category: get(4),
                note: get(5),
                source: get(6),
            });
        }
        Ok(out)
    }
    fn save(&self, rows: &[Row]) -> Result<(), String> {
        let mut text = String::from("id,date,vendor,amount,category,note,source\n");
        for r in rows {
            text.push_str(&csv_row(&[&r.id.to_string(), &r.date, &r.vendor, &r.amount.plain(), &r.category, &r.note, &r.source]));
            text.push('\n');
        }
        write_atomic(&self.ledger_path(), &text)
    }
    fn rules(&self) -> BTreeMap<String, String> {
        read_text(&self.dir.join("rules.json"), 256 * 1024)
            .ok()
            .flatten()
            .and_then(|t| serde_json::from_str::<BTreeMap<String, String>>(&t).ok())
            .unwrap_or_default()
    }
    fn save_rules(&self, rules: &BTreeMap<String, String>) -> Result<(), String> {
        write_atomic(&self.dir.join("rules.json"), &serde_json::to_string_pretty(rules).unwrap_or_else(|_| "{}".into()))
    }
}

fn s(input: &Value, key: &str) -> String {
    input.get(key).and_then(|v| v.as_str()).map(|x| x.trim().to_string()).unwrap_or_default()
}

fn category_for(vendor: &str, given: &str, rules: &BTreeMap<String, String>) -> String {
    if !given.is_empty() {
        return given.to_string();
    }
    let v = vendor.to_ascii_lowercase();
    if let Some(c) = rules.get(&v) {
        return c.clone();
    }
    for (k, c) in rules {
        if v.contains(k.as_str()) {
            return c.clone();
        }
    }
    "Uncategorised".into()
}

fn summary_view(st: &Store, rows: &[Row], month: Option<&str>) -> (String, String) {
    let scoped: Vec<&Row> = rows.iter().filter(|r| month.map(|m| month_of(&r.date) == m).unwrap_or(true)).collect();
    let mut by_cat: BTreeMap<String, i64> = BTreeMap::new();
    let mut by_month: BTreeMap<String, i64> = BTreeMap::new();
    let mut total = 0i64;
    for r in &scoped {
        *by_cat.entry(if r.category.is_empty() { "Uncategorised".into() } else { r.category.clone() }).or_default() += r.amount.0;
        total += r.amount.0;
    }
    for r in rows {
        *by_month.entry(month_of(&r.date).to_string()).or_default() += r.amount.0;
    }
    let scope = month.map(|m| m.to_string()).unwrap_or_else(|| "all time".into());
    let mut cats: Vec<(String, i64)> = by_cat.into_iter().collect();
    cats.sort_by(|a, b| b.1.cmp(&a.1));
    let labels: Vec<String> = cats.iter().map(|c| c.0.clone()).collect();
    let values: Vec<f64> = cats.iter().map(|c| Money(c.1).as_f64()).collect();
    let months: Vec<String> = by_month.keys().cloned().collect();
    let mvals: Vec<f64> = by_month.values().map(|v| Money(*v).as_f64()).collect();
    let mut md = format!("**{}** across {} receipt{} ({scope})\n\n", Money(total).fmt(&st.symbol), scoped.len(), if scoped.len() == 1 { "" } else { "s" });
    if !labels.is_empty() {
        md.push_str(&chart_fence("hbar", &format!("Spending by category — {scope}"), &labels, &values, &st.symbol));
        md.push_str("\n\n");
    }
    if months.len() > 1 {
        md.push_str(&chart_fence("bar", "Spending by month", &months, &mvals, &st.symbol));
        md.push_str("\n\n");
    }
    let mut table: Vec<Vec<String>> = scoped.iter().map(|r| vec![r.date.clone(), r.vendor.clone(), r.amount.fmt(&st.symbol), r.category.clone(), r.note.clone()]).collect();
    table.sort_by(|a, b| b[0].cmp(&a[0]));
    table.truncate(300);
    md.push_str(&csv_fence(&["date", "vendor", "amount", "category", "note"], &table));
    // Live panel (TS dashboard, rendered inline by DextUI) — baked with the
    // same numbers as the fences above; missing panel template is not an error.
    let panel = json!({
        "generated": today(),
        "symbol": st.symbol,
        "scope": scope,
        "total_cents": total,
        "count": scoped.len(),
        "by_category": cats.iter().map(|c| json!({"label": c.0, "cents": c.1})).collect::<Vec<_>>(),
        "by_month": by_month.iter().map(|(k, v)| json!({"label": k, "cents": v})).collect::<Vec<_>>(),
        "rows": scoped.iter().map(|r| json!({"date": r.date, "vendor": r.vendor, "amount_cents": r.amount.0, "category": r.category, "note": r.note})).collect::<Vec<_>>(),
    });
    if let Some(dir) = pack_dir("DEXT_PACK_RECEIPTS_DIR") {
        if let Ok(Some(_)) = write_panel(&dir, &st.dir, &panel) {
            md.push_str("\n\n![dashboard](.receipts/panel.html)");
        }
    }
    let content = format!(
        "{scope}: {} in {} receipts. By category: {}.",
        Money(total).fmt(&st.symbol),
        scoped.len(),
        cats.iter().map(|c| format!("{} {}", c.0, Money(c.1).fmt(&st.symbol))).collect::<Vec<_>>().join(", ")
    );
    (content, md)
}

fn guess_from_text(text: &str) -> Value {
    let mut best: Option<Money> = None;
    let mut date: Option<String> = None;
    let mut vendor = String::new();
    for line in text.lines().take(200) {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        if vendor.is_empty() && l.chars().any(|c| c.is_alphabetic()) && l.len() < 60 {
            vendor = l.to_string();
        }
        if date.is_none() {
            for w in l.split_whitespace() {
                if let Some(d) = parse_date(w) {
                    date = Some(d);
                    break;
                }
            }
        }
        for w in l.split_whitespace() {
            if w.chars().any(|c| c.is_ascii_digit()) && (w.contains('.') || w.contains('$') || w.contains('€') || w.contains('£')) {
                if let Some(m) = Money::parse(w) {
                    if m.0 > 0 && best.map(|b| m > b).unwrap_or(true) {
                        best = Some(m);
                    }
                }
            }
        }
    }
    json!({ "vendor": vendor, "date": date, "amount": best.map(|m| m.plain()) })
}

fn list_files(st: &Store, folder: &str) -> Result<Value, String> {
    let dir = if folder.is_empty() { st.root.clone() } else { confined(&st.root, folder)? };
    let known: std::collections::HashSet<String> = st.rows()?.into_iter().map(|r| r.source).filter(|x| !x.is_empty()).collect();
    let mut files = Vec::new();
    let mut entries: Vec<_> = fs::read_dir(&dir).map_err(|e| format!("read {}: {e}", dir.display()))?.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || e.file_type().map(|t| t.is_symlink() || t.is_dir()).unwrap_or(true) {
            continue;
        }
        let ext = Path::new(&name).extension().map(|x| x.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
        if !["pdf", "jpg", "jpeg", "png", "heic", "webp", "txt", "csv", "md"].contains(&ext.as_str()) {
            continue;
        }
        let rel = if folder.is_empty() { name.clone() } else { format!("{folder}/{name}") };
        let mut item = json!({ "file": rel, "kind": if ["txt", "csv", "md"].contains(&ext.as_str()) { "text" } else { "image_or_pdf" }, "recorded": known.contains(&rel) });
        if !known.contains(&rel) && ["txt", "md"].contains(&ext.as_str()) {
            if let Ok(Some(text)) = read_text(&e.path(), 512 * 1024) {
                item["guess"] = guess_from_text(&text);
            }
        }
        files.push(item);
        if files.len() >= MAX_FILES {
            break;
        }
    }
    let pending = files.iter().filter(|f| f["recorded"] == false).count();
    Ok(json!({ "folder": if folder.is_empty() { "." } else { folder }, "files": files, "pending": pending }))
}

struct Receipts;

impl Runtime for Receipts {
    fn activate(&mut self, req: &Request) -> Response {
        let st = match Store::open(&req.cwd) {
            Ok(s) => s,
            Err(e) => return Response::error(e),
        };
        let rows = st.rows().unwrap_or_default();
        let (content, md) = summary_view(&st, &rows, None);
        Response::ok(format!(
            "receipts ready in {} — ledger has {} rows ({}). Tools: list_receipt_files, add_receipt, set_category_rule, receipts_summary, export_ledger. Categories: {}.",
            st.root.display(),
            rows.len(),
            content,
            DEFAULT_CATEGORIES.join(", ")
        ))
        .view("Receipts — where things stand", md)
    }

    fn tool(&mut self, req: &Request, tool: &str, input: &Value) -> Response {
        let st = match Store::open(&req.cwd) {
            Ok(s) => s,
            Err(e) => return Response::error(e),
        };
        let r = match tool {
            "list_receipt_files" => list_files(&st, &s(input, "folder")).map(|v| {
                let pending = v["pending"].as_u64().unwrap_or(0);
                Response::ok(format!(
                    "{pending} file(s) not yet in the ledger. For each image/PDF, read it and call add_receipt with date, vendor, amount, category and source=<file>. Text files carry a `guess` you should verify.\n{}",
                    serde_json::to_string_pretty(&v).unwrap_or_default()
                ))
            }),
            "add_receipt" => add_receipt(&st, input),
            "set_category_rule" => set_rule(&st, input),
            "receipts_summary" => st.rows().map(|rows| {
                let month = s(input, "month");
                let (content, md) = summary_view(&st, &rows, if month.is_empty() { None } else { Some(&month) });
                Response::ok(content).view(format!("Receipts — {}", if month.is_empty() { "summary".to_string() } else { month }), md)
            }),
            "export_ledger" => export(&st, input),
            other => Err(format!("unknown tool '{other}'")),
        };
        match r {
            Ok(resp) => resp,
            Err(e) => Response::error(e),
        }
    }
}

fn add_receipt(st: &Store, input: &Value) -> Result<Response, String> {
    let date = parse_date(&s(input, "date")).ok_or_else(|| format!("date '{}' is not a date I understand (use YYYY-MM-DD)", s(input, "date")))?;
    let vendor = s(input, "vendor");
    if vendor.is_empty() || vendor.len() > 120 {
        return Err("vendor is required (max 120 chars)".into());
    }
    let amount = match input.get("amount") {
        Some(Value::Number(n)) => Money::from_f64(n.as_f64().unwrap_or(0.0)),
        Some(Value::String(t)) => Money::parse(t).ok_or_else(|| format!("amount '{t}' is not a number"))?,
        _ => return Err("amount is required".into()),
    };
    if amount.0 == 0 {
        return Err("amount must not be zero".into());
    }
    let rules = st.rules();
    let category = category_for(&vendor, &s(input, "category"), &rules);
    let note = s(input, "note").chars().take(200).collect::<String>();
    let source = s(input, "source").chars().take(200).collect::<String>();
    let mut rows = st.rows()?;
    let force = input.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
    if !force {
        if let Some(d) = rows.iter().find(|r| r.date == date && r.amount == amount && r.vendor.eq_ignore_ascii_case(&vendor)) {
            return Ok(Response::ok(format!(
                "Looks like a duplicate of receipt #{} ({} {} {}). Not added. Pass force=true if it really is a second purchase.",
                d.id, d.date, d.vendor, d.amount.fmt(&st.symbol)
            )));
        }
    }
    let id = rows.iter().map(|r| r.id).max().unwrap_or(0) + 1;
    rows.push(Row { id, date: date.clone(), vendor: vendor.clone(), amount, category: category.clone(), note, source });
    st.save(&rows)?;
    let m = month_of(&date).to_string();
    let (content, md) = summary_view(st, &rows, Some(&m));
    Ok(Response::ok(format!("Added #{id}: {date} {vendor} {} → {category}. {content}", amount.fmt(&st.symbol))).view(format!("Receipts — {m}"), md))
}

fn set_rule(st: &Store, input: &Value) -> Result<Response, String> {
    let vendor = s(input, "vendor").to_ascii_lowercase();
    let category = s(input, "category");
    if vendor.is_empty() || category.is_empty() {
        return Err("vendor and category are required".into());
    }
    let mut rules = st.rules();
    rules.insert(vendor.clone(), category.clone());
    st.save_rules(&rules)?;
    let mut rows = st.rows()?;
    let mut changed = 0;
    for r in rows.iter_mut() {
        if r.vendor.to_ascii_lowercase().contains(&vendor) && r.category != category {
            r.category = category.clone();
            changed += 1;
        }
    }
    if changed > 0 {
        st.save(&rows)?;
    }
    let (content, md) = summary_view(st, &rows, None);
    Ok(Response::ok(format!("Rule saved: '{vendor}' → {category}; {changed} existing receipt(s) recategorised. {content}")).view("Receipts — categories", md))
}

fn export(st: &Store, input: &Value) -> Result<Response, String> {
    let month = s(input, "month");
    let rows = st.rows()?;
    let scoped: Vec<&Row> = rows.iter().filter(|r| month.is_empty() || month_of(&r.date) == month).collect();
    let name = format!("ledger-{}.csv", if month.is_empty() { "all".to_string() } else { month.clone() });
    let path = st.dir.join("exports").join(&name);
    let mut text = String::from("id,date,vendor,amount,category,note,source\n");
    for r in &scoped {
        text.push_str(&csv_row(&[&r.id.to_string(), &r.date, &r.vendor, &r.amount.plain(), &r.category, &r.note, &r.source]));
        text.push('\n');
    }
    write_atomic(&path, &text)?;
    let total: i64 = scoped.iter().map(|r| r.amount.0).sum();
    Ok(Response::ok(format!("Exported {} rows ({}) to .receipts/exports/{name}", scoped.len(), Money(total).fmt(&st.symbol))))
}

fn main() {
    run(&mut Receipts);
}
