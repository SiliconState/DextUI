<script lang="ts">
  // Workspace-file previews markdown can't do with a plain <img>. PDFs ride
  // the browser's viewer, text is fetched into a bounded <pre>, and office/ODF
  // files get an explicit download surface (the browser has no safe native
  // renderer; dext inspects the workspace copy with format-aware local tools).
  import { boundedResponseText } from "../lib/files";

  let { src, name, kind }: { src: string; name: string; kind: "pdf" | "text" | "document" } = $props();

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
        return boundedResponseText(r, TEXT_CAP);
      })
      .then((t) => {
        text = t;
      })
      .catch(() => {
        if (!ctl.signal.aborted) failed = true;
      });
    return () => ctl.abort();
  });
</script>

{#if kind === "pdf"}
  <iframe class="fv fv-pdf" src={src} title={name} loading="lazy"></iframe>
  <a class="fv-open" href={src} target="_blank" rel="noopener noreferrer">Open {name} in a tab ↗</a>
{:else if kind === "document"}
  <span class="fv-doc" data-agent-id="markdown.document">
    <span aria-hidden="true">▤</span>
    <span class="fv-docname">{name}</span>
    <a class="fv-open" href={src} download>Download</a>
  </span>
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
  .fv-doc {
    display: flex;
    align-items: center;
    gap: 8px;
    width: min(100%, 38rem);
    padding: 7px 9px;
    border: 1px solid var(--line);
    border-left: 2px solid var(--cyan);
    background: var(--bg1);
  }
  .fv-doc > :first-child {
    color: var(--cyan);
  }
  .fv-docname {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--dim);
  }
  .fv-open {
    color: var(--blue);
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
