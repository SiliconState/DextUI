//! cashflow — 13-week projection from what the other packs already know:
//! outflows from .receipts/ledger.csv (average weekly spend per category over
//! the last 8 weeks) plus recurring bills, inflows from unpaid invoices in
//! .invoices/register.csv (expected on their due date) plus recurring income.
//! State in `<folder>/.cashflow/`: config.json { balance, balance_date }, recurring.json [ {name, amount, every_days, next} ].
use dextui_pack_sdk::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct Config { #[serde(default)] balance: i64, #[serde(default)] balance_date: String, #[serde(default = "sym")] symbol: String }
fn sym() -> String { "$".into() }

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Recurring { name: String, amount: i64, every_days: i64, next: String }

struct Store { root: PathBuf, dir: PathBuf }
impl Store {
    fn open(cwd: &str) -> Result<Store, String> {
        let root = fs::canonicalize(cwd).map_err(|e| format!("folder: {e}"))?;
        let dir = confined(&root, ".cashflow")?;
        ensure_dir(&dir)?;
        Ok(Store { root, dir })
    }
    fn config(&self) -> Config { read_text(&self.dir.join("config.json"), 64 << 10).ok().flatten().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Config { symbol: sym(), ..Default::default() }) }
    fn save_config(&self, c: &Config) -> Result<(), String> { write_atomic(&self.dir.join("config.json"), &serde_json::to_string_pretty(c).map_err(|e| e.to_string())?) }
    fn recurring(&self) -> Vec<Recurring> { read_text(&self.dir.join("recurring.json"), 1 << 20).ok().flatten().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default() }
    fn save_recurring(&self, r: &[Recurring]) -> Result<(), String> { write_atomic(&self.dir.join("recurring.json"), &serde_json::to_string_pretty(r).map_err(|e| e.to_string())?) }
    /// (date, category, cents) from the ledger.
    fn ledger(&self) -> Vec<(String, String, i64)> {
        read_text(&self.root.join(".receipts").join("ledger.csv"), 8 << 20).ok().flatten().map(|t| csv_parse(&t).into_iter().skip(1).filter(|r| r.len() >= 5).filter_map(|r| Money::parse(&r[3]).map(|m| (r[1].clone(), r[4].clone(), m.0))).collect()).unwrap_or_default()
    }
    /// (due, client, outstanding cents) from unpaid invoices.
    fn receivables(&self) -> Vec<(String, String, i64)> {
        read_text(&self.root.join(".invoices").join("register.csv"), 8 << 20).ok().flatten().map(|t| csv_parse(&t).into_iter().skip(1).filter(|r| r.len() >= 7 && r[6] != "paid" && r[6] != "void" && r[6] != "draft").filter_map(|r| {
            let bal = Money::parse(&r[4])?.0 - Money::parse(&r[5])?.0;
            if bal > 0 { Some((r[3].clone(), r[1].clone(), bal)) } else { None }
        }).collect()).unwrap_or_default()
    }
}

fn s(input: &Value, key: &str) -> String { input.get(key).and_then(|v| v.as_str()).map(|x| x.trim().to_string()).unwrap_or_default() }
fn money_in(v: Option<&Value>) -> Option<Money> { match v { Some(Value::Number(n)) => n.as_f64().map(Money::from_f64), Some(Value::String(t)) => Money::parse(t), _ => None } }

fn forecast(st: &Store, weeks: usize) -> (String, String) {
    let cfg = st.config();
    let sym = &cfg.symbol;
    let start = if cfg.balance_date.is_empty() { today() } else { cfg.balance_date.clone() };
    let d0 = day_number(&start).unwrap_or(0);
    // Average weekly outflow per category over the last 8 weeks of ledger history.
    let ledger = st.ledger();
    let mut by_cat: BTreeMap<String, i64> = BTreeMap::new();
    for (date, cat, cents) in &ledger {
        if let Some(d) = day_number(date) { if d0 - d <= 56 && d <= d0 { *by_cat.entry(if cat.is_empty() { "Other".into() } else { cat.clone() }).or_default() += cents; } }
    }
    let weekly_burn: i64 = by_cat.values().sum::<i64>() / 8;
    let mut weeks_out: Vec<(String, i64, i64, i64)> = Vec::new(); // (label, in, out, balance)
    let mut bal = cfg.balance;
    let recurring = st.recurring();
    let receivables = st.receivables();
    let mut lowest = (bal, start.clone());
    for w in 0..weeks {
        let (a, b) = (d0 + (w as i64) * 7, d0 + (w as i64 + 1) * 7);
        let mut inflow = 0i64;
        let mut outflow = weekly_burn;
        for (due, _, cents) in &receivables {
            let dd = day_number(due).unwrap_or(i64::MAX);
            // Overdue receivables are assumed to land in week 0; not sooner than due.
            let land = dd.max(d0);
            if land >= a && land < b { inflow += cents; }
        }
        for r in &recurring {
            let mut n = day_number(&r.next).unwrap_or(i64::MAX);
            if r.every_days <= 0 { continue; }
            while n < a { n += r.every_days; }
            while n >= a && n < b { if r.amount >= 0 { inflow += r.amount } else { outflow += -r.amount }; n += r.every_days; }
        }
        bal += inflow - outflow;
        let label = from_day_number(a);
        if bal < lowest.0 { lowest = (bal, label.clone()); }
        weeks_out.push((label, inflow, outflow, bal));
    }
    let labels: Vec<String> = weeks_out.iter().map(|w| w.0[5..].to_string()).collect();
    let bals: Vec<f64> = weeks_out.iter().map(|w| Money(w.3).as_f64()).collect();
    let mut md = format!("Opening **{}** on {start} · typical weekly spend **{}** · lowest point **{}** (week of {})\n\n", Money(cfg.balance).fmt(sym), Money(weekly_burn).fmt(sym), Money(lowest.0).fmt(sym), lowest.1);
    md.push_str(&chart_fence("line", &format!("Projected balance, {weeks} weeks (drag to explore what-ifs)"), &labels, &bals, sym));
    md.push_str("\n\n");
    let rows: Vec<Vec<String>> = weeks_out.iter().map(|w| vec![w.0.clone(), Money(w.1).fmt(sym), Money(w.2).fmt(sym), Money(w.3).fmt(sym)]).collect();
    md.push_str(&csv_fence(&["week of", "in", "out", "balance"], &rows));
    if !by_cat.is_empty() {
        let cl: Vec<String> = by_cat.keys().cloned().collect();
        let cv: Vec<f64> = by_cat.values().map(|v| Money(v / 8).as_f64()).collect();
        md.push_str("\n\n");
        md.push_str(&chart_fence("hbar", "Typical weekly spend by category (last 8 weeks)", &cl, &cv, sym));
    }
    let warn = if lowest.0 < 0 { format!(" WARNING: balance goes negative around {}.", lowest.1) } else { String::new() };
    let content = format!("{weeks}-week forecast from {start}: opening {}, weekly burn {}, {} receivables ({}) and {} recurring items; lowest {} on {}.{warn}", Money(cfg.balance).fmt(sym), Money(weekly_burn).fmt(sym), receivables.len(), Money(receivables.iter().map(|r| r.2).sum::<i64>()).fmt(sym), recurring.len(), Money(lowest.0).fmt(sym), lowest.1);
    (content, md)
}

