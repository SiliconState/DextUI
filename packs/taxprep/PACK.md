---
name: taxprep
description: Quarterly tax estimate and an accountant-ready package from your books, revenue received, deductible expenses by category, taxable amount, checklist. Arithmetic from your own rules, not tax advice.
ui-title: Tax prep
ui-starter-prompt: Estimate this quarter's tax from my books and build the package my accountant needs
ui-artifact: html
ui-time-to-first-artifact: 60
ui-requires: [approval:auto-write]
ui-gallery: true
ui-tags: [money, tax]
ui-icon: tax
ui-personas: [accountant, business]
---

# Tax prep

State: `.taxprep/config.json` (the user's rules) and `.taxprep/package-<quarter>/`.
Inputs: `.receipts/ledger.csv` (expenses) and `.invoices/register.csv` (payments received).

## Workflow

1. First run: ask for jurisdiction (a label), the flat rate (%) to apply, the fiscal
   year start month, and which categories are not deductible → `set_tax_config`.
   **Never guess a rate or a rule.** If the user does not know, say so and leave the
   rate at 0, the package is still useful to the accountant.
2. `estimate` for the quarter; read the taxable amount and the checklist. If any
   expenses are Uncategorised, fix those first (receipts pack), they cannot be
   classified.
3. `build_package` writes `expenses.csv`, `invoices.csv`, `summary.md`, `summary.json`
   into `.taxprep/package-<quarter>/`. Point the user at the folder.

Every view says it is arithmetic, not advice; keep that framing in your replies too.
Simplification to state plainly: revenue counts invoices with payments whose invoice
date falls in the quarter (cash-basis by invoice date).
