// receipts panel — the dashboard DextUI renders inline next to the ledger.
// Data is baked per run by the Rust runtime into window.__PACK_DATA__:
// { generated, symbol, scope, total_cents, count, by_category:[{label,cents}],
//   by_month:[{label,cents}], rows:[{date,vendor,amount,category,note}] }
import { definePanel, el, h2, muted, money, bars, table, type Row } from "../../pack-sdk-ts/index";

definePanel((host, data) => {
  const symbol = typeof data.symbol === "string" && data.symbol ? data.symbol : "$";
  const total = typeof data.total_cents === "number" ? data.total_cents : 0;
  const count = typeof data.count === "number" ? data.count : 0;
  const byCat = Array.isArray(data.by_category) ? data.by_category : [];
  const byMonth = Array.isArray(data.by_month) ? data.by_month : [];
  const rows: Row[] = Array.isArray(data.rows)
    ? data.rows.map((r: any) => [String(r.date ?? ""), String(r.vendor ?? ""), money(Number(r.amount_cents ?? 0), symbol), String(r.category ?? ""), String(r.note ?? "")])
    : [];

  host.append(
    el("header", { class: "head" },
      el("div", {},
        h2("Receipts & expenses"),
        muted(`${count} receipt${count === 1 ? "" : "s"} · ${String(data.scope ?? "all time")} · generated ${String(data.generated ?? "")}`),
      ),
      el("div", { class: "total" }, money(total, symbol)),
    ),
  );

  if (byCat.length) {
    host.append(el("section", {}, el("h3", {}, "By category"), bars(byCat.map((c: any) => ({ label: String(c.label), cents: Number(c.cents) })), symbol)));
  }
  if (byMonth.length > 1) {
    host.append(el("section", {}, el("h3", {}, "By month"), bars(byMonth.map((m: any) => ({ label: String(m.label), cents: Number(m.cents) })), symbol)));
  }
  if (rows.length) {
    host.append(el("section", {}, el("h3", {}, "Ledger"), table(["date", "vendor", "amount", "category", "note"], rows.slice(0, 200), [2])));
  } else {
    host.append(muted("Nothing recorded yet — drop receipt files in the folder and ask to scan them."));
  }
});
