# DextUI consumer packs

Rust cores + dext PACK.md manifests, "TS panel, Rust core" per pack. State
always lives in plain files inside the user's session folder (`.receipts/`,
`.invoices/`) — never in the pack and never outside the folder.

- `sdk-rs/` — shared library: Pack Runtime Protocol v1 framing (one JSON
  request on stdin, one JSON response on stdout, `view` effects → runtime_view
  cards), money as integer cents, RFC-4180 CSV, dates, confined paths, and the
  ```chart / ```csv fences DextUI renders interactively.
- `receipts/` — ledger + categories + duplicates → charts and CSV exports (+ TS panel).
- `invoice/` — numbered printable invoices, payments, aging (+ TS panel).
- `reconcile/` — bank statement CSV (any column layout) matched to receipts and
  paid invoices by amount + date window + description; explain the leftovers.
- `cashflow/` — 13-week projection: ledger burn (last 8 weeks), unpaid invoices on
  their due dates, recurring bills/income; draggable line chart, negative warning.
- `taxprep/` — quarterly estimate from the user's own rules (rate, non-deductible
  and partial categories, fiscal year start) + accountant package folder. Arithmetic, not advice.
- `followups/` — who owes a reply/document/payment; overdue invoices auto-tracked;
  reminder drafts (polite/friendly/firm) the user sends themselves.

All six share one folder: `.receipts/`, `.invoices/`, `.reconcile/`, `.cashflow/`,
`.taxprep/`, `.followups/`. The month-end-close flow (`flows/month-end-close.flow.json`)
chains them. Tests: `scripts/packs-runtime.test.mjs` (receipts, invoice, panels) and
`scripts/month-end.test.mjs` (the four seeded through the real receipts/invoice runtimes).
- `build.sh` — `cargo build --release`, typecheck + bundle the TS panels, and install all six onto the `business`
  shelf (`~/.dext/shelves/business`) with a `shelf.json` manifest. `--offline`
  when the crates cache is warm; `--shelf-root=` to install elsewhere.

The packs run under dext's Pack Runtime (`runtime.json`); every tool returns
a view card so DextUI shows charts/tables and the agent narrates them.
