<script lang="ts">
  // Tier 2 — the run sheet. An overlay on the gallery/dialog pattern, never a
  // transcript block. Chain of step groups; one line per worker; exactly one
  // tail pane; actions conditional on run state (stop while live, answer
  // while paused, deliverables + tails always). Keys are scoped to the dialog.
  import type { CrewGroup, CrewWorker } from "@dextui/protocol";
  import { crew, crewDur, closeRun, requestTail, refreshTail, openFile, stopRun, answerRun, shortRun, GLYPH } from "../lib/crew.svelte";

  let { onClose }: { onClose?: () => void } = $props();

  const GROUP_EXPANDED_CAP = 5; // groups expanded by default
  const GROUP_COLLAPSE_AT = 4; // members beyond which a group starts folded
  const DONE_VISIBLE = 3; // completed rows shown before "▸ n completed"
  const ROWS_CAP = 8; // rows per expanded group before "▾ n more"

  const run = $derived(crew.open);
  const live = $derived(!!run && (run.status === "running" || run.status === "pending" || run.status === "paused"));
  const paused = $derived(!!run && run.status === "paused" && !!run.escalation);
  const stopped = $derived(!!run && run.state === "stopped");

  let expanded = $state<Record<number, boolean>>({});
  let showDone = $state<Record<number, boolean>>({});
  let showAll = $state<Record<number, boolean>>({});
  let focus = $state(""); // worker key under j/k
  let confirmStop = $state(false);
  let answer = $state("");
  let answerEl: HTMLTextAreaElement | null = $state(null);
  let now = $state(Date.now());

  // Reset per-run UI state when a different run lands in the sheet.
  let lastId = "";
  $effect(() => {
    const id = run?.id ?? "";
    if (id !== lastId) {
      lastId = id;
      expanded = {};
      showDone = {};
      showAll = {};
      focus = "";
      confirmStop = false;
      answer = "";
    }
  });

  $effect(() => {
    if (!run || run.counts.run === 0) return;
    const t = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => {
      clearInterval(t);
    };
  });

  const RANK: Record<string, number> = { failed: 0, running: 1, paused: 2, pending: 3, completed: 4 };

  function isExpanded(g: CrewGroup): boolean {
    if (g.index in expanded) return expanded[g.index]!;
    if (g.workers.length > GROUP_COLLAPSE_AT) return false;
    return g.index < GROUP_EXPANDED_CAP || g.status !== "completed";
  }

  interface Rows {
    rows: CrewWorker[];
    hiddenDone: number;
    hiddenMore: number;
  }

  function rowsOf(g: CrewGroup): Rows {
    const sorted = [...g.workers].sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9));
    let rows = sorted;
    let hiddenDone = 0;
    if (!showDone[g.index]) {
      const done = sorted.filter((w) => w.status === "completed");
      if (done.length > DONE_VISIBLE) {
        const keep = new Set(done.slice(0, DONE_VISIBLE).map((w) => w.key));
        rows = sorted.filter((w) => w.status !== "completed" || keep.has(w.key));
        hiddenDone = done.length - DONE_VISIBLE;
      }
    }
    let hiddenMore = 0;
    if (!showAll[g.index] && rows.length > ROWS_CAP) {
      hiddenMore = rows.length - ROWS_CAP;
      rows = rows.slice(0, ROWS_CAP);
    }
    return { rows, hiddenDone, hiddenMore };
  }

  function bar(g: CrewGroup): string {
    const n = g.counts.total || 1;
    const done = Math.round(((g.counts.done + g.counts.fail) / n) * 10);
    return "█".repeat(done) + "░".repeat(10 - done);
  }

  function dur(w: CrewWorker): string {
    if (w.status === "running") {
      void now;
      return w.started_at ? crewDur(Date.now() - w.started_at) : "…";
    }
    return w.duration_ms !== undefined ? crewDur(w.duration_ms) : "—";
  }

  function base(p: string): string {
    return p.split("/").pop() ?? p;
  }

  function visibleKeys(): string[] {
    if (!run) return [];
    return run.groups.filter(isExpanded).flatMap((g) => rowsOf(g).rows.map((w) => w.key));
  }

  function move(delta: number) {
    const keys = visibleKeys();
    if (keys.length === 0) return;
    const i = keys.indexOf(focus);
    focus = keys[i < 0 ? (delta > 0 ? 0 : keys.length - 1) : (i + delta + keys.length) % keys.length]!;
    document.querySelector<HTMLElement>(`[data-agent-id="crew.run.${run?.id}.w.${focus}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function moveGroup(delta: number) {
    if (!run || run.groups.length === 0) return;
    const gi = focus ? Number(focus.split(".")[0]) : -1;
    const next = run.groups[(Math.max(0, gi) + delta + run.groups.length) % run.groups.length]!;
    expanded[next.index] = true;
    focus = rowsOf(next).rows[0]?.key ?? "";
  }

  function stop() {
    if (!run || !live) return;
    if (!confirmStop) {
      confirmStop = true;
      setTimeout(() => (confirmStop = false), 4000);
      return;
    }
    confirmStop = false;
    stopRun(run.id);
  }

  function submit() {
    if (!run || !paused) return;
    if (answerRun(run.id, answer)) answer = "";
  }

  function onKey(e: KeyboardEvent) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    const editing = !!t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT");
    if (editing) {
      if (e.key === "Enter" && !e.shiftKey && t === answerEl) {
        e.preventDefault();
        submit();
      }
      return;
    }
    switch (e.key) {
      case "j": move(1); break;
      case "k": move(-1); break;
      case "J": moveGroup(1); break;
      case "K": moveGroup(-1); break;
      case "Enter": if (focus) requestTail(focus); else return; break;
      case "x": if (live) stop(); else return; break;
      case "y": if (confirmStop) stop(); else return; break;
      case "a": if (paused) answerEl?.focus(); else return; break;
      case "r": if (crew.tailWorker) refreshTail(); else return; break;
      default: return;
    }
    e.preventDefault();
  }

  function close() {
    closeRun();
    onClose?.();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="sheet"
  role="dialog"
  aria-modal="true"
  aria-label={run ? `crew run ${run.id}` : "crew run"}
  tabindex="-1"
  data-agent-id={`crew.run.${crew.openId}`}
  data-state={run ? run.state : "loading"}
  onkeydown={onKey}
>
  {#if !run}
    <div class="head"><span class="dim">crew run {shortRun(crew.openId)} · loading…</span>
      <button class="act close" data-agent-id={`crew.run.${crew.openId}.close`} onclick={close}>esc</button></div>
  {:else}
    <div class={`head st-${run.state}`}>
      <span class={`glyph ${run.state === "running" ? "pulse" : ""}`}>{GLYPH[run.state]}</span>
      <span class="title"><b>crew run {shortRun(run.id)}</b>
        <span class="dim"> · {run.mode} · {stopped ? "stopped by user" : run.status} · {run.status === "running" || run.status === "pending" ? crewDur(run.age_ms) : crewDur(run.duration_ms)}</span></span>
      <span class="counts" aria-live="polite">
        {#if run.counts.run}<span class="st-cyan">●{run.counts.run}</span>{/if}
        {#if run.counts.done}<span class="st-green">✓{run.counts.done}</span>{/if}
        {#if run.counts.fail}<span class="st-red">✗{run.counts.fail}</span>{/if}
        {#if run.counts.paused}<span class="st-yellow">⚠{run.counts.paused}</span>{/if}
        {#if run.counts.pending}<span class="faint">○{run.counts.pending}</span>{/if}
      </span>
      <button class="act close" data-agent-id={`crew.run.${run.id}.close`} onclick={close}>esc</button>
    </div>
    <div class="task faint" title={run.cwd}>{run.task}</div>

    <div class="body">
      {#if paused && run.escalation}
        <section class="esc" data-agent-id={`crew.run.${run.id}.escalation`} data-state={crew.answering ? "answering" : "open"} aria-label="escalation">
          <div class="esc-head"><span class="st-yellow">⚠ escalation</span> <span class="dim">· {run.escalation.label}{run.escalation.reason ? ` · ${run.escalation.reason}` : ""}</span></div>
          <pre class="tail">{run.escalation.question}</pre>
          <textarea
            bind:this={answerEl}
            bind:value={answer}
            rows="3"
            placeholder="your answer — ⏎ submits, shift+⏎ newline"
            disabled={crew.answering}
            data-agent-id={`crew.run.${run.id}.answer`}
          ></textarea>
          <div class="acts">
            <button class="act ok" data-agent-id={`crew.run.${run.id}.answer.submit`} disabled={crew.answering || !answer.trim()} onclick={submit}>[⏎] {crew.answering ? "answering…" : "submit answer"}</button>
            <span class="faint">first answer wins across clients · no deadline</span>
          </div>
        </section>
      {/if}

      {#each run.groups as g (g.index)}
        {@const open = isExpanded(g)}
        {@const r = rowsOf(g)}
        <div class="group" role="rowgroup" data-agent-id={`crew.run.${run.id}.g.${g.index}`} data-state={g.status}>
          <button class="sect" onclick={() => (expanded[g.index] = !open)} aria-expanded={open}>
            <span class="faint">{open ? "▾" : "▸"}</span>
            step {g.index}{g.kind === "sequential" ? ` · ${g.label}` : ` · ${g.kind === "parallel" ? "parallel" : "fanout"} (${g.counts.total})`}
            {#if g.kind !== "sequential" && g.counts.total > 1}
              <span class="bar st-green">{bar(g)}</span>
              {#if g.counts.done}<span class="st-green">✓</span>{g.counts.done}{/if}
              {#if g.counts.run}<span class="st-cyan">●</span>{g.counts.run}{/if}
              {#if g.counts.fail}<span class="st-red">✗</span>{g.counts.fail}{/if}
              {#if g.counts.paused}<span class="st-yellow">⚠</span>{g.counts.paused}{/if}
              {#if g.counts.pending}<span class="faint">○{g.counts.pending}</span>{/if}
            {:else if g.status === "paused"}
              <span class="st-yellow">⚠ escalation</span>
            {/if}
          </button>
          {#if open}
            {#each r.rows as w (w.key)}
              <div class={`row st-${w.status}`} class:focus={focus === w.key} data-agent-id={`crew.run.${run.id}.w.${w.key}`} data-state={w.status}>
                <span class={`glyph ${w.status === "running" ? "pulse" : ""}`}>{GLYPH[w.status]}</span>
                <button class="lbl truncate" title={w.label} onclick={() => { focus = w.key; requestTail(w.key); }}>{w.label}</button>
                <span class="agent faint truncate">{w.agent}{w.model ? ` · ${w.model}` : ""}</span>
                <span class="dur dim">{dur(w)}</span>
                <span class="extra truncate">
                  {#if w.status === "failed" && w.error}<span class="st-red">{w.error}</span>
                  {:else if w.status === "paused"}<span class="st-yellow">awaiting answer</span>
                  {:else if w.output}<button class="act" data-agent-id={`crew.run.${run.id}.w.${w.key}.file`} onclick={() => openFile(w.output!)}>{base(w.output)}</button>{/if}
                </span>
                <button class="act tail-act" data-agent-id={`crew.run.${run.id}.w.${w.key}.tail`} data-state={crew.tailWorker === w.key ? "shown" : "hidden"} onclick={() => { focus = w.key; requestTail(w.key); }}>{crew.tailWorker === w.key ? "[⏎] hide" : "[⏎] tail"}</button>
              </div>
              {#if crew.tailWorker === w.key}
                <div class="tailpane" data-agent-id={`crew.run.${run.id}.tail`} data-state={crew.tailPending ? "loading" : "shown"}>
                  <div class="tail-head faint">live.log · {w.label}{crew.tail ? ` · last ${crew.tail.lines.length} lines${crew.tail.truncated ? " (truncated)" : ""}` : ""}
                    <button class="act" data-agent-id={`crew.run.${run.id}.tail.refresh`} onclick={refreshTail}>[r] refresh</button></div>
                  <pre class="tail">{crew.tailPending && !crew.tail ? "…" : crew.tail?.lines.join("\n") || "(empty)"}</pre>
                </div>
              {/if}
            {/each}
            {#if r.hiddenDone > 0}
              <button class="fold faint" data-agent-id={`crew.run.${run.id}.g.${g.index}.done`} onclick={() => (showDone[g.index] = true)}>▸ {r.hiddenDone} more completed</button>
            {/if}
            {#if r.hiddenMore > 0}
              <button class="fold faint" data-agent-id={`crew.run.${run.id}.g.${g.index}.more`} onclick={() => (showAll[g.index] = true)}>▾ {r.hiddenMore} more</button>
            {/if}
          {/if}
        </div>
      {/each}

      {#if crew.file}
        <div class="filepane" data-agent-id={`crew.run.${run.id}.file`} data-state="shown">
          <div class="tail-head faint">{crew.file.path} · {crew.file.bytes} B{crew.file.truncated ? " (truncated)" : ""}
            <button class="act" onclick={() => (crew.file = null)}>close</button></div>
          <pre class="tail file">{crew.file.text}</pre>
        </div>
      {/if}
    </div>

    <div class="foot">
      {#if paused}<button class="act" data-agent-id={`crew.run.${run.id}.answer.focus`} onclick={() => answerEl?.focus()}>[a] answer…</button>{/if}
      {#if live}
        <button class="act warn" data-agent-id={`crew.run.${run.id}.stop`} data-state={confirmStop ? "confirm" : crew.stopping ? "stopping" : "ready"} disabled={crew.stopping} onclick={stop}>
          {confirmStop ? "confirm stop? [y]" : crew.stopping ? "stopping…" : "[x] stop"}
        </button>
      {/if}
      {#if run.files.length}
        <span class="faint">deliverables:</span>
        {#each run.files as f (f)}<button class="act" data-agent-id={`crew.run.${run.id}.file.${f}`} onclick={() => openFile(f)}>{f}</button>{/each}
      {/if}
      <span class="faint hint">j/k workers · J/K groups · ⏎ tail{live ? " · x stop" : ""}{paused ? " · a answer" : ""}{!live ? " · terminal run: no stop, no answer" : ""}</span>
    </div>
  {/if}
</div>

<style>
  .sheet { display: flex; flex-direction: column; min-height: 0; max-height: 100%; outline: none; }
  .head { display: flex; gap: 10px; align-items: baseline; padding: 8px 12px 4px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  .head .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .counts { display: flex; gap: 8px; }
  .task { padding: 2px 12px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .body { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 12px; }
  .foot { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; padding: 6px 12px; border-top: 1px solid var(--line); }
  .hint { margin-left: auto; font-size: 11px; }
  .sect { display: flex; gap: 6px; align-items: baseline; width: 100%; text-align: left; color: var(--dim); text-transform: lowercase; letter-spacing: .06em; font-size: 12px; margin: 8px 0 2px; }
  .sect:hover { background: var(--bg2); }
  .bar { letter-spacing: -1px; }
  .row { display: flex; gap: 10px; align-items: baseline; padding: 2px 0 2px 16px; white-space: nowrap; min-width: 0; }
  .row:hover, .row.focus { background: var(--bg2); }
  .row.focus { box-shadow: inset 2px 0 0 var(--cyan); }
  .glyph { flex: 0 0 1ch; }
  .lbl { flex: 0 1 14rem; min-width: 6rem; text-align: left; color: var(--fg); }
  .agent { flex: 0 1 10rem; min-width: 0; }
  .dur { flex: 0 0 5rem; text-align: right; }
  .extra { flex: 1; min-width: 0; }
  .tail-act { flex-shrink: 0; font-size: 11px; }
  .fold { display: block; padding: 2px 0 2px 26px; width: 100%; text-align: left; }
  .fold:hover { background: var(--bg2); }
  .tailpane, .filepane { margin: 2px 0 6px 26px; border-left: 2px solid var(--line); background: var(--bg); }
  .tail-head { display: flex; gap: 10px; padding: 3px 8px 0; font-size: 11px; }
  .tail { margin: 0; padding: 4px 8px 6px; font-size: 12px; color: var(--dim); white-space: pre-wrap; word-break: break-word; max-height: 40dvh; overflow: auto; }
  .tail.file { color: var(--fg); }
  .esc { border-left: 2px solid var(--yellow); background: var(--bg1); padding: 6px 10px; margin: 6px 0 10px; }
  .esc-head { margin-bottom: 4px; }
  .esc textarea { width: 100%; background: var(--bg3); color: var(--fg); border: 1px solid var(--line); font: inherit; padding: 6px; resize: vertical; margin-top: 6px; }
  .esc .acts { display: flex; gap: 12px; align-items: baseline; margin-top: 4px; }
  .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st-pending .glyph { color: var(--faint); }
  .st-running .glyph { color: var(--cyan); }
  .st-completed .glyph { color: var(--green); }
  .st-failed .glyph { color: var(--red); }
  .st-paused .glyph { color: var(--yellow); }
  .st-stopped .glyph, .st-stopped .title { color: var(--dim); }
  .st-cyan { color: var(--cyan); } .st-green { color: var(--green); } .st-red { color: var(--red); } .st-yellow { color: var(--yellow); }
  .dim { color: var(--dim); } .faint { color: var(--faint); }
  @media (max-width: 900px) {
    .agent { display: none; }
    .lbl { flex-basis: 8rem; }
  }
</style>
