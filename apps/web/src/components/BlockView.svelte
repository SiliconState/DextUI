<script lang="ts">
  import type { Block } from "@dextui/protocol";
  import { splitFences, inlineTokens } from "../lib/markdown";
  import { copyText } from "../lib/state.svelte";
  import DiffView from "./DiffView.svelte";

  let { block, onInspect }: { block: Block; onInspect?: (b: Block) => void } = $props();

  function looksLikeDiff(t: string): boolean {
    return /^[-+]{3} |^@@ |^diff --git /m.test(t);
  }

  const markerColor: Record<string, string> = {
    info: "text-dim",
    note: "text-accent",
    warn: "text-warn",
    err: "text-err",
    error: "text-err",
  };
  const markerIcon: Record<string, string> = {
    info: "·",
    note: "◆",
    warn: "▲",
    err: "✕",
    error: "✕",
  };

  const toolStatus: Record<string, { label: string; cls: string }> = {
    preview: { label: "planned", cls: "border-warn/40 text-warn" },
    running: { label: "running", cls: "border-accent/40 text-accent" },
    ok: { label: "ok", cls: "border-ok/40 text-ok" },
    failed: { label: "failed", cls: "border-err/40 text-err" },
  };
  const toolDot: Record<string, string> = {
    preview: "bg-warn animate-pulse",
    running: "bg-accent animate-pulse",
    ok: "bg-ok",
    failed: "bg-err",
  };
</script>

{#if block.kind === "user"}
  <div class="group flex flex-col gap-1" data-agent-id="block.user">
    <span class="text-[10px] font-semibold uppercase tracking-wider text-faint">you</span>
    <div class="whitespace-pre-wrap rounded-xl rounded-tl-sm border border-accent/30 bg-accent/10 px-3 py-2 text-[15px] leading-relaxed">
      {block.text}
    </div>
  </div>
{:else if block.kind === "text"}
  <div class="group flex flex-col gap-1" data-agent-id="block.text">
    <span class="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-faint">
      dext
      <button
        class="opacity-0 transition-opacity group-hover:opacity-100"
        data-agent-id="block.text.copy"
        onclick={() => copyText(block.text, "Copied reply")}
      >
        copy
      </button>
    </span>
    <div class="space-y-2 text-[15px] leading-relaxed">
      {#each splitFences(block.text) as seg (seg)}
        {#if seg.type === "code"}
          <pre class="overflow-x-auto rounded-xl border border-line bg-panel p-3 font-mono text-xs">{seg.text}</pre>
        {:else}
          {#each seg.text.split(/\n{2,}/) as para (para)}
            <p class="whitespace-pre-line">
              {#each inlineTokens(para) as tk (tk)}
                {#if tk.t === "code"}<code class="rounded bg-raised px-1 font-mono text-[13px]">{tk.s}</code>{:else if tk.t === "bold"}<strong>{tk.s}</strong>{:else}{tk.s}{/if}
              {/each}
            </p>
          {/each}
        {/if}
      {/each}
    </div>
  </div>
{:else if block.kind === "thinking"}
  <details class="group" data-state={block.complete ? "complete" : "thinking"} data-agent-id="block.thinking">
    <summary class="cursor-pointer select-none text-xs hover:text-dim">
      <span class={block.complete ? "text-faint" : "thinking-live font-medium"}>
        {block.complete ? "Thinking (recorded)" : "Thinking…"}
      </span>
    </summary>
    <div class="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap border-l-2 border-line pl-3 text-sm italic text-dim">
      {block.text}
    </div>
  </details>
{:else if block.kind === "tool"}
  {@const st = toolStatus[block.status] ?? { label: block.status, cls: "border-line text-dim" }}
  <div
    class="group space-y-2 rounded-xl border border-line bg-panel p-3 transition-colors hover:border-accent/40"
    data-agent-id={`tool.${block.call_id}`}
    data-state={block.status}
  >
    <div class="flex items-center gap-2 text-sm">
      <span class={`h-2 w-2 shrink-0 rounded-full ${toolDot[block.status] ?? "bg-faint"}`}></span>
      <span class="shrink-0 font-mono text-accent">{block.name}</span>
      <span class="truncate text-dim">{block.summary}</span>
      <span class={`ml-auto shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] ${st.cls}`} data-agent-id={`tool.${block.call_id}.status`}>
        {st.label}
      </span>
      {#if onInspect}
        <button
          class="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          data-agent-id={`tool.${block.call_id}.inspect`}
          onclick={() => onInspect?.(block)}
        >
          raw
        </button>
      {/if}
    </div>
    {#if block.output_tail && looksLikeDiff(block.output_tail)}
      <DiffView text={block.output_tail} compact />
    {:else if block.output_tail}
      <pre class="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg p-2 font-mono text-xs text-dim" data-agent-id={`tool.${block.call_id}.tail`}>{block.output_tail}</pre>
    {/if}
    {#if block.content}
      <details>
        <summary class="cursor-pointer text-xs text-faint hover:text-dim">full output</summary>
        {#if looksLikeDiff(block.content)}
          <div class="mt-1"><DiffView text={block.content} /></div>
        {:else}
          <pre class="mt-1 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg p-2 font-mono text-xs" data-agent-id={`tool.${block.call_id}.content`}>{block.content}</pre>
        {/if}
      </details>
    {/if}
  </div>
{:else if block.kind === "marker"}
  <p class={`flex items-center gap-2 text-sm ${markerColor[block.level] ?? "text-dim"}`} data-agent-id="block.marker">
    <span class="font-mono text-xs">{markerIcon[block.level] ?? "·"}</span>
    {block.text}
  </p>
{:else if block.kind === "slash"}
  <div class="group flex items-start gap-2" data-agent-id="block.slash">
    <pre class="flex-1 overflow-x-auto whitespace-pre-wrap rounded-xl border border-accent/30 bg-accent/5 p-3 font-mono text-xs text-dim">{block.text}</pre>
    <button class="opacity-0 transition-opacity group-hover:opacity-100" data-agent-id="block.slash.copy" onclick={() => copyText(block.text, "Copied output")}>copy</button>
  </div>
{:else if block.kind === "view"}
  <div class="space-y-2 rounded-xl border border-line bg-panel p-3" data-agent-id={`view.${block.pack}`}>
    <p class="flex items-center gap-2 text-xs uppercase tracking-wide text-faint">
      <span class="rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-[10px] normal-case tracking-normal text-accent2">{block.pack}</span>
      {block.title}
    </p>
    <pre class="overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-relaxed">{block.markdown}</pre>
  </div>
{/if}
