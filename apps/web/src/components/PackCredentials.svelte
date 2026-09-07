<script lang="ts">
  // Pack credentials dialog: the values behind a pack's `credential-env`
  // names. Each value goes to the host exactly once and is cleared here on
  // submit; the host stores it under DEXT_HOME (0600) and puts it in dext's
  // env — the same place `export NAME=…; dext` would. Only names come back.
  import { packCreds, closePackCredentials, submitPackCredentials, packWithCredentials } from "../lib/packcreds.svelte";
  import { useDialog } from "../lib/dialog.svelte";

  const dlg = useDialog(() => packCreds.open);
  const pack = $derived(packCreds.open ? packWithCredentials(packCreds.pack) : null);
  const names = $derived(pack?.credential_env ?? []);
  const isSet = (n: string) => !!pack?.credentials.set.includes(n);

  let values = $state<Record<string, string>>({});
  let clear = $state<Record<string, boolean>>({});
  let reveal = $state(false);
  let firstEl = $state<HTMLInputElement | null>(null);

  // Fresh fields every time the dialog opens; nothing lingers after submit.
  // The rAF focus runs after useDialog's own rAF (its effect registers
  // first), so the first input — not the esc button — ends up focused.
  $effect(() => {
    if (packCreds.open) {
      values = {};
      clear = {};
      reveal = false;
      requestAnimationFrame(() => firstEl?.focus());
    }
  });
  const filledCount = $derived(Object.values(values).filter((v) => v.trim()).length);
  const clearCount = $derived(Object.values(clear).filter(Boolean).length);

  function submit(e: Event) {
    e.preventDefault();
    if (packCreds.pending) return;
    submitPackCredentials(values, Object.keys(clear).filter((k) => clear[k]));
    values = {};
  }
  /** Remember the first field for the open-focus rAF (see $effect). */
  function firstField(el: HTMLInputElement, first: boolean) {
    if (first) firstEl = el;
  }
  function onKey(e: KeyboardEvent) {
    dlg.onKey(e);
    if (e.key === "Escape") { closePackCredentials(); e.preventDefault(); e.stopPropagation(); }
  }
</script>

{#if packCreds.open && pack}
  <div class="insp-scrim" data-agent-id="packcreds.scrim" onclick={closePackCredentials} onkeydown={() => {}} role="presentation"></div>
  <div class="insp gallery-overlay creds" role="dialog" aria-modal="true" aria-label="Pack credentials" tabindex="-1" use:dlg.ref data-agent-id="packcreds.overlay" data-state={packCreds.pending ? "pending" : "ready"} onkeydown={onKey}>
    <div class="insp-head">
      <span class="st-magenta">Credentials</span>
      <span class="dim"><span class="st-cyan">{pack.name}</span> · {pack.credentials.set.length} of {names.length} set</span>
      <span class="insp-acts">
        <button class="act" data-agent-id="packcreds.close" onclick={closePackCredentials}>esc</button>
      </span>
    </div>
    <form class="body" onsubmit={submit} data-agent-id="packcreds.form">
      <p class="dim intro">
        Stored on the host at <code>~/.dext/packs/credentials/{pack.name}.env</code> (owner-only) and handed to dext as environment — never to the chat, never to the model.
        Set the group your account uses; leave the rest blank.
      </p>
      <ul class="fields">
        {#each names as n, i (n)}
          <li class="field" data-agent-id={`packcreds.field.${n}`} data-state={clear[n] ? "clearing" : isSet(n) ? "set" : "unset"}>
            <label for={`cred-${n}`}>
              <code>{n}</code>
              {#if isSet(n)}<span class="st-green tiny">set</span>{:else}<span class="faint tiny">not set</span>{/if}
            </label>
            <input
              id={`cred-${n}`}
              use:firstField={i === 0}
              bind:value={values[n]}
              type={reveal ? "text" : "password"}
              autocomplete="off"
              spellcheck="false"
              disabled={!!clear[n] || packCreds.pending}
              placeholder={isSet(n) ? "•••••• (leave blank to keep)" : "paste value"}
              aria-label={n}
            />
            {#if isSet(n)}
              <label class="tiny faint clr" title="Remove the stored value">
                <input type="checkbox" bind:checked={clear[n]} disabled={packCreds.pending} /> clear
              </label>
            {/if}
          </li>
        {/each}
      </ul>
      {#if packCreds.error}<p class="st-red" data-agent-id="packcreds.error">✗ {packCreds.error}</p>{/if}
      <div class="acts">
        <button type="submit" class="act accent" data-agent-id="packcreds.submit" disabled={packCreds.pending || (filledCount === 0 && clearCount === 0)}>
          {packCreds.pending ? "Saving…" : filledCount > 0 ? `Save ${filledCount} value${filledCount === 1 ? "" : "s"}` : clearCount > 0 ? `Clear ${clearCount}` : "Save"}
        </button>
        <button type="button" class="act" onclick={() => (reveal = !reveal)} data-agent-id="packcreds.reveal">{reveal ? "Hide" : "Show"}</button>
        <button type="button" class="act" onclick={closePackCredentials}>Cancel</button>
        <span class="faint tiny">Applies from the next turn. Same file works for the CLI.</span>
      </div>
    </form>
  </div>
{/if}

<style>
  .creds {
    left: 0;
    width: min(36rem, 94vw);
    height: auto;
    max-height: 88dvh;
    margin: auto;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px 12px 12px;
    overflow: auto;
  }
  .intro { margin: 0; line-height: 1.4; }
  .intro code { color: var(--cyan); }
  .fields { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .field { display: grid; grid-template-columns: minmax(12rem, 1fr) 2fr auto; gap: 8px; align-items: center; }
  .field label { display: flex; gap: 6px; align-items: baseline; }
  .field input[type="password"], .field input[type="text"] { width: 100%; }
  .clr { display: flex; gap: 4px; align-items: center; white-space: nowrap; }
  .acts { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .tiny { font-size: 0.8em; }
  @media (max-width: 40rem) {
    .field { grid-template-columns: 1fr; gap: 2px; }
  }
</style>
