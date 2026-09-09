<script lang="ts">
  // Approval box: yellow rail, keyboard-first [a] once · [s] always · [d] deny.
  // CSS rail, not glyph gutters — wrapped lines stay inside the structure.
  import type { PendingPermission } from "@dextui/client";
  import { connection } from "../lib/state.svelte";
  import Diff from "./Diff.svelte";

  let { pending, sessionId }: { pending: PendingPermission; sessionId: string } = $props();

  let note = $state("");
  const imagePermission = $derived(pending.tool === "read_image");

  function respond(choice: "once" | "always" | "deny") {
    connection()?.respond(sessionId, pending.request_id, choice, note.trim() || undefined);
    note = "";
  }
</script>

<div class="appr" data-state="awaiting_approval" data-agent-id={`approval.${pending.request_id}`}>
  <div class="appr-head">
    <span class="st-yellow">{imagePermission ? "Share image pixels" : "Approval"}</span>
    <span class="faint">·</span>
    <span class="st-yellow">{pending.tool}</span>
    {#if pending.risk}
      <span class="faint">· Risk:{pending.risk}</span>
    {/if}
    <span class="appr-summary dim">{pending.summary}</span>
  </div>
  {#if imagePermission}
    <p class="appr-disclosure" data-agent-id={`approval.${pending.request_id}.disclosure`}>
      Dext will sanitize this workspace image, strip metadata, resize it, and send its pixels to the active model provider for this turn.
    </p>
  {/if}
  {#if pending.diff}
    <Diff text={pending.diff} />
  {:else if pending.input !== undefined}
    <details class="appr-input">
      <summary><span class="faint">▸ Input</span></summary>
      <pre class="appr-pre" data-agent-id={`approval.${pending.request_id}.input`}>{JSON.stringify(pending.input, null, 2)}</pre>
    </details>
  {/if}
  <div class="appr-actions">
    <button class="act ok" data-agent-id={`approval.${pending.request_id}.once`} onclick={() => respond("once")}>[a] {imagePermission ? "Share once" : "Once"}</button>
    <button class="act accent" data-agent-id={`approval.${pending.request_id}.always`} title={imagePermission ? "Allow future read_image calls in this session without another prompt" : undefined} onclick={() => respond("always")}>[s] {imagePermission ? "Always share" : "Always"}</button>
    <button class="act err" data-agent-id={`approval.${pending.request_id}.deny`} onclick={() => respond("deny")}>[d] Deny</button>
    <input
      bind:value={note}
      type="text"
      placeholder="Note (optional)"
      class="appr-note"
      data-agent-id={`approval.${pending.request_id}.note`}
    />
  </div>
</div>

<style>
  .appr {
    width: 100%;
    min-width: 0;
    border-left: 2px solid var(--yellow);
    background: color-mix(in srgb, var(--yellow) 4%, transparent);
    padding: 6px 12px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .appr-head {
    display: flex;
    gap: 6px;
    align-items: baseline;
    min-width: 0;
  }
  .appr-disclosure {
    margin: 0;
    color: var(--dim);
    line-height: 1.45;
  }
  .appr-summary {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .appr-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 16px;
    align-items: baseline;
  }
  .appr-note {
    flex: 1 1 16rem;
    min-width: 120px;
    border-bottom: 1px solid var(--line);
    padding: 1px 0;
  }
  .appr-pre {
    white-space: pre;
    overflow-x: auto;
    max-height: 12rem;
    overflow-y: auto;
    color: var(--dim);
    font-size: 12px;
    background: var(--bg1);
    padding: 4px 8px;
  }
  .appr-input summary {
    cursor: pointer;
    user-select: none;
    list-style: none;
  }
  .appr-input summary::-webkit-details-marker {
    display: none;
  }
  .faint {
    color: var(--faint);
  }
  .dim {
    color: var(--dim);
  }
  .st-yellow {
    color: var(--yellow);
  }
</style>
