<script lang="ts">
  // Pack gallery: the empty state and the `g` overlay. Result before
  // explanation — every card is one click to a prefilled prompt. Cards whose
  // requirements this host cannot meet are shown greyed with the reason, never
  // hidden: visibility of the catalog is the point.
  import type { PackInfo } from "@dextui/protocol";
  import { app, galleryPacks, packStarter, packUnmet, prefillComposer } from "../lib/state.svelte";

  let { compact = false, onPick }: { compact?: boolean; onPick?: () => void } = $props();

  let showAll = $state(false);
  let hero = $state(false);
  let service = $state("");
  let purpose = $state("");

  const curated = $derived(galleryPacks());
  const others = $derived(app.packs.filter((p) => !p.ui.gallery));

  const glyph: Record<string, string> = { chart: "▮", html: "▤", table: "☰", markdown: "¶", file: "▫", none: "·" };

  function pick(p: PackInfo) {
    prefillComposer(packStarter(p));
    onPick?.();
  }

  function slug(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "connector";
  }

  function buildConnector() {
    const name = slug(service);
    const text = [
      `Create a new dext pack at connectors/${name} for ${service.trim() || "the service"}.`,
      `Run \`dext pack create connectors/${name}\`, then edit its PACK.md so the pack: ${purpose.trim() || "does what I describe next"}.`,
      "Auth: ask me for a token via local_auth_prompt at run time; never write it to files.",
      "Expose actions as slash-style entry points and emit results as runtime_view cards.",
      `Add front-matter keys ui-starter-prompt, ui-artifact and ui-gallery: true so it shows in the DextUI gallery.`,
    ].join("\n");
    prefillComposer(text);
    hero = false;
    onPick?.();
  }
</script>

<section class="gal" class:compact data-agent-id="packs.gallery" data-state={app.packs.length ? "ready" : "empty"}>
  {#if app.packs.length === 0}
    <p class="dim">No packs on this host. <span class="faint">Packs are workflows you can run, edit and share — just files in your workspace.</span></p>
  {:else}
    <header class="gal-head">
      <span><span class="st-magenta">packs</span> <span class="faint">· workflows you can run, edit and share. They are just files in your workspace.</span></span>
      <span class="faint">{app.packs.length}</span>
    </header>

    <div class="cards">
      <button class="card hero" data-agent-id="packs.hero" onclick={() => (hero = !hero)} aria-expanded={hero}>
        <span class="card-title"><span class="st-green">+</span> Build a connector</span>
        <span class="card-desc">For your workflow: name a service, say what it should do. Ends with a pack you own.</span>
        <span class="card-meta faint">/pack create · owns a pack</span>
      </button>

      {#each curated as p (p.name)}
        {@const missing = packUnmet(p)}
        <button class="card" class:greyed={missing.length > 0} data-agent-id={`packs.card.${p.name}`} data-state={missing.length ? "unmet" : "ready"}
          title={missing.length ? `needs ${missing.join(", ")}` : packStarter(p)} onclick={() => pick(p)}>
          <span class="card-title"><span class="st-cyan">{glyph[p.ui.artifact] ?? "·"}</span> {p.name}</span>
          <span class="card-desc">{p.description}</span>
          <span class="card-meta faint">
            {p.ui.artifact}{#if p.ui.time_to_first_artifact} · ~{p.ui.time_to_first_artifact}s{/if}{#if p.shelf} · {p.shelf}{/if}
            {#if missing.length}<span class="st-yellow"> · needs {missing.join(", ")}</span>{:else if p.ui.requires.length === 0}<span class="st-green"> · no setup</span>{/if}
          </span>
        </button>
      {/each}
    </div>

    {#if hero}
      <form class="hero-form" data-agent-id="packs.hero.form" onsubmit={(e) => { e.preventDefault(); buildConnector(); }}>
        <label>service <input bind:value={service} placeholder="e.g. Linear, Stripe, my Postgres" maxlength="60" required data-agent-id="packs.hero.service" /></label>
        <label>it should <input bind:value={purpose} placeholder="e.g. list open issues assigned to me as a table" maxlength="200" required data-agent-id="packs.hero.purpose" /></label>
        <div class="row">
          <button type="submit" class="act accent" data-agent-id="packs.hero.submit">[⏎] draft the prompt</button>
          <button type="button" class="act" onclick={() => (hero = false)}>cancel</button>
          <span class="faint">You review the prompt before it runs.</span>
        </div>
      </form>
    {/if}

    {#if others.length}
      <button class="act all" data-agent-id="packs.all" aria-expanded={showAll} onclick={() => (showAll = !showAll)}>
        {showAll ? "▾" : "▸"} all packs ({others.length} more)
      </button>
      {#if showAll}
        <ul class="all-list">
          {#each others as p (p.name)}
            <li>
              <button class="row-btn" data-agent-id={`packs.row.${p.name}`} onclick={() => pick(p)}>
                <span class="st-cyan">{p.name}</span>
                <span class="faint">{p.shelf ?? "-"}</span>
                <span class="dim truncate">{p.description}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  {/if}
</section>

<style>
  .gal { display: flex; flex-direction: column; gap: 10px; width: 100%; }
  .gal-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
  .compact .cards { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); }
  .card { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid var(--line); background: var(--bg1); text-align: left; min-width: 0; }
  .card:hover, .card:focus-visible { border-color: var(--cyan); background: var(--bg2); }
  .card.hero { border-style: dashed; }
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
  .row-btn { display: grid; grid-template-columns: 10em 8em 1fr; gap: 10px; width: 100%; padding: 3px 6px; align-items: baseline; }
  .row-btn:hover { background: var(--bg2); }
  .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .st-yellow { color: var(--yellow); }
  @media (max-width: 560px) {
    .row-btn { grid-template-columns: 1fr; gap: 2px; }
    .hero-form label { grid-template-columns: 1fr; }
  }
</style>
