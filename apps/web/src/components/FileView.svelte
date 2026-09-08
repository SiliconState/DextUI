<script lang="ts">
  // Workspace-file previews markdown can't do with a plain <img>: PDFs ride
  // the browser's own viewer in a frame (the host serves them inline, no CSP
  // sandbox — the viewer document carries no scripts), text arrives by fetch
  // and renders as a bounded <pre>. Both go through the authenticated file
  // endpoint with ?t=, so no extra surface opens.
  let { src, name, kind }: { src: string; name: string; kind: "pdf" | "text" } = $props();

  const TEXT_CAP = 256 * 1024;
  let text = $state<string | null>(null);
  let failed = $state(false);

  $effect(() => {
    failed = false;
    text = null;
    if (kind !== "text") return;
    const ctl = new AbortController();
    fetch(src, { signal: ctl.signal })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
      })
      .then((t) => {
        text = t.length > TEXT_CAP ? `${t.slice(0, TEXT_CAP)}\n… (truncated)` : t;
      })
      .catch(() => {
        failed = true;
      });
    return () => ctl.abort();
  });
</script>

{#if kind === "pdf"}
  <iframe class="fv fv-pdf" src={src} title={name} loading="lazy"></iframe>
  <a class="fv-open" href={src} target="_blank" rel="noopener noreferrer">open {name} in a tab ↗</a>
{:else if failed}
  <span class="fv-miss">✗ could not load {name} from the session workspace</span>
{:else}
  <pre class="fv fv-text">{text ?? `loading ${name}…`}</pre>
{/if}

<style>
  .fv {
    border: 1px solid var(--line);
    background: var(--bg1);
    max-width: 100%;
  }
  .fv-pdf {
    display: block;
    width: 100%;
    height: 460px;
  }
  .fv-text {
    margin: 0;
    padding: 8px 10px;
    max-height: 320px;
    overflow: auto;
    font-size: 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .fv-open {
    font-size: 11px;
  }
  .fv-miss {
    display: inline-block;
    border: 1px solid color-mix(in srgb, var(--red, #f85149) 45%, var(--line));
    color: var(--red, #f85149);
    padding: 2px 8px;
    font-size: 11.5px;
  }
</style>
