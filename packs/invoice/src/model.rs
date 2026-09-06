//! invoice — Rust core for the "Invoices" pack. Files are the state under
//! `<folder>/.invoices/`: business.json, clients.json, register.csv, and one
//! `<number>.json` + `<number>.html` per invoice (the HTML renders inline in
//! DextUI via `![invoice](.invoices/INV-0001.html)`).
use dextui_pack_sdk::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Business {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub email: String,
    /// Percent, e.g. 20 for 20 %.
    #[serde(default)]
    pub tax_rate: f64,
    #[serde(default = "default_symbol")]
    pub currency: String,
    #[serde(default = "default_terms")]
    pub payment_terms_days: i64,
    #[serde(default = "default_prefix")]
    pub prefix: String,
    #[serde(default = "default_next")]
    pub next_number: u32,
    #[serde(default)]
    pub footer: String,
}
fn default_symbol() -> String { "$".into() }
fn default_terms() -> i64 { 30 }
fn default_prefix() -> String { "INV-".into() }
fn default_next() -> u32 { 1 }

impl Default for Business {
    fn default() -> Self {
        Self {
            name: String::new(),
            address: String::new(),
            email: String::new(),
            tax_rate: 0.0,
            currency: default_symbol(),
            payment_terms_days: default_terms(),
            prefix: default_prefix(),
            next_number: default_next(),
            footer: String::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Client {
    pub name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub address: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Item {
    pub description: String,
    pub qty: f64,
    /// cents
    pub unit_price: i64,
    pub total: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Invoice {
    pub number: String,
    pub client: String,
    pub date: String,
    pub due: String,
    pub items: Vec<Item>,
    pub subtotal: i64,
    pub tax_rate: f64,
    pub tax: i64,
    pub total: i64,
    #[serde(default)]
    pub paid: i64,
    #[serde(default)]
    pub paid_on: String,
    /// draft | sent | paid | partial | void
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default)]
    pub notes: String,
}
fn default_status() -> String { "sent".into() }

pub struct Store {
    pub root: PathBuf,
    pub dir: PathBuf,
}

impl Store {
    pub fn open(cwd: &str) -> Result<Store, String> {
        let root = fs::canonicalize(cwd).map_err(|e| format!("folder: {e}"))?;
        let dir = confined(&root, ".invoices")?;
        ensure_dir(&dir)?;
        Ok(Store { root, dir })
    }
    pub fn business(&self) -> Business {
        read_text(&self.dir.join("business.json"), 64 * 1024).ok().flatten().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }
    pub fn save_business(&self, b: &Business) -> Result<(), String> {
        write_atomic(&self.dir.join("business.json"), &serde_json::to_string_pretty(b).map_err(|e| e.to_string())?)
    }
    pub fn clients(&self) -> Vec<Client> {
        read_text(&self.dir.join("clients.json"), 1024 * 1024).ok().flatten().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }
    pub fn save_clients(&self, c: &[Client]) -> Result<(), String> {
        write_atomic(&self.dir.join("clients.json"), &serde_json::to_string_pretty(c).map_err(|e| e.to_string())?)
    }
    pub fn invoices(&self) -> Vec<Invoice> {
        let mut out = Vec::new();
        if let Ok(rd) = fs::read_dir(&self.dir) {
            let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.ends_with(".json") && n != "business.json" && n != "clients.json").collect();
            names.sort();
            for n in names {
                if let Ok(Some(t)) = read_text(&self.dir.join(&n), 1024 * 1024) {
                    if let Ok(inv) = serde_json::from_str::<Invoice>(&t) {
                        out.push(inv);
                    }
                }
            }
        }
        out
    }
    pub fn save_invoice(&self, inv: &Invoice, b: &Business, client: &Client) -> Result<(), String> {
        write_atomic(&self.dir.join(format!("{}.json", inv.number)), &serde_json::to_string_pretty(inv).map_err(|e| e.to_string())?)?;
        write_atomic(&self.dir.join(format!("{}.html", inv.number)), &render_html(inv, b, client))?;
        self.write_register()
    }
    pub fn write_register(&self) -> Result<(), String> {
        let mut text = String::from("number,client,date,due,total,paid,status\n");
        for i in self.invoices() {
            text.push_str(&csv_row(&[&i.number, &i.client, &i.date, &i.due, &Money(i.total).plain(), &Money(i.paid).plain(), &i.status]));
            text.push('\n');
        }
        write_atomic(&self.dir.join("register.csv"), &text)
    }
}

pub fn render_html(inv: &Invoice, b: &Business, c: &Client) -> String {
    let sym = &b.currency;
    let e = html_escape;
    let mut rows = String::new();
    for it in &inv.items {
        rows.push_str(&format!(
            "<tr><td>{}</td><td class=n>{}</td><td class=n>{}</td><td class=n>{}</td></tr>",
            e(&it.description), fmt_qty(it.qty), Money(it.unit_price).fmt(sym), Money(it.total).fmt(sym)
        ));
    }
    let status_line = match inv.status.as_str() {
        "paid" => format!("<p class=paid>PAID {}</p>", e(&inv.paid_on)),
        "partial" => format!("<p class=due>Paid {} · balance {}</p>", Money(inv.paid).fmt(sym), Money(inv.total - inv.paid).fmt(sym)),
        "void" => "<p class=due>VOID</p>".to_string(),
        _ => format!("<p class=due>Due {}</p>", e(&inv.due)),
    };
    format!(
        "<!doctype html><html><head><meta charset=utf-8><title>{num}</title><style>\
body{{font:14px/1.5 system-ui,sans-serif;color:#111;max-width:720px;margin:32px auto;padding:0 24px}}\
h1{{font-size:28px;margin:0 0 4px}}.muted{{color:#666}}.grid{{display:flex;justify-content:space-between;gap:24px;margin:24px 0}}\
table{{width:100%;border-collapse:collapse;margin:16px 0}}th,td{{padding:8px;border-bottom:1px solid #ddd;text-align:left}}\
th{{font-size:12px;text-transform:uppercase;color:#666}}.n{{text-align:right;font-variant-numeric:tabular-nums}}\
.totals{{margin-left:auto;width:280px}}.totals td{{border:0;padding:4px 8px}}.totals .big{{font-size:18px;font-weight:700;border-top:2px solid #111}}\
.paid{{color:#0a7;font-weight:700}}.due{{color:#b60;font-weight:700}}.foot{{margin-top:32px;font-size:12px;color:#666;white-space:pre-line}}\
@media print{{body{{margin:0}}}}</style></head><body>\
<div class=grid><div><h1>Invoice</h1><div class=muted>{num}</div><div class=muted>Issued {date}</div>{status}</div>\
<div style=\"text-align:right\"><strong>{bname}</strong><div class=muted style=\"white-space:pre-line\">{baddr}</div><div class=muted>{bemail}</div></div></div>\
<div><strong>Bill to</strong><div>{cname}</div><div class=muted style=\"white-space:pre-line\">{caddr}</div><div class=muted>{cemail}</div></div>\
<table><thead><tr><th>Description</th><th class=n>Qty</th><th class=n>Unit</th><th class=n>Amount</th></tr></thead><tbody>{rows}</tbody></table>\
<table class=totals><tr><td>Subtotal</td><td class=n>{sub}</td></tr><tr><td>Tax ({rate}%)</td><td class=n>{tax}</td></tr><tr class=big><td>Total</td><td class=n>{total}</td></tr></table>\
<div class=foot>{notes}{footer}</div></body></html>",
        num = e(&inv.number), date = e(&inv.date), status = status_line,
        bname = e(&b.name), baddr = e(&b.address), bemail = e(&b.email),
        cname = e(&c.name), caddr = e(&c.address), cemail = e(&c.email),
        rows = rows, sub = Money(inv.subtotal).fmt(sym), rate = fmt_qty(inv.tax_rate), tax = Money(inv.tax).fmt(sym), total = Money(inv.total).fmt(sym),
        notes = if inv.notes.is_empty() { String::new() } else { format!("{}\n\n", e(&inv.notes)) }, footer = e(&b.footer)
    )
}

pub fn fmt_qty(q: f64) -> String {
    if (q - q.round()).abs() < 1e-9 { format!("{}", q.round() as i64) } else { format!("{q:.2}") }
}

pub fn s(input: &Value, key: &str) -> String {
    input.get(key).and_then(|v| v.as_str()).map(|x| x.trim().to_string()).unwrap_or_default()
}

pub fn money_in(v: Option<&Value>) -> Option<Money> {
    match v {
        Some(Value::Number(n)) => n.as_f64().map(Money::from_f64),
        Some(Value::String(t)) => Money::parse(t),
        _ => None,
    }
}
