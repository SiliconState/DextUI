<script lang="ts">
  // Approval box: yellow rail, keyboard-first [a] once · [s] always · [d] deny.
  // CSS rail, not glyph gutters — wrapped lines stay inside the structure.
  import type { PendingPermission } from "@dextui/client";
  import { connection } from "../lib/state.svelte";
  import Diff from "./Diff.svelte";

  let { pending, sessionId }: { pending: PendingPermission; sessionId: string } = $props();

  let note = $state("");
  const imagePermission = $derived(pending.tool === "read_image");
  const commandPreview = $derived.by(() => {
    if (!pending.input || typeof pending.input !== "object") return "";
    const input = pending.input as Record<string, unknown>;
    const value = input.command ?? input.path;
    return typeof value === "string" ? value : "";
  });
  const imagePath = $derived.by(() => {
    if (!imagePermission || !pending.input || typeof pending.input !== "object") return "";
    const path = (pending.input as { path?: unknown }).path;
    return typeof path === "string" ? path : "";
  });

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
      <span class="faint">· Risk: {pending.risk}</span>
    {/if}
    <span class="appr-summary dim">{pending.summary}</span>
  </div>
  {#if imagePermission}
    <p class="appr-disclosure" data-agent-id={`approval.${pending.request_id}.disclosure`}>
      Dext will sanitize this workspace image, strip metadata, resize it, and send its pixels to the active model provider for this turn.
      {#if imagePath}<code data-agent-id={`approval.${pending.request_id}.path`}>{imagePath}</code>{/if}
    </p>
  {/if}
  {#if !imagePermission && commandPreview}<pre class="command-preview" data-agent-id={`approval.${pending.request_id}.preview`}>{commandPreview}</pre>{/if}
  {#if pending.diff}
    <Diff text={pending.diff} />
  {:else if pending.input !== undefined}
    <details class="appr-input">
      <summary><span class="faint">▸ Input</span></summary>
      <pre class="appr-pre" data-agent-id={`approval.${pending.request_id}.input`}>{JSON.stringify(pending.input, null, 2)}</pre>
    </details>
  {/if}
  <div class="appr-actions">
    <button class="act ok" data-agent-id={`approval.${pending.request_id}.once`} onclick={() => respond("once")}><span class="key-hint">[a] </span>{imagePermission ? "Share once" : "Approve"}</button>
    <button class="act accent" data-agent-id={`approval.${pending.request_id}.always`} title={imagePermission ? "Allow future read_image calls in this session without another prompt" : undefined} onclick={() => respond("always")}><span class="key-hint">[s] </span>{imagePermission ? "Always share" : "Always allow"}</button>
    <button class="act err" data-agent-id={`approval.${pending.request_id}.deny`} onclick={() => respond("deny")}><span class="key-hint">[d] </span>Deny</button>
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
  .appr-disclosure code {
    display: block;
    margin-top: 3px;
    color: var(--fg);
    overflow-wrap: anywhere;
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
  .command-preview { white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.5 var(--mono); color: var(--fg); }
  @media (pointer: coarse), (hover: none), (max-width: 600px) {
    .key-hint { display: none; }
    .appr { padding: 10px 12px; gap: 8px; }
    .appr-head { flex-wrap: wrap; font-family: var(--sans); }
    .appr-summary { white-space: normal; flex-basis: 100%; overflow-wrap: anywhere; }
    .appr-head > span { min-width: 0; overflow-wrap: anywhere; }
    .appr-actions { min-width: 0; }
    .appr-actions button { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
    .appr-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .appr-actions button { padding: 10px; text-align: center; border: 1px solid var(--line); border-radius: 5px; font-family: var(--sans); }
    .appr-actions .ok { background: color-mix(in srgb, var(--green) 12%, var(--bg1)); }
    .appr-actions .err { grid-column: 1; grid-row: 1; }
    .appr-actions .ok { grid-column: 2; grid-row: 1; }
    .appr-actions .accent { grid-column: 1 / -1; }
    .appr-note { grid-column: 1 / -1; min-width: 0; padding: 8px; }
    .appr-pre { white-space: pre-wrap; overflow-wrap: anywhere; }
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
