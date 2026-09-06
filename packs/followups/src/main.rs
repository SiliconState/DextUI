//! followups — who owes you a reply, a payment or a document. State in
//! `<folder>/.followups/items.csv`: id,who,what,due,status,source,note.
//! Overdue invoices from .invoices/register.csv are surfaced automatically as
//! payment follow-ups (source=invoice:<n>) so nothing slips. Drafts are text
//! the user sends themselves — the pack never contacts anyone.
use dextui_pack_sdk::*;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Debug)]
struct Item { id: u64, who: String, what: String, due: String, status: String, source: String, note: String }

struct Store { root: PathBuf, dir: PathBuf, symbol: String }
impl Store {
    fn open(cwd: &str) -> Result<Store, String> {
        let root = fs::canonicalize(cwd).map_err(|e| format!("folder: {e}"))?;
        let dir = confined(&root, ".followups")?;
        ensure_dir(&dir)?;
        Ok(Store { root, dir, symbol: std::env::var("RECEIPTS_CURRENCY").unwrap_or_else(|_| "$".into()) })
    }
    fn items(&self) -> Vec<Item> {
        let text = read_text(&self.dir.join("items.csv"), 8 << 20).ok().flatten().unwrap_or_default();
        csv_parse(&text).into_iter().skip(1).filter(|r| r.len() >= 5).map(|r| Item { id: r[0].parse().unwrap_or(0), who: r[1].clone(), what: r[2].clone(), due: r[3].clone(), status: r[4].clone(), source: r.get(5).cloned().unwrap_or_default(), note: r.get(6).cloned().unwrap_or_default() }).collect()
    }
    fn save(&self, items: &[Item]) -> Result<(), String> {
        let mut t = String::from("id,who,what,due,status,source,note\n");
        for i in items { t.push_str(&csv_row(&[&i.id.to_string(), &i.who, &i.what, &i.due, &i.status, &i.source, &i.note])); t.push('\n'); }
        write_atomic(&self.dir.join("items.csv"), &t)
    }
    /// Overdue unpaid invoices become payment follow-ups if not already tracked.
    fn sync_invoices(&self) -> Result<usize, String> {
        let mut items = self.items();
        let mut added = 0;
        if let Ok(Some(t)) = read_text(&self.root.join(".invoices").join("register.csv"), 8 << 20) {
            let now = day_number(&today()).unwrap_or(0);
            for r in csv_parse(&t).into_iter().skip(1).filter(|r| r.len() >= 7) {
                let (num, client, due, status) = (&r[0], &r[1], &r[3], &r[6]);
                if status == "paid" || status == "void" || status == "draft" { continue; }
                let bal = Money::parse(&r[4]).map(|m| m.0).unwrap_or(0) - Money::parse(&r[5]).map(|m| m.0).unwrap_or(0);
                if bal <= 0 || day_number(due).map(|d| d >= now).unwrap_or(true) { continue; }
                let source = format!("invoice:{num}");
                if items.iter().any(|i| i.source == source && i.status != "done") { continue; }
                let id = items.iter().map(|i| i.id).max().unwrap_or(0) + 1;
                items.push(Item { id, who: client.clone(), what: format!("payment of {} for {num}", Money(bal).fmt(&self.symbol)), due: due.clone(), status: "open".into(), source, note: String::new() });
                added += 1;
            }
        }
        if added > 0 { self.save(&items)?; }
        Ok(added)
    }
}

fn s(input: &Value, key: &str) -> String { input.get(key).and_then(|v| v.as_str()).map(|x| x.trim().to_string()).unwrap_or_default() }

fn list_view(st: &Store) -> (String, String) {
    let mut items: Vec<Item> = st.items().into_iter().filter(|i| i.status != "done").collect();
    let now = day_number(&today()).unwrap_or(0);
    let age = |i: &Item| now - day_number(&i.due).unwrap_or(now);
    items.sort_by_key(|i| -age(i));
    let overdue = items.iter().filter(|i| age(i) > 0).count();
    let rows: Vec<Vec<String>> = items.iter().map(|i| vec![i.id.to_string(), i.who.clone(), i.what.clone(), i.due.clone(), match age(i) { a if a > 0 => format!("{a} days late"), 0 => "today".into(), a => format!("in {} days", -a) }, i.note.clone()]).collect();
    let mut md = format!("**{}** open · **{overdue}** overdue\n\n", items.len());
    md.push_str(&csv_fence(&["id", "who", "what", "due", "when", "note"], &rows));
    let content = format!("{} open follow-ups, {overdue} overdue: {}", items.len(), items.iter().filter(|i| age(i) > 0).take(5).map(|i| format!("{} — {} ({} days)", i.who, i.what, age(i))).collect::<Vec<_>>().join("; "));
    (content, md)
}

