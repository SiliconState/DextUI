---
name: cashflow
description: A 13-week cash projection from your ledger, unpaid invoices and recurring bills — the chart is draggable so you can try what-ifs. Rust runtime does the arithmetic; nothing is estimated from thin air.
ui-title: Cash-flow forecast
ui-starter-prompt: Project my cash for the next 13 weeks from the ledger, unpaid invoices and my recurring bills; show it as a chart I can drag
ui-artifact: chart
ui-time-to-first-artifact: 30
ui-requires: [approval:auto-write]
ui-gallery: true
ui-tags: [money, planning]
ui-icon: cashflow
ui-personas: [business, accountant]
---

# Cash-flow forecast

State: `.cashflow/config.json` (balance, date, currency) and `.cashflow/recurring.json`.
Inputs it reads: `.receipts/ledger.csv` (typical weekly spend, last 8 weeks) and
`.invoices/register.csv` (unpaid invoices land on their due date; overdue ones in week 1).

## Workflow

1. First run: ask for today's bank balance → `set_balance`.
2. Ask about recurring items the ledger cannot see yet (rent, payroll, subscriptions,
   retainers) → `add_recurring` (negative = bill, positive = income, `every_days`).
3. `forecast` — read the lowest point aloud; if the balance goes negative, say when
   and by how much, and suggest the two or three levers (chase an invoice, move a
   bill, cut a category) with the numbers.
4. Re-run after changes; the chart is interactive — the user can drag points to
   explore, the runtime keeps the truth.

Numbers come from the runtime only; never round or guess an amount yourself.
