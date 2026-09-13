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

/// review_text_receipts: verify the guessed vendor/date/amount of pending text
/// receipts (txt/md) in DextUI forms, prefilled from the file's own text.
/// Adds go straight into the ledger with the file as source; "leave for later"
/// is session state so review loops terminate without touching the ledger.
const FILE_BATCH: usize = 3;
const FILE_MAX_FORMS: usize = 10;

fn host_forms(req: &Request) -> bool {
    req.context.as_ref().map(|c| c.ui_methods.iter().any(|m| m == "form" || m == "*")).unwrap_or(false)
}

fn cut(s: &str, n: usize) -> String { s.chars().take(n).collect() }

/// Session review state (round-tripped via Response.state): the folder being
/// walked and the files the user chose to leave for later.
fn review_state(req: &Request) -> (String, Vec<String>) {
    let st = req.state.clone().unwrap_or(Value::Null);
    let folder = st.get("review").and_then(|r| r.get("folder")).and_then(|f| f.as_str()).unwrap_or_default().to_string();
    let skip = st.get("review").and_then(|r| r.get("skip")).and_then(|s| s.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).take(256).collect())
        .unwrap_or_default();
    (folder, skip)
}

fn review_state_json(folder: &str, skip: &[String]) -> Value {
    json!({ "review": { "folder": folder, "skip": skip } })
}

