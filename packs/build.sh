#!/usr/bin/env bash
# Build the consumer packs and install them onto the `business` shelf so dext
# discovers them as installed packs:
#   business/packs/receipts/{PACK.md,runtime.json,bin/receipts-runtime}
#   business/packs/invoice/{PACK.md,runtime.json,bin/invoice-runtime}
# Usage: packs/build.sh [--shelf-root=~/.dext/shelves] [--offline]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SHELF_ROOT="${DEXT_SHELVES:-$HOME/.dext/shelves}"
CARGO_ARGS=(--release)
for arg in "$@"; do
  case "$arg" in
    --shelf-root=*) SHELF_ROOT="${arg#*=}" ;;
    --offline) CARGO_ARGS+=(--offline) ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

(cd "$ROOT" && cargo build "${CARGO_ARGS[@]}" -p receipts -p invoice)

# TS panels: typecheck, then bundle each ui/panel.ts into ui/panel.html
# (self-contained, data placeholder baked per run by the runtime).
REPO="$(cd "$ROOT/.." && pwd)"
"$REPO/node_modules/.bin/tsc" --noEmit --strict --target es2020 --module esnext --moduleResolution bundler --lib dom,es2020 --skipLibCheck \
  "$ROOT/pack-sdk-ts/index.ts" "$ROOT/receipts/ui/panel.ts" "$ROOT/invoice/ui/panel.ts"
node "$ROOT/scripts/build-panel.mjs" "$ROOT/receipts"
node "$ROOT/scripts/build-panel.mjs" "$ROOT/invoice"

install_pack() {
  local pack="$1" bin="$2"
  local dest="$SHELF_ROOT/business/packs/$pack"
  mkdir -p "$dest/bin" "$dest/ui"
  cp "$ROOT/$pack/PACK.md" "$ROOT/$pack/runtime.json" "$dest/"
  cp "$ROOT/$pack/ui/panel.html" "$dest/ui/panel.html"
  cp -f "$ROOT/target/release/$bin" "$dest/bin/$bin"
  chmod +x "$dest/bin/$bin"
  echo "installed -> $dest"
}

# Shelf manifest so `dext pack list` shows it as a coherent shelf.
mkdir -p "$SHELF_ROOT/business"
cat > "$SHELF_ROOT/business/shelf.json" <<'JSON'
{
  "id": "business",
  "name": "Business",
  "description": "Consumer packs for bookkeepers and small business owners: receipts, invoices, reconciliation, cash flow.",
  "packs": [
    { "id": "receipts", "name": "Receipts & expenses", "description": "Turn a folder of receipts into a sorted expense ledger with monthly totals and spending charts.", "abilities": [{ "ability": "command", "name": "receipts", "usage": "dext pack run receipts scan this folder and record every receipt", "description": "Record receipt files into a categorized ledger and show spending charts." }], "version": "0.1.0" },
    { "id": "invoice", "name": "Invoices", "description": "Numbered, printable invoices with tax, due dates and aging — who owes what, how late.", "abilities": [{ "ability": "command", "name": "invoice", "usage": "dext pack run invoice create an invoice for my last job", "description": "Create and track invoices and outstanding balances." }], "version": "0.1.0" }
  ]
}
JSON

install_pack receipts receipts-runtime
install_pack invoice invoice-runtime
echo "business shelf ready under $SHELF_ROOT/business"
