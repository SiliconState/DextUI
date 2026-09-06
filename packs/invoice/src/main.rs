mod model;

use dextui_pack_sdk::*;
use model::*;
use serde_json::Value;
use std::collections::BTreeMap;

struct Invoices;

fn aging_view(st: &Store, as_of: &str) -> (String, String) {
    let b = st.business();
    let sym = &b.currency;
    let today = day_number(as_of).unwrap_or(0);
    let mut buckets: BTreeMap<&str, i64> = BTreeMap::new();
    let mut by_client: BTreeMap<String, i64> = BTreeMap::new();
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut outstanding = 0i64;
    for i in st.invoices() {
        if i.status == "paid" || i.status == "void" {
            continue;
        }
        let bal = i.total - i.paid;
        if bal <= 0 {
            continue;
        }
        let late = today - day_number(&i.due).unwrap_or(today);
        let bucket = if late <= 0 { "current" } else if late <= 30 { "1-30 days" } else if late <= 60 { "31-60 days" } else if late <= 90 { "61-90 days" } else { "90+ days" };
        *buckets.entry(bucket).or_default() += bal;
        *by_client.entry(i.client.clone()).or_default() += bal;
        outstanding += bal;
        rows.push(vec![i.number.clone(), i.client.clone(), i.due.clone(), if late > 0 { format!("{late} days late") } else { "not yet due".into() }, Money(bal).fmt(sym)]);
    }
    let order = ["current", "1-30 days", "31-60 days", "61-90 days", "90+ days"];
    let labels: Vec<String> = order.iter().filter(|k| buckets.contains_key(*k)).map(|k| k.to_string()).collect();
    let values: Vec<f64> = labels.iter().map(|k| Money(buckets[k.as_str()]).as_f64()).collect();
    let mut clients: Vec<(String, i64)> = by_client.into_iter().collect();
    clients.sort_by(|a, b| b.1.cmp(&a.1));
    let mut md = format!("**{}** outstanding across {} invoice{} (as of {as_of})\n\n", Money(outstanding).fmt(sym), rows.len(), if rows.len() == 1 { "" } else { "s" });
    if !labels.is_empty() {
        md.push_str(&chart_fence("bar", "Outstanding by age", &labels, &values, sym));
        md.push_str("\n\n");
        let cl: Vec<String> = clients.iter().map(|c| c.0.clone()).collect();
        let cv: Vec<f64> = clients.iter().map(|c| Money(c.1).as_f64()).collect();
        md.push_str(&chart_fence("hbar", "Who owes what", &cl, &cv, sym));
        md.push_str("\n\n");
    }
    rows.sort_by(|a, b| a[2].cmp(&b[2]));
    md.push_str(&csv_fence(&["invoice", "client", "due", "age", "balance"], &rows));
    // Live panel (TS dashboard, rendered inline by DextUI) — same numbers.
    let panel = serde_json::json!({
        "generated": as_of,
        "symbol": sym,
        "outstanding_cents": outstanding,
        "buckets": labels.iter().map(|k| serde_json::json!({"label": k, "cents": buckets[k.as_str()]})).collect::<Vec<_>>(),
        "by_client": clients.iter().map(|c| serde_json::json!({"label": c.0, "cents": c.1})).collect::<Vec<_>>(),
        "rows": rows.iter().map(|r| serde_json::json!({"number": r[0], "client": r[1], "due": r[2], "age": r[3], "balance_cents": Money::parse(&r[4]).map(|m| m.0).unwrap_or(0)})).collect::<Vec<_>>(),
    });
    if let Some(dir) = pack_dir("DEXT_PACK_INVOICE_DIR") {
        if let Ok(Some(_)) = write_panel(&dir, &st.dir, &panel) {
            md.push_str("\n\n![dashboard](.invoices/panel.html)");
        }
    }
    let content = format!(
        "Outstanding {} in {} invoices. By client: {}.",
        Money(outstanding).fmt(sym),
        rows.len(),
        clients.iter().map(|c| format!("{} {}", c.0, Money(c.1).fmt(sym))).collect::<Vec<_>>().join(", ")
    );
    (content, md)
}

fn invoice_view(st: &Store, inv: &Invoice) -> String {
    let sym = st.business().currency;
    let mut md = format!(
        "**{}** · {} · issued {} · due {} · **{}** ({})\n\n![invoice](.invoices/{}.html)\n\n",
        inv.number, inv.client, inv.date, inv.due, Money(inv.total).fmt(&sym), inv.status, inv.number
    );
    let rows: Vec<Vec<String>> = inv.items.iter().map(|i| vec![i.description.clone(), fmt_qty(i.qty), Money(i.unit_price).fmt(&sym), Money(i.total).fmt(&sym)]).collect();
    md.push_str(&csv_fence(&["description", "qty", "unit", "amount"], &rows));
    md
}

