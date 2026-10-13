<script lang="ts">
  // The Float window: a small DextUI that stays on top while the person uses
  // their own browser. State, decisions, the latest reply and the message box.
  import type { SessionStore } from "@dextui/client";
  import { app, queueTotal } from "../../lib/state.svelte";
  import { useSession } from "../../lib/useSession.svelte";
  import { headerStatus } from "../../lib/session-header";
  import Composer from "../../components/Composer.svelte";
  import Approval from "../../components/Approval.svelte";

  let { getStore, onReturn }: { getStore: () => SessionStore | null; onReturn: () => void } = $props();
  const store = $derived(getStore());
  const sess = useSession(() => store);
  const view = $derived(sess.view);
  const status = $derived(headerStatus(view, app.phase));
  const title = $derived(app.sessions.find((s) => s.id === view?.id)?.title || "DextUI");
  const pending = $derived(view ? [...view.pending.values()] : []);
  const reply = $derived.by(() => {
    if (!view) return "";
    for (let i = view.blocks.length - 1; i >= 0; i--) {
      const b = view.blocks[i]!;
      if (b.kind === "text") return b.text.slice(-6000);
    }
    return "";
  });
</script>

<div class="float-panel" data-agent-id="browser.float.panel">
  <header>
    <span class="float-state" data-tone={status.tone} aria-live="polite" data-agent-id="browser.float.state">{status.label}</span>
    <span class="float-title" title={title}>{title}</span>
    <button class="act accent" data-agent-id="browser.float.return" onclick={onReturn}>Back to DextUI</button>
  </header>
  <div class="float-body">
    {#if status.busy || status.label === "Needs input"}<p class="step">{status.step}</p>{/if}
    {#if view}
      {#each pending as permission (permission.request_id)}<Approval pending={permission} sessionId={view.id} />{/each}
    {/if}
    {#if view?.pendingUi || queueTotal() > pending.length}
      <button class="act warn" data-agent-id="browser.float.decisions" onclick={onReturn}>Answer {queueTotal()} waiting in DextUI</button>
    {/if}
    {#if reply}<p class="reply" data-agent-id="browser.float.reply">{reply}</p>{:else if !pending.length}<p class="step">No reply yet. Messages you send here go to this session.</p>{/if}
  </div>
  {#if store}<div class="float-composer"><Composer {store} /></div>{/if}
</div>

<style>
  .float-panel { height: 100dvh; display: flex; flex-direction: column; background: var(--bg); color: var(--fg); }
  header { display: flex; align-items: center; gap: 8px; padding: 0 10px; min-height: 36px; background: var(--bg1); border-bottom: 1px solid var(--line); font: 12px/1.4 var(--sans); }
  .float-state { color: var(--dim); flex-shrink: 0; }
  .float-state[data-tone="amber"] { color: var(--yellow); }
  .float-state[data-tone="blue"] { color: var(--cyan); }
  .float-state[data-tone="red"] { color: var(--red); }
  .float-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header button { min-height: 32px; }
  .float-body { flex: 1; min-height: 0; overflow: auto; padding: 10px; overflow-wrap: anywhere; display: flex; flex-direction: column; gap: 8px; }
  .step { color: var(--dim); font: 12px/1.4 var(--sans); }
  .reply { white-space: pre-wrap; font: 13px/1.5 var(--sans); }
  .float-composer { border-top: 1px solid var(--line); background: var(--bg1); }
  .float-composer :global(.browser-launcher) { display: none; }
</style>
