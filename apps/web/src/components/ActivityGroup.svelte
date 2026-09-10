<script lang="ts">
  import type { ViewBlock } from "@dextui/client";
  import ActivityTool from "./ActivityTool.svelte";
  import { toolStatusDisplay } from "../lib/display";
  import type { ActivityKind } from "../lib/transcript-groups";

  let {
    id,
    tools,
    activity,
    caption,
    open,
    onToggle,
    getToolOpen,
    setToolOpen,
    onInspect,
    sessionId,
  }: {
    id: number;
    tools: Extract<ViewBlock, { kind: "tool" }>[];
    activity: ActivityKind;
    caption: string;
    open: boolean;
    onToggle: (open: boolean, user: boolean) => void;
    getToolOpen: (tool: Extract<ViewBlock, { kind: "tool" }>) => boolean;
    setToolOpen: (tool: Extract<ViewBlock, { kind: "tool" }>, open: boolean, user?: boolean) => void;
    onInspect?: (b: ViewBlock) => void;
    sessionId: string;
  } = $props();

  const failed = $derived(tools.filter((t) => t.status === "failed").length);
  const running = $derived(tools.filter((t) => t.status === "running" || t.status === "preview").length);
  const imageOk = $derived(tools.filter((tool) => tool.name.toLowerCase() === "read_image" && tool.status === "ok").length);
  const commitOk = $derived(tools.filter((tool) => tool.name.toLowerCase() === "git_commit" && tool.status === "ok").length);
  const singleton = $derived(tools.length === 1 ? tools[0] : undefined);
  const singletonName = $derived(singleton?.name.toLowerCase() ?? "");
  const verb = $derived(
    activity === "web" ? "Browsed web"
      : activity === "image" ? "Viewed image"
      : singletonName === "git_commit" ? "Committed"
      : singletonName === "write_file" ? "Wrote"
      : activity === "edit" ? "Changed"
      : activity === "mixed" ? "Reviewed + changed"
      : "Inspected",
  );
  const completeMark = $derived(activity === "web" ? "↗" : activity === "image" ? "◇" : activity === "read" ? "·" : "✓");
  const completeClass = $derived(activity === "web" ? "st-cyan" : activity === "image" ? "st-magenta" : activity === "read" ? "dim" : "st-green");
  const outcome = $derived(singleton ? toolStatusDisplay(singleton.name, singleton.status, singleton.content) : undefined);
  const specialOutcome = $derived.by(() => {
    if (!singleton || singleton.status !== "ok") return "";
    if (singletonName === "http") {
      const status = singleton.content?.match(/\bHTTP\/\d(?:\.\d)?\s+(\d{3}(?:\s+[^\r\n]+)?)/i)?.[1];
      return status ? `HTTP ${status}` : "";
    }
    if (singletonName === "git_commit") {
      const hash = singleton.content?.match(/^\[[^\]\r\n]*\s([0-9a-f]{7,40})\]/mi)?.[1];
      return hash ? `commit ${hash.slice(0, 8)}` : "";
    }
    return "";
  });
  const outcomeLabel = $derived(specialOutcome || (outcome && outcome.label !== "✓ ok" ? outcome.label.replace(/^[^\w]+\s*/, "") : ""));
</script>

<div
  class="activity"
  class:open
  class:changed={activity === "edit" || activity === "mixed"}
  class:web={activity === "web"}
  class:image={activity === "image"}
  class:failed={failed > 0}
  data-agent-id={`activity.${id}`}
  data-state={failed ? "failed" : running ? "running" : "complete"}
>
  <button class="activity-toggle" type="button" aria-expanded={open} onclick={() => onToggle(!open, true)}>
    <span class="caret" class:open aria-hidden="true">▸</span>
    <span class={failed ? "st-red" : running ? "st-cyan pulse" : completeClass}>
      {failed ? "✗" : running ? "●" : completeMark} {verb}
    </span>
    <span class="activity-caption">{caption}</span>
    <span class="faint activity-count">· {tools.length} {tools.length === 1 ? "call" : "calls"}</span>
    {#if failed}<span class={outcomeLabel ? (outcome?.className ?? "st-red") : "st-red"}>· {outcomeLabel || `${failed} failed`}</span>{:else if running}<span class="st-cyan">· {running} active</span>{:else if outcomeLabel}<span class={outcome?.className ?? "faint"}>· {outcomeLabel}</span>{:else}<span class="faint">· passed</span>{/if}
    {#if !singleton && imageOk}<span class="st-green">· {imageOk === 1 ? "image" : `${imageOk} images`} → context</span>{/if}
    {#if !singleton && commitOk}<span class="faint">· {commitOk} {commitOk === 1 ? "commit" : "commits"}</span>{/if}
  </button>

  {#if open}
    <div class="activity-tools" data-agent-id={`activity.${id}.details`}>
      {#each tools as tool (tool.call_id)}
        <ActivityTool {tool} groupId={id} open={getToolOpen(tool)} onToggle={(open, user) => setToolOpen(tool, open, user)} {onInspect} {sessionId} />
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
  .activity.web { border-left-color: color-mix(in srgb, var(--cyan) 42%, var(--line)); }
  .activity.image { border-left-color: color-mix(in srgb, var(--magenta) 42%, var(--line)); }
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
  @media (max-width: 620px) {
    .activity-count { display: none; }
    .activity-toggle { flex-wrap: wrap; }
    .activity-caption { flex: 1 1 55%; }
  }
</style>
