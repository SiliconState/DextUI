<script lang="ts">
  // Renders parsed markdown as real DOM: true <table>, lists, headings, safe
  // links. Terminal soul stays in the chrome; content gets the web — charts
  // and session-cwd images included.
  import { parseMarkdown, prettyPath, type Inline, type MdBlock } from "../lib/markdown";
  import { fileUrl as fileUrlFor, isHtmlPath, isPdfPath, isTextPath, servablePath } from "../lib/files";
  import Chart from "./Chart.svelte";
  import ChartRow from "./ChartRow.svelte";
  import FileView from "./FileView.svelte";
  import { fenceFor } from "../ext";
  import HtmlArtifact from "./HtmlArtifact.svelte";
  import { ChartLink } from "../lib/chartlink.svelte";
  import { app } from "../lib/state.svelte";

  let { src, sessionId = "" }: { src: string; sessionId?: string } = $props();

  const blocks = $derived(parseMarkdown(src));
  // Consecutive tables - each optionally titled by its own ###/#### heading -
  // flow side-by-side in a wrapped flex row, so a wide pane shows 3-4 across
  // instead of stacking every table full-width. Any other block between tables
  // (h1/h2 section title, paragraph, code, list...) breaks the run; lone
  // tables keep the classic full-width layout.
  type MdTable = Extract<MdBlock, { kind: "table" }>;
  type MdHeading = Extract<MdBlock, { kind: "heading" }>;
  type TCard = { head: MdHeading | null; table: MdTable };
  type MdChart = Extract<MdBlock, { kind: "chart" }>;
  type Run =
    | { kind: "single"; b: MdBlock }
    | { kind: "lone"; card: TCard }
    | { kind: "grid"; cards: TCard[] }
    // Tables keep content width; trailing charts are a measured row (ChartRow)
    // that shares the line when it fits beside them, else wraps below full-width.
    | { kind: "tape"; cards: TCard[]; charts: MdChart[] }
    // Charts with no table in front of them still share a row.
    | { kind: "charts"; charts: MdChart[] };
  const layout = $derived.by(() => {
    const runs: Run[] = [];
    let cards: TCard[] = [];
    const flush = () => {
      if (cards.length === 1) runs.push({ kind: "lone", card: cards[0]! });
      else if (cards.length > 1) runs.push({ kind: "grid", cards });
      cards = [];
    };
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]!;
      const nx = blocks[i + 1];
      if (b.kind === "chart") {
        const last = runs[runs.length - 1];
        if (cards.length > 0) {
          runs.push({ kind: "tape", cards, charts: [b] });
          cards = [];
        } else if (last?.kind === "tape" || last?.kind === "charts") {
          last.charts.push(b);
        } else {
          runs.push({ kind: "charts", charts: [b] });
        }
        continue;
      }
      if (b.kind === "table") {
        cards.push({ head: null, table: b });
      } else if (b.kind === "heading" && b.level >= 3 && nx?.kind === "table") {
        cards.push({ head: b, table: nx });
        i++;
      } else {
        flush();
        runs.push({ kind: "single", b });
      }
    }
    flush();
    return runs;
  });
  // One selection link per rendered message: charts sharing a dataset id
  // cross-highlight — click a bar in one, its siblings dim the same index.
  const link = new ChartLink();
  const canFiles = $derived(app.caps.includes("files_read"));
  // href → true once the browser reports a failed image load: an actionable
  // chip instead of silent alt-text soup when a file 404s.
  let broken = $state<Record<string, boolean>>({});

  const sessCwd = $derived(app.sessions.find((s) => s.id === sessionId)?.cwd ?? "");

  const fileUrl = (href: string, opts?: { theme?: boolean }): string => fileUrlFor(sessionId, href, sessCwd, opts);
  const isHtmlArtifact = isHtmlPath;
</script>

