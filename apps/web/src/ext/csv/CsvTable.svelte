<script lang="ts">
  // ```csv fence → a real table. Escaped by construction (text nodes only),
  // capped so a pack that dumps a ledger cannot stall the tab. Click a header
  // to sort; numbers sort numerically and right-align.
  let { text, lang }: { text: string; lang: string } = $props();

  const MAX_ROWS = 500;
  const MAX_COLS = 40;

  function parseCsv(src: string, delim: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"') {
          if (src[i + 1] === '"') { cell += '"'; i++; }
          else quoted = false;
        } else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === delim) { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && src[i + 1] === "\n") i++;
        row.push(cell); cell = "";
        if (row.some((c) => c.trim() !== "")) rows.push(row.slice(0, MAX_COLS));
        row = [];
        if (rows.length > MAX_ROWS) break;
      } else cell += ch;
    }
    if (cell !== "" || row.length) { row.push(cell); if (row.some((c) => c.trim() !== "")) rows.push(row.slice(0, MAX_COLS)); }
    return rows;
  }

  const delim = $derived(lang.toLowerCase() === "tsv" ? "\t" : ",");
  const parsed = $derived(parseCsv(text, delim));
  const header = $derived(parsed[0] ?? []);
  const body = $derived(parsed.slice(1, MAX_ROWS + 1));
  const truncated = $derived(parsed.length > MAX_ROWS + 1);

  const numeric = $derived(header.map((_, ci) => body.length > 0 && body.every((r) => r[ci] === undefined || r[ci].trim() === "" || isNum(r[ci]))));
  function isNum(s: string): boolean {
    return /^\s*-?[$€£]?\s*[\d,]*\.?\d+\s*%?\s*$/.test(s);
  }
  function num(s: string): number {
    return Number(s.replace(/[$€£,%\s]/g, "")) || 0;
  }

  let sortCol = $state(-1);
  let sortDir = $state(1);
  const rows = $derived.by(() => {
    if (sortCol < 0) return body;
    const ci = sortCol;
    const isN = numeric[ci];
    return [...body].sort((a, b) => {
      const x = a[ci] ?? "";
      const y = b[ci] ?? "";
      return (isN ? num(x) - num(y) : x.localeCompare(y)) * sortDir;
    });
  });
  function sortBy(ci: number) {
    if (sortCol === ci) sortDir = -sortDir;
    else { sortCol = ci; sortDir = 1; }
  }
</script>

{#if header.length === 0}
  <pre class="md-art">{text}</pre>
{:else}
  <div class="csv" data-agent-id="ext.csv" data-state={truncated ? "truncated" : "ready"}>
    <table>
      <thead>
        <tr>
          {#each header as h, ci (ci)}
            <th class:num={numeric[ci]} class:sorted={sortCol === ci} onclick={() => sortBy(ci)} title="click to sort">
              {h}{#if sortCol === ci}<span class="faint"> {sortDir > 0 ? "▴" : "▾"}</span>{/if}
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each rows as r, ri (ri)}
          <tr>
            {#each header as _, ci (ci)}
              <td class:num={numeric[ci]}>{r[ci] ?? ""}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
    <div class="meta faint">{body.length} row{body.length === 1 ? "" : "s"}{truncated ? ` (first ${MAX_ROWS} shown)` : ""} · {header.length} col{header.length === 1 ? "" : "s"}</div>
  </div>
{/if}

<style>
  .csv { overflow-x: auto; border: 1px solid var(--line); background: var(--bg1); }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { padding: 3px 8px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; }
  th { color: var(--cyan); cursor: pointer; user-select: none; position: sticky; top: 0; background: var(--bg2); }
  th.sorted { color: var(--fg); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  tbody tr:hover { background: var(--bg2); }
  .meta { padding: 2px 8px; font-size: 11px; }
</style>
