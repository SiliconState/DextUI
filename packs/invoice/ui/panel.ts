// invoice panel — who owes what, baked per run by the Rust runtime into
// window.__PACK_DATA__: { generated, symbol, outstanding_cents,
//   buckets:[{label,cents}], by_client:[{label,cents}],
//   rows:[{number,client,due,age,balance_cents,status}] }
import { definePanel, el, h2, muted, money, bars, table, type Row } from "../../pack-sdk-ts/index";

definePanel((host, data) => {
  const symbol = typeof data.symbol === "string" && data.symbol ? data.symbol : "$";
  const outstanding = typeof data.outstanding_cents === "number" ? data.outstanding_cents : 0;
  const buckets = Array.isArray(data.buckets) ? data.buckets : [];
  const byClient = Array.isArray(data.by_client) ? data.by_client : [];
  const rows: Row[] = Array.isArray(data.rows)
    ? data.rows.map((r: any) => [String(r.number ?? ""), String(r.client ?? ""), String(r.due ?? ""), String(r.age ?? ""), money(Number(r.balance_cents ?? 0), symbol)])
    : [];

  host.append(
    el("header", { class: "head" },
      el("div", {},
        h2("Invoices — who still owes"),
        muted(`generated ${String(data.generated ?? "")}`),
      ),
      el("div", { class: "total" }, money(outstanding, symbol)),
    ),
  );

  if (!rows.length) {
    host.append(muted("Nothing outstanding — everything is paid (or no invoices yet)."));
    return;
  }
  if (buckets.length) {
    host.append(el("section", {}, el("h3", {}, "By age"), bars(buckets.map((b: any) => ({ label: String(b.label), cents: Number(b.cents) })), symbol)));
  }
  if (byClient.length) {
    host.append(el("section", {}, el("h3", {}, "By client"), bars(byClient.map((c: any) => ({ label: String(c.label), cents: Number(c.cents) })), symbol)));
  }
  host.append(el("section", {}, el("h3", {}, "Outstanding"), table(["invoice", "client", "due", "age", "balance"], rows, [4])));
});
