<script lang="ts">
  // Pack gallery: the empty state and the `g` overlay. First visit asks who
  // you are (persona) and folds the catalog accordingly — nothing is hidden,
  // only grouped. Every card is one click to a prefilled prompt; with no
  // session active the folder picker comes first, because for a bookkeeper
  // or a shop owner the unit of work is "a folder", not "a repo".
  import type { PackInfo } from "@dextui/protocol";
  import { app, packStarter, packUnmet, prefillComposer } from "../lib/state.svelte";
  import { openPackSheet, openPackPanel, packEditEnabled } from "../lib/packsheet.svelte";
  import { openPackCredentials, packCredsEnabled } from "../lib/packcreds.svelte";
  /** "Credentials 2/7" chip data for packs that declare credential-env. */
  function credChip(p: { credential_env?: string[]; credentials?: { set: string[] } }): { set: number; total: number } | null {
    if (!packCredsEnabled() || !p.credential_env?.length) return null;
    return { set: p.credentials?.set.length ?? 0, total: p.credential_env.length };
  }
  import { PERSONAS, persona, setPersona, personaTitle, packTitle, humanRequirement, galleryGroups } from "../lib/persona.svelte";
  import { foldersEnabled, openFolderPicker } from "../lib/folders.svelte";

  let { compact = false, onPick }: { compact?: boolean; onPick?: () => void } = $props();

  let showAll = $state(false);
  let showFolded = $state(false);
  let hero = $state(false);
  let service = $state("");
  let purpose = $state("");

  const groups = $derived(galleryGroups(persona.id));
  const consumer = $derived(persona.id === "accountant" || persona.id === "business");
  const glyph: Record<string, string> = { chart: "▮", html: "▤", table: "☰", markdown: "¶", file: "▫", none: "·" };
  const icons: Record<string, string> = { receipt: "▤", invoice: "▥", reconcile: "⇄", cashflow: "↗", tax: "§", followup: "✉", crew: "⚑", inbox: "✉", report: "▤", loop: "↻", tune: "⚙", browser: "◫", chart: "▮" };

  function cardGlyph(p: PackInfo): string {
    return (p.ui.icon && icons[p.ui.icon]) || glyph[p.ui.artifact] || "·";
  }

  /** Time-to-first-artifact in words for consumers, seconds for developers. */
  function eta(p: PackInfo): string {
    const s = p.ui.time_to_first_artifact;
    if (!s) return "";
    if (!consumer) return `~${s}s`;
    return s <= 15 ? "seconds" : s <= 60 ? "about a minute" : `~${Math.round(s / 60)} min`;
  }

  function pick(p: PackInfo) {
    const text = packStarter(p);
    if (!app.activeId && foldersEnabled()) {
      openFolderPicker({ seed: text });
      onPick?.();
      return;
    }
    prefillComposer(text);
    onPick?.();
  }

  function slug(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "connector";
  }

  function buildConnector() {
    const name = slug(service);
    const text = consumer
      ? [
          `Build me a new tool called "${service.trim() || "my tool"}" that ${purpose.trim() || "does what I describe next"}.`,
          `Create it as a dext pack (run \`dext pack create mine/${name}\`), describe the steps in its PACK.md in plain language, and add ui-title, ui-starter-prompt, ui-artifact and ui-gallery: true so it shows up in my gallery.`,
          "If it needs a login or token, ask me for it when it runs; never write secrets into files.",
        ].join("\n")
      : [
          `Create a new dext pack at connectors/${name} for ${service.trim() || "the service"}.`,
          `Run \`dext pack create connectors/${name}\`, then edit its PACK.md so the pack: ${purpose.trim() || "does what I describe next"}.`,
          "Auth: ask me for a token via local_auth_prompt at run time; never write it to files.",
          "Expose actions as slash-style entry points and emit results as runtime_view cards.",
          "Add front-matter keys ui-starter-prompt, ui-artifact and ui-gallery: true so it shows in the DextUI gallery.",
        ].join("\n");
    prefillComposer(text);
    hero = false;
    onPick?.();
  }
