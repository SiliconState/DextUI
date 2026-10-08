<script lang="ts">
  import { tick } from "svelte";
  import { app, copyText } from "../lib/state.svelte";
  import { diagramIssue, diagramScale, diagramSourceForWidth, type DiagramResult, type DiagramPalette } from "../lib/mermaid-policy";
  import { loadDiagramRenderer } from "../lib/mermaid-loader";

  let { source, closed, complete = true }: { source: string; closed: boolean; complete?: boolean } = $props();
  let root = $state<HTMLElement | null>(null);
  let visible = $state(false);
  let width = $state(320);
  let result = $state<DiagramResult | null>(null);
  let url = $state("");
  let loading = $state(false);
  let error = $state("");
  let readable = $state(false);
  let showSource = $state(false);
  let retry = $state(0);
  const issue = $derived(closed ? diagramIssue(source) : null);
  const displaySource = $derived(diagramSourceForWidth(source, width < 600));
  const verticalFit = $derived(displaySource !== source);
  const fitScale = $derived(result ? diagramScale(result.width, result.height, width, 420) : 1);
  const scale = $derived(readable ? 1 : fitScale);
  const status = $derived(!closed ? complete ? "Incomplete diagram. Source preserved." : "Diagram · drawing…" : issue ?? (error || (loading ? "Rendering diagram…" : "Diagram loads when visible.")));

  $effect(() => {
    const node = root;
    if (!node) return;
    const resize = new ResizeObserver(([entry]) => { if (entry) width = entry.contentRect.width; });
    resize.observe(node);
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => { visible = !!entry?.isIntersecting; });
    if (observer) observer.observe(node);
    else visible = true;
    return () => { resize.disconnect(); observer?.disconnect(); };
  });

  // Only a wide/narrow orientation change re-runs layout. Other width/zoom
  // changes reuse the SVG; hidden theme updates wait until visible.
  let sourceSeen = "";
  let attemptedKey = "";
  $effect(() => {
    const text = source;
    if (text === sourceSeen) return;
    sourceSeen = text;
    result = null; url = ""; error = ""; readable = false; showSource = false; attemptedKey = "";
  });
  $effect(() => {
    const image = url;
    return () => { if (image) URL.revokeObjectURL(image); };
  });
  $effect(() => {
    const text = displaySource;
    const original = source;
    const ready = closed;
    const theme = app.resolvedTheme;
    const scope = app.hostEpoch;
    const attempt = retry;
    if (!visible || !ready || issue || app.needsToken) return;
    const key = `${scope}:${theme}:${attempt}:${original}:${text}`;
    if (key === attemptedKey) return;
    let current = true;
    error = "";
    loading = true;
    const css = getComputedStyle(document.documentElement);
    const token = (name: string) => css.getPropertyValue(name).trim();
    const palette: DiagramPalette = { background: token("--bg1"), surface: token("--bg2"), text: token("--fg"), border: token("--cyan"), accent: token("--blue"), line: token("--dim"), dark: theme !== "light" };
    // Let the browser finish painting/scrolling before downloading or parsing.
    const timer = setTimeout(() => {
      void loadDiagramRenderer().then((renderer) => {
        if (!current) return null;
        return renderer.renderDiagram(text, palette, () => current, scope);
      }).then((rendered) => {
        if (!current || !rendered) return;
        attemptedKey = key;
        result = rendered;
        url = URL.createObjectURL(new Blob([rendered.svg], { type: "image/svg+xml" }));
      }).catch(() => {
        if (current) { attemptedKey = key; error = "Diagram could not render. Check the source or retry when online."; result = null; url = ""; }
      }).finally(() => { if (current) loading = false; });
    }, 100);
    return () => { current = false; clearTimeout(timer); loading = false; };
  });

  function toggleReadable() {
    readable = !readable;
    void tick().then(() => root?.querySelector<HTMLElement>(".diagram-canvas")?.scrollTo({ top: 0, left: 0 }));
  }
</script>

<section class="diagram" bind:this={root} data-agent-id="markdown.mermaid" data-state={!closed ? "pending" : issue || error ? "fallback" : loading ? "loading" : url ? "rendered" : "loading"} aria-label="Mermaid diagram">
  <div class="diagram-head">
    <span class="diagram-label">Diagram{verticalFit ? " · vertical fit" : ""}</span>
    {#if url && !issue && !error}<button type="button" data-agent-id="mermaid.zoom" aria-pressed={readable} onclick={toggleReadable}>{readable ? "Fit" : "Zoom"}</button>{/if}
    <button type="button" data-agent-id="mermaid.source.toggle" aria-expanded={showSource} onclick={() => (showSource = !showSource)}>{showSource ? "Hide source" : "Source"}</button>
    <button type="button" data-agent-id="mermaid.copy" onclick={() => copyText(source, "Copied diagram source")}>Copy</button>
  </div>
  {#if !closed || issue || error || !url}
    <p class="diagram-status" role="status" data-agent-id="mermaid.status">{status}</p>
    {#if error && !issue}<button class="retry" type="button" data-agent-id="mermaid.retry" onclick={() => (retry += 1)}>Retry diagram</button>{/if}
  {:else}
    <!-- Keyboard users must be able to pan the zoomed scroll region. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="diagram-canvas" class:readable tabindex={readable ? 0 : -1} role="region" aria-label={readable ? "Diagram at readable size, scroll to pan" : "Diagram fitted to message width"} data-agent-id="mermaid.canvas">
      {#key url}<img src={url} alt="Rendered Mermaid diagram; original text is available with Source" width={Math.max(1, Math.round(result!.width * scale))} height={Math.max(1, Math.round(result!.height * scale))} data-agent-id="mermaid.image" onerror={(event) => { if (event.currentTarget instanceof HTMLImageElement && event.currentTarget.src === url) { error = "Diagram image could not display. Source preserved."; url = ""; } }} />{/key}
    </div>
    {#if loading}<p class="diagram-status" role="status">Updating diagram…</p>{/if}
  {/if}
  {#if showSource || issue || error || (!closed && complete)}<pre class="diagram-source" data-agent-id="mermaid.source">{source}</pre>{/if}
</section>

<style>
  .diagram { min-width: 0; max-width: 100%; border: 1px solid var(--line); border-radius: 3px; background: var(--bg1); overflow: hidden; font: 12px/1.4 var(--sans); }
  .diagram-head { display: flex; align-items: center; gap: 4px; padding: 0 8px; border-bottom: 1px solid var(--line); min-width: 0; }
  .diagram-label { flex: 1; min-width: 0; color: var(--dim); }
  button { min-height: 32px; min-width: 44px; padding: 4px 8px; color: var(--cyan); font: inherit; }
  .diagram-status { padding: 12px; color: var(--dim); overflow-wrap: anywhere; }
  .retry { margin: 0 4px 8px; }
  .diagram-canvas { width: 100%; min-width: 0; overflow: hidden; padding: 12px; display: flex; justify-content: center; }
  .diagram-canvas.readable { display: block; overflow: auto; max-height: min(65dvh, 600px, max(44px, calc(var(--mobile-viewport-height, 100dvh) - 120px))); overscroll-behavior: contain; }
  img { display: block; flex: none; max-width: none; object-fit: contain; }
  .diagram-source { padding: 12px; border-top: 1px solid var(--line); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--fg); font: 12px/1.5 var(--mono); max-height: 24rem; overflow-y: auto; }
  @media (max-width: 900px), (pointer: coarse) { button { min-height: 44px; } }
</style>