/// Pending text receipts (txt/md, unrecorded, not skipped this session), with
/// their guesses, in list_files order.
fn pending_texts(st: &Store, folder: &str, skip: &[String]) -> Result<Vec<(String, Value)>, String> {
    let v = list_files(st, folder)?;
    let mut out = Vec::new();
    for f in v["files"].as_array().cloned().unwrap_or_default() {
        let file = f["file"].as_str().unwrap_or_default().to_string();
        let ext = Path::new(&file).extension().map(|x| x.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
        if f["recorded"].as_bool() != Some(false) || !["txt", "md"].contains(&ext.as_str()) || skip.iter().any(|s| s == &file) {
            continue;
        }
        let guess = f.get("guess").cloned().unwrap_or(json!({ "vendor": "", "date": "", "amount": null }));
        out.push((file, guess));
    }
    Ok(out)
}

fn snippet(st: &Store, file: &str) -> String {
    let p = match confined(&st.root, file) { Ok(p) => p, Err(_) => return String::new() };
    let text = read_text(&p, 512 * 1024).ok().flatten().unwrap_or_default();
    cut(&text.lines().map(str::trim).filter(|l| !l.is_empty()).take(3).collect::<Vec<_>>().join(" · "), 160)
}

fn file_form(round: usize, batch: &[(String, Value)], rules: &std::collections::BTreeMap<String, String>, st: &Store) -> Value {
    let mut fields = Vec::new();
    for (i, (file, guess)) in batch.iter().enumerate() {
        let i = i + 1;
        let g = |k: &str| guess.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let vendor = g("vendor");
        let amount = guess.get("amount").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        fields.push(json!({
            "id": format!("s{i}"),
            "label": cut(file, 80),
            "type": "select",
            "options": [
                { "value": format!("add|{file}"), "label": "Add to the ledger" },
                { "value": format!("skip|{file}"), "label": "Leave for later" },
            ],
            "default": format!("add|{file}"),
            "description": snippet(st, file),
        }));
        for (suffix, label, val, ph) in [
            ("d", "date", g("date"), "YYYY-MM-DD"),
            ("v", "vendor", vendor.clone(), "who was paid"),
            ("a", "amount", amount, "e.g. 12.50"),
            ("c", "category", category_for(&vendor, "", rules), ""),
        ] {
            let mut field = json!({ "id": format!("{suffix}{i}"), "label": format!("{} — {label}", cut(file, 40)), "type": "text" });
            if !ph.is_empty() { field["placeholder"] = Value::String(ph.to_string()); }
            if !val.is_empty() { field["default"] = Value::String(val); }
            fields.push(field);
        }
    }
    json!({
        "title": "Verify text receipts",
        "description": format!("Batch {round}. Defaults are guessed from the file text — fix anything wrong. Add records it in the ledger with the file as source; cancelling keeps earlier batches."),
        "submit_label": "Apply",
        "fields": fields,
    })
}

/// The tool entry point: first form, or a fallback summary on hosts without forms.
fn review_files(st: &Store, input: &Value, req: &Request) -> Response {
    let (state_folder, skip) = review_state(req);
    // An explicit folder — even "" (the root) — always wins; the session's
    // remembered folder is only a fallback when the tool call omits the key
    // entirely. Otherwise the schema's "default is the root" promise would
    // break for a session that previously reviewed a sub-folder.
    let folder = match input.get("folder") {
        Some(v) => v.as_str().unwrap_or_default().to_string(),
        None => state_folder,
    };
    let pending = match pending_texts(st, &folder, &skip) { Ok(p) => p, Err(e) => return Response::error(e) };
    if pending.is_empty() {
        let rows = st.rows().unwrap_or_default();
        let (content, md) = summary_view(st, &rows, None);
        return Response::ok(format!("No pending text receipts to review. {content}")).view("Receipts — where things stand", md);
    }
    if !host_forms(req) {
        return Response::ok(format!("{} text receipt file(s) pending and this host cannot render review forms. Use list_receipt_files to see each file's guessed vendor/date/amount, verify it, then add with add_receipt (date, vendor, amount, category, source=<file>).", pending.len()));
    }
    let batch: Vec<(String, Value)> = pending.iter().take(FILE_BATCH).cloned().collect();
    let params = file_form(1, &batch, &st.rules(), st);
    Response::ok(format!("Reviewing {} pending text receipt(s), {} per form.", pending.len(), batch.len()))
        .ui_request("files-1", METHOD_FORM, params)
        .with_state(review_state_json(&folder, &skip))
}

/// Host answered a verify form: apply the adds and skips, then ask the next or finish.
fn files_answer(st: &Store, req: &Request, round: &UiRound) -> Response {
    if round.method != METHOD_FORM {
        return Response::error(format!("unexpected UI response method '{}'", round.method));
    }
    let Some(n) = round.request_id.strip_prefix("files-").and_then(|n| n.parse::<usize>().ok()) else {
        return Response::error(format!("unexpected UI request id '{}'", round.request_id));
    };
    let (folder, mut skip) = review_state(req);
    let pending = match pending_texts(st, &folder, &skip) { Ok(p) => p, Err(e) => return Response::error(e) };
    let stopped = |why: &str| {
        Response::ok(format!("Review stopped ({why}) — files already added stay in the ledger. {} text receipt(s) still pending; run review_text_receipts to continue.", pending.len()))
    };
    let UiAnswer::Ok { value } = &round.response else {
        return stopped(match &round.response { UiAnswer::Cancelled => "cancelled", UiAnswer::Error { code, .. } => code, UiAnswer::Ok { .. } => unreachable!() });
    };
    // Each s<i> value is "add|<file>" or "skip|<file>", so answers stay valid
    // even if the directory order shifts between form and submit.
    let obj = value.as_object().cloned().unwrap_or_default();
    let mut lines: Vec<String> = Vec::new();
    for (key, choice) in &obj {
        let Some(idx) = key.strip_prefix('s') else { continue };
        let Some(choice) = choice.as_str() else { continue };
        let Some((action, file)) = choice.split_once('|') else { continue };
        if file.is_empty() || !pending.iter().any(|(f, _)| f == file) { continue; }
        if action != "add" {
            if !skip.iter().any(|s| s == file) && skip.len() < 256 {
                skip.push(file.to_string());
                lines.push(format!("{} left for later", cut(file, 60)));
            }
            continue;
        }
        let gi = |suffix: &str| obj.get(&format!("{suffix}{idx}")).and_then(|v| v.as_str()).map(str::to_string).unwrap_or_default();
        let input = json!({ "date": gi("d"), "vendor": gi("v"), "amount": gi("a"), "category": gi("c"), "source": file });
        match add_receipt(st, &input) {
            Ok(resp) => lines.push(format!("{} → {}", cut(file, 60), cut(resp.content.split(". ").next().unwrap_or(&resp.content), 120))),
            Err(e) => lines.push(format!("{} → not added: {e}", cut(file, 60))),
        }
    }
    let head = if lines.is_empty() { "No files recorded this batch.".to_string() } else { lines.join("; ") };
    let pending = match pending_texts(st, &folder, &skip) { Ok(p) => p, Err(e) => return Response::error(e) };
    let finish = |head: &str, pending: usize, skip: Vec<String>, folder: &str| -> Response {
        let rows = st.rows().unwrap_or_default();
        let (content, md) = summary_view(st, &rows, None);
        let tail = if pending == 0 { String::new() } else { format!(" {pending} file(s) left for later; run review_text_receipts again to continue.") };
        Response::ok(format!("{head}{tail} {content}")).view("Receipts — where things stand", md).with_state(review_state_json(folder, &skip))
    };
    if pending.is_empty() || n >= FILE_MAX_FORMS {
        return finish(&head, pending.len(), skip, &folder);
    }
    let batch: Vec<(String, Value)> = pending.iter().take(FILE_BATCH).cloned().collect();
    let params = file_form(n + 1, &batch, &st.rules(), st);
    Response::ok(format!("{head} {} file(s) left.", pending.len()))
        .ui_request(format!("files-{}", n + 1), METHOD_FORM, params)
        .with_state(review_state_json(&folder, &skip))
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
            "receipts ready in {} — ledger has {} rows ({}). Tools: list_receipt_files, add_receipt, set_category_rule, receipts_summary, export_ledger, review_text_receipts (verify pending text receipts in quick forms). Categories: {}.",
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
            "review_text_receipts" => Ok(review_files(&st, input, req)),
            other => Err(format!("unknown tool '{other}'")),
        };
        match r {
            Ok(resp) => resp,
            Err(e) => Response::error(e),
        }
    }
    fn ui_response(&mut self, req: &Request, round: &UiRound) -> Response {
        let st = match Store::open(&req.cwd) { Ok(s) => s, Err(e) => return Response::error(e) };
        files_answer(&st, req, round)
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
