<script lang="ts">
  // Full-height right-side home for interactive HTML reports. The report stays
  // sandboxed in an opaque origin; chat keeps only its compact launcher.
  import { currentResolvedTheme } from "../lib/state.svelte";
  import { artifact, closeArtifact } from "../lib/artifact.svelte";
  import { useDialog } from "../lib/dialog.svelte";

  const dlg = useDialog(() => !!artifact.document);
  let mode = $state<"report" | "code">("report");
  let lastKey = "";
  let fetchedCode = $state("");
  let codeFailed = $state(false);

  const item = $derived(artifact.document);
  const codeText = $derived(item?.code ?? item?.html ?? fetchedCode);
  const canShowCode = $derived(!!item && (item.code !== undefined || item.html !== undefined || !!item.src));
  const key = $derived(`${item?.sessionId ?? ""}\u001f${item?.name ?? ""}\u001f${item?.src ?? ""}`);

  const themedSrc = $derived.by(() => {
    if (!item?.src) return undefined;
    const url = new URL(item.src, location.origin);
    url.searchParams.set("theme", currentResolvedTheme());
    return `${url.pathname}${url.search}${url.hash}`;
  });

  // Inline fences need the same theme bootstrap as file reports receive via
  // their URL query. No dynamic input besides the whitelisted theme is added.
  const doc = $derived.by(() => {
    if (item?.html === undefined) return undefined;
    const theme = currentResolvedTheme();
    const head = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; script-src 'unsafe-inline'; font-src data:"><meta name="color-scheme" content="light dark"><script>try{document.documentElement.dataset.theme="${theme}"}catch(e){}<\/script>`;
    if (/<html[\s>]/i.test(item.html)) {
      return /<head[\s>]/i.test(item.html)
        ? item.html.replace(/<head([^>]*)>/i, `<head$1>${head}`)
        : item.html.replace(/<html([^>]*)>/i, `<html$1><head>${head}</head>`);
    }
    return `<!doctype html><html><head>${head}<style>body{margin:16px;font:13px/1.45 system-ui,sans-serif;color:light-dark(#242830,#c8cfd9);background:light-dark(#f4f2ec,#0b0d10)}</style></head><body>${item.html}</body></html>`;
  });

  $effect(() => {
    if (key !== lastKey) {
      lastKey = key;
      mode = "report";
      fetchedCode = "";
      codeFailed = false;
    }
  });

  async function showCode() {
    mode = "code";
    if (!item?.src || fetchedCode || codeFailed || item.code !== undefined || item.html !== undefined) return;
    try {
      const res = await fetch(item.src);
      if (!res.ok) throw new Error(String(res.status));
      const text = await res.text();
      fetchedCode = text.length > 1024 * 1024 ? `${text.slice(0, 1024 * 1024)}\n… (truncated)` : text;
    } catch {
      codeFailed = true;
    }
  }

  function onKey(e: KeyboardEvent) {
    dlg.onKey(e);
    if (e.key === "Escape") {
      closeArtifact();
      e.preventDefault();
      e.stopPropagation();
    }
  }
</script>

{#if item}
  <div class="insp-scrim" data-agent-id="artifact.scrim" onclick={closeArtifact} onkeydown={() => {}} role="presentation"></div>
  <div
    class="insp artifact-sheet"
    role="dialog"
    aria-modal="true"
    aria-labelledby="artifact-title"
    tabindex="-1"
    use:dlg.ref
    data-agent-id="artifact.overlay"
    data-state={mode}
    onkeydown={onKey}
  >
    <header class="insp-head">
      <span class="st-cyan">Interactive report</span>
      <span class="dim title" id="artifact-title" title={item.name}>{item.name}</span>
      <span class="insp-acts">
        {#if canShowCode}
          <button class="act" class:on={mode === "report"} data-agent-id="artifact.report" onclick={() => (mode = "report")}>Report</button>
          <button class="act" class:on={mode === "code"} data-agent-id="artifact.code" onclick={showCode}>Code</button>
        {/if}
        {#if item.src}<a class="act" href={item.src} target="_blank" rel="noopener noreferrer">New tab ↗</a>{/if}
        <button class="act" data-agent-id="artifact.close" onclick={closeArtifact}>esc</button>
      </span>
    </header>
    <div class="body">
      {#if mode === "code"}
        <pre data-agent-id="artifact.source">{codeFailed ? "Could not load this report's source." : codeText || "Loading source…"}</pre>
      {:else if item.src}
        {#key `${key}\u001f${currentResolvedTheme()}`}
          <iframe sandbox="allow-scripts" title={item.name} src={themedSrc} data-agent-id="artifact.frame"></iframe>
        {/key}
      {:else}
        <iframe sandbox="allow-scripts" title={item.name} srcdoc={doc} data-agent-id="artifact.frame"></iframe>
      {/if}
    </div>
  </div>
{/if}

<style>
  .artifact-sheet {
    width: min(76rem, 96vw);
  }
  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .insp-acts {
    display: flex;
    gap: 12px;
    align-items: baseline;
    flex: none;
  }
  .act.on {
    color: var(--fg);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .body {
    flex: 1;
    min-height: 0;
    background: var(--bg);
  }
  iframe {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    background: var(--bg);
    color-scheme: inherit;
  }
  pre {
    width: 100%;
    height: 100%;
    overflow: auto;
    padding: 12px 14px;
    color: var(--dim);
    background: var(--bg1);
    font-size: 11.5px;
    line-height: 1.45;
    white-space: pre;
  }
  @media (max-width: 700px) {
    .artifact-sheet {
      width: 100vw;
    }
    .insp-head {
      flex-wrap: wrap;
    }
    .title {
      order: 3;
      width: 100%;
    }
  }
</style>
