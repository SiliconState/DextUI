<script lang="ts">
  // Sandboxed HTML preview card: model-emitted ```html fences (srcdoc) and
  // workspace .html files (src) share one surface. The frame is opaque-origin
  // (sandbox without allow-same-origin), so embedded scripts can run but never
  // touch the app's DOM, storage, or token. A tiny probe is injected into
  // srcdoc documents to report their height so the card fits without a
  // scrollbar; file artifacts get a fixed, user-resizable height.
  let {
    src,
    html,
    name,
    code,
  }: { src?: string; html?: string; name: string; code?: string } = $props();

  let mode = $state<"preview" | "code">("preview");
  let frame = $state<HTMLIFrameElement | null>(null);
  let fitH = $state<number | null>(null);

  const MIN_H = 120;
  const MAX_H = 1400;

  // Height probe — posts scrollHeight on load, resize, and DOM mutation.
  const PROBE = `<script>(function(){var p=parent,l=0;function r(){var h=Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0);if(h!==l){l=h;p.postMessage({dextArtifactHeight:h},"*")}}addEventListener("load",r);addEventListener("resize",r);new MutationObserver(r).observe(document.documentElement,{subtree:true,childList:true,attributes:true});setTimeout(r,0);setTimeout(r,300)})()<\/script>`;

  const doc = $derived.by(() => {
    if (html === undefined) return undefined;
    const scheme = `<meta name="color-scheme" content="light dark">`;
    // Full documents keep their own <head>; fragments get a minimal shell so
    // fonts/colors follow the app rather than the UA defaults.
    if (/<html[\s>]/i.test(html)) {
      return /<head[\s>]/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${scheme}${PROBE}`) : html.replace(/<html([^>]*)>/i, `<html$1><head>${scheme}${PROBE}</head>`);
    }
    return `<!doctype html><html><head>${scheme}${PROBE}<style>body{margin:8px;font:13px/1.45 system-ui,sans-serif;color:CanvasText;background:Canvas}</style></head><body>${html}</body></html>`;
  });

  $effect(() => {
    const el = frame;
    if (!el || html === undefined) return;
    const onMsg = (e: MessageEvent) => {
      if (e.source !== el.contentWindow) return;
      const h = (e.data as { dextArtifactHeight?: unknown })?.dextArtifactHeight;
      if (typeof h === "number" && Number.isFinite(h)) fitH = Math.max(MIN_H, Math.min(MAX_H, Math.ceil(h) + 2));
    };
    addEventListener("message", onMsg);
    return () => removeEventListener("message", onMsg);
  });

  const codeText = $derived(code ?? html ?? "");
</script>

<span class="art" data-agent-id="markdown.artifact" data-state={mode}>
  <span class="art-head">
    <span class="st-cyan">▤ artifact</span>
    <span class="dim art-name">{name}</span>
    {#if codeText}
      <button class="act" class:on={mode === "preview"} onclick={() => (mode = "preview")}>preview</button>
      <button class="act" class:on={mode === "code"} onclick={() => (mode = "code")}>code</button>
    {/if}
    {#if src}<a class="act" href={src} target="_blank" rel="noopener noreferrer">open ↗</a>{/if}
  </span>
  {#if mode === "code"}
    <pre class="art-code">{codeText}</pre>
  {:else if src}
    <iframe sandbox="allow-scripts" loading="lazy" title={name} {src} class="fixed"></iframe>
  {:else}
    <iframe bind:this={frame} sandbox="allow-scripts" title={name} srcdoc={doc} style:height={fitH ? `${fitH}px` : undefined} class:fit={fitH !== null}></iframe>
  {/if}
</span>

<style>
  .art {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 100%;
    border: 1px solid var(--line);
    background: var(--bg1);
  }
  .art-head {
    display: flex;
    gap: 8px;
    align-items: center;
    border-bottom: 1px solid var(--line);
    padding: 3px 8px;
  }
  .art-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11.5px;
  }
  .art-head .act.on {
    color: var(--fg);
    text-decoration: underline;
  }
  iframe {
    display: block;
    width: 100%;
    height: 360px;
    border: 0;
    /* Follows the app theme; `color-scheme` is inherited from <html>, so an
       embedded page's prefers-color-scheme resolves to ours, not the OS's. */
    background: var(--bg);
    color-scheme: inherit;
  }
  iframe.fixed {
    height: 560px;
    resize: vertical;
    overflow: auto;
    min-height: 120px;
  }
  .art-code {
    margin: 0;
    padding: 6px 8px;
    max-height: 420px;
    overflow: auto;
    font-size: 11.5px;
    line-height: 1.4;
    color: var(--dim);
    white-space: pre;
  }
</style>
