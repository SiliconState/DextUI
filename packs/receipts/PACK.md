---
name: receipts
description: Turn a folder of receipts into a sorted expense ledger with monthly totals and spending charts. Rust runtime keeps the ledger, categories and duplicates straight; the agent reads each receipt file and records it.
ui-title: Receipts & expenses
ui-starter-prompt: Scan this folder for receipts, record each one with the right category, then show me this month's spending as a chart
ui-artifact: chart
ui-time-to-first-artifact: 30
ui-requires: [approval:auto-write]
ui-gallery: true
ui-tags: [money, bookkeeping]
ui-icon: receipt
ui-personas: [accountant, business]
---

# Receipts & expenses

The state lives in plain files under the session folder, never anywhere else:

- `.receipts/ledger.csv`: one row per receipt: `id,date,vendor,amount,category,note,source`
- `.receipts/rules.json`: vendor → category rules the user teaches
- `.receipts/exports/`: CSV exports for the accountant

Use the runtime tools (`receipts-runtime`), not ad-hoc shell writes, the
runtime owns the ledger format, category rules and duplicate detection.

## Workflow

1. `list_receipt_files`: see what receipt files exist and which are already
   recorded (`recorded: true`).
2. For each pending file, **read it yourself** (images and PDFs are yours to
   read; text files come with a `guess` you must verify, never trust blind).
3. `add_receipt` with the date, vendor, amount and `source` = the file path.
   Pick a sensible category (Meals, Travel, Office, Software, Utilities,
   Rent, Supplies, Marketing, Fees, Other), the runtime learns the rule when
   the user corrects it.
4. When the user teaches "X is always Y", call `set_category_rule` so future
   receipts land right automatically.
5. Show results with `receipts_summary` (charts + ledger table); scope to a
   month with `month: "YYYY-MM"`.
6. `export_ledger` when the user wants a file to hand over (accountant,
   spreadsheet).

Rules of thumb: amounts are exact, never invent or round one; if a receipt
is unreadable, say so and move on; duplicates are refused unless the user
confirms it is a second purchase (`force: true`); the currency symbol comes
from `RECEIPTS_CURRENCY` (default `$`).
