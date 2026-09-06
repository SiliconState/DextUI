// Pure display helpers shared by components and state (no store imports, so
// lower layers like state.svelte can use them without a cycle).
import type { PackInfo } from "@dextui/protocol";

/** Capitalize the first letter of every word, leaving the rest untouched
 * ("Bank reconciliation" → "Bank Reconciliation", "TradingView" stays). Words
 * starting with a non-letter ("(Edge)", "&") keep their first real letter. */
export function titleCase(s: string): string {
  return s
    .split(/(\s+)/)
    .map((w) => {
      const i = w.search(/\p{L}/u);
      return i < 0 ? w : w.slice(0, i) + w.charAt(i).toUpperCase() + w.slice(i + 1);
    })
    .join("");
}

/** Pack display name: curated title when there is one, else the id with
 * `-`/`_` as spaces ("edge_browser" → "Edge Browser"). Always title-cased, so
 * no pack ever renders in small letters. */
export function packTitle(p: Pick<PackInfo, "name" | "ui">): string {
  return titleCase(p.ui.title ?? p.name.replace(/[-_]+/g, " "));
}