</script>

<section class="gal" class:compact data-agent-id="packs.gallery" data-state={app.packs.length ? (persona.id && !persona.picking ? "ready" : "persona") : "empty"}>
  {#if app.packs.length === 0}
    <p class="dim">No packs on this host. <span class="faint">Packs are workflows you can run, edit and share — just files in your workspace.</span></p>
  {:else if !persona.id || persona.picking}
    <!-- onboarding: who is this for? one click, remembered per browser, changeable any time -->
    <header class="gal-head">
      <span><span class="st-magenta">Welcome</span> <span class="faint">· what do you do? This only chooses which tools you see first.</span></span>
    </header>
    <div class="cards personas">
      {#each PERSONAS as p (p.id)}
        <button class="card persona" data-agent-id={`persona.${p.id}`} onclick={() => setPersona(p.id)}>
          <span class="card-title"><span class="st-cyan">{p.glyph}</span> {p.title}</span>
          <span class="card-desc">{p.blurb}</span>
        </button>
      {/each}
    </div>
    <p class="faint">
      {#if persona.id}<button class="act" data-agent-id="persona.keep" onclick={() => (persona.picking = false)}>Keep "{personaTitle(persona.id)}"</button> · {/if}
      <button class="act" data-agent-id="persona.skip" onclick={() => setPersona("business")}>Skip — show me everything</button>
    </p>
  {:else}
    <header class="gal-head">
      <span>
        <span class="st-magenta">{consumer ? "Tools" : "Packs"}</span>
        <span class="faint"> · for <button class="act inline" data-agent-id="persona.change" title="Change who this is for" onclick={() => (persona.picking = true)}>{personaTitle(persona.id)} ▾</button></span>
        {#if !consumer}<span class="faint"> · workflows you can run, edit and share. They are just files in your workspace.</span>{/if}
      </span>
      <span class="head-acts">
        {#if foldersEnabled()}
          <button class="act" data-agent-id="packs.folder" title="Choose the folder the work happens in" onclick={() => { openFolderPicker(); onPick?.(); }}>▸ Work in a folder…</button>
        {/if}
        <span class="faint">{app.packs.length}</span>
      </span>
    </header>

    <div class="cards">
      <button class="card hero" data-agent-id="packs.hero" onclick={() => (hero = !hero)} aria-expanded={hero}>
        <span class="card-title"><span class="st-green">+</span> {consumer ? "Build something new" : "Build a connector"}</span>
        <span class="card-desc">{consumer ? "Name it, say what it should do. You end up with a tool you own and can change." : "For your workflow: name a service, say what it should do. Ends with a pack you own."}</span>
        <span class="card-meta faint">{consumer ? "Yours to keep" : "/pack create · owns a pack"}</span>
      </button>

      {#each groups.forYou as p (p.name)}
        {@const missing = packUnmet(p)}
        <div class="card" class:greyed={missing.length > 0} data-agent-id={`packs.card.${p.name}`} data-state={missing.length ? "unmet" : "ready"}>
          <button class="card-main" title={missing.length ? missing.map((m) => humanRequirement(m)).join(", ") : packStarter(p)} onclick={() => pick(p)}>
            <span class="card-title"><span class="st-cyan">{cardGlyph(p)}</span> {packTitle(p)}</span>
            <span class="card-desc">{p.description}</span>
            <span class="card-meta faint">
              {#if consumer}
                {#if eta(p)}{eta(p)}{/if}
                {#if missing.length}<span class="st-yellow"> · {missing.map((m) => humanRequirement(m)).join(", ")}</span>{:else if p.ui.requires.length === 0}<span class="st-green"> · ready</span>{/if}
              {:else}
                {p.ui.artifact}{#if eta(p)} · {eta(p)}{/if}{#if p.shelf} · {p.shelf}{/if}
                {#if missing.length}<span class="st-yellow"> · needs {missing.join(", ")}</span>{:else if p.ui.requires.length === 0}<span class="st-green"> · no setup</span>{/if}
              {/if}
            </span>
          </button>
          {#if p.ui.panel || p.ui.actions?.length || credChip(p)}
            <div class="chips">
              {#if credChip(p)}
                {@const cc = credChip(p)!}
                <button class="chip" class:st-yellow={cc.set === 0} data-agent-id={`packs.creds.${p.name}`} data-state={cc.set === 0 ? "unset" : "set"} title="Provide the credentials this pack declares — stored on the host, never in the chat" onclick={() => openPackCredentials(p.name)}>Credentials {cc.set}/{cc.total}</button>
              {/if}
              {#if p.ui.panel}
                <button class="chip" data-agent-id={`packs.panelbtn.${p.name}`} onclick={() => openPackPanel(p.name)}>Panel</button>
              {/if}
              {#each p.ui.actions ?? [] as a, i}
                <button class="chip" data-agent-id={`packs.action.${p.name}.${i}`} title={a.prompt}
                  onclick={() => { prefillComposer(a.prompt); onPick?.(); }}>{a.label}</button>
              {/each}
            </div>
          {/if}
          {#if packEditEnabled() && !consumer}
            <button class="card-edit" data-agent-id={`packs.edit.${p.name}`} title="Edit pack files" onclick={() => openPackSheet(p.name)}>Edit</button>
          {/if}
        </div>
      {/each}
    </div>

    {#if hero}
      <form class="hero-form" data-agent-id="packs.hero.form" onsubmit={(e) => { e.preventDefault(); buildConnector(); }}>
        <label>{consumer ? "Call it" : "Service"} <input bind:value={service} placeholder={consumer ? "e.g. Mileage log, Client birthdays" : "e.g. Linear, Stripe, my Postgres"} maxlength="60" required data-agent-id="packs.hero.service" /></label>
        <label>It should <input bind:value={purpose} placeholder={consumer ? "e.g. turn my trip notes into a monthly mileage table" : "e.g. list open issues assigned to me as a table"} maxlength="200" required data-agent-id="packs.hero.purpose" /></label>
        <div class="row">
          <button type="submit" class="act accent" data-agent-id="packs.hero.submit">[⏎] Draft the request</button>
          <button type="button" class="act" onclick={() => (hero = false)}>Cancel</button>
          <span class="faint">You review it before it runs.</span>
        </div>
      </form>
    {/if}

    {#if groups.folded.packs.length}
      <button class="act all" data-agent-id="packs.folded" aria-expanded={showFolded} onclick={() => (showFolded = !showFolded)}>
        {showFolded ? "▾" : "▸"} {groups.folded.title} ({groups.folded.packs.length})
      </button>
      {#if showFolded}
        <div class="cards">
          {#each groups.folded.packs as p (p.name)}
            {@const missing = packUnmet(p)}
            <div class="card" class:greyed={missing.length > 0} data-agent-id={`packs.card.${p.name}`} data-state={missing.length ? "unmet" : "ready"}>
              <button class="card-main" title={missing.length ? missing.map((m) => humanRequirement(m)).join(", ") : packStarter(p)} onclick={() => pick(p)}>
                <span class="card-title"><span class="st-cyan">{cardGlyph(p)}</span> {packTitle(p)}</span>
                <span class="card-desc">{p.description}</span>
                <span class="card-meta faint">{p.ui.artifact}{#if eta(p)} · {eta(p)}{/if}{#if missing.length}<span class="st-yellow"> · {missing.map((m) => humanRequirement(m)).join(", ")}</span>{/if}</span>
              </button>
              {#if packEditEnabled()}
                <button class="card-edit" data-agent-id={`packs.edit.${p.name}`} title="Edit pack files" onclick={() => openPackSheet(p.name)}>Edit</button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    {/if}

    {#if groups.others.length}
      <button class="act all" data-agent-id="packs.all" aria-expanded={showAll} onclick={() => (showAll = !showAll)}>
        {showAll ? "▾" : "▸"} All packs ({groups.others.length} more)
      </button>
      {#if showAll}
        <ul class="all-list">
          {#each groups.others as p (p.name)}
            <li>
              <div class="row-wrap">
                <button class="row-btn" data-agent-id={`packs.row.${p.name}`} onclick={() => pick(p)}>
                  <span class="st-cyan">{packTitle(p)}</span>
                  <span class="faint">{p.shelf ?? "-"}</span>
                  <span class="dim truncate">{p.description}</span>
                </button>
                {#if packEditEnabled()}
                  <button class="row-edit" data-agent-id={`packs.edit.${p.name}`} onclick={() => openPackSheet(p.name)}>Edit</button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  {/if}
</section>

<style>
  .gal { display: flex; flex-direction: column; gap: 10px; width: 100%; }
  .gal-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; flex-wrap: wrap; }
  .head-acts { display: flex; gap: 10px; align-items: baseline; }
  .act.inline { padding: 0 2px; color: var(--cyan); }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
  .compact .cards { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); }
  .personas { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
  .card { position: relative; display: flex; flex-direction: column; border: 1px solid var(--line); background: var(--bg1); text-align: left; min-width: 0; }
  .card.persona { gap: 4px; padding: 12px 12px; border-color: var(--cyan); }
  .card.persona:hover, .card.persona:focus-visible { background: var(--bg2); }
  .card-main { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; min-width: 0; background: none; border: 0; color: inherit; font: inherit; text-align: left; }
  .card-main:hover, .card-main:focus-visible { color: var(--cyan); }
  .card:hover, .card:focus-within { border-color: var(--cyan); background: var(--bg2); }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 10px 8px; }
  .chip { font-size: 10px; padding: 1px 6px; color: var(--cyan); background: none; border: 1px solid var(--line); }
  .chip:hover { border-color: var(--cyan); background: var(--bg2); }
  .card-edit { position: absolute; right: 6px; top: 6px; padding: 1px 6px; font-size: 10px; color: var(--dim); background: var(--bg1); border: 1px solid var(--line); }
  .card-edit:hover { color: var(--cyan); border-color: var(--cyan); }
  .card.hero { border-style: dashed; display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; }
  .card.greyed { opacity: 0.6; }
  .card.greyed:hover { opacity: 0.9; }
  .card-title { color: var(--fg); font-weight: bold; }
  .card-desc { color: var(--dim); font-size: 12px; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .card-meta { font-size: 11px; }
  .hero-form { display: grid; gap: 6px; padding: 8px 10px; border: 1px dashed var(--line); background: var(--bg1); }
  .hero-form label { display: grid; grid-template-columns: 6em 1fr; gap: 8px; align-items: baseline; color: var(--dim); font-size: 12px; }
  .hero-form input { border-bottom: 1px solid var(--line); min-width: 0; }
  .row { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
  .all { align-self: flex-start; }
  .all-list { list-style: none; display: grid; gap: 2px; }
  .row-wrap { display: flex; gap: 6px; align-items: center; }
  .row-btn { display: grid; grid-template-columns: 10em 8em 1fr; gap: 10px; flex: 1; min-width: 0; padding: 3px 6px; align-items: baseline; }
  .row-edit { padding: 1px 6px; font-size: 10px; color: var(--dim); border: 1px solid var(--line); }
  .row-edit:hover { color: var(--cyan); border-color: var(--cyan); }
  .row-btn:hover { background: var(--bg2); }
  .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .st-yellow { color: var(--yellow); }
  @media (max-width: 560px) {
    .row-btn { grid-template-columns: 1fr; gap: 2px; }
    .hero-form label { grid-template-columns: 1fr; }
  }
</style>
