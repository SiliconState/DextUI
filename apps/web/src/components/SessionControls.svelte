<script lang="ts">
  // Session controls popover: model, thinking and permissions folded behind
  // one status chip so the bar reads as status, not a toolbar. These are
  // session-level controls; device-level things live in the ⚙ settings menu.
  // Same anchored-catcher pattern as SettingsMenu; selects keep stable ids.
  import type { SessionState } from "@dextui/client";
  import type { ThinkingEffort } from "@dextui/protocol";
  import { app, closeSessionCtl } from "../lib/state.svelte";
  import { popoverPos } from "../lib/popover";
  import { useDialog } from "../lib/dialog.svelte";

  let { view }: { view: SessionState } = $props();

  const dlg = useDialog(() => app.sessionCtlOpen);
  const posStyle = $derived(popoverPos(app.sessionCtlAnchor, 304));

  const modelValue = $derived(view.provider && view.model ? `${view.provider}\u001f${view.model}` : "");
  const modelInCatalog = $derived(app.modelCatalog.some((group) => group.provider === view.provider && group.models.includes(view.model ?? "")));
  const canSelectModel = $derived(
    app.phase === "live" &&
      app.caps.includes("model_select") &&
      view.status === "live" &&
      !view.working && !view.modelLocked && app.modelCatalog.length > 0,
  );
  // With the bridge (steering.live), /effort is a runtime control dext applies
  // mid-turn, so the selector stays enabled while working.
  const liveEffort = $derived(app.caps.includes("steering.live"));
  const canSelectEffort = $derived(
    app.phase === "live" &&
      app.caps.includes("effort_select") &&
      view.status === "live" &&
      (liveEffort || !view.working) && app.effortOptions.length > 0,
  );

  function selectModel(e: Event) {
    const raw = (e.currentTarget as HTMLSelectElement).value;
    const split = raw.indexOf("\u001f");
    if (split < 1) return;
    const provider = raw.slice(0, split);
    const model = raw.slice(split + 1);
    app.conn?.configureSession(view.id, { provider, model });
  }

  function selectEffort(e: Event) {
    const thinking_effort = (e.currentTarget as HTMLSelectElement).value as ThinkingEffort;
    app.conn?.configureSession(view.id, { thinking_effort });
  }

  // Permission policy: what dext may do without asking. Keep the protocol
  // values stable while presenting the choice in plain language.
  const APPROVAL_LABELS: Record<string, string> = {
    ask: "Ask before actions",
    "auto-read": "Read without asking",
    "auto-write": "Edit without asking",
    always: "Allow all actions",
    never: "Deny all actions",
  };
  const canSetApproval = $derived(
    app.phase === "live" && app.caps.includes("slash.approval") && view.status === "live",
  );
  const approvalOptions = $derived.by(() => {
    const base = ["ask", "auto-read", "auto-write"];
    const cur = view.approvalProfile;
    const list = cur && !base.includes(cur) ? [cur, ...base] : base;
    return list.map((v) => ({ value: v, label: APPROVAL_LABELS[v] ?? v }));
  });
  function selectApproval(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    if (v && v !== view.approvalProfile) app.conn?.slash(view.id, `/approval ${v}`);
  }

  function onKey(e: KeyboardEvent) {
    dlg.onKey(e);
    if (e.key === "Escape") {
      closeSessionCtl();
      e.preventDefault();
      e.stopPropagation();
    }
  }
</script>

