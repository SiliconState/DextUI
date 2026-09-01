<script lang="ts">
  // Approval box rendered in the transcript flow — dext's ┌─ approval idiom,
  // keyboard-first: [a] once · [s] always · [d] deny.
  import type { PendingPermission } from "@dextui/client";
  import { connection } from "../lib/state.svelte";
  import Diff from "./Diff.svelte";

  let { pending, sessionId }: { pending: PendingPermission; sessionId: string } = $props();

  let note = $state("");

  function respond(choice: "once" | "always" | "deny") {
    connection()?.respond(sessionId, pending.request_id, choice, note.trim() || undefined);
    note = "";
  }
</script>

<div class="appr" data-state="awaiting_approval" data-agent-id={`approval.${pending.request_id}`}>
  <div class="appr-head">
    <span class="faint">┌─</span>
    <span class="st-yellow bold">approval</span>
    <span class="faint">·</span>
    <span class="st-yellow">{pending.tool}</span>
    {#if pending.risk}
      <span class="faint">· risk:{pending.risk}</span>
    {/if}
  </div>
  <div class="appr-body">
    <div class="appr-line">
      <span class="gut">│</span>
      <span>{pending.summary}</span>
    </div>
    {#if pending.diff}
      <Diff text={pending.diff} prefix="│ " />
    {:else if pending.input !== undefined}
      <details class="appr-input">
        <summary><span class="gut">│</span> <span class="faint">▸ input</span></summary>
        <pre class="appr-pre" data-agent-id={`approval.${pending.request_id}.input`}><span class="gut">│ </span>{JSON.stringify(pending.input, null, 2)}</pre>
      </details>
    {/if}
    <div class="appr-line">
      <span class="gut">│</span>
      <input
        bind:value={note}
        type="text"
        placeholder="note (optional)"
        class="appr-note"
        data-agent-id={`approval.${pending.request_id}.note`}
      />
    </div>
    <div class="appr-line appr-actions">
      <span class="gut">│</span>
      <button class="act ok" data-agent-id={`approval.${pending.request_id}.once`} onclick={() => respond("once")}>[a] once</button>
      <button class="act accent" data-agent-id={`approval.${pending.request_id}.always`} onclick={() => respond("always")}>[s] always</button>
      <button class="act err" data-agent-id={`approval.${pending.request_id}.deny`} onclick={() => respond("deny")}>[d] deny</button>
    </div>
  </div>
  <div class="faint">└</div>
</div>

<style>
  .appr {
    padding: 2px 14px 6px;
    border-left: 2px solid var(--yellow);
    background: color-mix(in srgb, var(--yellow) 4%, transparent);
    max-width: 130ch;
  }
  .appr-head {
    display: flex;
    gap: 6px;
    align-items: baseline;
  }
  .bold {
    font-weight: bold;
  }
  .appr-body {
    padding: 2px 0;
  }
  .appr-line {
    display: flex;
    gap: 8px;
    align-items: baseline;
    white-space: pre-wrap;
  }
  .appr-note {
    flex: 1;
    min-width: 120px;
    border-bottom: 1px solid var(--line);
    padding: 1px 0;
  }
  .appr-actions {
    gap: 16px;
    margin-top: 4px;
  }
  .appr-pre {
    white-space: pre-wrap;
    color: var(--dim);
  }
  .appr-input summary {
    cursor: pointer;
    user-select: none;
    list-style: none;
  }
  .appr-input summary::-webkit-details-marker {
    display: none;
  }
  .gut {
    color: var(--faint);
    user-select: none;
  }
  .faint {
    color: var(--faint);
  }
  .st-yellow {
    color: var(--yellow);
  }
</style>
