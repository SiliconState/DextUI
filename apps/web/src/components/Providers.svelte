<script lang="ts">
  // Providers dialog: sign in to / out of model vendors. One row per provider
  // dext knows; "Sign in" opens an inline paste field for the API key or
  // token. The value goes to the host once (x-agentlinkd.auth.login) and is
  // cleared here immediately — never stored client-side. Browser OAuth flows
  // are not offered: the host may be headless or paired over LAN/hosted.
  import { providers, closeProviders, loginProvider, logoutProvider } from "../lib/connectors.svelte";
  import { useDialog } from "../lib/dialog.svelte";

  const dlg = useDialog(() => providers.open);
  let editing = $state<string | null>(null);
  let credential = $state("");
  let fieldEl = $state<HTMLInputElement | null>(null);

  function begin(id: string) {
    editing = id;
    credential = "";
    requestAnimationFrame(() => fieldEl?.focus());
  }
  function cancel() {
    editing = null;
    credential = "";
  }
  function submit(e: Event) {
    e.preventDefault();
    const id = editing;
    const value = credential.trim();
    if (!id || !value) return;
    loginProvider(id, value);
    credential = "";
    editing = null;
  }
  function onKey(e: KeyboardEvent) {
    dlg.onKey(e);
    if (e.key === "Escape") {
      if (editing) cancel();
      else closeProviders();
      e.preventDefault();
      e.stopPropagation();
    }
  }
  function authWord(auth: string): string {
    if (auth === "key") return "API key";
    if (auth === "auth") return "Signed in";
    if (auth === "none") return "Not signed in";
    return auth;
  }
  function signedIn(auth: string): boolean {
    return auth !== "none" && auth !== "";
  }
</script>

{#if providers.open}
  <div class="insp-scrim" data-agent-id="providers.scrim" onclick={closeProviders} onkeydown={() => {}} role="presentation"></div>
  <div class="insp gallery-overlay providers" role="dialog" aria-modal="true" aria-label="Providers" tabindex="-1" use:dlg.ref data-agent-id="providers.overlay" data-state={providers.pending ? "pending" : "ready"} onkeydown={onKey}>
    <div class="insp-head">
      <span class="st-magenta">Providers</span>
      <span class="dim">Who runs your models</span>
      <span class="insp-acts">
        <button class="act" data-agent-id="providers.close" onclick={closeProviders}>esc</button>
      </span>
    </div>
    <div class="insp-body">
      {#if !providers.loaded}
        <p class="dim">Loading…</p>
      {:else}
        <ul class="list" data-agent-id="providers.list">
          {#each providers.items as p (p.id)}
            <li class="row" class:active={p.active} data-agent-id={`providers.row.${p.id}`} data-state={signedIn(p.auth) ? "in" : "out"}>
              <div class="who">
                <span class="name">{p.label}</span>
                {#if p.active}<span class="pill">active</span>{/if}
                <span class="faint sub">{p.id} · {p.model}</span>
              </div>
              {#if editing === p.id}
                <form class="paste" onsubmit={submit}>
                  <input bind:this={fieldEl} bind:value={credential} type="password" autocomplete="off" spellcheck="false" placeholder="Paste API key or token" aria-label={`Credential for ${p.label}`} data-agent-id="providers.credential" />
                  <button type="submit" class="act accent" disabled={!credential.trim() || providers.pending} data-agent-id="providers.submit">Sign in</button>
                  <button type="button" class="act" onclick={cancel}>Cancel</button>
                </form>
              {:else}
                <span class="state" class:st-green={signedIn(p.auth)} class:faint={!signedIn(p.auth)}>{authWord(p.auth)}</span>
                {#if signedIn(p.auth)}
                  <button class="act" disabled={providers.pending} data-agent-id={`providers.logout.${p.id}`} onclick={() => logoutProvider(p.id)}>Sign out</button>
                  <button class="act" disabled={providers.pending} data-agent-id={`providers.relogin.${p.id}`} onclick={() => begin(p.id)} title="Replace the stored credential">Replace</button>
                {:else}
                  <button class="act accent" disabled={providers.pending} data-agent-id={`providers.login.${p.id}`} onclick={() => begin(p.id)}>Sign in</button>
                {/if}
              {/if}
            </li>
          {/each}
        </ul>
        <p class="faint note">Keys are stored by dext on the host, never in this browser. Providers that only offer a browser login are signed in from the host's terminal with <code>dext auth login &lt;provider&gt; web</code>.</p>
      {/if}
    </div>
  </div>
{/if}

<style>
  .providers {
    width: min(640px, calc(100vw - 32px));
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 4px;
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
  }
  .row:last-child {
    border-bottom: 0;
  }
  .who {
    flex: 1 1 200px;
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  .name {
    font-weight: 600;
  }
  .sub {
    font-size: 0.85em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pill {
    font-size: 0.75em;
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0 7px;
    color: var(--dim);
  }
  .state {
    font-size: 0.9em;
    min-width: 7ch;
  }
  .paste {
    display: flex;
    gap: 6px;
    flex: 1 1 100%;
    align-items: stretch;
  }
  .paste input {
    flex: 1;
    min-width: 0;
  }
  .note {
    margin: 12px 0 0;
    line-height: 1.45;
  }
</style>