fn set_business(st: &Store, input: &Value) -> Result<Response, String> {
    let mut b = st.business();
    for (k, target) in [("name", &mut b.name), ("address", &mut b.address), ("email", &mut b.email), ("currency", &mut b.currency), ("prefix", &mut b.prefix), ("footer", &mut b.footer)] {
        let v = s(input, k);
        if !v.is_empty() {
            *target = v.chars().take(400).collect();
        }
    }
    if let Some(r) = input.get("tax_rate").and_then(|v| v.as_f64()) {
        if !(0.0..=100.0).contains(&r) {
            return Err("tax_rate must be a percentage between 0 and 100".into());
        }
        b.tax_rate = r;
    }
    if let Some(d) = input.get("payment_terms_days").and_then(|v| v.as_i64()) {
        b.payment_terms_days = d.clamp(0, 365);
    }
    if let Some(n) = input.get("next_number").and_then(|v| v.as_u64()) {
        b.next_number = n.clamp(1, 999_999) as u32;
    }
    if b.name.is_empty() {
        return Err("business name is required".into());
    }
    st.save_business(&b)?;
    Ok(Response::ok(format!(
        "Business saved: {} · tax {}% · terms {} days · currency {} · next number {}{:04}",
        b.name, fmt_qty(b.tax_rate), b.payment_terms_days, b.currency, b.prefix, b.next_number
    )))
}

fn add_client(st: &Store, input: &Value) -> Result<Response, String> {
    let name = s(input, "name");
    if name.is_empty() || name.len() > 120 {
        return Err("client name is required (max 120 chars)".into());
    }
    let mut clients = st.clients();
    let c = Client { name: name.clone(), email: s(input, "email").chars().take(200).collect(), address: s(input, "address").chars().take(400).collect() };
    match clients.iter_mut().find(|x| x.name.eq_ignore_ascii_case(&name)) {
        Some(existing) => {
            if !c.email.is_empty() { existing.email = c.email.clone(); }
            if !c.address.is_empty() { existing.address = c.address.clone(); }
        }
        None => clients.push(c),
    }
    st.save_clients(&clients)?;
    Ok(Response::ok(format!("Client saved: {name}. {} client(s) on file: {}", clients.len(), clients.iter().map(|c| c.name.clone()).collect::<Vec<_>>().join(", "))))
}

fn create_invoice(st: &Store, input: &Value) -> Result<Response, String> {
    let mut b = st.business();
    if b.name.is_empty() {
        return Err("set up the business first (set_business with at least a name)".into());
    }
    let client_name = s(input, "client");
    let client = st.clients().into_iter().find(|c| c.name.eq_ignore_ascii_case(&client_name)).ok_or_else(|| format!("unknown client '{client_name}' — add_client first"))?;
    let items_in = input.get("items").and_then(|v| v.as_array()).ok_or("items must be a list of {description, qty, unit_price}")?;
    if items_in.is_empty() || items_in.len() > 100 {
        return Err("between 1 and 100 items".into());
    }
    let mut items = Vec::new();
    let mut subtotal = 0i64;
    for it in items_in {
        let description: String = s(it, "description").chars().take(200).collect();
        if description.is_empty() {
            return Err("every item needs a description".into());
        }
        let qty = it.get("qty").and_then(|v| v.as_f64()).unwrap_or(1.0);
        if !(qty > 0.0 && qty < 1_000_000.0) {
            return Err(format!("qty for '{description}' must be positive"));
        }
        let unit = money_in(it.get("unit_price")).ok_or_else(|| format!("unit_price for '{description}' is not a number"))?;
        let total = Money::from_f64(unit.as_f64() * qty);
        subtotal += total.0;
        items.push(Item { description, qty, unit_price: unit.0, total: total.0 });
    }
    let tax_rate = input.get("tax_rate").and_then(|v| v.as_f64()).unwrap_or(b.tax_rate);
    let tax = Money::from_f64(Money(subtotal).as_f64() * tax_rate / 100.0).0;
    let date = if s(input, "date").is_empty() { today() } else { parse_date(&s(input, "date")).ok_or("date must be YYYY-MM-DD")? };
    let due_days = input.get("due_days").and_then(|v| v.as_i64()).unwrap_or(b.payment_terms_days);
    let due = add_days(&date, due_days).unwrap_or_else(|| date.clone());
    let number = format!("{}{:04}", b.prefix, b.next_number);
    let inv = Invoice {
        number: number.clone(), client: client.name.clone(), date, due, items, subtotal, tax_rate, tax, total: subtotal + tax,
        paid: 0, paid_on: String::new(), status: if s(input, "status") == "draft" { "draft".into() } else { "sent".into() }, notes: s(input, "notes").chars().take(1000).collect(),
    };
    st.save_invoice(&inv, &b, &client)?;
    b.next_number += 1;
    st.save_business(&b)?;
    Ok(Response::ok(format!(
        "Created {number} for {} — total {} (subtotal {}, tax {}), due {}. File: .invoices/{number}.html",
        inv.client, Money(inv.total).fmt(&b.currency), Money(subtotal).fmt(&b.currency), Money(tax).fmt(&b.currency), inv.due
    ))
    .view(format!("Invoice {number}"), invoice_view(st, &inv)))
}

