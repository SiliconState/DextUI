<script lang="ts">
  // Pack editor overlay: file tree + plain-text editor, whole files only.
  // [⌘/Ctrl+⏎] saves atomically on the host; the refreshed catalog follows
  // via packs.changed (a PACK.md edit can change ui-* and /pack commands).
  import { useDialog } from "../lib/dialog.svelte";
  import { packSheet, closePackSheet, closePackPanel, savePackFile, selectFile, runWithPack, packSheetDirty } from "../lib/packsheet.svelte";

  const dlg = useDialog(() => packSheet.open);
  const dlgPanel = useDialog(() => packSheet.panelOpen);
  const fileCount = $derived(packSheet.files.filter((f) => f.kind === "file").length);

  function onKey(e: KeyboardEvent) {
    dlg.onKey(e);
    dlgPanel.onKey(e);
    if (!packSheet.open) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      savePackFile();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if packSheet.open}
  <div class="sheet-scrim" data-agent-id="packs.sheet.scrim" onclick={() => closePackSheet()} onkeydown={() => {}} role="presentation"></div>
  <div class="sheet" use:dlg.ref role="dialog" aria-label="edit pack files" tabindex="-1"
    data-agent-id="packs.sheet" data-state={packSheet.loading ? "loading" : packSheetDirty() ? "dirty" : "ready"}>
    <header class="head">
      <span><span class="st-magenta">pack</span> <span class="st-cyan">{packSheet.pack}</span>
        <span class="faint">· {fileCount} file{fileCount === 1 ? "" : "s"} · files in your workspace</span></span>
      <span class="row">
        {#if packSheet.sel}<button class="act" data-agent-id="packs.sheet.run" onclick={runWithPack}>run with this</button>{/if}
        <button class="act close" data-agent-id="packs.sheet.close" onclick={() => closePackSheet()}>esc</button>
      </span>
    </header>
    <div class="body">
      <nav class="files" data-agent-id="packs.sheet.files" aria-label="pack files">
        {#if packSheet.listing}<div class="faint pad">loading…</div>{/if}
        {#each packSheet.files as f (f.path)}
          {@const depth = f.path.split("/").length - 1}
          <button class="file" class:sel={f.path === packSheet.sel} class:dim={f.kind !== "file" || !f.editable}
            style={`padding-left:${6 + depth * 12}px`} data-agent-id={`packs.sheet.file.${f.path}`}
            data-state={f.path === packSheet.sel ? "selected" : "idle"} disabled={f.kind !== "file" || !f.editable}
            onclick={() => selectFile(f.path)}>
            {f.kind === "dir" ? "▸" : "·"} {f.path.split("/").pop()}
          </button>
        {/each}
      </nav>
      <div class="editor">
        {#if packSheet.error}<div class="err" data-agent-id="packs.sheet.error">{packSheet.error}</div>{/if}
        {#if packSheet.sel}
          <textarea data-agent-id="packs.sheet.editor" bind:value={packSheet.text} spellcheck="false"
            disabled={packSheet.loading} placeholder={packSheet.loading ? "loading…" : ""}></textarea>
        {:else if !packSheet.listing}
          <div class="faint pad">select a file</div>
        {/if}
      </div>
    </div>
    <footer class="foot">
      <span class="faint truncate">{packSheet.sel || "—"}{#if packSheetDirty()} <span class="st-yellow">· modified</span>{/if}</span>
      <button class="act ok" data-agent-id="packs.sheet.save"
        data-state={packSheet.saving ? "saving" : packSheetDirty() ? "ready" : "idle"}
        disabled={!packSheetDirty() || packSheet.saving || packSheet.loading} onclick={savePackFile}>
        [⏎] {packSheet.saving ? "saving…" : "save"}
      </button>
    </footer>
  </div>
{/if}

{#if packSheet.panelOpen}
  <div class="sheet-scrim" data-agent-id="packs.panel.scrim" onclick={closePackPanel} onkeydown={() => {}} role="presentation"></div>
  <div class="sheet panel" use:dlgPanel.ref role="dialog" aria-label="pack panel" tabindex="-1"
    data-agent-id="packs.panel" data-state={packSheet.panelLoading ? "loading" : packSheet.error ? "error" : "ready"}>
    <header class="head">
      <span><span class="st-magenta">panel</span> <span class="st-cyan">{packSheet.pack}</span>
        <span class="faint">· {packSheet.panelFile} · sandboxed (no scripts, no network)</span></span>
      <button class="act close" data-agent-id="packs.panel.close" onclick={closePackPanel}>esc</button>
    </header>
    {#if packSheet.panelLoading}
      <div class="faint pad">loading…</div>
    {:else if packSheet.error}
      <div class="err" data-agent-id="packs.panel.error">{packSheet.error}</div>
    {:else}
      <iframe class="pane" title="pack panel" sandbox="" srcdoc={packSheet.panelHtml} data-agent-id="packs.panel.frame"></iframe>
    {/if}
  </div>
{/if}

<style>
  .sheet-scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 40; }
  .sheet { position: fixed; inset: 8vh 8vw; z-index: 41; display: flex; flex-direction: column;
    background: var(--bg0); border: 1px solid var(--line); min-width: 0; }
  .head, .foot { display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
    padding: 6px 10px; border-bottom: 1px solid var(--line); }
  .foot { border-bottom: 0; border-top: 1px solid var(--line); }
  .row { display: flex; gap: 8px; }
  .body { display: grid; grid-template-columns: 240px 1fr; min-height: 0; flex: 1; }
  .files { border-right: 1px solid var(--line); overflow-y: auto; padding: 6px 0; }
  .file { display: block; width: 100%; text-align: left; padding: 2px 10px; border: 0; background: none;
    color: var(--fg); font: inherit; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .file:hover:not(:disabled) { background: var(--bg2); }
  .file.sel { background: var(--bg2); color: var(--cyan); }
  .file.dim { color: var(--dim); cursor: default; }
  .editor { display: flex; flex-direction: column; min-width: 0; }
  textarea { flex: 1; resize: none; border: 0; outline: none; background: var(--bg0); color: var(--fg);
    font-family: var(--mono, monospace); font-size: 12px; line-height: 1.45; padding: 8px 10px; min-width: 0; }
  .err { padding: 4px 10px; color: var(--red, #e06c75); font-size: 12px; border-bottom: 1px solid var(--line); }
  .pad { padding: 6px 10px; }
  .pane { flex: 1; border: 0; background: #fff; min-height: 0; }
  .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st-yellow { color: var(--yellow); }
  @media (max-width: 700px) { .body { grid-template-columns: 1fr; } .files { max-height: 30vh; border-right: 0; border-bottom: 1px solid var(--line); } }
</style>
