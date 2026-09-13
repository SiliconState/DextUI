//! reconcile — match a bank statement CSV against the ledger (.receipts) and
//! paid invoices (.invoices/register.csv). State in `<folder>/.reconcile/`:
//!   statement.csv   normalised import: id,date,description,amount
//!   matches.json    { "<stmt id>": { "kind": "receipt|invoice|manual", "ref": "...", "note": "..." } }
//! Matching: exact amount, date within ±N days, then description similarity.
//! `review_unexplained` walks the leftovers through DextUI forms (pack UI
//! protocol); each submitted batch is applied atomically, so cancelling
//! mid-review keeps earlier batches and a re-run resumes where it stopped.
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
    // `skipped` entries are deliberate "leave unexplained" decisions from
    // review_unexplained: they stay out of the unexplained set so a review
    // loop terminates, but are never counted as matched.
    let real = matches.values().filter(|m| m.kind != "skipped").count();
    let skipped_ct = matches.len() - real;
    let unmatched: Vec<&Line> = lines.iter().filter(|l| !matches.contains_key(&l.id.to_string())).collect();
    let matched_refs: std::collections::HashSet<&str> = matches.values().filter(|m| m.kind != "skipped").map(|m| m.r#ref.as_str()).collect();
    let missing: Vec<&(String, String, String, i64)> = cands.iter().filter(|c| !matched_refs.contains(c.0.as_str())).collect();
    let (m_in, m_out): (i64, i64) = lines.iter().fold((0, 0), |(i, o), l| if l.amount > 0 { (i + l.amount, o) } else { (i, o + l.amount) });
    let mut md = format!("**{real}** of **{}** statement lines matched{} · in {} · out {}\n\n", lines.len(), if skipped_ct > 0 { format!(" · {skipped_ct} left by you") } else { String::new() }, Money(m_in).fmt(&st.symbol), Money(m_out).fmt(&st.symbol));
    md.push_str(&chart_fence("donut", "Statement lines", &["matched".into(), "unmatched".into()], &[real as f64, (lines.len() - real) as f64], ""));
    md.push_str("\n\n**On the statement but not in your books** (add a receipt or explain):\n\n");
    let rows: Vec<Vec<String>> = unmatched.iter().map(|l| vec![l.id.to_string(), l.date.clone(), l.description.clone(), Money(l.amount).fmt(&st.symbol)]).collect();
    md.push_str(&csv_fence(&["line", "date", "description", "amount"], &rows));
    md.push_str("\n\n**In your books but not on the statement** (not yet cleared, or wrong amount/date):\n\n");
    let rows2: Vec<Vec<String>> = missing.iter().map(|c| vec![c.0.clone(), c.1.clone(), c.2.clone(), Money(c.3).fmt(&st.symbol)]).collect();
    md.push_str(&csv_fence(&["ref", "date", "who", "amount"], &rows2));
    let content = format!("{} of {} lines matched (±{window} days). {} statement lines unexplained ({}), {} book entries not on the statement.{}", real, lines.len(), unmatched.len(), Money(unmatched.iter().map(|l| l.amount).sum::<i64>()).fmt(&st.symbol), missing.len(), if skipped_ct > 0 { format!(" {} line(s) marked leave-unexplained.", skipped_ct) } else { String::new() });
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

/// review_unexplained: walk unexplained statement lines through DextUI forms.
/// Batches of 5; each submitted batch is applied atomically to matches.json, so
/// cancel/crash keeps earlier batches and a re-run resumes from what is left.
/// Dext caps one tool call at 16 UI rounds — stop at 14 and tell the user to
/// re-run rather than trip the limit mid-form.
const REVIEW_BATCH: usize = 5;
const REVIEW_MAX_FORMS: usize = 14;
const NOTE_CHOICE: &str = "__note__";
const SKIP_CHOICE: &str = "__skip__";

fn host_forms(req: &Request) -> bool {
    req.context.as_ref().map(|c| c.ui_methods.iter().any(|m| m == "form" || m == "*")).unwrap_or(false)
}

fn unexplained(lines: &[Line], matches: &BTreeMap<String, Match>) -> Vec<Line> {
    lines.iter().filter(|l| !matches.contains_key(&l.id.to_string())).cloned().collect()
}

/// Ranked candidate book entries for one statement line: exact amount within
/// `window` days, scored like the auto-matcher, excluding already-used refs.
fn ranked_candidates(
    cands: &[(String, String, String, i64)],
    used: &std::collections::HashSet<String>,
    line: &Line,
    window: i64,
) -> Vec<(String, String, String, i64)> {
    let ld = day_number(&line.date).unwrap_or(0);
    let mut scored: Vec<(f64, (String, String, String, i64))> = cands
        .iter()
        .filter(|c| !used.contains(&c.0) && c.3 == line.amount)
        .filter_map(|c| {
            let cd = day_number(&c.1)?;
            if (cd - ld).abs() > window { return None; }
            Some((1.0 + similarity(&line.description, &c.2) - (cd - ld).abs() as f64 * 0.05, c.clone()))
        })
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.into_iter().map(|(_, c)| c).take(3).collect()
}

fn cut(s: &str, n: usize) -> String { s.chars().take(n).collect() }

/// `review-<round>-w<window>` keeps the review stateless across invocations.
fn review_id(round: usize, window: i64) -> String { format!("review-{round}-w{window}") }

fn parse_review_id(id: &str) -> Option<(usize, i64)> {
    let rest = id.strip_prefix("review-")?;
    let (n, w) = rest.split_once("-w")?;
    Some((n.parse().ok()?, w.parse().ok()?))
}

fn review_form(round: usize, batch: &[Line], cands: &[(String, String, String, i64)], used: &std::collections::HashSet<String>, explained: usize, total: usize, window: i64, symbol: &str) -> Value {
    let mut fields = Vec::new();
    // One book entry explains at most one line: once a ref is offered to a
    // line (and preselected as its default), later lines in the SAME batch
    // must not offer or default to it again — otherwise two same-amount lines
    // could both submit it on one Apply. Cross-batch safety comes from the
    // saved matches feeding the next batch's `used` set.
    let mut offered = used.clone();
    for l in batch {
        let ranked = ranked_candidates(cands, &offered, l, window);
        if let Some(top) = ranked.first() { offered.insert(top.0.clone()); }
        let mut options: Vec<Value> = ranked
            .iter()
            .map(|c| json!({ "value": c.0, "label": format!("{} · {} · {} · {}", c.0, c.1, cut(&c.2, 60), Money(c.3).fmt(symbol)) }))
            .collect();
        options.push(json!({ "value": NOTE_CHOICE, "label": "Explain with a note" }));
        options.push(json!({ "value": SKIP_CHOICE, "label": "Leave unexplained" }));
        fields.push(json!({
            "id": format!("l{}", l.id),
            "label": format!("Line {} · {} · {} · {}", l.id, l.date, Money(l.amount).fmt(symbol), cut(&l.description, 70)),
            "type": "select",
            "options": options,
            "default": ranked.first().map(|c| c.0.clone()).unwrap_or_else(|| SKIP_CHOICE.to_string()),
            "description": cut(&l.description, 200),
        }));
        fields.push(json!({
            "id": format!("n{}", l.id),
            "label": format!("Line {} — note", l.id),
            "type": "text",
            "placeholder": "bank fee, transfer, personal…",
            "description": "Only used with 'Explain with a note'",
        }));
    }
    json!({
        "title": "Review unexplained bank lines",
        "description": format!("Batch {round}: {explained} of {total} lines explained so far. Choices apply when you submit; cancelling keeps earlier batches."),
        "submit_label": "Apply",
        "fields": fields,
    })
}

/// The tool entry point: first form, or a fallback list on hosts without forms.
fn review_start(st: &Store, input: &Value, req: &Request) -> Response {
    let window = input.get("window_days").and_then(|v| v.as_i64()).unwrap_or(14).clamp(0, 60);
    let lines = st.lines();
    let matches = st.matches();
    let left = unexplained(&lines, &matches);
    if left.is_empty() {
        return match reconcile(st, 3) {
            Ok((content, md)) => Response::ok(format!("Nothing to review — every line is explained. {content}")).view("Reconciliation", md),
            Err(e) => Response::error(e),
        };
    }
    if !host_forms(req) {
        let listing = left.iter().take(50).map(|l| format!("line {} · {} · {} · {}", l.id, l.date, Money(l.amount).fmt(&st.symbol), l.description)).collect::<Vec<_>>().join("\n");
        let more = if left.len() > 50 { format!("\n… and {} more", left.len() - 50) } else { String::new() };
        return Response::ok(format!("{} statement lines are unexplained and this host cannot render review forms. Explain them with explain_line (line, ref like receipt#12 / invoice:INV-0002, or a note):\n{listing}{more}", left.len()));
    }
    let used: std::collections::HashSet<String> = matches.values().map(|m| m.r#ref.clone()).filter(|r| !r.is_empty()).collect();
    let batch: Vec<Line> = left.iter().take(REVIEW_BATCH).cloned().collect();
    let params = review_form(1, &batch, &st.candidates(), &used, lines.len() - left.len(), lines.len(), window, &st.symbol);
    Response::ok(format!("Reviewing {} unexplained statement lines ({} per form).", left.len(), batch.len()))
        .ui_request(review_id(1, window), METHOD_FORM, params)
}

/// Host answered a review form: apply that batch, then ask the next or finish.
fn review_answer(st: &Store, round: &UiRound) -> Response {
    if round.method != METHOD_FORM {
        return Response::error(format!("unexpected UI response method '{}'", round.method));
    }
    let Some((n, window)) = parse_review_id(&round.request_id) else {
        return Response::error(format!("unexpected UI request id '{}'", round.request_id));
    };
    let lines = st.lines();
    let matches_now = st.matches();
    let left_now = unexplained(&lines, &matches_now);
    let stopped = |why: &str| {
        Response::ok(format!("Review stopped ({why}) — earlier batches stay applied. {} line(s) still unexplained; run review_unexplained to continue.", left_now.len()))
    };
    let UiAnswer::Ok { value } = &round.response else {
        return stopped(match &round.response {
            UiAnswer::Cancelled => "cancelled",
            UiAnswer::Error { code, .. } => code,
            UiAnswer::Ok { .. } => unreachable!(),
        });
    };
    // Apply exactly the fields the form carried (l<id> select, n<id> note).
    let obj = value.as_object().cloned().unwrap_or_default();
    let cands = st.candidates();
    // A book entry explains at most one line: a ref already claimed by an
    // earlier line of this batch is refused even when amount/date would fit,
    // so a crafted submission cannot double-book one receipt/invoice.
    let mut matches = matches_now.clone();
    let mut claimed: std::collections::HashSet<String> = matches.values().map(|m| m.r#ref.clone()).filter(|r| !r.is_empty()).collect();
    let mut applied: Vec<String> = Vec::new();
    for (key, choice) in &obj {
        let Some(line_id) = key.strip_prefix('l') else { continue };
        let Some(line) = lines.iter().find(|l| l.id.to_string() == line_id) else { continue };
        if matches.contains_key(line_id) { continue; }
        let choice = choice.as_str().unwrap_or(SKIP_CHOICE);
        if choice == SKIP_CHOICE {
            matches.insert(line_id.to_string(), Match { kind: "skipped".into(), r#ref: String::new(), note: String::new() });
            applied.push(format!("line {line_id} left unexplained"));
            continue;
        }
        if choice == NOTE_CHOICE {
            let note: String = obj.get(&format!("n{line_id}")).and_then(|v| v.as_str()).unwrap_or("").trim().chars().take(200).collect();
            if note.is_empty() {
                matches.insert(line_id.to_string(), Match { kind: "skipped".into(), r#ref: String::new(), note: String::new() });
                applied.push(format!("line {line_id} left unexplained"));
                continue;
            }
            matches.insert(line_id.to_string(), Match { kind: "manual".into(), r#ref: String::new(), note: note.clone() });
            applied.push(format!("line {line_id} explained ({})", cut(&note, 60)));
        } else if !claimed.contains(choice) && cands.iter().any(|c| c.0 == choice && c.3 == line.amount) {
            claimed.insert(choice.to_string());
            let kind = if choice.starts_with("receipt") { "receipt" } else { "invoice" };
            matches.insert(line_id.to_string(), Match { kind: kind.into(), r#ref: choice.to_string(), note: String::new() });
            applied.push(format!("line {line_id} → {choice}"));
        }
    }
    if !applied.is_empty() {
        if let Err(e) = st.save_matches(&matches) { return Response::error(e); }
    }
    let head = if applied.is_empty() { "No changes in this batch.".to_string() } else { format!("Applied: {}.", applied.join("; ")) };
    let matches = st.matches();
    let left = unexplained(&st.lines(), &matches);
    if left.is_empty() {
        return match reconcile(st, 3) {
            Ok((content, md)) => Response::ok(format!("{head} Review complete. {content}")).view("Reconciliation", md),
            Err(e) => Response::error(e),
        };
    }
    if n >= REVIEW_MAX_FORMS {
        return Response::ok(format!("{head} {} line(s) still unexplained — per-call form limit reached; run review_unexplained again to continue.", left.len()));
    }
    let used: std::collections::HashSet<String> = matches.values().map(|m| m.r#ref.clone()).filter(|r| !r.is_empty()).collect();
    let batch: Vec<Line> = left.iter().take(REVIEW_BATCH).cloned().collect();
    let explained = st.lines().len() - left.len();
    let params = review_form(n + 1, &batch, &st.candidates(), &used, explained, st.lines().len(), window, &st.symbol);
    Response::ok(format!("{head} {} line(s) left.", left.len())).ui_request(review_id(n + 1, window), METHOD_FORM, params)
}

struct Reconcile;
impl Runtime for Reconcile {
    fn activate(&mut self, req: &Request) -> Response {
        let st = match Store::open(&req.cwd) { Ok(s) => s, Err(e) => return Response::error(e) };
        let n = st.lines().len();
        Response::ok(format!("reconcile ready in {} — {n} statement lines on file. Tools: import_statement (bank CSV path), reconcile [window_days], explain_line (line, ref|note), review_unexplained (walk whatever is left through quick forms). Books come from .receipts/ledger.csv and .invoices/register.csv.", st.root.display()))
    }
    fn tool(&mut self, req: &Request, tool: &str, input: &Value) -> Response {
        let st = match Store::open(&req.cwd) { Ok(s) => s, Err(e) => return Response::error(e) };
        let r = match tool {
            "import_statement" => import(&st, input),
            "reconcile" => reconcile(&st, input.get("window_days").and_then(|v| v.as_i64()).unwrap_or(3).clamp(0, 30)).map(|(c, md)| Response::ok(c).view("Reconciliation", md)),
            "explain_line" => mark(&st, input),
            "review_unexplained" => Ok(review_start(&st, input, req)),
            other => Err(format!("unknown tool '{other}'")),
        };
        r.unwrap_or_else(Response::error)
    }
    fn ui_response(&mut self, req: &Request, round: &UiRound) -> Response {
        let st = match Store::open(&req.cwd) { Ok(s) => s, Err(e) => return Response::error(e) };
        review_answer(&st, round)
    }
}

fn main() { let _ = json!(null); run(&mut Reconcile); }
