<script lang="ts">
  // Crew tail/file panes. Worker tails and deliverables are usually markdown
  // the agents wrote — render it (headings, lists, tables, code) instead of a
  // raw <pre>; plain logs stay line-oriented with level coloring. "auto"
  // sniffs the content so callers never have to guess which shape it is.
  import Markdown from "./Markdown.svelte";

  let {
    text,
    mode = "auto",
    file = false,
    sessionId = "",
  }: { text: string; mode?: "auto" | "md" | "log"; file?: boolean; sessionId?: string } = $props();

  const MD_HINTS: RegExp[] = [
    /^\s{0,3}#{1,6}\s+\S/m, // ATX headings
    /```/, // fenced code
    /^\s{0,3}([-*+]|\d+\.)\s+\S/m, // lists
    /\*\*[^*\n]+\*\*/, // bold
    /^\|.+\|$/m, // tables
  ];
  const isMd = $derived(mode === "md" || (mode === "auto" && MD_HINTS.some((re) => re.test(text ?? ""))));
  const lines = $derived((text ?? "").split("\n"));

  function level(l: string): string {
    if (/\b(error|failed|failure|fatal|panic|✗)\b/i.test(l)) return "err";
    if (/\b(warn|warning|⚠)\b/i.test(l)) return "warn";
    if (/\b(ok|done|success|✓|✔)\b/i.test(l)) return "ok";
    return "";
  }
</script>

{#if isMd}
  <div class="tail md" class:file><Markdown src={text} {sessionId} /></div>
{:else}
  <div class="tail log" class:file role="log">
    {#each lines as l, i (i)}
      <div class="ln {level(l)}">{l || " "}</div>
    {/each}
  </div>
{/if}

<style>
  /* The parent pane already styles .tail (padding, max-height, pre-wrap);
     rendered markdown wants flowing text, so reset it and compact the
     blocks — this is a pane, not a transcript column. */
  .md {
    white-space: normal;
  }
  .md :global(h1),
  .md :global(h2),
  .md :global(h3) {
    margin: 0.4em 0 0.2em;
  }
  .md :global(p) {
    margin: 0.25em 0;
  }
  .md :global(ul),
  .md :global(ol) {
    margin: 0.25em 0;
    padding-left: 1.4em;
  }
  .md :global(pre) {
    margin: 0.3em 0;
    padding: 6px 8px;
    background: var(--bg2);
    border: 1px solid var(--line);
    overflow-x: auto;
    white-space: pre;
  }
  .log .ln {
    min-height: 1.3em;
  }
  .log .ln.err {
    color: var(--red);
  }
  .log .ln.warn {
    color: var(--yellow);
  }
  .log .ln.ok {
    color: var(--green);
  }
</style>
