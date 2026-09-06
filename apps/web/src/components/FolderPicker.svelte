<script lang="ts">
  // Folder picker overlay: breadcrumb + folder list, confined to the host's
  // root. "Use this folder" opens (or focuses) a session there. Keyboard:
  // ↑/↓ move, → enter, ← up, ⏎ use, n new folder, Esc close.
  import { folders, navigate, pickCurrent, closeFolderPicker, createFolder, shortFolder } from "../lib/folders.svelte";
  import { app } from "../lib/state.svelte";
  import { useDialog } from "../lib/dialog.svelte";

  const dlg = useDialog(() => folders.open);
  let cursor = $state(0);
  let creating = $state(false);
  let newName = $state("");

  const listing = $derived(folders.listing);
  const crumbs = $derived.by(() => {
    const l = folders.listing;
    const home = app.conn?.home ?? "";
    if (!l) return [];
    const out: { label: string; path: string }[] = [{ label: "home", path: home }];
    if (l.rel) {
      let at = home;
      for (const seg of l.rel.split("/")) {
        at = `${at}/${seg}`;
        out.push({ label: seg, path: at });
      }
    }
    return out;
  });

  $effect(() => {
    void folders.listing;
    cursor = 0;
  });

  function onKey(e: KeyboardEvent) {
    if (creating) {
      if (e.key === "Escape") { creating = false; e.stopPropagation(); }
      return;
    }
    const n = listing?.dirs.length ?? 0;
    if (e.key === "ArrowDown") { cursor = Math.min(n - 1, cursor + 1); e.preventDefault(); }
    else if (e.key === "ArrowUp") { cursor = Math.max(0, cursor - 1); e.preventDefault(); }
    else if (e.key === "ArrowRight" && listing && n > 0) { navigate(`${listing.path}/${listing.dirs[cursor]?.name}`); e.preventDefault(); }
    else if (e.key === "ArrowLeft" && listing?.parent) { navigate(listing.parent); e.preventDefault(); }
    else if (e.key === "Enter") { pickCurrent(); e.preventDefault(); }
    else if (e.key === "n" && !e.metaKey && !e.ctrlKey) { creating = true; e.preventDefault(); }
    else if (e.key === "Escape") { closeFolderPicker(); e.stopPropagation(); }
  }

  function submitNew(e: Event) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    createFolder(name);
    newName = "";
    creating = false;
  }
</script>

{#if folders.open}
  <div class="insp-scrim" data-agent-id="folders.scrim" onclick={closeFolderPicker} onkeydown={() => {}} role="presentation"></div>
  <div class="insp gallery-overlay folders" role="dialog" aria-modal="true" aria-label="choose a folder" tabindex="-1" use:dlg.ref data-agent-id="folders.overlay" data-state={folders.loading ? "loading" : "ready"} onkeydown={onKey}>
    <div class="insp-head">
      <span class="st-magenta">folder</span>
      <span class="dim">where should this work happen?</span>
      <span class="insp-acts">
        <button class="act" data-agent-id="folders.close" onclick={closeFolderPicker}>esc</button>
      </span>
    </div>
    <div class="insp-body body">
      <nav class="crumbs" data-agent-id="folders.crumbs">
        {#each crumbs as c, i (c.path)}
          {#if i > 0}<span class="faint">/</span>{/if}
          <button class="crumb" class:current={i === crumbs.length - 1} data-agent-id={`folders.crumb.${i}`} onclick={() => navigate(c.path)}>{c.label}</button>
        {/each}
      </nav>
      {#if listing}
        <ul class="list" data-agent-id="folders.list">
          {#if listing.parent}
            <li><button class="row" data-agent-id="folders.up" onclick={() => navigate(listing.parent!)}><span class="faint">↑</span> ..</button></li>
          {/if}
          {#each listing.dirs as d, i (d.name)}
            <li>
              <button class="row" class:cur={i === cursor} data-agent-id={`folders.dir.${d.name}`} onclick={() => { cursor = i; navigate(`${listing.path}/${d.name}`); }}>
                <span class="st-cyan">▸</span> {d.name}
              </button>
            </li>
          {/each}
          {#if listing.dirs.length === 0}
            <li class="dim empty">no sub-folders{listing.files ? ` · ${listing.files} file${listing.files === 1 ? "" : "s"} here` : ""}</li>
          {/if}
          {#if listing.truncated}<li class="faint empty">list truncated</li>{/if}
        </ul>
        <div class="foot">
          <button class="act accent" data-agent-id="folders.use" onclick={pickCurrent}>[⏎] use <b>{shortFolder(listing.path)}</b>{listing.files ? ` · ${listing.files} file${listing.files === 1 ? "" : "s"}` : ""}</button>
          {#if creating}
            <form class="newf" onsubmit={submitNew}>
              <input bind:value={newName} placeholder="new folder name" maxlength="80" data-agent-id="folders.new.name" />
              <button type="submit" class="act" data-agent-id="folders.new.submit">create</button>
              <button type="button" class="act" onclick={() => (creating = false)}>cancel</button>
            </form>
          {:else}
            <button class="act" data-agent-id="folders.new" onclick={() => (creating = true)}>[n] new folder here</button>
          {/if}
          <span class="faint hint">↑↓ move · → open · ← up</span>
        </div>
      {:else}
        <p class="dim">loading…</p>
      {/if}
    </div>
  </div>
{/if}

<style>
  .folders { max-width: 560px; }
  .body { display: flex; flex-direction: column; gap: 8px; }
  .crumbs { display: flex; flex-wrap: wrap; gap: 4px; align-items: baseline; font-size: 12px; }
  .crumb { padding: 0 4px; color: var(--dim); background: none; border: 0; font: inherit; }
  .crumb:hover { color: var(--cyan); }
  .crumb.current { color: var(--fg); font-weight: bold; }
  .list { list-style: none; display: grid; gap: 1px; max-height: 50vh; overflow-y: auto; border: 1px solid var(--line); background: var(--bg1); }
  .row { display: flex; gap: 8px; width: 100%; padding: 4px 8px; text-align: left; background: none; border: 0; color: inherit; font: inherit; }
  .row:hover, .row.cur { background: var(--bg2); color: var(--cyan); }
  .empty { padding: 6px 8px; font-size: 12px; }
  .foot { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .newf { display: flex; gap: 6px; align-items: baseline; }
  .newf input { border-bottom: 1px solid var(--line); min-width: 14em; }
  .hint { margin-left: auto; font-size: 11px; }
</style>
