<script lang="ts">
  // Global approval queue: every pending permission across all sessions,
  // oldest first, at the top of the rail. Compact rows only — the full card
  // (diff + note) still lives in the active session's approval dock.
  import type { PendingPackUi, PendingPermission } from "@dextui/client";
  import { queue, queueTotal, activate, respondGlobal } from "../lib/state.svelte";
  import { crewEscalations, crewDur, crewIdle, openRun, shortRun } from "../lib/crew.svelte";

  let { onPick }: { onPick?: () => void } = $props();

  let open = $state(localStorage.getItem("dextui.queueOpen") !== "0");
  let now = $state(Date.now());

  const total = $derived(queueTotal());
  // Crew escalations: the one crew decision. [open] only. Sensitive image
  // approvals are review-only here; a/s/d remain for ordinary permissions.
  const escalations = $derived(crewEscalations());
  type Decision =
    | { kind: "permission"; at: number; sessionId: string; sessionTitle: string; pending: PendingPermission }
    | { kind: "form"; at: number; sessionId: string; sessionTitle: string; pending: PendingPackUi };
  const decisions = $derived.by((): Decision[] => [
    ...queue.entries.map((entry): Decision => ({ kind: "permission", at: entry.pending.received_at, sessionId: entry.sessionId, sessionTitle: entry.sessionTitle, pending: entry.pending })),
    ...queue.uiEntries.map((entry): Decision => ({ kind: "form", at: entry.pending.received_at, sessionId: entry.sessionId, sessionTitle: entry.sessionTitle, pending: entry.pending })),
  ].sort((a, b) => a.at - b.at));

  // Coarse relative stamps ("3m") only need a slow clock, and only while rows exist.
  $effect(() => {
    if (total === 0) return;
    const t = setInterval(() => {
      now = Date.now();
    }, 30_000);
    return () => {
      clearInterval(t);
    };
  });

  function toggle() {
    open = !open;
    localStorage.setItem("dextui.queueOpen", open ? "1" : "0");
  }

  function age(ts: number): string {
    void now; // render-time read keeps stamps fresh
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h`;
  }

  function go(id: string) {
    activate(id);
    onPick?.();
  }

  function goRun(id: string) {
    openRun(id);
    onPick?.();
  }
</script>

{#if total > 0}
  <section
    class="queue"
    data-agent-id="queue.rail"
    data-state={open ? "expanded" : "collapsed"}
    aria-label="Needs you — decisions pending"
  >
    <button class="queue-head" data-agent-id="queue.toggle" aria-expanded={open}
      aria-label={`Needs you: ${total} ${total === 1 ? "decision" : "decisions"} pending`}
      onclick={toggle}>
      <span class="faint">{open ? "▾" : "▸"}</span>
      <span class="st-yellow">Needs you</span>
      <span class="st-yellow">({total})</span>
    </button>
    {#if open}
      <div class="queue-list">
        {#each decisions as decision (`${decision.kind}:${decision.sessionId}:${decision.kind === "form" ? decision.pending.id : decision.pending.request_id}`)}
          {#if decision.kind === "form"}
            <div class="queue-row count" data-agent-id={`queue.ui.${decision.sessionId}.${decision.pending.id}`} data-state="awaiting_answer">
              <span class="st-yellow">?</span>
              <span class="q-tool">{decision.pending.pack}</span>
              <span class="dim truncate">{decision.pending.params.title}</span>
              <span class="faint q-meta">{decision.sessionTitle} · {age(decision.pending.received_at)}</span>
              <button class="act accent" data-agent-id={`queue.ui.${decision.sessionId}.${decision.pending.id}.open`} onclick={() => go(decision.sessionId)}>[Open form]</button>
            </div>
          {:else}
            <div
              class="queue-row"
              data-agent-id={`queue.${decision.sessionId}.${decision.pending.request_id}`}
              data-state="awaiting_approval"
            >
              <button
                class="queue-goto"
                data-agent-id={`queue.${decision.sessionId}.${decision.pending.request_id}.open`}
                title="Open session"
                onclick={() => go(decision.sessionId)}
              >
                <span class="st-yellow">⚠</span>
                <span class="q-tool">{decision.pending.tool === "read_image" ? "Share image pixels" : decision.pending.tool}</span>
                <span class="dim truncate">{decision.pending.summary}</span>
                <span class="faint q-meta">{decision.sessionTitle} · {age(decision.pending.received_at)}</span>
              </button>
              <span class="queue-acts">
                {#if decision.pending.tool === "read_image"}
                  <button
                    class="act accent"
                    data-agent-id={`queue.${decision.sessionId}.${decision.pending.request_id}.review`}
                    title="Open the full pixel-sharing disclosure before deciding"
                    onclick={() => go(decision.sessionId)}
                  >[review]</button>
                  <button
                    class="act err"
                    data-agent-id={`queue.${decision.sessionId}.${decision.pending.request_id}.deny`}
                    aria-label="Do not share image pixels"
                    title="Do not send this image to the model provider"
                    onclick={() => respondGlobal(decision.sessionId, decision.pending.request_id, "deny")}
                  >[d]</button>
                {:else}
                  <button
                    class="act ok"
                    data-agent-id={`queue.${decision.sessionId}.${decision.pending.request_id}.once`}
                    aria-label="Approve once"
                    title="Approve once"
                    onclick={() => respondGlobal(decision.sessionId, decision.pending.request_id, "once")}
                  >[a]</button>
                  <button
                    class="act accent"
                    data-agent-id={`queue.${decision.sessionId}.${decision.pending.request_id}.always`}
                    aria-label="Approve always"
                    title="Approve always"
                    onclick={() => respondGlobal(decision.sessionId, decision.pending.request_id, "always")}
                  >[s]</button>
                  <button
                    class="act err"
                    data-agent-id={`queue.${decision.sessionId}.${decision.pending.request_id}.deny`}
                    aria-label="Deny"
                    title="Deny"
                    onclick={() => respondGlobal(decision.sessionId, decision.pending.request_id, "deny")}
                  >[d]</button>
                {/if}
              </span>
            </div>
          {/if}
        {/each}
        {#each escalations as r (r.id)}
          <div class="queue-row count" data-agent-id={`queue.crew.${r.id}`} data-state="awaiting_answer">
            <span class="st-yellow">⚠</span>
            <span class="q-tool">Crew escalation</span>
            <span class="dim truncate" title={r.escalation?.question}>{r.escalation?.label ?? r.task}</span>
            <span class="faint q-meta">{shortRun(r.id)} · {(void now, crewDur(crewIdle(r, Date.now())))}</span>
            <button class="act accent" data-agent-id={`queue.crew.${r.id}.open`} onclick={() => goRun(r.id)}>[Open]</button>
          </div>
        {/each}
        {#each queue.counts as s (s.id)}
          <div class="queue-row count" data-agent-id={`queue.${s.id}.count`} data-state="count_only">
            <span class="st-yellow">⚠ {s.count}</span>
            <span class="dim truncate">{s.title}</span>
            <button class="act accent" data-agent-id={`queue.${s.id}.count.open`} onclick={() => go(s.id)}
              >[open]</button
            >
          </div>
        {/each}
      </div>
    {/if}
  </section>
{/if}
<!-- Decisions-first: announce count changes to assistive tech even when the
     rail is collapsed or the user is elsewhere in the document. -->
<p class="sr-only" role="status" aria-live="polite" data-agent-id="queue.announce">
  {total === 0 ? "No decisions pending" : `${total} ${total === 1 ? "decision" : "decisions"} need${total === 1 ? "s" : ""} you`}
</p>

<style>
  .queue {
    border-bottom: 1px solid var(--line);
  }
  .queue-head {
    width: 100%;
    display: flex;
    gap: 6px;
    padding: 6px 10px 4px;
    align-items: baseline;
  }
  .queue-list {
    max-height: 40dvh;
    overflow-y: auto;
    padding-bottom: 4px;
  }
  .queue-row {
    display: flex;
    flex-direction: column;
    padding: 3px 10px;
    border-left: 2px solid color-mix(in srgb, var(--yellow) 55%, var(--line));
  }
  .queue-row:hover {
    background: var(--bg2);
  }
  .queue-row.count {
    flex-direction: row;
    gap: 6px;
    align-items: baseline;
  }
  .queue-goto {
    display: flex;
    gap: 6px;
    width: 100%;
    min-width: 0;
    align-items: baseline;
  }
  .queue-goto .truncate {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .queue-acts {
    display: flex;
    gap: 8px;
    padding-left: 12px;
  }
  .q-tool {
    flex-shrink: 0;
  }
  .q-meta {
    flex-shrink: 0;
    font-size: 11px;
  }
  .truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .dim {
    color: var(--dim);
  }
  .faint {
    color: var(--faint);
  }
  .st-yellow {
    color: var(--yellow);
  }
</style>
