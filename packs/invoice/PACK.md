---
name: invoice
description: Numbered, printable invoices with tax, due dates and aging — who owes what, how late. Rust runtime owns numbering, money and the printable HTML; the agent collects the details.
ui-title: Invoices
ui-starter-prompt: Set up my invoicing (I'll give you my business details), create an invoice for my last job, and show me who still owes me money
ui-artifact: html
ui-time-to-first-artifact: 40
ui-requires: [approval:auto-write]
ui-gallery: true
ui-tags: [money, clients]
ui-icon: invoice
ui-personas: [business, accountant]
---

# Invoices

The state lives in plain files under the session folder:

- `.invoices/business.json` — your details (name, address, tax rate, terms, numbering)
- `.invoices/clients.json` — clients
- `.invoices/<number>.json` + `.invoices/<number>.html` — one pair per invoice
- `.invoices/register.csv` — the flat register (for spreadsheets)

Use the runtime tools (`invoice-runtime`), not ad-hoc shell writes — the
runtime owns numbering, money math and the printable HTML.

## Workflow

1. First run: ask for the business name, address, email, tax rate (%) and
   usual payment terms (days), then `set_business` — once.
2. `add_client` for each client (name is enough; email/address when known).
3. `create_invoice` with the client and item lines (description, qty,
   unit_price). The runtime assigns the number, computes tax and due date,
   and writes a printable HTML file. **Show it inline** with
   `![invoice](.invoices/INV-0001.html)` (use the actual number) — DextUI
   renders it in the chat — and point the user to the file for printing/PDF.
4. When money arrives: `mark_paid` (full by default; pass `amount` for
   partial payments).
5. "Who owes me?" → `aging`: buckets by age and totals by client, with the
   full list. Offer to draft a polite reminder for anything 30+ days late
   (the followups pack or a plain draft — the user sends it themselves).

Rules of thumb: totals are exact — computed by the runtime, never estimated;
draft invoices (`status: "draft"`) when the user hasn't confirmed details;
never renumber an existing invoice; the currency symbol comes from
`set_business` (default `$`).