{#if app.sessionCtlOpen}
  <div class="menu-catch" data-agent-id="session.controls.scrim" onclick={closeSessionCtl} onkeydown={() => {}} role="presentation"></div>
  <div
    class="menu"
    style={posStyle}
    role="dialog"
    aria-modal="true"
    aria-labelledby="session-controls-title"
    tabindex="-1"
    use:dlg.ref
    data-agent-id="session.controls.overlay"
    onkeydown={onKey}
  >
    <div class="head">
      <span id="session-controls-title">This session</span>
      <span class="summary">Model, thinking, permissions</span>
      <button class="act close" data-agent-id="session.controls.close" aria-label="Close session controls" onclick={closeSessionCtl}>esc</button>
    </div>
    {#if app.caps.includes("model_select") && app.modelCatalog.length > 0}
      <div class="sec">
        <span class="lbl">Model</span>
        <select
          class="ctl"
          value={modelValue}
          onchange={selectModel}
          onfocus={() => app.conn?.authStatus()}
          disabled={!canSelectModel}
          title={view.modelLocked ? "Model is fixed once this session has history. Start a new session to change it." : app.caps.includes("model_switch") ? "Model for the next turn; history is kept" : "Model for this session's first turn"}
          data-agent-id="status.model.select"
          data-state={view.modelLocked ? "locked" : canSelectModel ? "ready" : "disabled"}
        >
          {#if modelValue && !modelInCatalog}<option value={modelValue}>{view.model} (current)</option>{/if}
          {#each app.modelCatalog as group (group.provider)}
            <optgroup label={group.label ? `${group.label} (${group.provider})` : group.provider}>
              {#each group.models as model (model)}
                <option value={`${group.provider}\u001f${model}`}>{model}</option>
              {/each}
            </optgroup>
          {/each}
        </select>
        {#if view.modelLocked}
          <span class="hint">Fixed after this session has history — start a new session to change it</span>
        {/if}
      </div>
    {/if}

    {#if app.caps.includes("effort_select") && app.effortOptions.length > 0}
      <div class="sec">
        <span class="lbl">Thinking</span>
        <select
          class="ctl"
          value={view.thinkingEffort ?? "medium"}
          onchange={selectEffort}
          disabled={!canSelectEffort}
          title="Reasoning effort for the next turn"
          data-agent-id="status.effort.select"
          data-state={canSelectEffort ? "ready" : "disabled"}
        >
          {#each app.effortOptions as effort (effort)}
            <option value={effort}>{effort}</option>
          {/each}
        </select>
      </div>
    {/if}

    {#if view.approvalProfile}
      <div class="sec">
        <span class="lbl">Permissions</span>
        {#if canSetApproval}
          <select
            class="ctl appr"
            value={view.approvalProfile}
            onchange={selectApproval}
            title="What dext may do without asking — applies from the next turn"
            data-agent-id="status.approval.select"
            data-state="ready"
          >
            {#each approvalOptions as opt (opt.value)}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        {:else}
          <span class="appr-val" data-agent-id="status.profile" title="Approval profile — {view.approvalProfile}">{APPROVAL_LABELS[view.approvalProfile] ?? view.approvalProfile}</span>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .menu-catch {
    position: fixed;
    inset: 0;
    z-index: 36;
  }
  .menu {
    position: fixed;
    z-index: 37;
    width: min(19rem, calc(100vw - 24px));
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border: 1px solid var(--line);
    background: var(--bg3);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
    font-size: 12px;
    animation: fade-in 0.1s ease-out;
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 2px 2px 7px;
    border-bottom: 1px solid var(--line);
    color: var(--fg);
  }
  .summary {
    margin-left: auto;
    color: var(--faint);
    font-size: 0.85em;
  }
  .close {
    flex: none;
  }
  .sec {
    display: grid;
    grid-template-columns: 4.5rem 1fr;
    gap: 2px 8px;
    align-items: center;
    padding: 2px;
  }
  .sec .hint {
    grid-column: 2;
  }
  .lbl {
    color: var(--faint);
    font-size: 0.85em;
    letter-spacing: 0.04em;
  }
  .ctl {
    width: 100%;
    min-width: 0;
    appearance: auto;
    border: 1px solid var(--line);
    background: var(--bg1);
    color: var(--cyan);
    font: inherit;
    padding: 3px 4px;
    cursor: pointer;
  }
  .ctl:disabled {
    color: var(--dim);
    cursor: default;
  }
  .ctl option,
  .ctl optgroup {
    background: var(--bg1);
    color: var(--fg);
  }
  /* Approval keeps its caution hue (was a yellow badge on the bar). */
  .ctl.appr {
    color: var(--yellow);
  }
  .appr-val {
    color: var(--yellow);
  }
  .hint {
    color: var(--faint);
    font-size: 0.85em;
  }
</style>
