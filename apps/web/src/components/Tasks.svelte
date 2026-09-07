<script lang="ts">
  // Shared task workspace panel: the list + the record editor. Same durable
  // record the agent holds — saves go through the host (validated, rev-bumped,
  // optimistic concurrency), agent-side edits arrive live via tasks.changed.
  import { tasks, closeTasks, openTask, newTask, saveTask, deleteTask, refreshTasks, TASK_STATUSES_UI } from "../lib/tasks.svelte";
  import { app } from "../lib/state.svelte";
  import { useDialog } from "../lib/dialog.svelte";

  const dlg = useDialog(() => tasks.open);

  const GLYPH: Record<string, string> = { planned: "○", active: "▶", blocked: "⛔", done: "✓", failed: "✗", dropped: "·" };

  const draft = $derived(tasks.draft);

  /** Acceptance criteria: one line in the editor = one item. */
  let acceptanceText = $state("");
  $effect(() => {
    acceptanceText = (draft?.acceptance ?? []).join("\n");
  });

  function markDirty() {
    if (draft) draft.dirty = true;
  }

  function setAcceptance(v: string) {
    acceptanceText = v;
    if (!draft) return;
    draft.acceptance = v.split("\n").map((l) => l.trim()).filter(Boolean);
    markDirty();
  }

  function save() {
    saveTask();
  }

  const statusGlyph = $derived(GLYPH[draft?.status ?? "planned"] ?? "·");
</script>

