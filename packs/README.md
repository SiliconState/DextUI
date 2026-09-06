# DextUI consumer packs

Rust cores + dext PACK.md manifests, "TS panel, Rust core" per pack. State
always lives in plain files inside the user's session folder (`.receipts/`,
`.invoices/`) — never in the pack and never outside the folder.

- `sdk-rs/` — shared library: Pack Runtime Protocol v1 framing (one JSON
  request on stdin, one JSON response on stdout, `view` effects → runtime_view
  cards), money as integer cents, RFC-4180 CSV, dates, confined paths, and the
  ```chart / ```csv fences DextUI renders interactively.
- `receipts/` — ledger + categories + duplicates → charts and CSV exports.
- `invoice/` — numbered printable invoices, payments, aging.
- `build.sh` — `cargo build --release` and install both onto the `business`
  shelf (`~/.dext/shelves/business`) with a `shelf.json` manifest. `--offline`
  when the crates cache is warm; `--shelf-root=` to install elsewhere.

The packs run under dext's Pack Runtime (`runtime.json`); every tool returns
a view card so DextUI shows charts/tables and the agent narrates them.
