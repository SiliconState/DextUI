<script lang="ts">
  // Folder picker modal: centered, not a corner drawer. Filter-as-you-type,
  // finder semantics — click selects, double-click (or →) enters, ⏎ uses;
  // recents are the live sessions' folders. Confined to the host root
  // (hello_ok.home); the host never lists anything outside it.
  import { folders, navigate, pickCurrent, closeFolderPicker, createFolder, recentFolders, shortFolder, movableSession } from "../lib/folders.svelte";
  import { app } from "../lib/state.svelte";
  import { useDialog } from "../lib/dialog.svelte";
  import { KIND_LABEL, addConnector, cancelSignIn, connectors, connectorsEnabled, relaySignIn, removeConnector, reopenSignIn, resetSignIn, signin, startSignIn, syncConnector } from "../lib/connectors.svelte";
  import type { ConnectorKind } from "@dextui/protocol";

  // Connect form (inside the picker footer). Git kinds take an optional token
  // (sent once, cleared). Drive kinds sign in with the provider: the host runs
  // rclone's OAuth listener, we open the consent page, and `add` redeems the
  // resulting ticket — no token ever passes through this component.
  let kind = $state<ConnectorKind>("github");
  let cLabel = $state("");
  let cRemote = $state("");
  let cSecret = $state("");
  let landing = $state("");
  let relayOpen = $state(false);
  const isDrive = $derived(kind === "gdrive" || kind === "dropbox");
  const kindOk = $derived(isDrive ? connectors.tools.rclone : connectors.tools.git);
  const signedIn = $derived(isDrive && signin.phase === "done" && signin.kind === kind && !!signin.ticket);
  const remoteHint = $derived(
    kind === "github" ? "owner/repo" : kind === "git" ? "https://…/repo.git" : "Folder inside the drive (blank = everything — the first copy can take a while)",
  );
  const secretHint = $derived(kind === "github" ? "Personal access token (optional for public repos)" : "Token (optional)");
  const providerName = $derived(kind === "gdrive" ? "Google" : "Dropbox");
  /** Folder name when the user leaves it blank: last path segment sans .git, or the drive's name. */
  const defaultLabel = $derived.by(() => {
    const seg = cRemote.trim().split("/").filter(Boolean).pop() ?? "";
    const clean = seg.replace(/\.git$/i, "");
    return clean || (isDrive ? KIND_LABEL[kind] : "");
  });
  function openConnect() {
    connectors.formOpen = true;
    creating = false;
  }
  function closeConnect() {
    connectors.formOpen = false;
    cSecret = "";
    landing = "";
    relayOpen = false;
    if (signin.phase !== "idle") cancelSignIn();
    resetSignIn();
  }
  function pickKind(k: ConnectorKind) {
    if (k === kind) return;
    if (signin.phase !== "idle") cancelSignIn();
    kind = k;
  }
  function submitConnect(e: Event) {
    e.preventDefault();
    const label = cLabel.trim() || defaultLabel;
    if (!label) return;
    if (!isDrive && !cRemote.trim()) return;
    if (isDrive) {
      if (!signedIn || !signin.ticket) return;
      addConnector({ kind, label, remote: cRemote.trim(), ticket: signin.ticket });
      return;
    }
    addConnector({ kind, label, remote: cRemote.trim(), ...(cSecret.trim() ? { secret: cSecret.trim() } : {}) });
    cSecret = "";
  }
  function submitRelay() {
    const l = landing.trim();
    if (!l) return;
    relaySignIn(l);
    landing = "";
  }
  function relayKey(e: KeyboardEvent) {
    if (e.key === "Enter") { e.preventDefault(); submitRelay(); }
  }
  let confirmDisc = $state("");
  let discTimer: ReturnType<typeof setTimeout> | undefined;
  /** Two clicks: the second disconnects with full cleanup — the local copy and
   *  the saved sign-in go; the originals stay in the cloud/repo. */
  function disconnect(id: string) {
    if (confirmDisc !== id) {
      confirmDisc = id;
      clearTimeout(discTimer);
      discTimer = setTimeout(() => (confirmDisc = ""), 4000);
      return;
    }
    confirmDisc = "";
    removeConnector(id, true);
  }

  // The host confirms an add by listing (formOpen is cleared by the store);
  // reset the text fields then so the next connect starts clean.
  $effect(() => {
    if (!connectors.formOpen) { cLabel = ""; cRemote = ""; landing = ""; relayOpen = false; }
  });

  const dlg = useDialog(() => folders.open);
  let cursor = $state(-1); // index into `visible`; -1 = the current folder itself
  let filter = $state("");
  let sortRecent = $state(false);
  let creating = $state(false);
  let newName = $state("");
  let filterEl = $state<HTMLInputElement | null>(null);

  const listing = $derived(folders.listing);
  const q = $derived(filter.trim().toLowerCase());
  const visible = $derived.by(() => {
    const dirs = listing?.dirs ?? [];
    const hit = q ? dirs.filter((d) => d.name.toLowerCase().includes(q)) : [...dirs];
    if (sortRecent) hit.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    return hit;
  });
  const selected = $derived(cursor >= 0 && cursor < visible.length ? visible[cursor] : null);
  const target = $derived(listing ? (selected ? `${listing.path}/${selected.name}` : listing.path) : "");
  const recents = $derived(listing && !listing.rel && !q ? recentFolders() : []);
  // Intent: "move" relocates `moving` (this session); "open" starts a new
  // session. The other action is always one keystroke away (⇧⏎) when a
  // session is movable, so the picker never needs a mode switch.
  const moving = $derived(folders.intent === "move" ? movableSession(folders.moveId) : null);
  const alt = $derived(folders.intent === "move" ? null : movableSession());
  const isHere = $derived(!!moving && moving.cwd === target);
  const crumbs = $derived.by(() => {
    const l = folders.listing;
    const home = app.conn?.home ?? "";
    if (!l) return [];
    const out: { label: string; path: string }[] = [{ label: "Home", path: home }];
    if (l.rel) {
      let at = home;
      for (const seg of l.rel.split("/")) {
        at = `${at}/${seg}`;
        out.push({ label: seg, path: at });
      }
    }
    return out;
  });

  // New listing: fresh selection and filter (finder behaviour).
  $effect(() => {
    void folders.listing;
    filter = "";
    cursor = -1;
  });
  // Typing selects the first match; a cleared filter means "this folder".
  $effect(() => {
    void q;
    cursor = q ? 0 : -1;
  });
  // Focus the filter on open and after every navigation — navigating swaps
  // the row buttons, which drops focus to <body> and would kill key handling.
  // rAF queues this after useDialog's own rAF focus (first focusable = the
  // close button), so the filter wins.
  $effect(() => {
    void folders.listing;
    if (folders.open) requestAnimationFrame(() => filterEl?.focus());
  });

  function useTarget(alternate = false): void {
    if (!target) return;
    if (!alternate) { pickCurrent(target); return; }
    if (folders.intent === "move") pickCurrent(target, "open");
    else if (alt) pickCurrent(target, "move");
  }
  function enter(d: { name: string }): void {
    if (listing) navigate(`${listing.path}/${d.name}`);
  }
  function onKey(e: KeyboardEvent) {
    dlg.onKey(e); // Tab trap while the modal is open
    if (creating || connectors.formOpen) {
      if (e.key === "Escape") { creating = false; closeConnect(); e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if (e.key === "Escape") {
      if (q) filter = "";
      else { closeFolderPicker(); e.stopPropagation(); }
      e.preventDefault();
      return;
    }
    if (e.key === "ArrowDown") { cursor = Math.min(visible.length - 1, cursor + 1); e.preventDefault(); }
    else if (e.key === "ArrowUp") { cursor = Math.max(-1, cursor - 1); e.preventDefault(); }
    else if (e.key === "ArrowRight" && selected && !q) { enter(selected); e.preventDefault(); } // (→ moves the filter caret while typing)
    else if (e.key === "ArrowLeft" && listing?.parent && !q) { navigate(listing.parent); e.preventDefault(); }
    else if (e.key === "Enter") { useTarget(e.shiftKey); e.preventDefault(); }
    else if (e.key === "n" && !e.metaKey && !e.ctrlKey && !(e.target instanceof HTMLInputElement)) { creating = true; newName = ""; e.preventDefault(); }
  }

  function submitNew(e: Event) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    createFolder(name);
    newName = "";
    creating = false;
  }

  function ago(ms: number): string {
    const s = Math.max(1, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return "now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d`;
    if (d < 30) return `${Math.floor(d / 7)}w`;
    if (d < 365) return `${Math.floor(d / 30)}mo`;
    return `${Math.floor(d / 365)}y`;
  }
</script>

{#if folders.open}
  <div class="insp-scrim" data-agent-id="folders.scrim" onclick={closeFolderPicker} onkeydown={() => {}} role="presentation"></div>
  <div class="insp gallery-overlay folders" role="dialog" aria-modal="true" aria-label="Choose a folder" tabindex="-1" use:dlg.ref data-agent-id="folders.overlay" data-state={folders.loading ? "loading" : "ready"} onkeydown={onKey}>
    <div class="insp-head">
      <span class="st-magenta">Folder</span>
      {#if moving}
        <span class="dim" data-agent-id="folders.intent" data-state="move">Move <b>{moving.title}</b> · now in {shortFolder(moving.cwd) || "host folder"}</span>
      {:else}
        <span class="dim" data-agent-id="folders.intent" data-state="open">Where should this work happen?</span>
      {/if}
      <span class="insp-acts">
        <button class="act" data-agent-id="folders.close" onclick={closeFolderPicker}>esc</button>
      </span>
    </div>
    {#if listing}
      <div class="body">
        <div class="tools">
          <input class="filter" bind:this={filterEl} bind:value={filter} placeholder="Filter folders…" spellcheck="false" autocomplete="off" aria-label="Filter folders" data-agent-id="folders.filter" />
          {#if listing.dirs.some((d) => typeof d.mtime === "number")}
            <button class="act" data-agent-id="folders.sort" title="Sort folders by name or last change" onclick={() => (sortRecent = !sortRecent)}>
              {sortRecent ? "▾ Recent" : "a–z"}
            </button>
          {/if}
        </div>
        <div class="scroll">
          {#if recents.length}
            <div class="recents">
              <span class="faint lbl">Recent</span>
              {#each recents as r, i (r)}
                <button class="chip" class:sel={!!moving && moving.cwd === r} data-agent-id={`folders.recent.${i}`} title={moving && moving.cwd === r ? `${r}\n(current folder)` : r} onclick={() => pickCurrent(r)}>{shortFolder(r)}</button>
              {/each}
            </div>
          {/if}
          {#if connectorsEnabled() && !listing.rel && !q}
            <div class="recents connected" data-agent-id="folders.connected">
              <span class="faint lbl">Connected</span>
              {#each connectors.items as c (c.id)}
                <span class="conn" data-state={c.status} data-agent-id={`folders.conn.${c.id}`}>
                  <button class="chip" title={`${KIND_LABEL[c.kind]} · ${c.remote}${c.error ? `\n${c.error}` : ""}`} onclick={() => pickCurrent(c.local)} disabled={c.status === "syncing"}>
                    <span class="kind">{KIND_LABEL[c.kind]}</span> {c.label}
                  </button>
                  {#if c.status === "syncing"}
                    <span class="faint tiny">syncing…</span>
                  {:else if c.status === "error"}
                    <button class="tiny st-red" title={c.error} onclick={() => syncConnector(c.id)}>retry</button>
                  {:else}
                    <button class="tiny faint" title="Pull the latest from the source" onclick={() => syncConnector(c.id)}>↻</button>
                  {/if}
                  {#if c.status !== "syncing"}
                    <button
                      class="tiny faint"
                      class:st-red={confirmDisc === c.id}
                      title={confirmDisc === c.id ? "Disconnect and delete the local copy — the originals stay in your drive/repo" : "Disconnect (full cleanup)"}
                      aria-label={`Disconnect ${c.label}`}
                      data-agent-id={`folders.connect.disconnect.${c.id}`}
                      data-state={confirmDisc === c.id ? "confirm" : "ready"}
                      onclick={() => disconnect(c.id)}
                    >{confirmDisc === c.id ? "sure?" : "×"}</button>
                  {/if}
                </span>
              {/each}
              <button class="chip add" data-agent-id="folders.connect" onclick={openConnect} title="Connect a GitHub repo, Google Drive or Dropbox folder">+ Connect…</button>
            </div>
          {/if}
          <nav class="crumbs" aria-label="Path" data-agent-id="folders.crumbs">
            {#each crumbs as c, i (c.path)}
              {#if i > 0}<span class="faint">/</span>{/if}
              <button class="crumb" class:current={i === crumbs.length - 1} data-agent-id={`folders.crumb.${i}`} onclick={() => navigate(c.path)}>{c.label}</button>
            {/each}
            {#if listing.files}<span class="faint filecount">· {listing.files} file{listing.files === 1 ? "" : "s"}</span>{/if}
          </nav>
          <ul class="list" data-agent-id="folders.list">
            {#if listing.parent && !q}
              <li class="entry">
                <button class="go" data-agent-id="folders.up" title="Go up one folder" aria-label="Go up one folder" onclick={() => navigate(listing.parent!)}><span class="faint">↑</span></button>
                <button class="row" onclick={() => navigate(listing.parent!)}><span class="name faint">..</span></button>
              </li>
            {/if}
            {#each visible as d, i (d.name)}
              <li class="entry" class:cur={i === cursor}>
                <button class="go" data-agent-id={`folders.go.${d.name}`} title={`Open ${d.name}`} aria-label={`Open ${d.name}`} onclick={() => enter(d)}>▸</button>
                <button class="row" data-agent-id={`folders.dir.${d.name}`} title={d.name} onclick={() => (cursor = i)} ondblclick={() => enter(d)}>
                  <span class="name">{d.name}</span>
                  {#if typeof d.mtime === "number"}<span class="faint ago">{ago(d.mtime)}</span>{/if}
                </button>
              </li>
            {/each}
            {#if visible.length === 0}
              <li class="dim empty">{q ? `Nothing matches “${filter.trim()}”` : `No sub-folders${listing.files ? ` · ${listing.files} file${listing.files === 1 ? "" : "s"} here` : ""}`}</li>
            {/if}
            {#if listing.truncated}<li class="faint empty">List truncated</li>{/if}
          </ul>
        </div>
        <div class="foot">
          {#if connectors.formOpen}
            <form class="connect" onsubmit={submitConnect} data-agent-id="folders.connect.form" data-state={connectors.pending ? "pending" : "ready"}>
              <div class="kinds" role="radiogroup" aria-label="Source">
                {#each ["github", "gdrive", "dropbox", "git"] as k (k)}
                  <button type="button" class="chip" class:sel={kind === k} role="radio" aria-checked={kind === k} onclick={() => pickKind(k as ConnectorKind)}>{KIND_LABEL[k as ConnectorKind]}</button>
                {/each}
              </div>
              {#if !kindOk}
                <p class="faint tiny">{isDrive ? "rclone is not installed on the host — install it to connect Drive or Dropbox." : "git is not installed on the host."}</p>
              {/if}
              {#if isDrive}
                <div class="signin" data-agent-id="folders.connect.signin" data-state={signin.phase}>
                  {#if signedIn}
                    <span class="st-green">✓ Signed in to {providerName}</span>
                    <button type="button" class="tiny faint" onclick={cancelSignIn}>Use a different account</button>
                  {:else if signin.phase === "starting" || signin.phase === "waiting"}
                    <span class="dim">Waiting for {providerName}… finish in the tab that opened.</span>
                    {#if signin.url}<button type="button" class="tiny" onclick={reopenSignIn}>Open it again</button>{/if}
                    <button type="button" class="tiny faint" onclick={cancelSignIn}>Cancel</button>
                    <details class="relay" bind:open={relayOpen}>
                      <summary class="faint tiny">Signed in on another device and it ended on a page that would not load?</summary>
                      <div class="relayf">
                        <input bind:value={landing} placeholder="Paste the address of that page (http://127.0.0.1:53682/?state=…)" spellcheck="false" autocomplete="off" aria-label="Landing address" onkeydown={relayKey} data-agent-id="folders.connect.landing" />
                        <button type="button" class="act" disabled={!landing.trim()} onclick={submitRelay}>Finish</button>
                      </div>
                    </details>
                  {:else}
                    <button type="button" class="act accent" disabled={!kindOk} data-agent-id="folders.connect.signin.start" onclick={() => startSignIn(kind)}>Sign in with {providerName}</button>
                    {#if signin.phase === "error" && signin.error}<span class="st-red tiny">{signin.error}</span>{/if}
                  {/if}
                </div>
              {/if}
              <input bind:value={cRemote} placeholder={remoteHint} spellcheck="false" autocomplete="off" aria-label="Source" data-agent-id="folders.connect.remote" />
              <input bind:value={cLabel} placeholder={`Folder name (default: ${defaultLabel || "from the source"})`} maxlength="80" aria-label="Folder name" data-agent-id="folders.connect.label" />
              {#if !isDrive}
                <input bind:value={cSecret} type="password" placeholder={secretHint} autocomplete="off" spellcheck="false" aria-label="Credential" data-agent-id="folders.connect.secret" />
              {/if}
              <div class="acts">
                <button type="submit" class="act accent" disabled={!kindOk || connectors.pending || (isDrive ? !signedIn : !cRemote.trim())} data-agent-id="folders.connect.submit">{connectors.pending ? "Connecting…" : "Connect"}</button>
                <button type="button" class="act" onclick={closeConnect}>Cancel</button>
                <span class="faint tiny">Appears under Connected/{cLabel.trim() || defaultLabel || "…"}. {isDrive ? "Copies both ways; never deletes." : "Pull is fast-forward only; push commits everything."}</span>
              </div>
            </form>
          {:else if creating}
            <form class="newf" onsubmit={submitNew}>
              <input bind:value={newName} placeholder="New folder name" maxlength="80" data-agent-id="folders.new.name" />
              <button type="submit" class="act" data-agent-id="folders.new.submit">Create</button>
              <button type="button" class="act" onclick={() => (creating = false)}>Cancel</button>
            </form>
          {:else}
            {#if moving}
              <button class="use" data-agent-id="folders.use" data-state={isHere ? "here" : "move"} onclick={() => useTarget()} disabled={isHere}>
                <span class="faint">[⏎]</span> {isHere ? "Already here" : "Move here"} <b>{shortFolder(target)}</b>
                <span class="faint sub">{isHere ? "This session is in this folder" : "Keeps the conversation; the next turn works from this folder"}</span>
              </button>
              <button class="act" data-agent-id="folders.alt" title="Start a new session in this folder instead" onclick={() => useTarget(true)}>[⇧⏎] New session here</button>
            {:else}
              <button class="use" data-agent-id="folders.use" onclick={() => useTarget()}>
                <span class="faint">[⏎]</span> Use <b>{shortFolder(target)}</b>
                <span class="faint sub">{folders.seed ? "Opens a session and starts your pack" : "Opens a session here"}</span>
              </button>
              {#if alt}
                <button class="act" data-agent-id="folders.alt" title={`Move “${alt.title}” here instead of opening a new session`} onclick={() => useTarget(true)} disabled={alt.cwd === target}>[⇧⏎] Move current session here</button>
              {/if}
            {/if}
            <button class="act" data-agent-id="folders.new" onclick={() => (creating = true)}>[n] New folder here</button>
          {/if}
          {#if !connectors.formOpen}<span class="faint hint">↑↓ move · → open · ← up</span>{/if}
        </div>
      </div>
    {:else}
      <div class="insp-body">
        <p class="dim">Loading…</p>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Centered modal on top of the shared .insp drawer chrome (app.css):
     inset 0 + margin auto centers; the drawer's top/right/bottom stay. */
  .folders {
    left: 0;
    width: min(40rem, 94vw);
    height: min(34rem, 88dvh);
    margin: auto;
    border: 1px solid var(--line);
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55);
  }
  .folders[data-state="loading"] .scroll {
    /* Navigating: dim the (stale) list while the fresh listing is in flight. */
    opacity: 0.55;
  }
  @media (max-width: 640px) {
    .folders {
      width: 100vw;
      height: 100dvh;
      border: 0;
    }
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .tools {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 8px 12px 0;
  }
  .filter {
    flex: 1;
    min-width: 0;
    border: 1px solid var(--line);
    background: var(--bg2);
    padding: 3px 8px;
  }
  .filter:focus {
    border-color: var(--cyan);
    outline: none;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .recents {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: baseline;
  }
  .lbl {
    font-size: 11px;
  }
  .chip {
    border: 1px solid var(--line);
    background: var(--bg2);
    padding: 0 8px;
    color: var(--cyan);
    font-size: 12px;
    max-width: 16rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip:hover {
    border-color: var(--cyan);
  }
  .chip:disabled {
    opacity: 0.6;
  }
  .chip.add {
    color: var(--dim);
    border-style: dashed;
  }
  .chip.sel {
    border-color: var(--cyan);
    background: var(--bg1);
  }
  .conn {
    display: inline-flex;
    align-items: baseline;
    gap: 3px;
  }
  .conn[data-state="error"] .chip {
    border-color: var(--red);
  }
  .kind {
    color: var(--dim);
    font-size: 11px;
  }
  .tiny {
    font: inherit;
    font-size: 11px;
    background: none;
    border: 0;
    padding: 0 2px;
  }
  .signin {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: baseline;
  }
  .relay {
    flex: 1 1 100%;
  }
  .relay summary {
    cursor: pointer;
  }
  .relayf {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }
  .relayf input {
    flex: 1;
    min-width: 0;
  }
  .connect {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
  }
  .connect input {
    border: 1px solid var(--line);
    background: var(--bg2);
    padding: 4px 8px;
  }
  .connect input:focus {
    border-color: var(--cyan);
    outline: none;
  }
  .connect .kinds,
  .connect .acts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: baseline;
  }
  .connect p {
    margin: 0;
  }
  .crumbs {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: baseline;
    font-size: 12px;
  }
  .crumb {
    padding: 0 4px;
    color: var(--dim);
    background: none;
    border: 0;
    font: inherit;
  }
  .crumb:hover {
    color: var(--cyan);
  }
  .crumb.current {
    color: var(--fg);
    font-weight: bold;
  }
  .filecount {
    font-size: 11px;
  }
  .list {
    list-style: none;
    display: grid;
    gap: 1px;
    border: 1px solid var(--line);
    background: var(--bg2);
  }
  .entry {
    display: flex;
    align-items: stretch;
  }
  .row {
    display: flex;
    gap: 8px;
    flex: 1;
    min-width: 0;
    padding: 4px 8px;
    align-items: baseline;
    text-align: left;
    background: var(--bg1);
    border: 0;
    color: inherit;
    font: inherit;
  }
  .row:hover,
  .entry.cur .row {
    background: var(--bg2);
  }
  .row:hover .name,
  .entry.cur .name {
    color: var(--cyan);
  }
  /* Drill-down gutter on the LEFT of every name (tree convention): click a
     row selects, ▸ (or double-click, or →) drills in — and works on touch. */
  .go {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    border-right: 1px solid var(--line);
    background: var(--bg1);
    color: var(--cyan);
    font-size: 11px;
  }
  .go:hover,
  .entry.cur .go {
    background: var(--bg2);
  }
  .row .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
  }
  .ago {
    font-size: 11px;
    flex-shrink: 0;
  }
  .empty {
    padding: 6px 8px;
    font-size: 12px;
  }
  .foot {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    padding: 8px 12px;
    border-top: 1px solid var(--line);
  }
  .use {
    display: flex;
    gap: 6px;
    align-items: baseline;
    border: 1px solid var(--cyan);
    padding: 3px 10px;
    color: var(--fg);
    max-width: 100%;
    overflow: hidden;
  }
  .use:hover {
    background: var(--bg2);
  }
  .use b {
    color: var(--cyan);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    font-size: 11px;
    white-space: nowrap;
  }
  .newf {
    display: flex;
    gap: 6px;
    align-items: baseline;
    flex: 1;
    min-width: 0;
  }
  .newf input {
    flex: 1;
    min-width: 0;
    border: 1px solid var(--line);
    background: var(--bg2);
    padding: 3px 8px;
  }
  .hint {
    margin-left: auto;
    font-size: 11px;
  }
</style>
