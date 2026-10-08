<script lang="ts">
  // Session controls popover: model, thinking and permissions folded behind
  // one status chip so the bar reads as status, not a toolbar. These are
  // session-level controls; device-level things live in the ⚙ settings menu.
  // Same anchored-catcher pattern as SettingsMenu; selects keep stable ids.
  import { tick } from "svelte";
  import type { SessionState } from "@dextui/client";
  import type { ThinkingEffort } from "@dextui/protocol";
  import { app, closeSessionCtl, trackDelivery } from "../lib/state.svelte";
  import { popoverPos } from "../lib/popover";
  import { useDialog } from "../lib/dialog.svelte";
  import { headerContext } from "../lib/session-header";
  import { fmtTokens } from "../lib/markdown";

  let { view }: { view: SessionState } = $props();

  type Picker = "model" | "effort" | "approval";
  let picker = $state<Picker | null>(null);
  let modelQuery = $state("");
  let menuNode = $state<HTMLElement | null>(null);
  const pickerTitle = $derived(picker === "model" ? "Choose model" : picker === "effort" ? "Thinking effort" : "Permissions");
  const modelGroups = $derived(app.modelCatalog.map((group) => ({ ...group, models: group.models.filter((model) => `${group.label ?? ""} ${group.provider} ${model}`.toLowerCase().includes(modelQuery.trim().toLowerCase())) })).filter((group) => group.models.length));
  function returnToControls() {
    const previous = picker;
    picker = null;
    modelQuery = "";
    confirmAuto = false;
    if (previous) void tick().then(() => menuNode?.querySelector<HTMLElement>(`[data-agent-id="status.${previous}.picker"]`)?.focus({ preventScroll: true }));
  }
  function openPicker(value: Picker) {
    picker = value;
    modelQuery = "";
    confirmAuto = false;
    if (value === "model") app.conn?.authStatus();
    void tick().then(() => menuNode?.querySelector<HTMLElement>('[data-agent-id="session.picker.back"]')?.focus({ preventScroll: true }));
  }
  let advanced = $state(false);
  let phone = $state(matchMedia("(max-width: 900px)").matches);
  $effect(() => {
    const media = matchMedia("(max-width: 900px)");
    const update = () => { phone = media.matches; advanced = false; picker = null; modelQuery = ""; confirmAuto = false; };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  });
  const dlg = useDialog(() => app.sessionCtlOpen);
  let layoutRevision = $state(0);
  $effect(() => {
    if (!app.sessionCtlOpen) return;
    const resize = () => { layoutRevision += 1; };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  });
  const posStyle = $derived.by(() => {
    void layoutRevision;
    return popoverPos(app.sessionCtlAnchor, 304);
  });

  const modelValue = $derived(view.provider && view.model ? `${view.provider}\u001f${view.model}` : "");
  const modelInCatalog = $derived(app.modelCatalog.some((group) => group.provider === view.provider && group.models.includes(view.model ?? "")));
  const canSelectModel = $derived(
    app.phase === "live" &&
      app.caps.includes("model_select") &&
      view.status === "live" &&
      !view.working && !view.compacting && !view.backgroundCompactPending && !view.modelLocked && app.modelCatalog.length > 0,
  );
  // With the bridge (steering.live), /effort is a runtime control dext applies
  // mid-turn, so the selector stays enabled while working.
  const liveEffort = $derived(app.caps.includes("steering.live"));
  const canSelectEffort = $derived(
    app.phase === "live" &&
      app.caps.includes("effort_select") &&
      view.status === "live" &&
      !view.compacting && !view.backgroundCompactPending &&
      (liveEffort || !view.working) && app.effortOptions.length > 0,
  );

  function chooseModel(raw: string) {
    if (!canSelectModel) return;
    const split = raw.indexOf("\u001f");
    if (split < 1) return;
    const provider = raw.slice(0, split);
    const model = raw.slice(split + 1);
    if (!app.modelCatalog.some((group) => group.provider === provider && group.models.includes(model))) return;
    if (raw !== modelValue) app.conn?.configureSession(view.id, { provider, model });
    if (phone) returnToControls();
  }
  function selectModel(e: Event) { chooseModel((e.currentTarget as HTMLSelectElement).value); }

  function chooseEffort(thinking_effort: ThinkingEffort) {
    if (!canSelectEffort || !app.effortOptions.includes(thinking_effort)) return;
    if (thinking_effort !== view.thinkingEffort) app.conn?.configureSession(view.id, { thinking_effort });
    if (phone) returnToControls();
  }
  function selectEffort(e: Event) { chooseEffort((e.currentTarget as HTMLSelectElement).value as ThinkingEffort); }

  // Permission policy: what dext may do without asking. Keep the protocol
  // values stable while presenting the choice in plain language.
  const APPROVAL_LABELS: Record<string, string> = {
    ask: "Ask before actions",
    "auto-read": "Read without asking",
    "auto-write": "Edit without asking",
    always: "Allow all actions",
    never: "Deny all actions",
  };
  const APPROVAL_HINTS: Record<string, string> = {
    ask: "Ask before running tools",
    "auto-read": "Read files without asking; ask before changes",
    "auto-write": "Edit files without asking; ask before other actions",
    always: "Run all actions without asking, including commands",
    never: "Do not allow tool actions",
  };
  const canSetApproval = $derived(
    app.phase === "live" && app.caps.includes("slash.approval") && view.status === "live" && !view.compacting && !view.backgroundCompactPending,
  );
  const approvalOptions = $derived.by(() => {
    const base = ["ask", "auto-read", "auto-write", "always"];
    const cur = view.approvalProfile;
    const list = cur && !base.includes(cur) ? [cur, ...base] : base;
    return list.map((v) => ({ value: v, label: APPROVAL_LABELS[v] ?? v }));
  });
  let confirmAuto = $state(false);
  function applyApproval(value: string) {
    confirmAuto = false;
    if (!canSetApproval || !approvalOptions.some((option) => option.value === value)) return;
    if (value === view.approvalProfile) { if (phone) returnToControls(); return; }
    const text = `/approval ${value}`;
    const nonce = app.conn?.slash(view.id, text);
    if (nonce) trackDelivery(nonce, { sessionId: view.id, text, kind: "slash" });
    if (phone) returnToControls();
  }
  function chooseApproval(value: string) {
    if (!canSetApproval) return;
    if (value === "always" && view.approvalProfile !== "always") {
      confirmAuto = true;
      if (phone) void tick().then(() => menuNode?.querySelector<HTMLElement>('[data-agent-id="session.permission.enable"]')?.focus());
    }
    else applyApproval(value);
  }
  function selectApproval(e: Event) {
    const select = e.currentTarget as HTMLSelectElement;
    const value = select.value;
    select.value = view.approvalProfile ?? "ask";
    chooseApproval(value);
  }
  const context = $derived(headerContext(view));
  function compact() {
    if (app.phase !== "live" || view.working || view.compacting || view.backgroundCompaction || view.backgroundCompactPending || !app.caps.includes("slash.compact")) return;
    const text = "/compact";
    const nonce = app.conn?.slash(view.id, text);
    if (nonce) trackDelivery(nonce, { sessionId: view.id, text, kind: "slash" });
  }

  const canSetBackground = $derived(app.phase === "live" && app.caps.includes("background_compaction_setting") && (view.status === "live" || view.status === "cold") && !view.working && !view.compacting && !view.backgroundCompactPending);
  function selectBackground(e: Event) {
    const select = e.currentTarget as HTMLSelectElement;
    const enabled = select.value === "on";
    select.value = view.backgroundCompact === false ? "off" : "on";
    if (canSetBackground && enabled !== view.backgroundCompact) app.conn?.slash(view.id, `/compact background ${enabled ? "on" : "off"}`);
  }

  let forkSeq = $state("");
  $effect(() => { void view.id; void app.hostEpoch; forkSeq = ""; confirmAuto = false; picker = null; modelQuery = ""; });
  $effect(() => { if (!app.sessionCtlOpen) { confirmAuto = false; advanced = false; picker = null; modelQuery = ""; } });
  const canFork = $derived(app.phase === "live" && app.caps.includes("session_fork") && !view.working && !view.compacting && !view.backgroundCompaction && !view.backgroundCompactPending);
  function fork() {
    const at = !phone && forkSeq.trim() ? Number(forkSeq) : undefined;
    if (!canFork || (at !== undefined && (!Number.isSafeInteger(at) || at < 0))) return;
    if (app.conn?.forkSession(view.id, at)) closeSessionCtl();
  }

  function onKey(e: KeyboardEvent) {
    dlg.onKey(e);
    if (e.key === "Escape") {
      if (phone && picker) returnToControls();
      else closeSessionCtl();
      e.preventDefault();
      e.stopPropagation();
    }
  }
