<script lang="ts">
  import type { SessionState, ViewBlock } from "@dextui/client";
  import { copyText } from "../lib/state.svelte";
  import { readableOutput, toolResultMetadata } from "../lib/phone-presentation";
  import Diff from "./Diff.svelte";
  import { looksLikeDiff } from "../lib/display";
  let { block, view }: { block: ViewBlock; view: SessionState | null } = $props();
  let tab = $state<"command" | "output" | "raw">("output");
  let query = $state("");
  let wrap = $state(true);
  const raw = $derived(JSON.stringify(block, null, 2));
  const output = $derived(readableOutput(block.kind === "tool" ? block.content ?? block.output_tail ?? (block.status === "running" || block.status === "preview" ? "No output yet." : "No output.") : raw));
  const command = $derived(block.kind === "tool" ? block.summary : "text" in block ? block.text : raw);
  const text = $derived(tab === "raw" ? raw : tab === "command" ? command : output);
  const lines = $derived(text.split("\n"));
  const filtered = $derived(query ? lines.map((text, index) => ({ text, index })).filter((line) => line.text.toLowerCase().includes(query.toLowerCase())).map((line) => `${line.index + 1}  ${line.text}`).join("\n") : text);
  const metadata = $derived(toolResultMetadata(block, view?.recent));
</script>

<div class="detail" data-agent-id="tool.detail">
  {#if block.kind === "tool"}<div class="metadata">{block.status}{metadata.exitCode !== undefined ? ` · exit ${metadata.exitCode}` : ""}{metadata.duration !== undefined ? ` · ${metadata.duration.toFixed(1)}s` : ""}</div>{/if}
  <div class="tabs" role="group" aria-label="Tool detail view">
    {#each ["command", "output", "raw"] as value}<button class:active={tab === value} aria-pressed={tab === value} data-agent-id={`tool.detail.${value}`} onclick={() => { tab = value as typeof tab; query = ""; }}>{value === "command" ? "Command" : value === "output" ? "Output" : "Raw"}</button>{/each}
    <button class="copy" data-agent-id="tool.detail.copy" onclick={() => copyText(text, "Copied")}>Copy</button>
  </div>
  <label class="search"><span class="sr-only">Search tool detail</span><input type="search" bind:value={query} placeholder="Search output…" data-agent-id="tool.detail.search" />{#if query}<span>{filtered ? filtered.split("\n").length : 0} lines</span>{/if}</label>
  {#if tab === "output" && !query && looksLikeDiff(output)}<div class="diff-options"><span>File changes</span><button class="act" data-agent-id="diff.wrap" aria-pressed={wrap} onclick={() => (wrap = !wrap)}>{wrap ? "Wrap on" : "Wrap off"}</button></div>{/if}
  <div class="output" data-agent-id="tool.detail.body">
    {#if tab === "output" && !query && looksLikeDiff(output)}<Diff text={output} expanded controls={false} bind:wrap />{:else}<pre data-agent-id={tab === "raw" ? "drawer.block.json" : "tool.detail.text"}>{query ? filtered || "No matching lines." : text || "No output."}</pre>{/if}
  </div>
</div>

<style>
  .detail { min-width: 0; display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .metadata { padding: 8px 12px; color: var(--dim); font-size: 12px; }
  .tabs { min-width: 0; flex-wrap: wrap; display: flex; gap: 6px; padding: 0 12px 8px; border-bottom: 1px solid var(--line); }
  .tabs button { min-width: 0; padding: 6px 10px; border: 1px solid var(--line); border-radius: 4px; }
  .tabs .active { color: var(--cyan); background: var(--bg2); }
  .copy { margin-left: auto; }
  .diff-options { display: flex; align-items: center; justify-content: space-between; min-height: 44px; padding: 6px 12px; color: var(--dim); font-size: 12px; }
  .diff-options button { min-height: 44px; padding-inline: 8px; }
  .search { min-width: 0; display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--line); color: var(--dim); }
  input { flex: 1; min-width: 0; }
  .output { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
  @media (max-width: 900px) { .tabs button { min-height: 44px; } .search input { min-height: 44px; } }
  pre { min-width: 0; font: 12px/1.6 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--fg); }
</style>
