// Cross-chart selection link, one instance per Markdown message (created in
// Markdown.svelte, consumed by Chart.svelte via context). Charts that declare
// the same `dataset` id broadcast their selection — a clicked bar, a brushed
// range — and sibling charts dim everything outside it. Purely local state;
// nothing here round-trips to the host or mutates the spec.
export class ChartLink {
  sel: { ds: string; lo: number; hi: number } | null = $state(null);

  /** Click-select one index (clicking the same index again clears). */
  pick(ds: string, i: number): void {
    const cur = this.sel;
    this.sel = cur?.ds === ds && cur.lo === i && cur.hi === i ? null : { ds, lo: i, hi: i };
  }

  /** Brush-select an index range (drag on a line chart's brush strip). */
  range(ds: string, lo: number, hi: number): void {
    this.sel = { ds, lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
  }

  clear(ds: string): void {
    if (this.sel?.ds === ds) this.sel = null;
  }

  /** Is index `i` inside the active selection for `ds`? (No selection → all.) */
  active(ds: string, i: number): boolean {
    const s = this.sel;
    return !s || s.ds !== ds || (i >= s.lo && i <= s.hi);
  }

  has(ds: string): boolean {
    return !!this.sel && this.sel.ds === ds;
  }
}
