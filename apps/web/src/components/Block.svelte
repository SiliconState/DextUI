<script lang="ts">
  // Transcript blocks: terminal chrome (❯, status glyphs, rails) around
  // web-native content (real markdown, scrollable raw output). Structure rails
  // are CSS borders, never literal glyphs — glyph gutters shred when lines wrap.
  import type { ViewBlock as Block } from "@dextui/client";
  import { copyText } from "../lib/state.svelte";
  import Markdown from "./Markdown.svelte";
  import Diff from "./Diff.svelte";

  let { block, onInspect }: { block: Block; onInspect?: (b: Block) => void } = $props();

  function looksLikeDiff(t: string): boolean {
    return /^[-+]{3} |^@@ |^diff --git /m.test(t);
  }

  const markerGlyph: Record<string, string> = {
    info: "·",
    note: "•",
    warn: "⚠",
    error: "✗",
  };
  const markerClass: Record<string, string> = {
    info: "st-faint",
    note: "st-cyan",
    warn: "st-yellow",
    error: "st-red",
  };

  const toolLabel: Record<string, string> = {
    preview: "… planned",
    running: "● running",
    ok: "✓ ok",
    failed: "✗ failed",
  };
  const toolClass: Record<string, string> = {
    preview: "st-yellow",
    running: "st-cyan pulse",
    ok: "st-green",
    failed: "st-red",
  };

  function tailLines(t: string): string {
    return t.split("\n").slice(-8).join("\n");
  }
</script>