{#if tasks.open}
  <div class="insp-scrim" data-agent-id="tasks.scrim" onclick={closeTasks} onkeydown={() => {}} role="presentation"></div>
  <div class="insp gallery-overlay tasks" role="dialog" aria-modal="true" aria-label="Tasks" tabindex="-1" use:dlg.ref data-agent-id="tasks.overlay" data-state={draft ? "edit" : "list"}>
    <div class="insp-head">
      <span class="st-magenta">Tasks</span>
      <span class="dim">Shared workspace · {tasks.cwd || "host"}</span>
      <span class="insp-acts">
        {#if draft}
          <button class="act" data-agent-id="tasks.back" onclick={() => { tasks.draft = null; tasks.confirmDelete = ""; }}>← Tasks</button>
          <button class="act" data-agent-id="tasks.save" onclick={save}>{draft.dirty ? "Save*" : `Saved · rev ${draft.rev}`}</button>
        {:else}
          <button class="act" data-agent-id="tasks.refresh" onclick={refreshTasks}>↻</button>
          <button class="act accent" data-agent-id="tasks.new" onclick={newTask}>+ New task</button>
        {/if}
        <button class="act" data-agent-id="tasks.close" onclick={closeTasks}>esc</button>
      </span>
    </div>

    {#if !draft}
      <!-- LIST -->
      {#if tasks.list.length === 0}
        <div class="empty">
          <p class="dim">No shared tasks yet</p>
          <p class="dim">A task is the one durable record both you and the agent hold — goal, acceptance checks, blockers, artifacts.</p>
          <p class="dim">Create one here, or in a session: <code>/task plan &lt;name&gt; &lt;goal&gt;</code></p>
        </div>
      {:else}
        <ul class="flist" data-agent-id="tasks.list">
          {#each tasks.list as t (t.name)}
            <li class="frow" data-agent-id={`tasks.row.${t.name}`} data-state={t.status}>
              <button class="fmain" data-agent-id={`tasks.open.${t.name}`} onclick={() => openTask(t.name)}>
                <span class="st-{t.status === 'active' ? 'green' : t.status === 'done' ? 'cyan' : t.status === 'blocked' ? 'red' : 'yellow'}">{GLYPH[t.status] ?? "·"}</span>
                <span class="fname">{t.name}</span>
                <span class="dim">{t.title}</span>
                <span class="faint">rev {t.rev}{t.checks_ok > 0 ? ` · ${t.checks_ok} ✓` : ""}{t.updated_by === "agent" ? " · agent" : ""}</span>
              </button>
              <button class="act del" data-agent-id={`tasks.delete.${t.name}`} onclick={() => deleteTask(t.name)}>
                {tasks.confirmDelete === t.name ? "sure?" : "×"}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      {#if tasks.dir}
        <p class="faint tkl-dir" data-agent-id="tasks.dir">records: {tasks.dir} (the agent writes here too)</p>
      {/if}
    {:else}
      <!-- EDITOR -->
      <div class="tkl">
        {#if draft.stale}
          <p class="warn" data-agent-id="tasks.stale">The record changed on disk (maybe the agent) — your buffer is older than what's saved.</p>
          <button class="act" data-agent-id="tasks.stale.reload" onclick={() => draft.name && openTask(draft.name)}>Reload from disk</button>
        {/if}
        <div class="meta-row">
          <input class="m-in" value={draft.name} placeholder="task-name" disabled={draft.rev > 0} oninput={(e) => { draft.name = e.currentTarget.value.trim(); markDirty(); }} data-agent-id="tasks.meta.name" />
          <input class="m-in grow" value={draft.title} placeholder="Title (shown to you)" oninput={(e) => { draft.title = e.currentTarget.value; markDirty(); }} data-agent-id="tasks.meta.title" />
          <select class="m-in" value={draft.status} onchange={(e) => { draft.status = e.currentTarget.value as typeof draft.status; markDirty(); }} data-agent-id="tasks.meta.status">
            {#each TASK_STATUSES_UI as s (s.value)}
              <option value={s.value}>{statusGlyph} {s.label}</option>
            {/each}
          </select>
        </div>
        <label class="fld" data-agent-id="tasks.goal">
          <span>Goal — what does done mean?</span>
          <textarea rows="2" value={draft.goal} oninput={(e) => { draft.goal = e.currentTarget.value; markDirty(); }}></textarea>
        </label>
        <label class="fld" data-agent-id="tasks.acceptance">
          <span>Acceptance — machine-checkable, one per line</span>
          <textarea rows="3" value={acceptanceText} oninput={(e) => setAcceptance(e.currentTarget.value)}></textarea>
        </label>
        {#if draft.status === "blocked" || draft.blocked_on || draft.answer}
          <label class="fld" data-agent-id="tasks.blocked">
            <span>Blocked on — the question a human must answer</span>
            <textarea rows="2" value={draft.blocked_on} oninput={(e) => { draft.blocked_on = e.currentTarget.value; markDirty(); }}></textarea>
          </label>
          <label class="fld" data-agent-id="tasks.answer">
            <span>Answer</span>
            <textarea rows="2" value={draft.answer} oninput={(e) => { draft.answer = e.currentTarget.value; markDirty(); }}></textarea>
          </label>
        {/if}
        <label class="fld" data-agent-id="tasks.notes">
          <span>Constraints — guardrails</span>
          <textarea rows="2" value={draft.constraints.notes} oninput={(e) => { draft.constraints.notes = e.currentTarget.value; markDirty(); }}></textarea>
        </label>
        {#if draft.checks.length > 0}
          <div class="fld" data-agent-id="tasks.checks">
            <span>Checks — evidence, written by the runner</span>
            <ul class="tkl-checks">
              {#each draft.checks as c, i (i)}
                <li class="{c.ok ? 'ok' : 'no'}" data-agent-id={`tasks.check.${i}`}>
                  <span>{c.ok ? "✓" : "✗"}</span>
                  <span>{c.name}</span>
                  {#if c.detail}<span class="dim">{c.detail}</span>{/if}
                  <span class="faint">{c.by}</span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
        {#if draft.summary}
          <label class="fld" data-agent-id="tasks.summary">
            <span>Summary — written on completion</span>
            <textarea rows="3" value={draft.summary} disabled></textarea>
          </label>
        {/if}
        <p class="faint" data-agent-id="tasks.meta.info">
          rev {draft.rev} · updated by {draft.updated_by}{draft.updated_at ? ` · ${new Date(draft.updated_at).toLocaleString()}` : ""}
        </p>
        <div class="tkl-acts">
          <button class="act accent" data-agent-id="tasks.save.foot" onclick={save} disabled={!draft.dirty && draft.rev > 0}>{draft.dirty ? "Save" : "Saved"}</button>
          <button class="act del" data-agent-id="tasks.delete.foot" onclick={() => deleteTask(draft.name)}>
            {tasks.confirmDelete === draft.name ? "Really delete?" : "Delete"}
          </button>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .tkl {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 18px;
    overflow-y: auto;
    min-height: 0;
    flex: 1;
  }
  .tkl .meta-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .fld {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .fld > span {
    font-size: 11px;
    color: var(--dim, #888);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .fld textarea {
    background: transparent;
    border: 1px solid var(--line, #333);
    border-radius: 3px;
    color: inherit;
    font: inherit;
    padding: 6px 8px;
    resize: vertical;
  }
  .fld textarea:disabled {
    opacity: 0.7;
  }
  .tkl-checks {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .tkl-checks li {
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-size: 12px;
  }
  .tkl-checks li.ok span:first-child { color: #4cc38a; }
  .tkl-checks li.no span:first-child { color: #e5534b; }
  .tkl-acts {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    padding-top: 6px;
  }
  .tkl-dir {
    padding: 6px 18px 10px;
    margin: 0;
  }
  .empty {
    padding: 40px 18px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .warn {
    color: #e5534b;
  }
</style>
