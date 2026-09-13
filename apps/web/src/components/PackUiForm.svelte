<script lang="ts">
  import { onDestroy } from "svelte";
  import type { PendingPackUi } from "@dextui/client";
  import type { PackUiField, PackUiScalar } from "@dextui/protocol";
  import { app, connection } from "../lib/state.svelte";
  import { useDialog } from "../lib/dialog.svelte";

  let { request, sessionId, responseError, responseErrorRev }: { request: PendingPackUi; sessionId: string; responseError?: string; responseErrorRev: number } = $props();
  const dlg = useDialog(() => !!request);
  let values = $state<Record<string, unknown>>({});
  let initialized = $state("");
  let error = $state("");
  let submitting = $state(false);
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  onDestroy(() => previousFocus?.focus());

  $effect(() => {
    if (initialized === request.id) return;
    initialized = request.id;
    const next: Record<string, unknown> = {};
    for (const field of request.params.fields) {
      if (field.default !== undefined) next[field.id] = field.default;
      else if (field.type === "boolean") next[field.id] = false;
      else if (field.type === "multiselect") next[field.id] = [];
      else next[field.id] = "";
    }
    values = next;
    error = "";
    submitting = false;
  });

  $effect(() => {
    void responseErrorRev;
    if (!responseError) return;
    submitting = false;
    error = responseError;
  });

  $effect(() => {
    if (app.phase === "live" || !submitting) return;
    submitting = false;
    error = "Connection lost. Your answers are still here; retry when the host is live.";
  });

  function optionToken(field: PackUiField, value: unknown): string {
    const index = field.options?.findIndex((option) => Object.is(option.value, value)) ?? -1;
    return index < 0 ? "" : String(index);
  }

  function optionValue(field: PackUiField, token: string): PackUiScalar {
    if (token === "") return "";
    const index = Number(token);
    return Number.isInteger(index) ? (field.options?.[index]?.value ?? "") : "";
  }

  function setValue(id: string, value: unknown) {
    values = { ...values, [id]: value };
  }

  function setMulti(field: PackUiField, target: HTMLSelectElement) {
    setValue(field.id, [...target.selectedOptions].map((option) => optionValue(field, option.value)));
  }

  function selected(value: unknown, option: PackUiScalar): boolean {
    return Array.isArray(value) && value.some((item: unknown) => Object.is(item, option));
  }

  function missing(field: PackUiField): boolean {
    if (!field.required) return false;
    const value = values[field.id];
    if (field.type === "boolean") return value !== true;
    if (field.type === "multiselect") return !Array.isArray(value) || value.length === 0;
    return value === undefined || value === null || String(value).trim() === "";
  }

  function submit() {
    if (submitting) return;
    const absent = request.params.fields.find(missing);
    if (absent) {
      error = `${absent.label} is required`;
      return;
    }
    const out: Record<string, unknown> = {};
    for (const field of request.params.fields) {
      const value = values[field.id];
      if (field.type === "number" && value !== "" && !Number.isFinite(Number(value))) {
        error = `${field.label} must be a valid number`;
        return;
      }
      out[field.id] = field.type === "number" && value !== "" ? Number(value) : value;
    }
    let encoded: string;
    try {
      encoded = JSON.stringify(out);
    } catch {
      error = "This form contains a value that cannot be sent.";
      return;
    }
    if (new TextEncoder().encode(encoded).byteLength > 64 * 1024) {
      error = "This form is too large to send. Shorten one or more answers.";
      return;
    }
    submitting = true;
    error = "";
    if (!connection()?.uiRespond(sessionId, request.id, { status: "ok", value: out })) {
      submitting = false;
      error = "Not connected. Your answers are still here; retry when the host is live.";
    }
  }

  function cancel() {
    if (submitting) return;
    submitting = true;
    error = "";
    if (!connection()?.uiRespond(sessionId, request.id, { status: "cancelled" })) {
      submitting = false;
      error = "Not connected. Reconnect before cancelling this form.";
    }
  }

  function keydown(e: KeyboardEvent) {
    dlg.onKey(e);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  }
</script>