{#if block.kind === "user"}
  <div class="b-user" data-agent-id="block.user">
    <span class="pg">❯</span>
    <span class="b-user-text">{block.text}</span>
  </div>
{:else if block.kind === "text"}
  <div class="b-text" data-agent-id="block.text">
    <Markdown src={block.text} />
    {#if !block.complete}<span class="blink cursor">▊</span>{/if}
    <button class="act hover-act" data-agent-id="block.text.copy" onclick={() => copyText(block.text, "copied")}>copy</button>
  </div>
{:else if block.kind === "thinking"}
  {#if block.complete}
    <details class="b-think done" data-agent-id="block.thinking" data-state="complete">
      <summary><span class="faint">▸ thinking ({block.text.split("\n").length} lines)</span></summary>
      <div class="think-body">
        {#each block.text.split("\n").filter((l) => l.trim()) as line, i (i)}
          <div class="think-line"><span class="t-marker">•</span> {line}</div>
        {/each}
      </div>
    </details>
  {:else}
    <div class="b-think live" data-agent-id="block.thinking" data-state="thinking">
      {#each block.text.split("\n").slice(-6) as line, i (i)}
        <div class="think-line"><span class="t-marker">•</span> {line}</div>
      {/each}
    </div>
  {/if}
{:else if block.kind === "tool"}
  <div class="tool" data-agent-id={`tool.${block.call_id}`} data-state={block.status}>
    <div class="tool-head">
      <span class="tool-name">{block.name}</span>
      <span class="faint">·</span>
      <span class="dim tool-summary">{block.summary}</span>
      <span class={`tool-status ${toolClass[block.status] ?? "st-faint"}`} data-agent-id={`tool.${block.call_id}.status`}>
        {toolLabel[block.status] ?? block.status}
      </span>
      {#if onInspect}
        <button class="act hover-act" data-agent-id={`tool.${block.call_id}.inspect`} onclick={() => onInspect?.(block)}>raw</button>
      {/if}
    </div>
    {#if block.output_tail}
      {#if looksLikeDiff(block.output_tail)}
        <Diff text={block.output_tail} />
      {:else}
        <pre class="tool-pre" data-agent-id={`tool.${block.call_id}.tail`}>{tailLines(block.output_tail)}</pre>
      {/if}
    {/if}
    {#if block.content}
      <details class="tool-full">
        <summary><span class="faint">▸ output ({block.content.split("\n").length} lines)</span></summary>
        {#if looksLikeDiff(block.content)}
          <Diff text={block.content} />
        {:else}
          <pre class="tool-pre" data-agent-id={`tool.${block.call_id}.content`}>{block.content}</pre>
        {/if}
      </details>
    {/if}
  </div>
{:else if block.kind === "marker"}
  <div class={`b-marker ${markerClass[block.level] ?? "st-faint"}`} data-agent-id="block.marker">
    {markerGlyph[block.level] ?? "·"} {block.text}
  </div>
{:else if block.kind === "slash"}
  <div class="b-slash" data-agent-id="block.slash">
    <pre class="slash-pre">{block.text}</pre>
    <button class="act hover-act" data-agent-id="block.slash.copy" onclick={() => copyText(block.text, "copied")}>copy</button>
  </div>
{:else if block.kind === "view"}
  <div class="tool view" data-agent-id={`view.${block.pack}`}>
    <div class="tool-head">
      <span class="st-magenta">{block.pack}</span>
      <span class="faint">·</span>
      <span class="dim tool-summary">{block.title}</span>
    </div>
    <div class="view-body">
      <Markdown src={block.markdown} />
    </div>
  </div>
{/if}

<style>
  .pg {
    color: var(--green);
    font-weight: bold;
    user-select: none;
  }
  .b-user {
    width: 100%;
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  .b-user-text {
    white-space: pre-wrap;
    color: var(--fg);
  }
  .b-text {
    position: relative;
    width: 100%;
  }
  .cursor {
    color: var(--green);
  }
  .hover-act {
    visibility: hidden;
    margin-left: 8px;
  }
  .b-text .hover-act {
    position: absolute;
    top: 0;
    right: 0;
  }
  .b-text:hover .hover-act,
  .tool:hover .hover-act,
  .b-slash:hover .hover-act {
    visibility: visible;
  }
  .b-think {
    width: 100%;
  }
  .b-think.live {
    background: var(--bg1);
    padding: 4px 8px;
  }
  .b-think.done summary {
    cursor: pointer;
    user-select: none;
    list-style: none;
  }
  .b-think.done summary::-webkit-details-marker {
    display: none;
  }
  .b-think.done[open] summary {
    margin-bottom: 2px;
  }
  .think-body {
    background: var(--bg1);
    padding: 4px 8px;
  }
  .think-line {
    color: var(--dim);
    white-space: pre-wrap;
  }
  .t-marker {
    color: var(--faint);
  }
  /* Tool / pack cards: CSS rail, hover accent — never glyph gutters. */
  .tool {
    width: 100%;
    min-width: 0;
    border-left: 2px solid var(--line);
    padding: 2px 0 2px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    transition: border-color 0.12s ease-out;
  }
  .tool:hover {
    border-left-color: var(--cyan);
  }
  .tool[data-state="failed"] {
    border-left-color: color-mix(in srgb, var(--red) 55%, var(--line));
  }
  .tool.view {
    border-left-color: color-mix(in srgb, var(--magenta) 40%, var(--line));
  }
  .tool-head {
    display: flex;
    gap: 6px;
    align-items: baseline;
  }
  .tool-name {
    color: var(--cyan);
    font-weight: bold;
    flex-shrink: 0;
  }
  .tool-summary {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .tool-status {
    margin-left: auto;
    flex-shrink: 0;
  }
  .tool-pre {
    white-space: pre;
    overflow-x: auto;
    max-height: 20rem;
    overflow-y: auto;
    color: var(--dim);
    font-size: 12px;
    background: var(--bg1);
    padding: 4px 8px;
  }
  .tool-full summary {
    cursor: pointer;
    user-select: none;
    list-style: none;
  }
  .tool-full summary::-webkit-details-marker {
    display: none;
  }
  .view-body {
    width: 100%;
  }
  .b-marker {
    width: 100%;
    white-space: pre-wrap;
  }
  .b-slash {
    position: relative;
    width: 100%;
    min-width: 0;
    border-left: 2px solid color-mix(in srgb, var(--cyan) 35%, var(--line));
    padding-left: 10px;
  }
  .slash-pre {
    white-space: pre;
    overflow-x: auto;
    color: var(--dim);
    font-size: 12px;
  }
  .st-faint {
    color: var(--faint);
  }
  .st-cyan {
    color: var(--cyan);
  }
  .st-yellow {
    color: var(--yellow);
  }
  .st-red {
    color: var(--red);
  }
  .st-green {
    color: var(--green);
  }
  .st-magenta {
    color: var(--magenta);
  }
  .dim {
    color: var(--dim);
  }
  .faint {
    color: var(--faint);
  }
</style>