fn mark_paid(st: &Store, input: &Value) -> Result<Response, String> {
    let number = s(input, "number");
    let b = st.business();
    let mut inv = st.invoices().into_iter().find(|i| i.number.eq_ignore_ascii_case(&number)).ok_or_else(|| format!("no invoice '{number}'"))?;
    let amount = money_in(input.get("amount")).map(|m| m.0).unwrap_or(inv.total - inv.paid);
    if amount <= 0 {
        return Err("amount must be positive".into());
    }
    inv.paid = (inv.paid + amount).min(inv.total);
    inv.paid_on = if s(input, "date").is_empty() { today() } else { parse_date(&s(input, "date")).ok_or("date must be YYYY-MM-DD")? };
    inv.status = if inv.paid >= inv.total { "paid".into() } else { "partial".into() };
    let client = st.clients().into_iter().find(|c| c.name == inv.client).unwrap_or(Client { name: inv.client.clone(), ..Default::default() });
    st.save_invoice(&inv, &b, &client)?;
    let (content, md) = aging_view(st, &today());
    Ok(Response::ok(format!("{} is now {} ({} of {} received). {content}", inv.number, inv.status, Money(inv.paid).fmt(&b.currency), Money(inv.total).fmt(&b.currency))).view("Invoices — who still owes", md))
}

fn list_invoices(st: &Store, input: &Value) -> Result<Response, String> {
    let status = s(input, "status");
    let b = st.business();
    let all = st.invoices();
    let rows: Vec<Vec<String>> = all.iter().filter(|i| status.is_empty() || i.status == status).map(|i| vec![i.number.clone(), i.client.clone(), i.date.clone(), i.due.clone(), Money(i.total).fmt(&b.currency), Money(i.paid).fmt(&b.currency), i.status.clone()]).collect();
    let md = csv_fence(&["invoice", "client", "date", "due", "total", "paid", "status"], &rows);
    Ok(Response::ok(format!("{} invoice(s){}.", rows.len(), if status.is_empty() { String::new() } else { format!(" with status {status}") })).view("Invoices", md))
}

impl Runtime for Invoices {
    fn activate(&mut self, req: &Request) -> Response {
        let st = match Store::open(&req.cwd) {
            Ok(s) => s,
            Err(e) => return Response::error(e),
        };
        let b = st.business();
        let n = st.invoices().len();
        let (content, md) = aging_view(&st, &today());
        let setup = if b.name.is_empty() { "No business details yet — ask for the business name, address, tax rate and payment terms, then call set_business. " } else { "" };
        Response::ok(format!(
            "invoices ready in {} — {n} invoice(s) on file, {} client(s). {setup}{content} Tools: set_business, add_client, create_invoice, mark_paid, aging, list_invoices.",
            st.root.display(), st.clients().len()
        ))
        .view("Invoices — who still owes", md)
    }

    fn tool(&mut self, req: &Request, tool: &str, input: &Value) -> Response {
        let st = match Store::open(&req.cwd) {
            Ok(s) => s,
            Err(e) => return Response::error(e),
        };
        let r = match tool {
            "set_business" => set_business(&st, input),
            "add_client" => add_client(&st, input),
            "create_invoice" => create_invoice(&st, input),
            "mark_paid" => mark_paid(&st, input),
            "aging" => {
                let as_of = if s(input, "as_of").is_empty() { today() } else { parse_date(&s(input, "as_of")).unwrap_or_else(today) };
                let (content, md) = aging_view(&st, &as_of);
                Ok(Response::ok(content).view("Invoices — who still owes", md))
            }
            "list_invoices" => list_invoices(&st, input),
            other => Err(format!("unknown tool '{other}'")),
        };
        match r {
            Ok(resp) => resp,
            Err(e) => Response::error(e),
        }
    }
}

fn main() {
    run(&mut Invoices);
}
