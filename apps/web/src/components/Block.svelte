<script lang="ts">
  // Transcript blocks rendered as terminal output, not chat bubbles.
  // Tool calls use dext's swim-card idiom: ┌─ lane header, │ body, └ close.
  import type { Block } from "@dextui/protocol";
  import { splitFences, inlineTokens } from "../lib/markdown";
  import { copyText } from "../lib/state.svelte";
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

  function tailLines(t: string): string[] {
    return t.split("\n").slice(-8);
  }
</script>

{#if block.kind === "user"}
  <div class="b-user" data-agent-id="block.user">
    <span class="pg">❯</span>
    <span class="b-user-text">{block.text}</span>
  </div>
{:else if block.kind === "text"}
  <div class="b-text" data-agent-id="block.text">
    {#each splitFences(block.text) as seg (seg)}
      {#if seg.type === "code"}
        <pre class="codeblock">{seg.text}</pre>
      {:else}
        {#each seg.text.split(/\n{2,}/) as para (para)}
          <p class="para">
            {#each inlineTokens(para) as tk (tk)}
              {#if tk.t === "code"}<code class="ic">{tk.s}</code>{:else if tk.t === "bold"}<strong>{tk.s}</strong>{:else}{tk.s}{/if}
            {/each}
          </p>
        {/each}
      {/if}
    {/each}
    {#if !block.complete}<span class="blink cursor">▊</span>{/if}
    <button class="act hover-act" data-agent-id="block.text.copy" onclick={() => copyText(block.text, "copied")}>copy</button>
  </div>
{:else if block.kind === "thinking"}
  {#if block.complete}
    <details class="b-think done" data-agent-id="block.thinking" data-state="complete">
      <summary><span class="faint">▸ thinking</span><span class="faint"> ({block.text.split("\n").length} lines)</span></summary>
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
      <span class="faint">┌─</span>
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
      <div class="tool-body">
        {#if looksLikeDiff(block.output_tail)}
          <Diff text={block.output_tail} prefix="│ " />
        {:else}
          {#each tailLines(block.output_tail) as line, i (i)}
            <div class="tool-line"><span class="gut">│</span> <span class="dim">{line}</span></div>
          {/each}
        {/if}
      </div>
    {/if}
    {#if block.content}
      <details class="tool-full">
        <summary><span class="gut">│</span> <span class="faint">▸ output ({block.content.split("\n").length} lines)</span></summary>
        <div class="tool-body">
          {#if looksLikeDiff(block.content)}
            <Diff text={block.content} prefix="│ " />
          {:else}
            <pre class="tool-pre" data-agent-id={`tool.${block.call_id}.content`}><span class="gut">│ </span>{block.content}</pre>
          {/if}
        </div>
      </details>
    {/if}
    <div class="faint tool-foot">└</div>
  </div>
{:else if block.kind === "marker"}
  <div class={`b-marker ${markerClass[block.level] ?? "st-faint"}`} data-agent-id="block.marker">
    {markerGlyph[block.level] ?? "·"} {block.text}
  </div>
{:else if block.kind === "slash"}
  <div class="b-slash" data-agent-id="block.slash">
    {#each block.text.split("\n") as line, i (i)}
      <div><span class="gut">│</span> <span class="dim">{line}</span></div>
    {/each}
    <button class="act hover-act" data-agent-id="block.slash.copy" onclick={() => copyText(block.text, "copied")}>copy</button>
  </div>
{:else if block.kind === "view"}
  <div class="tool" data-agent-id={`view.${block.pack}`}>
    <div class="tool-head">
      <span class="faint">┌─</span>
      <span class="st-magenta">{block.pack}</span>
      <span class="faint">·</span>
      <span class="dim tool-summary">{block.title}</span>
    </div>
    <div class="tool-body">
      {#each block.markdown.split("\n") as line, i (i)}
        <div class="tool-line"><span class="gut">│</span> <span class="dim">{line}</span></div>
      {/each}
    </div>
    <div class="faint tool-foot">└</div>
  </div>
{/if}

<style>
  .pg {
    color: var(--green);
    font-weight: bold;
    user-select: none;
  }
  .b-user {
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
    max-width: 84ch; /* readable prose measure — web-native, not full-width terminal */
  }
  .para {
    white-space: pre-line;
    margin: 4px 0;
  }
  .codeblock {
    margin: 6px 0;
    padding: 6px 10px;
    border-left: 1px solid var(--line);
    background: var(--bg1);
    overflow-x: auto;
    font-size: 12px;
    white-space: pre;
  }
  .ic {
    background: var(--bg2);
    padding: 0 4px;
    color: var(--orange);
  }
  .cursor {
    color: var(--green);
  }
  .hover-act {
    visibility: hidden;
    margin-left: 8px;
  }
  .b-text:hover .hover-act,
  .tool:hover .hover-act,
  .b-slash:hover .hover-act {
    visibility: visible;
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
  .tool {
    max-width: 130ch;
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
  .tool-line {
    white-space: pre-wrap;
  }
  .tool-pre {
    white-space: pre-wrap;
    color: var(--dim);
  }
  .gut {
    color: var(--faint);
    user-select: none;
  }
  .tool-full summary {
    cursor: pointer;
    user-select: none;
    list-style: none;
  }
  .tool-full summary::-webkit-details-marker {
    display: none;
  }
  .b-marker {
    white-space: pre-wrap;
  }
  .b-slash {
    position: relative;
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
