<script lang="ts">
  import { untrack } from "svelte";
  import { app, confirmSessionAction } from "../lib/state.svelte";

  let title = $state("");
  const action = $derived(app.sessionAction);
  const target = $derived(action && "id" in action ? app.sessions.find((s) => s.id === action.id) : undefined);
  const count = $derived(action?.kind === "bulk"
    ? app.sessions.filter((s) => action.scope === "all" || s.status === "cold" || s.status === "exited").length
    : 1);

  $effect(() => {
    if (action?.kind === "rename") title = untrack(() => target?.title ?? "");
  });

  function focus(node: HTMLElement, enabled = true) {
    const id = requestAnimationFrame(() => { if (enabled) node.focus(); });
    return { destroy: () => cancelAnimationFrame(id) };
  }
</script>

{#if action}
  <form class="session-action" data-agent-id="session.action" aria-label="Confirm session action"
    onsubmit={(e) => { e.preventDefault(); confirmSessionAction(title); }}>
    {#if action.kind === "rename"}
      <label>Rename session
        <input use:focus bind:value={title} maxlength="80" required disabled={app.sessionPending}
          data-agent-id="session.rename.input" />
      </label>
    {:else}
      <p class="question">{action.kind === "clear" ? "Clear" : "Delete"} {action.kind === "bulk" ? `${count} ${action.scope === "cold" ? "closed " : ""}sessions` : `“${target?.title ?? "session"}”`}?</p>
      <p>Stops running work and permanently removes transcripts, agent context, session todos, drafts and history.</p>
      <p>{action.kind === "clear" ? "Keeps this session's name, folder and settings; starts with fresh context." : "Cannot be undone."} Workspace files are kept.</p>
    {/if}
    <div class="actions">
      <button use:focus={action.kind !== "rename"} type="button" class="act" disabled={app.sessionPending}
        data-agent-id="session.action.cancel" onclick={() => (app.sessionAction = null)}>cancel</button>
      <button type="submit" class="act" class:err={action.kind !== "rename"}
        disabled={app.sessionPending || app.phase !== "live" || count === 0 || (action.kind === "rename" && !title.trim())}
        data-agent-id="session.action.confirm">{app.sessionPending ? "working…" : action.kind === "rename" ? "save" : action.kind === "clear" ? "clear session" : "delete permanently"}</button>
    </div>
    <span class="faint" role="status">{app.phase !== "live" ? "Reconnect to continue" : app.sessionPending ? "Waiting for the server…" : ""}</span>
  </form>
{/if}

<style>
  .session-action { padding: 10px; border-bottom: 1px solid var(--line); background: var(--bg1); font-size: 11px; }
  p { margin: 0 0 8px; color: var(--dim); overflow-wrap: anywhere; }
  .question { color: var(--fg); }
  label { display: grid; gap: 6px; }
  input { min-width: 0; width: 100%; border: 1px solid var(--line); padding: 5px; }
  .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; }
  input:focus-visible, button:focus-visible { outline: 1px solid var(--cyan); outline-offset: 2px; }
</style>
