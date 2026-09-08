<script lang="ts">
  // Durable chat-side handle for an interactive HTML report. The document does
  // not compete with the transcript for width/height; it opens in ArtifactSheet
  // while this launcher remains at the exact point the agent delivered it.
  import { artifact, openArtifact } from "../lib/artifact.svelte";

  let {
    src,
    html,
    name,
    code,
    sessionId = "",
  }: { src?: string; html?: string; name: string; code?: string; sessionId?: string } = $props();

  const selected = $derived(
    !!artifact.document &&
      artifact.document.name === name &&
      artifact.document.src === src &&
      artifact.document.html === html &&
      artifact.document.sessionId === sessionId,
  );

  function open() {
    openArtifact({ src, html, name, code, sessionId });
  }
</script>

<span class="art" data-agent-id="markdown.artifact" data-state={selected ? "open" : "ready"}>
  <span class="mark" aria-hidden="true">▤</span>
  <span class="copy">
    <span class="kind">Interactive report</span>
    <span class="name" title={name}>{name}</span>
  </span>
  <button class="act open" data-agent-id="markdown.artifact.open" onclick={open}>{selected ? "View report" : "Open report"} →</button>
</span>

<style>
  .art {
    display: flex;
    align-items: center;
    gap: 9px;
    width: min(100%, 38rem);
    padding: 7px 9px;
    border: 1px solid var(--line);
    border-left: 2px solid var(--cyan);
    background: var(--bg1);
  }
  .art[data-state="open"] {
    background: var(--bg2);
  }
  .mark {
    color: var(--cyan);
    font-size: 15px;
  }
  .copy {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .kind {
    color: var(--fg);
    font-size: 11.5px;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--faint);
    font-size: 10.5px;
  }
  .open {
    flex: none;
    color: var(--cyan);
  }
</style>