fn drafts(st: &Store, input: &Value) -> Result<Response, String> {
    let tone = match s(input, "tone").as_str() { "firm" => "firm", "friendly" => "friendly", _ => "polite" };
    let sign = s(input, "sign_as");
    let now = day_number(&today()).unwrap_or(0);
    let items: Vec<Item> = st.items().into_iter().filter(|i| i.status != "done" && day_number(&i.due).map(|d| d < now).unwrap_or(false)).collect();
    if items.is_empty() { return Ok(Response::ok("Nothing overdue — no reminders needed.")); }
    let mut md = format!("_{} reminder draft(s), {tone}. Copy, adjust, send — nothing is sent for you._\n\n", items.len());
    for i in &items {
        let late = now - day_number(&i.due).unwrap_or(now);
        let opener = match tone { "firm" => format!("This is a reminder that {} was due on {} and is now {late} days overdue.", i.what, i.due), "friendly" => format!("Just a quick nudge — {} was due {} and I haven't seen it yet.", i.what, i.due), _ => format!("I'm following up on {}, which was due on {} ({late} days ago).", i.what, i.due) };
        let ask = if i.source.starts_with("invoice:") { "Could you let me know when the payment will be made? If it has already been sent, please ignore this note." } else { "Could you send it over when you get a chance, or let me know if anything is holding it up?" };
        md.push_str(&format!("### {} · #{}\n\n```text\nHi {},\n\n{opener} {ask}\n\nThanks,\n{}\n```\n\n", i.who, i.id, i.who.split_whitespace().next().unwrap_or(&i.who), if sign.is_empty() { "—" } else { &sign }));
    }
    Ok(Response::ok(format!("{} reminder draft(s) ready ({tone}); mark each sent with mark_followup status=sent.", items.len())).view("Reminder drafts", md))
}

struct Followups;
impl Runtime for Followups {
    fn activate(&mut self, req: &Request) -> Response {
        let st = match Store::open(&req.cwd) { Ok(s) => s, Err(e) => return Response::error(e) };
        let added = st.sync_invoices().unwrap_or(0);
        let (content, md) = list_view(&st);
        Response::ok(format!("followups ready in {}{}. {content} Tools: add_followup, list_followups, mark_followup (open|sent|done), draft_reminders (tone, sign_as).", st.root.display(), if added > 0 { format!(" — {added} overdue invoice(s) added") } else { String::new() })).view("Follow-ups", md)
    }
    fn tool(&mut self, req: &Request, tool: &str, input: &Value) -> Response {
        let st = match Store::open(&req.cwd) { Ok(s) => s, Err(e) => return Response::error(e) };
        let r: Result<Response, String> = match tool {
            "add_followup" => (|| {
                let (who, what) = (s(input, "who"), s(input, "what"));
                if who.is_empty() || what.is_empty() { return Err("who and what are required".into()); }
                let due = if s(input, "due").is_empty() { add_days(&today(), 7).unwrap_or_else(today) } else { parse_date(&s(input, "due")).ok_or("due must be a date (YYYY-MM-DD)")? };
                let mut items = st.items();
                let id = items.iter().map(|i| i.id).max().unwrap_or(0) + 1;
                items.push(Item { id, who: who.chars().take(80).collect(), what: what.chars().take(200).collect(), due: due.clone(), status: "open".into(), source: s(input, "source").chars().take(120).collect(), note: s(input, "note").chars().take(200).collect() });
                st.save(&items)?;
                let (content, md) = list_view(&st);
                Ok(Response::ok(format!("Added #{id}: {who} — {what}, due {due}. {content}")).view("Follow-ups", md))
            })(),
            "list_followups" => { let _ = st.sync_invoices(); let (c, md) = list_view(&st); Ok(Response::ok(c).view("Follow-ups", md)) }
            "mark_followup" => (|| {
                let id: u64 = s(input, "id").parse().map_err(|_| "id is required".to_string())?;
                let status = s(input, "status");
                if !["open", "sent", "done"].contains(&status.as_str()) { return Err("status must be open, sent or done".into()); }
                let mut items = st.items();
                let it = items.iter_mut().find(|i| i.id == id).ok_or_else(|| format!("no follow-up #{id}"))?;
                it.status = status.clone();
                if !s(input, "note").is_empty() { it.note = s(input, "note").chars().take(200).collect(); }
                if status == "sent" && it.note.is_empty() { it.note = format!("reminder sent {}", today()); }
                st.save(&items)?;
                let (content, md) = list_view(&st);
                Ok(Response::ok(format!("#{id} → {status}. {content}")).view("Follow-ups", md))
            })(),
            "draft_reminders" => { let _ = st.sync_invoices(); drafts(&st, input) }
            other => Err(format!("unknown tool '{other}'")),
        };
        r.unwrap_or_else(Response::error)
    }
}

fn main() { run(&mut Followups); }
