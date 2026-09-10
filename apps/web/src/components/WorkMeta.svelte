<script lang="ts">
  import type { ViewBlock } from "@dextui/client";
  import { parseRunMeta } from "../lib/display";

  let {
    id,
    blocks,
    open,
    onToggle,
  }: {
    id: number;
    blocks: Extract<ViewBlock, { kind: "marker" }>[];
    open: boolean;
    onToggle: (open: boolean, user: boolean) => void;
  } = $props();

  const parsed = $derived(blocks.map((b) => ({ block: b, meta: parseRunMeta(b.text) })).filter((x) => !!x.meta));
  const objective = $derived(parsed.find((x) => x.meta?.objective)?.meta?.objective ?? "");
  const latestPhase = $derived([...parsed].reverse().find((x) => x.meta?.phase)?.meta);
</script>

<div class="work-meta" data-agent-id={`activity.meta.${id}`}>
  <button class="meta-toggle" type="button" aria-expanded={open} onclick={() => onToggle(!open, true)}>
    <span class="caret" class:open aria-hidden="true">▸</span>
    {#if objective}<span class="meta-k">objective</span><span class="meta-line">{objective}</span>{/if}
    {#if latestPhase}<span class="meta-k phase">phase</span><span class="meta-pill">{latestPhase.phase}</span>{/if}
    {#if blocks.length > 1}<span class="faint count">· {blocks.length} updates</span>{/if}
  </button>
  {#if open}
    <div class="meta-history" data-agent-id={`activity.meta.${id}.details`}>
      {#each parsed as entry (entry.block.id)}
        {#if entry.meta?.objective}
          <div><span class="meta-k">objective</span><span>{entry.meta.objective}</span></div>
          {#each entry.meta.checkpoints as checkpoint}<div class="checkpoint"><span class="faint">—</span><span>{checkpoint}</span></div>{/each}
        {:else if entry.meta?.phase}
          <div><span class="meta-k">phase</span><span class="meta-pill">{entry.meta.phase}</span>{#if entry.meta.note}<span class="dim">— {entry.meta.note}</span>{/if}</div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .work-meta { width: 100%; color: var(--faint); font-size: 11px; }
  .meta-toggle {
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
    padding: 0;
  }
  .caret { display: inline-block; flex: 0 0 auto; transition: rotate 0.12s ease-out; }
  .caret.open { rotate: 90deg; }
  .meta-k { color: var(--faint); text-transform: lowercase; letter-spacing: 0.04em; flex: 0 0 auto; }
  .meta-k.phase { margin-left: 4px; }
  .meta-line { min-width: 0; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta-pill { color: var(--dim); border: 1px solid var(--line); padding: 0 4px; flex: 0 0 auto; }
  .count { flex: 0 0 auto; }
  .meta-history { display: grid; gap: 3px; margin: 5px 0 2px 13px; padding-left: 9px; border-left: 1px solid var(--line); color: var(--dim); }
  .meta-history > div { display: flex; align-items: baseline; gap: 7px; }
  .checkpoint { padding-left: 12px; }
  @media (max-width: 620px) {
    .count, .meta-k.phase { display: none; }
    .meta-toggle { flex-wrap: wrap; }
    .meta-line { flex: 1 1 70%; }
  }
</style>