{#snippet inline(parts: Inline[])}
  {#each parts as tk, i (i)}
    {#if tk.t === "code"}<code class="ic">{tk.s}</code>{:else if tk.t === "bold"}<strong>{tk.s}</strong>{:else if tk.t === "italic"}<em>{tk.s}</em>{:else if tk.t === "link"}<a href={!/^https?:\/\//.test(tk.href) && sessionId && canFiles && servablePath(tk.href) ? fileUrl(tk.href) : tk.href} target="_blank" rel="noopener noreferrer">{tk.s}</a>{:else if tk.t === "image"}
      {#if /^https?:\/\//.test(tk.href)}
        <!-- model-chosen remote URLs stay links: never fetch them silently -->
        <a href={tk.href} target="_blank" rel="noopener noreferrer">{tk.s || tk.href}</a>
      {:else if !sessionId || !canFiles}
        <code class="ic">{tk.href}</code>
      {:else if isHtmlArtifact(tk.href)}
        <!-- HTML artifact: self-contained dashboard in a sandboxed opaque-origin frame -->
        <HtmlArtifact src={fileUrl(tk.href, { theme: true })} name={tk.s || prettyPath(tk.href, sessCwd)} />
      {:else if isPdfPath(tk.href)}
        <!-- workspace PDF: the browser's own viewer, served inline by the host -->
        <div class="md-chartbox" data-agent-id="markdown.pdf">
          <FileView src={fileUrl(tk.href)} name={prettyPath(tk.href, sessCwd)} kind="pdf" />
        </div>
      {:else if isTextPath(tk.href)}
        <!-- workspace text file: fetched and shown as a bounded pre -->
        <div class="md-chartbox" data-agent-id="markdown.textfile">
          <FileView src={fileUrl(tk.href)} name={prettyPath(tk.href, sessCwd)} kind="text" />
        </div>
      {:else if broken[tk.href]}
        <span class="md-imgmiss" data-agent-id="markdown.image.missing">✗ image not found under the session workspace: {prettyPath(tk.href, sessCwd)}</span>
      {:else}
        <span class="md-img" data-agent-id="markdown.image">
          <img src={fileUrl(tk.href)} alt={tk.s} loading="lazy" onerror={() => (broken[tk.href] = true)} />
          {#if tk.s}<span class="faint md-imgcap">{tk.s}</span>{/if}
        </span>
      {/if}
    {:else}{tk.s}{/if}
  {/each}
{/snippet}

{#snippet renderTable(b: MdTable)}
  {@const NUM = /^[+\u2212\-]?\$?\d[\d,]*(\.\d+)?\s?(%|[kKMBT]|bp|x|pts?)?$|^(n\/a|—|-)$/}
  {@const cellText = (c: Inline[]) => c.map((t) => ("s" in t ? t.s : "")).join("").trim()}
  {@const numCol = b.rows.length > 0
    ? b.head.map((_, ci) => b.rows.filter((r) => NUM.test(cellText(r[ci] ?? []))).length >= Math.max(1, Math.ceil(b.rows.length * 0.6)))
    : b.head.map(() => false)}
  {@const sign = (t: string) => (/^[+]\$?\d/.test(t) ? "pos" : /^[\-\u2212]\$?\d/.test(t) ? "neg" : "")}
  <div class="md-tablewrap">
    <table class="md-table">
      <thead>
        <tr>
          {#each b.head as cell, ci (ci)}
            <th class:num={numCol[ci]} style={`text-align:${b.align[ci] === "r" || (numCol[ci] && b.align[ci] !== "c") ? "right" : b.align[ci] === "c" ? "center" : "left"}`}>
              {@render inline(cell)}
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each b.rows as row, ri (ri)}
          <tr>
            {#each row as cell, ci (ci)}
              {@const t = cellText(cell)}
              <td class:num={numCol[ci]} class:pos={numCol[ci] && sign(t) === "pos"} class:neg={numCol[ci] && sign(t) === "neg"} style={`text-align:${b.align[ci] === "r" || (numCol[ci] && b.align[ci] !== "c") ? "right" : b.align[ci] === "c" ? "center" : "left"}`}>
                {@render inline(cell)}
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/snippet}

{#snippet chartRow(charts: MdChart[])}
  <!-- measured packer: real px widths from the DOM — charts pair side by side
       beside (or below) the tables whenever the space allows, else stack -->
  <ChartRow charts={charts} {link} />
{/snippet}

{#snippet renderCard(c: TCard)}
  <div class="md-tcard">
    {#if c.head}
      <svelte:element this={`h${Math.min(Math.max(c.head.level, 1), 4)}`} class="md-h md-tcardh">
        {@render inline(c.head.inline)}
      </svelte:element>
    {/if}
    {@render renderTable(c.table)}
  </div>
{/snippet}

<div class="md">
  {#each layout as run, ri (ri)}
    {#if run.kind === "single"}
      {@render renderBlock(run.b)}
    {:else if run.kind === "lone"}
      {@render renderCard(run.card)}
    {:else if run.kind === "tape"}
      <!-- flow packer: tables at content width, then the chart cluster fills what is left on the row
           (two charts side by side when it fits) or wraps to its own full-width row -->
      <div class="md-tape" data-agent-id="markdown.tape">
        {#each run.cards as c, ci (ci)}
          {@render renderCard(c)}
        {/each}
        {@render chartRow(run.charts)}
      </div>
    {:else if run.kind === "charts"}
      <div class="md-tape" data-agent-id="markdown.chartrow">{@render chartRow(run.charts)}</div>
    {:else}
      <div class="md-tgrid" data-agent-id="markdown.tgrid">
        {#each run.cards as c, ci (ci)}
          {@render renderCard(c)}
        {/each}
      </div>
    {/if}
  {/each}
</div>

{#snippet renderBlock(b: MdBlock)}
    {#if b.kind === "heading"}
      <svelte:element this={`h${Math.min(Math.max(b.level, 1), 4)}`} class="md-h">
        {@render inline(b.inline)}
      </svelte:element>
    {:else if b.kind === "para"}
      <p class="md-p">{@render inline(b.inline)}</p>
    {:else if b.kind === "code"}
      {@const ext = fenceFor(b.lang)}
      {#if ext}
        <!-- registered fence extension (apps/web/src/ext/<name>): the component escapes its own content -->
        <div class="md-chartbox" data-agent-id={`markdown.ext.${b.lang}`}>
          <ext.component text={b.text} lang={b.lang ?? ""} />
        </div>
      {:else}
        <div class="md-code">
          {#if b.lang}<span class="md-lang">{b.lang}</span>{/if}
          <pre>{b.text}</pre>
        </div>
      {/if}
    {:else if b.kind === "html"}
      <!-- inline markup from a ```html/```svg fence: sandboxed srcdoc frame with a code toggle -->
      <div class="md-chartbox" data-agent-id="markdown.html">
        <HtmlArtifact html={b.text} name={b.lang === "svg" ? "inline svg" : "inline html"} />
      </div>
    {:else if b.kind === "chart"}
      <!-- interactive: hover, zoom/pan, drag-to-edit with live stats, sort,
           legend toggles, donut isolate, dataset cross-highlight (Chart.svelte;
           labels are Svelte-escaped — no {@html} on any dynamic string) -->
      <div class="md-chartbox" data-agent-id="markdown.chart">
        <Chart spec={b.spec} {link} />
      </div>
    {:else if b.kind === "art"}
      <pre class="md-art">{b.text}</pre>
    {:else if b.kind === "list"}
      {#if b.ordered}
        <ol class="md-list">
          {#each b.items as it, ii (ii)}
            <li>
              {@render inline(it.inline)}
              {#if it.sub.length > 0}
                <ul class="md-list">
                  {#each it.sub as sub, si (si)}
                    <li>{@render inline(sub.inline)}</li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/each}
        </ol>
      {:else}
        <ul class="md-list">
          {#each b.items as it, ii (ii)}
            <li>
              {@render inline(it.inline)}
              {#if it.sub.length > 0}
                <ul class="md-list">
                  {#each it.sub as sub, si (si)}
                    <li>{@render inline(sub.inline)}</li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {:else if b.kind === "quote"}
      <blockquote class="md-quote">{@render inline(b.inline)}</blockquote>
    {:else if b.kind === "hr"}
      <hr class="md-hr" />
    {/if}
{/snippet}

<style>
  .md {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .md-h {
    font-size: 13px;
    font-weight: bold;
    color: var(--fg);
    margin-top: 10px;
  }
  .md :is(h1, h2).md-h {
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.01em;
    border-bottom: 1px solid var(--line);
    padding-bottom: 3px;
    margin-top: 16px;
  }
  .md > :first-child.md-h {
    margin-top: 2px;
  }
  .md-p {
    white-space: pre-line;
    overflow-wrap: break-word;
  }
  .ic {
    background: var(--bg2);
    padding: 0 4px;
    color: var(--orange);
  }
  a {
    color: var(--blue);
    text-decoration: none;
  }
  a:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .md-code {
    position: relative;
    border-left: 2px solid var(--line);
    background: var(--bg1);
  }
  .md-code pre {
    padding: 6px 10px;
    overflow-x: auto;
    font-size: 12px;
  }
  .md-lang {
    position: absolute;
    top: 2px;
    right: 8px;
    color: var(--faint);
    font-size: 10px;
    user-select: none;
  }
  .md-art {
    overflow-x: auto;
    white-space: pre;
    color: var(--dim);
    font-size: 12px;
    line-height: 1.3;
  }
  .md-chartbox {
    max-width: 720px;
  }
  /* Tape: one wrapping row. Tables keep their content width (and scroll inside
     their card if wider than the pane); the chart cluster grows into whatever
     is left beside them, else wraps below at full width. */
  .md-tape {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem 1.5rem;
    align-items: flex-start;
  }
  .md-tape > .md-tcard {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 100%;
  }
  .md-tape .md-tcard .md-h {
    margin-top: 0;
  }
  .md-img {
    display: inline-flex;
    flex-direction: column;
    gap: 2px;
    max-width: 100%;
  }
  .md-img img {
    max-width: min(480px, 100%);
    max-height: 360px;
    border: 1px solid var(--line);
    background: var(--bg1);
  }
  .md-imgcap {
    font-size: 10px;
  }
  .md-imgmiss {
    display: inline-block;
    max-width: 100%;
    overflow-wrap: anywhere;
    border: 1px solid color-mix(in srgb, var(--red, #f85149) 45%, var(--line));
    color: var(--red, #f85149);
    padding: 2px 8px;
    font-size: 11.5px;
  }
  .md-list {
    padding-left: 2ch;
    display: flex;
    flex-direction: column;
    gap: 2px;
    list-style: none;
  }
  ul.md-list > li::before {
    content: "• ";
    color: var(--faint);
  }
  ol.md-list {
    counter-reset: md;
  }
  ol.md-list > li {
    counter-increment: md;
  }
  ol.md-list > li::before {
    content: counter(md) ". ";
    color: var(--faint);
  }
  .md-list .md-list {
    margin-top: 2px;
  }
  .md-tablewrap {
    overflow-x: auto;
    max-width: 100%;
  }
  .md-table {
    border-collapse: collapse;
    font-size: 12.5px;
  }
  .md-table th,
  .md-table td {
    border: 1px solid var(--line);
    padding: 3px 10px;
    vertical-align: top;
  }
  .md-table th {
    background: var(--bg1);
    color: var(--cyan);
    font-weight: bold;
    white-space: nowrap;
  }
  .md-table tbody tr:nth-child(even) {
    background: color-mix(in srgb, var(--bg1) 55%, transparent);
  }
  .md-table td.num,
  .md-table th.num {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  /* Direction tint is per cell and text-led; striping stays on the row. */
  .md-table tbody td.pos {
    color: var(--green, #3fb950);
    background: color-mix(in srgb, var(--green, #3fb950) 6%, transparent);
  }
  .md-table tbody td.neg {
    color: var(--red, #f85149);
    background: color-mix(in srgb, var(--red, #f85149) 6%, transparent);
  }
  .md-tgrid {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    align-items: flex-start;
  }
  .md-tcard {
    max-width: 100%;
  }
  .md-tgrid .md-tcard {
    flex: 1 1 240px;
    min-width: 200px;
  }
  .md-tcard .md-h {
    margin-top: 0;
    font-size: 12.5px;
  }
  .md-tcard .md-tablewrap {
    max-width: 100%;
  }
  .md-quote {
    border-left: 2px solid var(--faint);
    padding-left: 10px;
    color: var(--dim);
    font-style: italic;
  }
  .md-hr {
    border: 0;
    border-top: 1px solid var(--line);
    margin: 4px 0;
  }
</style>
