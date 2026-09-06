<script lang="ts">
  // Global approval queue: every pending permission across all sessions,
  // oldest first, at the top of the rail. Compact rows only — the full card
  // (diff + note) still lives in the active session's approval dock.
  import { queue, queueTotal, activate, respondGlobal } from "../lib/state.svelte";
  import { crewEscalations, crewDur, crewIdle, openRun, shortRun } from "../lib/crew.svelte";

  let { onPick }: { onPick?: () => void } = $props();

  let open = $state(localStorage.getItem("dextui.queueOpen") !== "0");
  let now = $state(Date.now());

  const total = $derived(queueTotal());
  // Crew escalations: the one crew decision. [open] only — a/s/d act on the
  // oldest *permission* and an escalation needs text, so they skip these rows.
  const escalations = $derived(crewEscalations());

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
    aria-label="approval queue"
  >
    <button class="queue-head" data-agent-id="queue.toggle" aria-expanded={open} onclick={toggle}>
      <span class="faint">{open ? "▾" : "▸"}</span>
      <span class="st-yellow">queue</span>
      <span class="st-yellow">({total})</span>
    </button>
    {#if open}
      <div class="queue-list">
        {#each queue.entries as e (e.sessionId + ":" + e.pending.request_id)}
          <div
            class="queue-row"
            data-agent-id={`queue.${e.sessionId}.${e.pending.request_id}`}
            data-state="awaiting_approval"
          >
            <button
              class="queue-goto"
              data-agent-id={`queue.${e.sessionId}.${e.pending.request_id}.open`}
              title="open session"
              onclick={() => go(e.sessionId)}
            >
              <span class="st-yellow">⚠</span>
              <span class="q-tool">{e.pending.tool}</span>
              <span class="dim truncate">{e.pending.summary}</span>
              <span class="faint q-meta">{e.sessionTitle} · {age(e.pending.received_at)}</span>
            </button>
            <span class="queue-acts">
              <button
                class="act ok"
                data-agent-id={`queue.${e.sessionId}.${e.pending.request_id}.once`}
                onclick={() => respondGlobal(e.sessionId, e.pending.request_id, "once")}
              >[a]</button>
              <button
                class="act accent"
                data-agent-id={`queue.${e.sessionId}.${e.pending.request_id}.always`}
                onclick={() => respondGlobal(e.sessionId, e.pending.request_id, "always")}
              >[s]</button>
              <button
                class="act err"
                data-agent-id={`queue.${e.sessionId}.${e.pending.request_id}.deny`}
                onclick={() => respondGlobal(e.sessionId, e.pending.request_id, "deny")}
              >[d]</button>
            </span>
          </div>
        {/each}
        {#each escalations as r (r.id)}
          <div class="queue-row count" data-agent-id={`queue.crew.${r.id}`} data-state="awaiting_answer">
            <span class="st-yellow">⚠</span>
            <span class="q-tool">crew escalation</span>
            <span class="dim truncate" title={r.escalation?.question}>{r.escalation?.label ?? r.task}</span>
            <span class="faint q-meta">{shortRun(r.id)} · {(void now, crewDur(crewIdle(r, Date.now())))}</span>
            <button class="act accent" data-agent-id={`queue.crew.${r.id}.open`} onclick={() => goRun(r.id)}>[open]</button>
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
