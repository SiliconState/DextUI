<script lang="ts">
  // Phone-only work summary: one quiet disclosure per turn. Expanded rows wrap
  // inside the card (no inner scrollbars, no sideways panning); full output,
  // command and raw JSON open in the full-screen ToolDetail on tap.
  import type { ViewBlock } from "@dextui/client";
  import Block from "./Block.svelte";
  import { humanizeTool } from "../lib/display";
  import { phoneWorkRows } from "../lib/phone-presentation";
  let { blocks, working = false, failed = false, open, onToggle, onInspect, sessionId }: { blocks: ViewBlock[]; working?: boolean; failed?: boolean; open: boolean; onToggle: (open: boolean) => void; onInspect?: (block: ViewBlock) => void; sessionId: string } = $props();
  const tools = $derived(blocks.filter((block) => block.kind === "tool"));
  const unsuccessful = $derived(tools.filter((tool) => tool.status === "failed").length);
  const active = $derived(tools.filter((tool) => tool.status === "running" || tool.status === "preview").at(-1));
  const rows = $derived(phoneWorkRows(blocks));
  // Very long turns show the newest rows first; earlier ones stay one tap away.
  const LIMIT = 24;
  const KEEP = 16;
  let showAll = $state(false);
  const hiddenRows = $derived(!showAll && rows.length > LIMIT ? rows.length - KEEP : 0);
  const shown = $derived(hiddenRows ? rows.slice(hiddenRows) : rows);
  const isShell = (name: string) => /^(bash|sh|shell)$/i.test(name);
</script>

<section class="work" data-agent-id={`phone.work.${blocks[0]?.id}`} data-state={working ? "working" : failed ? "failed" : "complete"}>
  <button class="summary" aria-expanded={open} onclick={() => onToggle(!open)}>
    <span class="caret" class:open aria-hidden="true">›</span>
    <span class="headline" class:failure={failed}>{working ? "Working" : failed ? "Work failed" : "Work details"}<span class="count"> · {tools.length} {tools.length === 1 ? "step" : "steps"}{unsuccessful ? ` · ${unsuccessful} unsuccessful` : ""}</span></span>
    {#if active}<span class="active">{humanizeTool(active.name, active.summary) || active.name}</span>{/if}
  </button>
  {#if open}
    <div class="details">
      {#if hiddenRows}<button class="earlier" data-agent-id="phone.work.earlier" onclick={() => (showAll = true)}>Show {hiddenRows} earlier</button>{/if}
      {#each shown as row (row.id)}
        {#if row.kind === "step"}
          {@const block = row.block}
          <button class="step" data-agent-id={`phone.tool.${block.call_id}`} data-state={block.status} onclick={() => onInspect?.(block)}>
            <span class="mark" aria-hidden="true">{block.status === "ok" ? "✓" : block.status === "failed" ? "!" : "●"}</span>
            <span class="step-text">
              <span class="step-label" class:cmd={isShell(block.name)}>{humanizeTool(block.name, block.summary) || block.name}</span>
              <span class="step-name">{block.name}{block.status === "failed" ? " · unsuccessful" : block.status === "running" ? " · running" : ""}</span>
            </span>
            <span class="chev" aria-hidden="true">›</span>
          </button>
        {:else if row.kind === "tip"}
          <details class="tip" data-agent-id="phone.work.tip">
            <summary><span class="tip-k">Tip</span><span class="tip-text">{row.summary}</span>{#if row.count > 1}<span class="tip-n">×{row.count}</span>{/if}</summary>
            <p>{row.text}</p>
          </details>
        {:else}
          <div class="row"><Block block={row.block} {onInspect} {sessionId} /></div>
        {/if}
      {/each}
    </div>
  {/if}
</section>

<style>
  .work { border: 1px solid var(--line); background: var(--bg1); border-radius: 6px; min-width: 0; max-width: 100%; overflow: hidden; }
  .summary { min-width: 0; display: flex; align-items: center; width: 100%; gap: 8px; padding: 0 12px; min-height: 44px; font: 13px/1.4 var(--sans); color: var(--dim); }
  .caret { flex: none; width: 10px; color: var(--faint); transition: rotate 0.12s ease-out; }
  .caret.open { rotate: 90deg; }
  .headline { min-width: 0; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .count { color: var(--dim); }
  .active { flex: 0 1 40%; min-width: 0; margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11px var(--mono); color: var(--cyan); }
  .failure { color: var(--red); }
  .details { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); border-top: 1px solid var(--line); padding: 2px 0 6px; }
  .details > * { min-width: 0; max-width: 100%; }
  .earlier { min-height: 44px; padding: 0 12px; color: var(--cyan); font: 13px var(--sans); text-align: left; }
  .step { display: grid; grid-template-columns: 16px minmax(0, 1fr) 10px; align-items: center; gap: 8px; width: 100%; min-height: 44px; padding: 6px 12px; text-align: left; }
  .step + .step { border-top: 1px solid color-mix(in srgb, var(--line) 55%, transparent); }
  .mark { color: var(--green); font-size: 12px; text-align: center; }
  .step[data-state="failed"] .mark { color: var(--yellow); }
  .step[data-state="running"] .mark, .step[data-state="preview"] .mark { color: var(--cyan); }
  .step-text { min-width: 0; display: grid; gap: 1px; }
  .step-label { min-width: 0; font: 13px/1.35 var(--sans); color: var(--fg); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .step-label.cmd { font: 12px/1.4 var(--mono); }
  .step-name { min-width: 0; font: 11px/1.3 var(--mono); color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chev { color: var(--faint); }
  .row { padding: 4px 12px; overflow-wrap: anywhere; }
  .tip { padding: 0 12px; color: var(--dim); font: 12px/1.45 var(--sans); }
  .tip summary { display: flex; align-items: center; gap: 8px; min-height: 44px; cursor: pointer; list-style: none; min-width: 0; }
  .tip summary::-webkit-details-marker { display: none; }
  .tip-k { flex: none; padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, var(--cyan) 12%, transparent); color: var(--cyan); font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; line-height: 16px; }
  .tip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tip[open] .tip-text { white-space: normal; overflow-wrap: anywhere; }
  .tip-n { flex: none; color: var(--faint); font-size: 11px; }
  .tip p { margin: 0 0 8px; padding-left: 10px; border-left: 2px solid var(--line); white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
