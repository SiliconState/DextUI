---
name: reconcile
description: Match a bank statement to your books, receipts and paid invoices, and list exactly what does not line up on either side. Rust runtime does the matching; the agent explains the leftovers with you.
ui-title: Bank reconciliation
ui-starter-prompt: Import my bank statement CSV from this folder and show me what does not match my receipts and invoices
ui-artifact: table
ui-time-to-first-artifact: 40
ui-requires: [approval:auto-write]
ui-gallery: true
ui-tags: [money, month-end]
ui-icon: reconcile
ui-personas: [accountant, business]
---

# Bank reconciliation

State: `.reconcile/statement.csv` (normalised import) and `.reconcile/matches.json`.
Books: `.receipts/ledger.csv` (money out) and `.invoices/register.csv` (money in, paid column).

## Workflow

1. Ask which CSV is the bank statement (a file in this folder), then `import_statement`.
   Columns are detected by name (date / description / amount or debit+credit); if
   detection fails, read the header yourself and tell the user what is missing.
2. `reconcile` matches by exact amount within ±3 days, then description similarity.
   Widen `window_days` only when the user says the bank posts late.
3. Walk the two leftover lists with the user: for each unexplained statement line,
   either record the missing receipt (receipts pack) or `explain_line` with a note
   (bank fee, transfer, personal); for book entries not on the statement, say
   "not cleared yet" and move on unless the amount looks wrong.
4. Finish with the reconcile card; call out anything still open.

Never invent a match. Same amount + wrong date is a question for the user, not a guess.
