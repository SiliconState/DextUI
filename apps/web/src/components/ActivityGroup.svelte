<script lang="ts">
  import type { ViewBlock } from "@dextui/client";
  import ActivityTool from "./ActivityTool.svelte";
  import Block from "./Block.svelte";
  import type { ActivityKind } from "../lib/transcript-groups";

  let {
    id,
    tools,
    activity,
    caption,
    progress,
    open,
    onToggle,
    onInspect,
    sessionId,
  }: {
    id: number;
    tools: Extract<ViewBlock, { kind: "tool" }>[];
    activity: ActivityKind;
    caption: string;
    progress?: Extract<ViewBlock, { kind: "text" }>;
    open: boolean;
    onToggle: (open: boolean, user: boolean) => void;
    onInspect?: (b: ViewBlock) => void;
    sessionId: string;
  } = $props();

  const failed = $derived(tools.filter((t) => t.status === "failed").length);
  const running = $derived(tools.filter((t) => t.status === "running" || t.status === "preview").length);
  const verb = $derived(activity === "edit" ? "Changed" : activity === "mixed" ? "Reviewed + changed" : "Inspected");
  // Do not echo a short caption verbatim inside its own expansion. Preserve the
  // original prose only when the compact caption actually shortened/normalized
  // it (long text or meaningful Markdown), so no information is lost.
  const showProgress = $derived(!!progress && progress.text.replace(/\s+/g, " ").trim() !== caption);
</script>

<div
  class="activity"
  class:open
  class:changed={activity !== "read"}
  class:failed={failed > 0}
  data-agent-id={`activity.${id}`}
  data-state={failed ? "failed" : running ? "running" : "complete"}
>
  <button class="activity-toggle" type="button" aria-expanded={open} onclick={() => onToggle(!open, true)}>
    <span class="caret" class:open aria-hidden="true">▸</span>
    <span class={failed ? "st-red" : running ? "st-cyan pulse" : activity === "read" ? "dim" : "st-green"}>
      {failed ? "✗" : running ? "●" : activity === "read" ? "·" : "✓"} {verb}
    </span>
    <span class="activity-caption">{caption}</span>
    <span class="faint activity-count">· {tools.length} {tools.length === 1 ? "call" : "calls"}</span>
    {#if failed}<span class="st-red">· {failed} failed</span>{:else if running}<span class="st-cyan">· {running} active</span>{:else}<span class="faint">· passed</span>{/if}
  </button>

  {#if open}
    <div class="activity-tools" data-agent-id={`activity.${id}.details`}>
      {#if showProgress && progress}<div class="activity-progress"><Block block={progress} {onInspect} {sessionId} /></div>{/if}
      {#each tools as tool (tool.call_id)}
        <ActivityTool {tool} groupId={id} {onInspect} {sessionId} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .activity {
    width: 100%;
    border-left: 2px solid color-mix(in srgb, var(--dim) 30%, var(--line));
    padding: 2px 0 2px 9px;
  }
  .activity.changed { border-left-color: color-mix(in srgb, var(--green) 45%, var(--line)); }
  .activity.failed { border-left-color: color-mix(in srgb, var(--red) 60%, var(--line)); }
  .activity-toggle {
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
    padding: 0;
  }
  .caret { display: inline-block; flex: 0 0 auto; transition: rotate 0.12s ease-out; color: var(--faint); }
  .caret.open { rotate: 90deg; }
  .activity-caption { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dim); }
  .activity-count { flex: 0 0 auto; }
  .activity-tools { display: grid; gap: 2px; margin: 5px 0 2px 8px; }
  .activity-progress { padding: 1px 0 5px 13px; border-left: 1px solid var(--line); }
  .activity-progress :global(.b-text) { color: var(--dim); font-size: 12px; }
  @media (max-width: 620px) {
    .activity-count { display: none; }
    .activity-toggle { flex-wrap: wrap; }
    .activity-caption { flex: 1 1 55%; }
  }
</style>