<div class="insp-scrim pack-ui-scrim" data-agent-id="pack-ui.scrim" onclick={cancel} onkeydown={() => {}} role="presentation"></div>
<div class="insp gallery-overlay pack-ui" role="dialog" aria-modal="true" aria-labelledby="pack-ui-title" tabindex="-1" use:dlg.ref data-agent-id="pack-ui.form" data-state="awaiting_answer" onkeydown={keydown}>
  <div class="insp-head">
    <span class="st-magenta">{request.pack}</span>
    <span class="dim">Needs input</span>
    <span class="insp-acts"><button class="act" type="button" disabled={submitting} data-agent-id="pack-ui.cancel.top" onclick={cancel}>esc</button></span>
  </div>
  <form class="pack-ui-body" onsubmit={(e) => { e.preventDefault(); submit(); }}>
    <header>
      <h2 id="pack-ui-title">{request.params.title}</h2>
      {#if request.params.description}<p class="dim">{request.params.description}</p>{/if}
      <p class="privacy">Your answers go directly to <span class="st-magenta">{request.pack}</span>. DextUI does not add them to chat or save them in the session journal.</p>
    </header>
    <div class="fields">
      {#each request.params.fields as field, i (field.id)}
        <label class:check={field.type === "boolean"}>
          {#if field.type === "boolean"}
            <input data-dialog-initial={i === 0 ? true : undefined} data-agent-id={`pack-ui.field.${field.id}`} type="checkbox" checked={values[field.id] === true} onchange={(e) => setValue(field.id, e.currentTarget.checked)} />
            <span>{field.label}{#if field.required} <span class="st-yellow">*</span>{/if}</span>
          {:else}
            <span>{field.label}{#if field.required} <span class="st-yellow">*</span>{/if}</span>
            {#if field.type === "textarea"}
              <textarea data-dialog-initial={i === 0 ? true : undefined} data-agent-id={`pack-ui.field.${field.id}`} placeholder={field.placeholder} value={String(values[field.id] ?? "")} oninput={(e) => setValue(field.id, e.currentTarget.value)}></textarea>
            {:else if field.type === "select"}
              <select data-dialog-initial={i === 0 ? true : undefined} data-agent-id={`pack-ui.field.${field.id}`} value={optionToken(field, values[field.id])} onchange={(e) => setValue(field.id, optionValue(field, e.currentTarget.value))}>
                <option value="" disabled={field.required}>Choose…</option>
                {#each field.options ?? [] as option, optionIndex}<option value={String(optionIndex)}>{option.label}</option>{/each}
              </select>
            {:else if field.type === "multiselect"}
              <select data-dialog-initial={i === 0 ? true : undefined} data-agent-id={`pack-ui.field.${field.id}`} multiple onchange={(e) => setMulti(field, e.currentTarget)}>
                {#each field.options ?? [] as option, optionIndex}<option value={String(optionIndex)} selected={selected(values[field.id], option.value)}>{option.label}</option>{/each}
              </select>
            {:else}
              <input data-dialog-initial={i === 0 ? true : undefined} data-agent-id={`pack-ui.field.${field.id}`} type={field.type === "number" ? "number" : "text"} placeholder={field.placeholder} value={String(values[field.id] ?? "")} oninput={(e) => setValue(field.id, e.currentTarget.value)} />
            {/if}
          {/if}
          {#if field.description}<small class="dim">{field.description}</small>{/if}
        </label>
      {/each}
    </div>
    {#if error}<p class="st-red" role="alert" data-agent-id="pack-ui.error">{error}</p>{/if}
    <footer>
      <button class="act accent" type="submit" data-agent-id="pack-ui.submit" disabled={submitting}>{submitting ? "Sending…" : request.params.submit_label}</button>
      <button class="act" type="button" data-agent-id="pack-ui.cancel" disabled={submitting} onclick={cancel}>Cancel</button>
    </footer>
  </form>
</div>

<style>
  .pack-ui { z-index: 46; }
  .pack-ui-scrim { z-index: 45; }
  .pack-ui-body { padding: 18px 20px; overflow: auto; display: grid; gap: 18px; }
  h2 { margin: 0 0 6px; font-size: 18px; font-weight: 600; color: var(--fg); }
  header p { margin: 5px 0; }
  .privacy { border-left: 2px solid var(--cyan); background: color-mix(in srgb, var(--cyan) 5%, transparent); padding: 7px 10px; color: var(--dim); }
  .fields { display: grid; gap: 14px; }
  label { display: grid; gap: 5px; color: var(--fg); }
  label.check { grid-template-columns: auto 1fr; align-items: center; }
  label.check small { grid-column: 2; }
  input:not([type="checkbox"]), textarea, select { width: 100%; border: 1px solid var(--line); background: var(--bg); color: var(--fg); padding: 7px 9px; border-radius: 2px; }
  textarea { min-height: 7rem; resize: vertical; }
  select[multiple] { min-height: 7rem; }
  small { line-height: 1.4; }
  footer { display: flex; gap: 12px; }
</style>