struct Cashflow;
impl Runtime for Cashflow {
    fn activate(&mut self, req: &Request) -> Response {
        let st = match Store::open(&req.cwd) { Ok(s) => s, Err(e) => return Response::error(e) };
        let cfg = st.config();
        let (content, md) = forecast(&st, 13);
        let setup = if cfg.balance_date.is_empty() { "Ask for today's bank balance and call set_balance first. " } else { "" };
        Response::ok(format!("cashflow ready in {}. {setup}{content} Tools: set_balance, add_recurring, remove_recurring, forecast.", st.root.display())).view("Cash flow — 13 weeks", md)
    }
    fn tool(&mut self, req: &Request, tool: &str, input: &Value) -> Response {
        let st = match Store::open(&req.cwd) { Ok(s) => s, Err(e) => return Response::error(e) };
        let r: Result<Response, String> = match tool {
            "set_balance" => (|| {
                let mut c = st.config();
                c.balance = money_in(input.get("balance")).ok_or("balance is required")?.0;
                c.balance_date = if s(input, "date").is_empty() { today() } else { parse_date(&s(input, "date")).ok_or("date must be YYYY-MM-DD")? };
                if !s(input, "currency").is_empty() { c.symbol = s(input, "currency").chars().take(4).collect(); }
                st.save_config(&c)?;
                let (content, md) = forecast(&st, 13);
                Ok(Response::ok(format!("Balance set: {} on {}. {content}", Money(c.balance).fmt(&c.symbol), c.balance_date)).view("Cash flow — 13 weeks", md))
            })(),
            "add_recurring" => (|| {
                let name = s(input, "name");
                if name.is_empty() || name.len() > 80 { return Err("name is required".into()); }
                let amount = money_in(input.get("amount")).ok_or("amount is required (negative = bill, positive = income)")?.0;
                let every = input.get("every_days").and_then(|v| v.as_i64()).unwrap_or(30);
                if !(1..=366).contains(&every) { return Err("every_days must be 1..366".into()); }
                let next = if s(input, "next").is_empty() { today() } else { parse_date(&s(input, "next")).ok_or("next must be YYYY-MM-DD")? };
                let mut list = st.recurring();
                list.retain(|r| !r.name.eq_ignore_ascii_case(&name));
                list.push(Recurring { name: name.clone(), amount, every_days: every, next });
                st.save_recurring(&list)?;
                let (content, md) = forecast(&st, 13);
                Ok(Response::ok(format!("Recurring '{name}' saved ({} every {every} days). {content}", Money(amount).fmt(&st.config().symbol))).view("Cash flow — 13 weeks", md))
            })(),
            "remove_recurring" => (|| {
                let name = s(input, "name");
                let mut list = st.recurring();
                let before = list.len();
                list.retain(|r| !r.name.eq_ignore_ascii_case(&name));
                if list.len() == before { return Err(format!("no recurring item '{name}'")); }
                st.save_recurring(&list)?;
                Ok(Response::ok(format!("Removed '{name}'. {} recurring item(s) left.", list.len())))
            })(),
            "forecast" => {
                let weeks = input.get("weeks").and_then(|v| v.as_u64()).unwrap_or(13).clamp(4, 52) as usize;
                let (content, md) = forecast(&st, weeks);
                Ok(Response::ok(content).view(format!("Cash flow — {weeks} weeks"), md))
            }
            other => Err(format!("unknown tool '{other}'")),
        };
        r.unwrap_or_else(Response::error)
    }
}

fn main() { run(&mut Cashflow); }
