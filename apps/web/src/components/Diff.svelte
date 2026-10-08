<script lang="ts">
  // Inline desktop diff; the phone launcher opens a modal with one scroll surface.
  import { app } from "../lib/state.svelte";
  import { useDialog } from "../lib/dialog.svelte";
  let { text, expanded = false, controls = true, wrap = $bindable(true) }: { text: string; expanded?: boolean; controls?: boolean; wrap?: boolean } = $props();
  let show = $state(false);
  let launcher = $state<HTMLButtonElement | null>(null);
  const dlg = useDialog(() => show, () => launcher);
  $effect(() => {
    if (!show) return;
    app.inlineDiffOpen = true;
    return () => { app.inlineDiffOpen = false; };
  });
  $effect(() => { void app.activeId; void app.hostEpoch; show = false; });
  // The launcher can live under an inert transcript. Mount the modal outside
  // that ancestor, otherwise the background isolation also disables the viewer.
  function portal(node: HTMLElement) {
    (document.getElementById("app") ?? document.body).appendChild(node);
    return { destroy: () => node.remove() };
  }
  const files = $derived([...text.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)].map((match) => match[1]).filter((path) => path !== "/dev/null"));
  const adds = $derived(text.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length);
  const dels = $derived(text.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length);
  function onKey(e: KeyboardEvent) {
    dlg.onKey(e);
    if (e.key === "Escape") { show = false; e.preventDefault(); }
    e.stopPropagation();
  }

  interface DLine {
    kind: "add" | "del" | "hunk" | "file" | "ctx";
    text: string;
  }

  const lines = $derived.by<DLine[]>(() => {
    const out: DLine[] = [];
    for (const line of text.split("\n")) {
      if (line.startsWith("@@")) out.push({ kind: "hunk", text: line });
      else if (line.startsWith("+++") || line.startsWith("---")) {
        const m = /^[++-]{3} (?:a\/)?(\S+)/.exec(line);
        if (m?.[1] && m[1] !== "/dev/null") {
          if (line.startsWith("+++")) out.push({ kind: "file", text: `─ ${m[1]}` });
        }
      } else if (line.startsWith("diff --git")) {
        // superseded by the +++ path line
      } else if (line.startsWith("+")) out.push({ kind: "add", text: line });
      else if (line.startsWith("-")) out.push({ kind: "del", text: line });
      else out.push({ kind: "ctx", text: line });
    }
    return out;
  });
</script>

{#snippet renderLines()}
  {#each lines as l, i (i)}<div class={`d-${l.kind}`}><span class="d-text">{l.text}</span></div>{/each}
{/snippet}
<div class="diff" class:expanded class:wrap={expanded && wrap} data-agent-id="diff.view">
  {@render renderLines()}
</div>
{#if !expanded}<button class="diff-launch" bind:this={launcher} data-agent-id="diff.open" onclick={() => (show = true)}><span>{files.length ? files.join(", ") : "Changes"}</span><span class="st-green">+{adds}</span><span class="st-red">−{dels}</span><span>Open diff ›</span></button>{/if}
{#if expanded && controls}<button class="act wrap-control" data-agent-id="diff.wrap" aria-pressed={wrap} onclick={() => (wrap = !wrap)}>{wrap ? "Wrap on" : "Wrap off"}</button>{/if}
{#if show}
  <div class="diff-scrim" use:portal role="presentation" onclick={() => (show = false)} data-agent-id="diff.scrim"></div>
  <div class="insp diff-sheet" use:portal role="dialog" aria-modal="true" aria-label="File changes" tabindex="-1" use:dlg.ref onkeydown={onKey} data-agent-id="diff.overlay">
    <div class="insp-head"><span>File changes · +{adds} / −{dels}</span><span class="insp-acts"><button class="act" aria-pressed={wrap} onclick={() => (wrap = !wrap)}>{wrap ? "Wrap on" : "Wrap off"}</button><button class="act" data-agent-id="diff.close" onclick={() => (show = false)}>Back</button></span></div>
    <div class="diff-body" class:wrap>{@render renderLines()}</div>
  </div>
{/if}

<style>
  .diff {
    overflow-x: auto;
    white-space: pre;
    max-height: 20rem;
    overflow-y: auto;
    font-size: 12px;
  }
  .diff.expanded { max-height: none; overflow: visible; min-width: 0; }
  .diff.wrap, .wrap .d-text { white-space: pre-wrap; overflow-wrap: anywhere; }
  .diff-launch { display: none; }
  .diff-scrim { position: fixed; inset: 0; z-index: 37; background: color-mix(in srgb, var(--bg) 55%, transparent); }
  .diff-sheet { z-index: 38; }
  .diff-body { flex: 1; min-height: 0; overflow: auto; padding: 12px; font: 12px/1.6 var(--mono); white-space: pre; }
  .diff-body.wrap { white-space: pre-wrap; overflow-wrap: anywhere; }
  .diff-sheet .insp-head { flex: none; min-width: 0; }
  .diff-sheet .insp-head > span:first-child { min-width: 0; overflow-wrap: anywhere; }
  .diff-sheet .insp-acts { flex: none; }
  .diff-sheet .act { min-height: 44px; }
  .wrap-control { margin-block: 8px; padding: 6px 10px; border: 1px solid var(--line); }
  .insp-acts { display: flex; gap: 12px; }
  @media (max-width: 600px) {
    .diff:not(.expanded) { display: none; }
    .diff-launch { display: flex; flex-wrap: wrap; gap: 8px; width: 100%; min-height: 44px; align-items: center; padding: 8px; background: var(--bg2); border: 1px solid var(--line); border-radius: 5px; font-size: 12px; }
    .diff-launch > :first-child { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  }
  .d-text {
    white-space: pre;
  }
  .d-add {
    color: var(--green);
    background: color-mix(in srgb, var(--green) 7%, transparent);
  }
  .d-del {
    color: var(--red);
    background: color-mix(in srgb, var(--red) 7%, transparent);
  }
  .d-hunk {
    color: var(--blue);
  }
  .d-file {
    color: var(--dim);
  }
  .d-ctx {
    color: var(--dim);
  }
</style>
