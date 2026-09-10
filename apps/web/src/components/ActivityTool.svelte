<script lang="ts">
  import type { ViewBlock } from "@dextui/client";
  import Block from "./Block.svelte";
  import { humanizeTool, toolStatusDisplay } from "../lib/display";

  let {
    tool,
    groupId,
    onInspect,
    sessionId,
  }: {
    tool: Extract<ViewBlock, { kind: "tool" }>;
    groupId: number;
    onInspect?: (b: ViewBlock) => void;
    sessionId: string;
  } = $props();

  const status = $derived(toolStatusDisplay(tool.name, tool.status, tool.content));
  let open = $state(false);
  let touched = $state(false);

  // A failure that arrives while this keyed row is mounted must break through
  // the fold, unless the user has deliberately toggled this exact call.
  $effect(() => {
    if (tool.status === "failed" && !touched) open = true;
  });
</script>

<div class="activity-tool" data-agent-id={`activity.${groupId}.tool.${tool.call_id}`}>
  <div class="activity-tool-head">
    <button
      class="activity-tool-toggle"
      type="button"
      aria-expanded={open}
      onclick={() => { touched = true; open = !open; }}
    >
      <span class="caret" class:open aria-hidden="true">▸</span>
      <span class="tool-name">{tool.name}</span>
      <span class="dim tool-label">{humanizeTool(tool.name, tool.summary)}</span>
      <span class={status.className}>{status.label}</span>
    </button>
    {#if onInspect}<button class="raw" type="button" data-agent-id={`activity.${groupId}.tool.${tool.call_id}.inspect`} onclick={() => onInspect?.(tool)}>Raw</button>{/if}
  </div>
  {#if open}
    <div class="activity-tool-body"><Block block={tool} {onInspect} {sessionId} /></div>
  {/if}
</div>

<style>
  .activity-tool { min-width: 0; }
  .activity-tool-head { display: flex; align-items: baseline; gap: 6px; }
  .activity-tool-toggle {
    display: flex;
    width: 100%;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    cursor: pointer;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    font: inherit;
    font-size: 12px;
    padding: 2px 0;
  }
  .caret { display: inline-block; flex: 0 0 auto; transition: rotate 0.12s ease-out; color: var(--faint); }
  .caret.open { rotate: 90deg; }
  .tool-name { color: var(--fg); flex: 0 0 auto; }
  .tool-label { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .raw { flex: 0 0 auto; border: 0; background: transparent; color: var(--faint); font: inherit; font-size: 11px; padding: 1px 3px; }
  .raw:hover { color: var(--fg); }
  .activity-tool-body { margin: 2px 0 7px 13px; }
  .activity-tool-body :global(.tool-head) { display: none; }
</style>
