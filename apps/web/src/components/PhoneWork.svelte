<script lang="ts">
  // Phone-only work summary: one quiet disclosure per turn. Expanded rows wrap
  // inside the card (no inner scrollbars, no sideways panning); full output,
  // command and raw JSON open in the full-screen ToolDetail on tap.
  import type { ViewBlock } from "@dextui/client";
  import Block from "./Block.svelte";
  import { humanizeTool } from "../lib/display";
  import { phoneWorkRows, phoneWorkCounts } from "../lib/phone-presentation";
  let { blocks, working = false, failed = false, open, onToggle, onInspect, sessionId }: { blocks: ViewBlock[]; working?: boolean; failed?: boolean; open: boolean; onToggle: (open: boolean) => void; onInspect?: (block: ViewBlock) => void; sessionId: string } = $props();
  const counts = $derived(phoneWorkCounts(blocks));
  const manyOutcomes = $derived(1 + Number(counts.failed > 0) + Number(counts.running > 0) + Number(counts.pending > 0) > 2);
  const rows = $derived(phoneWorkRows(blocks));
  const guidanceOnly = $derived(rows.length > 0 && rows.every((row) => row.kind === "tip"));
  const summaryTitle = $derived(working ? "Working" : failed ? "Work failed" : guidanceOnly ? "Work guidance" : "Work details");
  const summaryLabel = $derived(`${summaryTitle}${counts.total ? ` · ${counts.total} ${counts.total === 1 ? "step" : "steps"} · ${counts.passed} passed${counts.failed ? ` · ${counts.failed} failed` : ""}${counts.running ? ` · ${counts.running} running` : ""}${counts.pending ? ` · ${counts.pending} pending` : ""}` : " · Runtime notes"}`);
  // Very long turns show the newest rows first; earlier ones stay one tap away.
  const LIMIT = 24;
  const KEEP = 16;
  let showAll = $state(false);
  const hiddenRows = $derived(!showAll && rows.length > LIMIT ? rows.length - KEEP : 0);
  const shown = $derived(hiddenRows ? rows.slice(hiddenRows) : rows);
  const isShell = (name: string) => /^(bash|sh|shell)$/i.test(name);
</script>

<section class="work" data-agent-id={`phone.work.${blocks[0]?.id}`} data-state={working ? "working" : failed ? "failed" : "complete"}>
  <button class="summary" class:many-outcomes={manyOutcomes} aria-label={summaryLabel} aria-expanded={open} onclick={() => onToggle(!open)}>
    <span class="caret" class:open aria-hidden="true">›</span>
    <span class="summary-top">
      <span class="identity">
        <span class="headline" class:failure={failed}>{summaryTitle}</span>
        {#if counts.total}<span class="count" data-agent-id="phone.summary.steps"><span aria-hidden="true">·</span>{counts.total} {counts.total === 1 ? "step" : "steps"}</span>{/if}
      </span>
      {#if counts.total}
        <span class="outcomes" data-agent-id="phone.summary.outcomes">
          <span class="outcome passed" data-agent-id="phone.summary.passed"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg><span>{counts.passed}<span class="outcome-label">{" passed"}</span></span></span>
          {#if counts.failed}<span class="outcome failed" data-agent-id="phone.summary.failed"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg><span>{counts.failed}<span class="outcome-label">{" failed"}</span></span></span>{/if}
          {#if counts.running}<span class="outcome running" data-agent-id="phone.summary.running"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5" /><path d="M8 5v3l2 1" /></svg><span>{counts.running}<span class="outcome-label">{" running"}</span></span></span>{/if}
          {#if counts.pending}<span class="outcome pending" data-agent-id="phone.summary.pending"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5" /></svg><span>{counts.pending}<span class="outcome-label">{" pending"}</span></span></span>{/if}
        </span>
      {/if}
    </span>
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
              <span class="step-name">{block.name}{block.status === "failed" ? " · failed" : block.status === "running" ? " · running" : block.status === "preview" ? " · pending" : ""}</span>
            </span>
            <span class="chev" aria-hidden="true">›</span>
          </button>
        {:else if row.kind === "tip"}
          <details class="tip" class:warning={row.warning} data-agent-id="phone.work.tip">
            <summary><span class="tip-k">Bash tip</span><span class="tip-text">{row.summary}</span>{#if row.count > 1}<span class="tip-n">×{row.count}</span>{/if}</summary>
            <p>{row.text}</p>
          </details>
        {:else}
          <div class="row" class:notice={row.block.kind === "marker" && row.block.level !== "info" && row.block.level !== "note"}><Block block={row.block} {onInspect} {sessionId} /></div>
        {/if}
      {/each}
    </div>
  {/if}
</section>

<style>
  .work { container: phone-work / inline-size; border: 1px solid var(--line); background: var(--bg1); border-radius: 6px; min-width: 0; max-width: 100%; overflow: hidden; }
  .summary { min-width: 0; display: grid; grid-template-columns: 10px minmax(0, 1fr); align-items: center; width: 100%; gap: 8px; padding: 0 12px; min-height: 44px; font: 13px/1.4 var(--sans); color: var(--dim); }
  .caret { width: 10px; color: var(--faint); transition: rotate 0.12s ease-out; }
  .caret.open { rotate: 90deg; }
  .summary-top { min-width: 0; display: flex; align-items: center; gap: 8px; }
  .identity { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; }
  .headline { flex: 0 1 auto; min-width: 0; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .count { flex: none; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; color: var(--dim); font-size: 11px; font-variant-numeric: tabular-nums; }
  .outcomes { flex: none; display: flex; flex-wrap: nowrap; align-items: center; gap: 10px; font: 12px/1.4 var(--sans); font-variant-numeric: tabular-nums; }
  .outcome { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
  .outcome svg { flex: none; width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .passed { color: var(--green); }
  .failed { color: var(--red); }
  .running { color: var(--cyan); }
  .pending { color: var(--dim); }
  @container phone-work (max-width: 500px) {
    /* Keep the title and step total visible before compacting outcome wording.
       Full outcome labels also remain in the button's accessible name. */
    .many-outcomes .outcome-label { display: none; }
  }
  @container phone-work (max-width: 350px) {
    .outcome-label { display: none; }
    .outcomes { gap: 4px; font-size: 11px; }
    .outcome { gap: 3px; }
    .outcome svg { width: 10px; height: 10px; }
    .headline { font-size: 12px; }
    .identity { gap: 4px; }
    .summary-top { gap: 6px; }
  }
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
  .row { padding: 0 12px; overflow-wrap: anywhere; }
  .row.notice { padding-block: 6px; }
  .tip { padding: 0 12px; color: var(--dim); font: 12px/1.45 var(--sans); }
  .tip summary { display: flex; align-items: center; gap: 8px; min-height: 44px; cursor: pointer; list-style: none; min-width: 0; }
  .tip summary::-webkit-details-marker { display: none; }
  .tip-k { flex: none; padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, var(--cyan) 12%, transparent); color: var(--cyan); font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; line-height: 16px; }
  .tip.warning .tip-k { color: var(--yellow); background: color-mix(in srgb, var(--yellow) 12%, transparent); }
  .tip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tip[open] .tip-text { white-space: normal; overflow-wrap: anywhere; }
  .tip-n { flex: none; color: var(--faint); font-size: 11px; }
  .tip p { margin: 0 0 8px; padding-left: 10px; border-left: 2px solid var(--line); white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
