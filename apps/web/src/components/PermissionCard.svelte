<script lang="ts">
  import type { PendingPermission } from "@dextui/client";
  import { app, connection } from "../lib/state.svelte";
  import DiffView from "./DiffView.svelte";

  let { pending, sessionId }: { pending: PendingPermission; sessionId: string } = $props();

  let note = $state("");
  let showInput = $state(false);

  const riskStyle: Record<string, string> = {
    low: "border-ok/40 text-ok",
    medium: "border-warn/40 text-warn",
    high: "border-err/40 text-err",
  };

  function respond(choice: "once" | "always" | "deny") {
    connection()?.respond(sessionId, pending.request_id, choice, note.trim() || undefined);
    note = "";
  }
</script>

<div
  class="mx-3 mb-2 space-y-3 rounded-2xl border border-warn/40 bg-raised p-4 shadow-lg md:mx-4"
  data-state="awaiting_approval"
  data-agent-id={`approval.${pending.request_id}`}
>
  <div class="flex flex-wrap items-center gap-2 text-sm">
    <span class="h-2 w-2 animate-pulse rounded-full bg-warn"></span>
    <span class="text-[10px] font-semibold uppercase tracking-wider text-warn">approval needed</span>
    <span class="font-mono text-warn">{pending.tool}</span>
    {#if pending.risk}
      <span class={`rounded border px-1.5 py-0.5 text-xs ${riskStyle[pending.risk] ?? "border-line text-dim"}`} data-agent-id={`approval.${pending.request_id}.risk`}>
        {pending.risk}
      </span>
    {/if}
    <span class="min-w-0 flex-1 truncate text-dim">{pending.summary}</span>
  </div>

  {#if pending.diff}
    <DiffView text={pending.diff} />
  {:else if pending.input !== undefined}
    <details open={Object.keys(pending.input as object).length <= 6}>
      <summary class="cursor-pointer text-xs text-faint hover:text-dim">mutation preview</summary>
      <pre class="mt-1 max-h-40 overflow-auto rounded-lg border border-line bg-bg p-2 font-mono text-xs text-dim" data-agent-id={`approval.${pending.request_id}.input`}>{JSON.stringify(pending.input, null, 2)}</pre>
    </details>
  {/if}

  <input
    bind:value={note}
    type="text"
    placeholder="note — attaches to the decision (optional)"
    class="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm focus:border-accent focus:outline-none"
    data-agent-id={`approval.${pending.request_id}.note`}
  />

  <div class="flex flex-wrap items-center gap-2">
    <button
      data-agent-id={`approval.${pending.request_id}.once`}
      onclick={() => respond("once")}
      class="rounded-xl border border-ok/50 bg-ok/10 px-4 py-1.5 text-sm font-medium text-ok hover:bg-ok/20"
    >
      Once <span class="hidden font-mono text-xs opacity-60 md:inline">a</span>
    </button>
    <button
      data-agent-id={`approval.${pending.request_id}.always`}
      onclick={() => respond("always")}
      class="rounded-xl border border-accent/50 bg-accent/10 px-4 py-1.5 text-sm font-medium text-accent hover:bg-accent/20"
    >
      Always <span class="hidden font-mono text-xs opacity-60 md:inline">s</span>
    </button>
    <button
      data-agent-id={`approval.${pending.request_id}.deny`}
      onclick={() => respond("deny")}
      class="rounded-xl border border-err/50 bg-err/10 px-4 py-1.5 text-sm font-medium text-err hover:bg-err/20"
    >
      Deny <span class="hidden font-mono text-xs opacity-60 md:inline">d</span>
    </button>
    <span class="ml-auto hidden items-center gap-1 text-xs text-faint md:flex">
      {app.sessions.find((s) => s.id === sessionId)?.title ?? sessionId}
    </span>
  </div>
</div>
