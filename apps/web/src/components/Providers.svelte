<script lang="ts">
  // Providers dialog: sign in to / out of model vendors — a different thing
  // from the /login device pairing (that one signs this browser into the
  // host). Here each provider row invokes dext's own auth store: "Sign in"
  // opens an inline paste field whose value goes to the host once
  // (x-agentlinkd.auth.login → `dext auth login <provider> <credential>`)
  // and is cleared here immediately — never stored client-side. Browser
  // OAuth flows are not offered in-app: the host may be headless or paired
  // over LAN, so browser-only providers sign in from the host's terminal.
  import type { ProviderAuth } from "@dextui/protocol";
  import { providers, closeProviders, loginProvider, logoutProvider } from "../lib/connectors.svelte";
  import { useDialog } from "../lib/dialog.svelte";

  const dlg = useDialog(() => providers.open);
  let editing = $state<string | null>(null);
  let credential = $state("");
  let reveal = $state(false);
  let fieldEl = $state<HTMLInputElement | null>(null);

  // Markers that mean no usable credential: dext can say failed/expired when
  // a stored login stopped working — those rows get "Sign in" back.
  const NOT_SIGNED = new Set(["", "none", "failed", "expired", "missing", "absent", "disabled"]);
  function signedIn(auth: string): boolean {
    return !NOT_SIGNED.has(auth);
  }
  // How dext holds the credential, for the quiet sub-line. Unknown markers
  // render as nothing — never echo raw marker text into the page.
  function method(auth: string): string {
    if (auth === "key" || auth === "token") return "API key";
    if (auth === "auth" || auth === "web" || auth === "oauth" || auth === "session") return "session";
    return "";
  }
  function subline(p: ProviderAuth): string {
    const m = signedIn(p.auth) ? method(p.auth) : "";
    return m ? `${p.model} · ${m}` : p.model;
  }
  const connected = $derived(
    providers.items.filter((p) => signedIn(p.auth)).sort((a, b) => Number(b.active) - Number(a.active) || a.label.localeCompare(b.label)),
  );
  const available = $derived(providers.items.filter((p) => !signedIn(p.auth)).sort((a, b) => a.label.localeCompare(b.label)));
  const ordered = $derived([...connected, ...available]);

  function begin(id: string) {
    editing = id;
    credential = "";
    reveal = false;
    requestAnimationFrame(() => fieldEl?.focus());
  }
  function cancel() {
    editing = null;
    credential = "";
    reveal = false;
  }
  function submit(e: Event) {
    e.preventDefault();
    const id = editing;
    const value = credential.trim();
    if (!id || !value) return;
    loginProvider(id, value);
    credential = "";
    reveal = false;
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
</script>

{#if providers.open}
  <div class="insp-scrim" data-agent-id="providers.scrim" onclick={closeProviders} onkeydown={() => {}} role="presentation"></div>
  <div class="insp gallery-overlay providers" role="dialog" aria-modal="true" aria-label="Providers" tabindex="-1" use:dlg.ref data-agent-id="providers.overlay" data-state={providers.pending ? "pending" : "ready"} onkeydown={onKey}>
    <div class="insp-head">
      <span class="st-magenta">Providers</span>
      <span class="dim">Who runs your models</span>
      {#if providers.pending}<span class="faint pulse saving" data-agent-id="providers.saving">saving…</span>{/if}
      <span class="insp-acts">
        <button class="act" data-agent-id="providers.close" onclick={closeProviders}>esc</button>
      </span>
    </div>
    <div class="insp-body">
      {#if !providers.loaded}
        <p class="dim">Loading…</p>
      {:else if ordered.length === 0}
        <p class="dim empty">No model providers found on this host yet.</p>
      {:else}
        <ul class="list" data-agent-id="providers.list">
          {#each ordered as p, i (p.id)}
            {#if (i === 0 && connected.length > 0) || (i === connected.length && available.length > 0)}
              <li class="sec" aria-hidden="true">{i < connected.length ? `Connected · ${connected.length}` : `Available · ${available.length}`}</li>
            {/if}
            {@render row(p)}
          {/each}
        </ul>
        <p class="faint note">Credentials are held by dext on your host, never in this browser. Browser-only providers sign in from the host's terminal with <code>dext auth login &lt;provider&gt; web</code>.</p>
      {/if}
    </div>
  </div>
{/if}

{#snippet row(p: ProviderAuth)}
  <li class="row" class:active={p.active} data-agent-id={`providers.row.${p.id}`} data-state={signedIn(p.auth) ? "in" : "out"}>
    <div class="main">
      <div class="who" title={`${p.label} (${p.id})`}>
        <span class="dot" class:on={signedIn(p.auth)} class:live={p.active}></span>
        <span class="col">
          <span class="top">
            <span class="name">{p.label}</span>
            {#if p.active}<span class="pill">Active</span>{/if}
          </span>
          <span class="sub">{subline(p)}</span>
        </span>
      </div>
      {#if editing !== p.id}
        <div class="acts">
          {#if signedIn(p.auth)}
            <button class="act" disabled={providers.pending} data-agent-id={`providers.relogin.${p.id}`} onclick={() => begin(p.id)} title="Paste a new credential — replaces the stored one">Replace key</button>
            <button class="act" disabled={providers.pending} data-agent-id={`providers.logout.${p.id}`} onclick={() => logoutProvider(p.id)}>Sign out</button>
          {:else}
            <button class="act accent" disabled={providers.pending} data-agent-id={`providers.login.${p.id}`} onclick={() => begin(p.id)}>Sign in</button>
          {/if}
        </div>
      {/if}
    </div>
    {#if editing === p.id}
      <form class="paste" onsubmit={submit}>
        <input bind:this={fieldEl} bind:value={credential} type={reveal ? "text" : "password"} autocomplete="off" spellcheck="false" placeholder={signedIn(p.auth) ? "Paste the new API key or token" : "Paste API key or token"} aria-label={`Credential for ${p.label}`} data-agent-id="providers.credential" />
        <button type="button" class="act reveal" onclick={() => (reveal = !reveal)} tabindex={-1} title={reveal ? "Hide the pasted value" : "Show the pasted value"}>{reveal ? "hide" : "show"}</button>
        <button type="submit" class="act accent" disabled={!credential.trim() || providers.pending} data-agent-id="providers.submit">{signedIn(p.auth) ? "Replace" : "Sign in"}</button>
        <button type="button" class="act" onclick={cancel}>Cancel</button>
      </form>
    {/if}
  </li>
{/snippet}

<style>
  .providers {
    width: min(34rem, calc(100vw - 32px));
  }
  .saving {
    font-size: 0.85em;
  }
  .empty {
    text-align: center;
    padding: 24px 0;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .sec {
    padding: 12px 8px 4px;
    font-size: 0.78em;
    letter-spacing: 0.06em;
    color: var(--faint);
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 8px;
    border-bottom: 1px solid var(--line);
    border-left: 2px solid transparent;
  }
  .row:last-child {
    border-bottom: 0;
  }
  .row:hover {
    background: color-mix(in srgb, var(--bg2) 55%, transparent);
  }
  .row.active {
    border-left-color: var(--green);
  }
  .main {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .who {
    flex: 1 1 12rem;
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .dot {
    width: 6px;
    height: 6px;
    flex: none;
    background: var(--faint);
  }
  .dot.on {
    background: var(--green);
  }
  .dot.live {
    animation: dot-pulse 1.6s ease-in-out infinite;
  }
  @keyframes dot-pulse {
    50% {
      opacity: 0.3;
    }
  }
  .col {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .top {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .name {
    font-weight: 600;
    color: var(--fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pill {
    font-size: 0.75em;
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0 7px;
    color: var(--dim);
    white-space: nowrap;
  }
  .sub {
    font-size: 0.85em;
    color: var(--faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .acts {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .paste {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
    padding-left: 16px;
  }
  .paste input {
    flex: 1 1 10rem;
    min-width: 0;
  }
  .reveal {
    font-size: 0.85em;
  }
  .note {
    margin: 12px 0 0;
    line-height: 1.45;
  }
</style>