</script>

{#if app.sessionCtlOpen}
  <div class="menu-catch" data-agent-id="session.controls.scrim" onclick={closeSessionCtl} onkeydown={() => {}} role="presentation"></div>
  <div
    class="menu compact-popover"
    bind:this={menuNode}
    style={posStyle}
    role="dialog"
    aria-modal="true"
    aria-labelledby="session-controls-title"
    tabindex="-1"
    use:dlg.ref
    data-agent-id="session.controls.overlay"
    onkeydown={onKey}
    onfocusin={(event) => { if (phone && event.target instanceof HTMLElement) event.target.scrollIntoView({ block: "nearest" }); }}
  >
    <div class="head">
      {#if phone && picker}<button class="act picker-back" data-agent-id="session.picker.back" aria-label="Back to session controls" onclick={returnToControls}>‹ Back</button>{/if}
      <span id="session-controls-title">{phone && picker ? pickerTitle : "This session"}</span>
      <span class="summary">Model, thinking, permissions</span>
      <button class="act close" data-agent-id="session.controls.close" aria-label="Close session controls" onclick={closeSessionCtl}>Close</button>
    </div>
    {#if phone && picker}
      {#if picker === "model"}
        <input class="model-search" type="search" bind:value={modelQuery} placeholder="Search models…" aria-label="Search models" data-agent-id="session.model.search" />
        <div class="choices" role="group" aria-label="Models" data-agent-id="session.picker.choices">
          {#if modelValue && !modelInCatalog}<p class="hint current-model">Current: {view.model} · {view.provider} (not in catalog)</p>{/if}
          {#each modelGroups as group (group.provider)}
            <h3 class="choice-group">{group.label || group.provider}</h3>
            {#each group.models as model (model)}
              <button class="choice" aria-pressed={modelValue === `${group.provider}\u001f${model}`} disabled={!canSelectModel} data-agent-id="session.model.option" data-value={`${group.provider}\u001f${model}`} onclick={() => chooseModel(`${group.provider}\u001f${model}`)}><span class="choice-text">{model}</span><span class="choice-check" aria-hidden="true">{modelValue === `${group.provider}\u001f${model}` ? "✓" : ""}</span></button>
            {/each}
          {/each}
          {#if !modelGroups.length}<p class="hint">No matching models</p>{/if}
        </div>
      {:else if picker === "effort"}
        <p class="picker-hint">{liveEffort ? "Applies to this session, including during work." : "Reasoning effort for the next turn."}</p>
        <div class="choices" role="group" aria-label="Thinking effort" data-agent-id="session.picker.choices">
          {#each app.effortOptions as effort (effort)}<button class="choice" aria-pressed={(view.thinkingEffort ?? "medium") === effort} disabled={!canSelectEffort} data-agent-id={`session.effort.option.${effort}`} onclick={() => chooseEffort(effort)}><span class="choice-text effort-label">{effort}</span><span class="choice-check" aria-hidden="true">{(view.thinkingEffort ?? "medium") === effort ? "✓" : ""}</span></button>{/each}
        </div>
      {:else}
        <p class="picker-hint">What the agent may do without asking.</p>
        <div class="choices" role="group" aria-label="Permissions" data-agent-id="session.picker.choices">
          {#each approvalOptions as option (option.value)}<button class="choice" class:caution={option.value === "always"} aria-pressed={view.approvalProfile === option.value} disabled={!canSetApproval} data-agent-id={`session.approval.option.${option.value}`} onclick={() => chooseApproval(option.value)}><span class="choice-text">{option.value === "always" ? "Full auto" : option.label}<span class="choice-hint">{APPROVAL_HINTS[option.value] ?? option.value}</span></span><span class="choice-check" aria-hidden="true">{view.approvalProfile === option.value ? "✓" : ""}</span></button>{/each}
        </div>
        {#if confirmAuto}{@render autoConfirmation()}{/if}
      {/if}
    {:else}
    {#if app.caps.includes("model_select") && app.modelCatalog.length > 0}
      <div class="sec">
        <span class="lbl">Model</span>
        {#if phone}<button class="picker-value" data-agent-id="status.model.picker" aria-label={`Choose model. Current: ${view.model ?? "Not reported"}`} aria-haspopup="dialog" disabled={!canSelectModel} title={view.modelLocked ? "Fixed after this session has history. Start a new session to change it." : view.model} onclick={() => openPicker("model")}><span>{view.model ?? "Choose"}</span><span aria-hidden="true">›</span></button>
        {:else}<select
          class="ctl"
          value={modelValue}
          onchange={selectModel}
          onfocus={() => app.conn?.authStatus()}
          disabled={!canSelectModel}
          title={view.modelLocked ? "Model is fixed once this session has history. Start a new session to change it." : app.caps.includes("model_switch") ? "Model for the next turn; history is kept" : "Model for this session's first turn"}
          aria-label="Model" data-agent-id="status.model.select"
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
        </select>{/if}
        {#if view.modelLocked}
          <span class="hint model-lock-hint">Fixed after this session has history — start a new session to change it</span>
        {/if}
      </div>
    {/if}

    {#if app.caps.includes("effort_select") && app.effortOptions.length > 0}
      <div class="sec">
        <span class="lbl">Thinking</span>
        {#if phone}<button class="picker-value" data-agent-id="status.effort.picker" aria-label={`Choose thinking effort. Current: ${view.thinkingEffort ?? "medium"}`} aria-haspopup="dialog" disabled={!canSelectEffort} onclick={() => openPicker("effort")}><span class="effort-label">{view.thinkingEffort ?? "medium"}</span><span aria-hidden="true">›</span></button>
        {:else}<select
          class="ctl effort"
          value={view.thinkingEffort ?? "medium"}
          onchange={selectEffort}
          disabled={!canSelectEffort}
          title="Reasoning effort for the next turn"
          aria-label="Thinking effort" data-agent-id="status.effort.select"
          data-state={canSelectEffort ? "ready" : "disabled"}
        >
          {#each app.effortOptions as effort (effort)}
            <option value={effort}>{effort}</option>
          {/each}
        </select>{/if}
      </div>
    {/if}

    {#if view.approvalProfile}
      <div class="sec">
        <span class="lbl">Permissions</span>
        {#if phone && canSetApproval}<button class="picker-value" class:full-auto={view.approvalProfile === "always"} data-agent-id="status.approval.picker" aria-label={`Choose permissions. Current: ${APPROVAL_LABELS[view.approvalProfile] ?? view.approvalProfile}`} aria-haspopup="dialog" onclick={() => openPicker("approval")}><span>{view.approvalProfile === "always" ? "Full auto" : APPROVAL_LABELS[view.approvalProfile] ?? view.approvalProfile}</span><span aria-hidden="true">›</span></button>
        {:else if canSetApproval}
          <select
            class="ctl appr"
            class:full-auto={view.approvalProfile === "always"}
            value={view.approvalProfile}
            onchange={selectApproval}
            title="What dext may do without asking — applies from the next turn"
            aria-label="Permission policy" data-agent-id="status.approval.select"
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
      {#if confirmAuto}{@render autoConfirmation()}{/if}
    {/if}
    <div class="sec usage-section">
      <span class="lbl">Usage</span>
      <span class="usage-summary" title={context.assumed ? "Context window assumed; token counts reflect the last report" : "Context and cost reported by the runtime"}>{context.pct === undefined ? "Context not reported" : phone ? `Context ${context.pct}% · ${fmtTokens(context.used!)} / ${fmtTokens(context.window)}` : `Context ${context.pct}% · ${fmtTokens(context.used!)} / ${fmtTokens(context.window)} tokens`}<br /><span class="hint">Total {view.sessionUsage ? `$${view.sessionUsage.cost_usd.toFixed(2)}` : "not reported"} · {phone ? "turn" : "last turn"} {view.turnUsage ? `$${view.turnUsage.cost_usd.toFixed(2)}` : "not reported"}{!phone && context.assumed ? " · window assumed" : ""}</span></span>
      {#if app.caps.includes("slash.compact") && (!phone || advanced)}<button class="act ctl" data-agent-id="session.context.compact" disabled={app.phase !== "live" || view.working || view.compacting || !!view.backgroundCompaction || !!view.backgroundCompactPending} onclick={compact}>Compact context</button>{/if}
    </div>
    {#if phone}<button class="act advanced-toggle" data-agent-id="session.controls.more" aria-expanded={advanced} onclick={() => (advanced = !advanced)}>{advanced ? "Fewer controls ▴" : "Context and fork ▾"}</button>{/if}
    {#if !phone || advanced}
    {#if app.caps.includes("background_compaction_setting")}
      <div class="sec">
        <label class="lbl" for="background-compact">Context</label>
        <select id="background-compact" class="ctl" value={view.backgroundCompact === false ? "off" : "on"} onchange={selectBackground} disabled={!canSetBackground} data-agent-id="session.background.select" data-state={view.backgroundCompactPending ? "pending" : canSetBackground ? "ready" : "disabled"} title="Background summaries for this session; changes apply between turns">
          <option value="on">Background summaries on</option>
          <option value="off">Background summaries off</option>
        </select>
        <span class="hint">{view.backgroundCompactPending ? "Saving this session’s preference…" : "Saved for this session. Regular compaction stays available when off."}</span>
      </div>
    {/if}
    {#if app.caps.includes("session_fork")}
      <div class="sec">
        <span class="lbl">Branch</span>
        <input class="ctl fork-advanced" type="text" inputmode="numeric" pattern="[0-9]*" bind:value={forkSeq} placeholder="Event seq (optional)" data-agent-id="session.fork.seq" disabled={!canFork} />
        <span class="hint fork-advanced">Blank keeps the latest saved history. Event seq must identify a complete message.</span>
        <span class="hint fork-latest">Create a new session from the latest saved history. The original is kept.</span>
        <button class="act ctl" data-agent-id="session.fork" disabled={!canFork} onclick={fork}>Fork session</button>
      </div>
    {/if}
    {/if}
    {/if}
  </div>
{/if}

{#snippet autoConfirmation()}
  <div class="auto-confirm" data-agent-id="session.permission.confirm">
    <p>Full auto lets the agent run actions without asking, including commands that change or delete files. Only enable it for a trusted workspace.</p>
    <button class="act warn ctl" data-agent-id="session.permission.enable" disabled={!canSetApproval} onclick={() => applyApproval("always")}>Enable full auto</button>
    <button class="act ctl" data-agent-id="session.permission.cancel" onclick={() => phone ? returnToControls() : (confirmAuto = false)}>Keep current permissions</button>
  </div>
{/snippet}

<style>
  .fork-latest { display: none; }
  .advanced-toggle { padding: 6px 2px; min-height: 44px; border-top: 1px solid var(--line); color: var(--cyan); font-size: 12px; }
  .auto-confirm { border: 1px solid var(--yellow); padding: 10px; display: grid; gap: 8px; }
  .auto-confirm p { color: var(--yellow); }
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
    flex-shrink: 0;
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
    flex-shrink: 0;
    display: grid;
    grid-template-columns: 4.5rem minmax(0, 1fr);
    gap: 2px 8px;
    align-items: center;
    padding: 2px;
  }
  .sec .hint {
    grid-column: 2;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .sec button.ctl {
    grid-column: 2;
    white-space: normal;
    overflow-wrap: anywhere;
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
  @media (max-width: 900px) {
    /* One themed popup: each row opens its own in-popup choice list. */
    .menu { width: min(19rem, calc(100vw - 16px)); padding: 0 12px 4px; gap: 0; font: 13px/1.4 var(--sans); }
    .summary, .fork-advanced, .model-lock-hint { display: none; }
    .menu .head { align-items: center; position: sticky; top: 0; background: var(--bg3); z-index: 1; min-height: 44px; padding: 0; font-weight: 600; font-size: 14px; }
    .close { min-width: 44px; min-height: 44px; margin-right: -10px; text-align: center; color: var(--cyan); font-weight: 400; }
    .menu .sec { grid-template-columns: auto minmax(0, 1fr); gap: 2px 12px; padding: 0; min-height: 44px; min-width: 0; border-bottom: 1px solid color-mix(in srgb, var(--line) 70%, transparent); }
    .menu .sec > :not(.lbl) { min-width: 0; }
    .menu .sec .hint, .menu .sec button.ctl { grid-column: 1 / -1; }
    .lbl { font-size: 14px; letter-spacing: 0; color: var(--fg); }
    .hint { font-size: 12px; line-height: 1.4; color: var(--dim); padding-bottom: 8px; }
    .fork-latest { display: block; }
    .menu select.ctl { justify-self: end; width: auto; max-width: 100%; min-height: 44px; padding: 0 16px 0 0; appearance: none; -webkit-appearance: none; border: 0; background: linear-gradient(45deg, transparent 50%, var(--dim) 50%) no-repeat calc(100% - 4px) 52% / 5px 5px, linear-gradient(135deg, var(--dim) 50%, transparent 50%) no-repeat 100% 52% / 5px 5px; color: var(--dim); font-family: var(--sans); text-align: right; text-align-last: right; text-overflow: ellipsis; white-space: nowrap; overflow: hidden; }
    .appr-val { color: var(--yellow); justify-self: end; }
    .picker-value { display: flex; align-items: center; justify-content: flex-end; gap: 8px; width: 100%; min-width: 0; min-height: 44px; color: var(--dim); text-align: right; font: 14px/1.4 var(--sans); }
    .picker-value > span:first-child { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .picker-value > span:last-child { flex: none; color: var(--faint); }
    .picker-value.full-auto { color: var(--yellow); }
    .picker-value:disabled { opacity: 0.6; cursor: default; }
    .effort-label { text-transform: capitalize; }
    .picker-back { flex: none; min-height: 44px; color: var(--cyan); font-weight: 400; }
    .model-search { flex: none; min-width: 0; width: 100%; min-height: 44px; margin-block: 8px; padding: 6px 8px; background: var(--bg1); border: 1px solid var(--line); border-radius: 3px; }
    .choices { flex: none; min-width: 0; width: 100%; }
    .choice-group { padding: 12px 0 4px; font: 600 12px/1.4 var(--sans); color: var(--dim); overflow-wrap: anywhere; }
    .choice { width: 100%; min-width: 0; min-height: 44px; display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid color-mix(in srgb, var(--line) 70%, transparent); font: 14px/1.4 var(--sans); }
    .choice[aria-pressed="true"] { color: var(--cyan); }
    .choice:disabled { opacity: 0.6; cursor: default; }
    .choice.caution { color: var(--yellow); }
    .choice-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .choice-check { flex: none; width: 16px; color: var(--cyan); text-align: center; }
    .choice-hint { display: block; color: var(--dim); font-size: 12px; margin-top: 2px; }
    .picker-hint { flex: none; padding-block: 10px 4px; color: var(--dim); font-size: 12px; }
    .current-model { overflow-wrap: anywhere; padding-top: 4px; }
    .menu select.ctl:disabled { opacity: 0.6; cursor: default; }
    .menu button.ctl { min-height: 44px; margin-bottom: 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg1); color: var(--cyan); text-align: center; font-family: var(--sans); font-size: 14px; }
    .menu .usage-section { padding-block: 8px; }
    .usage-section .lbl { align-self: start; }
    .usage-summary { justify-self: end; text-align: right; overflow-wrap: anywhere; font-size: 13px; line-height: 1.4; color: var(--fg); }
    .usage-summary .hint { display: block; padding: 0; }
    .advanced-toggle { min-height: 44px; padding: 0; border: 0; color: var(--cyan); font: 14px var(--sans); }
    .auto-confirm { margin-block: 8px; border-radius: 8px; font-size: 13px; line-height: 1.45; }
    .auto-confirm .ctl { white-space: normal; margin: 0; }
  }
</style>
