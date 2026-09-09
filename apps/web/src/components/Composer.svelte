<script lang="ts">
  // Inline ❯ prompt — the composer is a terminal input line, not a chat box.
  import type { SessionStore } from "@dextui/client";
  import type { HostCommand } from "@dextui/protocol";
  import { tick, untrack } from "svelte";
  import { app, connection, newSession, stepSession, trackDelivery } from "../lib/state.svelte";
  import { useSession } from "../lib/useSession.svelte";
  import { runSlash as runExtSlash, slashCommands as extSlashCommands } from "../ext";
  import { fileUrl } from "../lib/files";
  import { attachFiles, attachUrl, attachmentBlock, attachmentsFor, clearAttachments, imageAttachmentKind, removeAttachment } from "../lib/uploads.svelte";

  let { store }: { store: SessionStore } = $props();

  let text = $state("");
  let menuIdx = $state(0);
  // Escape hides the slash menu without touching the draft; any edit re-arms it.
  let menuHidden = $state(false);
  let inputEl: HTMLTextAreaElement | undefined = $state();
  let menuEl: HTMLDivElement | undefined = $state();
  // Per-session prompt history (shell semantics): every submitted line —
  // prompt, steer, slash — newest last, consecutive duplicates collapsed.
  const HISTORY_CAP = 50;
  let hist: string[] = [];
  let histIdx = $state(0);
  let stash = "";

  // Fallback for hosts that predate hello_ok.commands: derive from slash.* caps.
  const LEGACY_COMMANDS: (HostCommand & { cap: string })[] = [
    { cmd: "/approval", desc: "Set dext approval profile", cap: "slash.approval" },
    { cmd: "/compact", desc: "Compact session context", cap: "slash.compact" },
    { cmd: "/model", desc: "Show or switch model", cap: "slash.model" },
    { cmd: "/todos", desc: "Show the todo list", cap: "slash.todos" },
    { cmd: "/help", desc: "List host commands", cap: "slash.help" },
  ];

  const sess = useSession(() => store);
  const view = $derived(sess.view ?? store.state);

  const commands = $derived<HostCommand[]>([
    ...(app.commands.length > 0 ? app.commands : LEGACY_COMMANDS.filter((c) => app.caps.includes(c.cap))),
    // Client-side slash commands registered by extensions (apps/web/src/ext/*).
    ...extSlashCommands(),
  ]);
  // The menu stays open while the text is still a prefix of some command —
  // including multi-word ones like `/pack run re<port>` — and closes once a
  // command is complete and followed by a space (the task is free text).
  // Matching is word-wise: every finished word must equal the command's word,
  // the word being typed may be a prefix (rank 0), or — for pack names typed
  // from memory: `stockdeep`, `stock-deepdive`, `deepdive` — a normalised
  // substring (rank 1) or subsequence (rank 2). Prefix matches list first.
  const slashQuery = $derived(text.trimStart().toLowerCase());
  function norm(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9/]/g, "");
  }
  function isSubsequence(needle: string, hay: string): boolean {
    let i = 0;
    for (const ch of hay) if (ch === needle[i]) i++;
    return i === needle.length;
  }
  function slashRank(cmd: string, typed: string): number {
    const words = typed.trim().toLowerCase().split(/\s+/);
    const parts = cmd.toLowerCase().split(/\s+/);
    if (words.length > parts.length) return -1;
    for (let i = 0; i < words.length - 1; i++) if (parts[i] !== words[i]) return -1;
    const w = words[words.length - 1]!;
    const p = parts[words.length - 1]!;
    if (p.startsWith(w)) return 0;
    const nw = norm(w);
    if (nw.length < 3) return -1;
    if (norm(p).includes(nw)) return 1;
    return isSubsequence(nw, norm(p)) ? 2 : -1;
  }
  const slashOpen = $derived(
    !menuHidden &&
      text.startsWith("/") &&
      !text.includes("\n") &&
      (!text.includes(" ") || commands.some((c) => slashRank(c.cmd, text) >= 0 && c.cmd.toLowerCase() !== slashQuery.trim())),
  );
  const slashList = $derived(
    slashOpen
      ? commands
          .map((c, i) => ({ c, i, r: slashRank(c.cmd, text) }))
          .filter((x) => x.r >= 0)
          .sort((a, b) => a.r - b.r || a.i - b.i)
          .map((x) => x.c)
      : [],
  );
  // menuIdx can outlive a shrinking list (typing narrows matches); clamp before use.
  const menuCur = $derived(slashList.length === 0 ? 0 : Math.min(menuIdx, slashList.length - 1));
  // Keyboard navigation in a scrolling menu keeps the cursor row visible.
  $effect(() => {
    void menuCur;
    menuEl?.querySelector<HTMLElement>(".c-menu-row.cursor")?.scrollIntoView({ block: "nearest" });
  });
  const live = $derived(view.status === "live");
  // Real hosts may not support mid-turn steering; honor the hello capability
  // (snapshotted into reactive app.caps at phase=live).
  const canSteer = $derived(app.caps.includes("steering"));
  // Attachments (files_write): chips upload into <cwd>/uploads and their
  // paths ride the prompt tail; a send waits for in-flight uploads.
  const canAttach = $derived(app.caps.includes("files_write") && live);
  const atts = $derived(attachmentsFor(app.activeId));
  const uploading = $derived(atts.some((a) => a.status === "uploading"));
  const sessCwd = $derived(app.sessions.find((s) => s.id === app.activeId)?.cwd ?? "");
  const canSend = $derived(
    (text.trim().length > 0 || atts.some((a) => a.status === "done")) &&
      !uploading &&
      app.phase === "live" &&
      app.activeId !== "" &&
      live &&
      (!view.working || canSteer),
  );
  // Shortcut glyph for the platform's primary modifier (⌘ on Apple, ^ elsewhere).
  const MOD = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? "⌘" : "^";
  const placeholder = $derived.by(() => {
    if (view.status === "exited") return `session closed — ${MOD}n for a new one`;
    if (view.status === "cold") return "session closed — use wake in the session menu";
    if (!live) return "waking session…";
    if (view.working) {
      return canSteer ? "type to queue — delivers as the next turn… (^c to stop)" : "turn running… (^c to stop)";
    }
    const parts = ["type a request…"];
    if (commands.length > 0) parts.push("/ commands");
    parts.push("↑ history");
    return parts.join("   ");
  });
  // Auto-grow by measuring scrollHeight so soft-wrapped lines count too
  // (a hard-\n count kept the box at 1 row while wrapped text scrolled away).
  const MAX_ROWS = 8;
  function fit(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 21;
    const cap = lh * MAX_ROWS + 4;
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
    el.style.overflowY = el.scrollHeight > cap ? "auto" : "hidden";
  }
  $effect(() => {
    const el = inputEl;
    if (!el) return;
    void text; // re-measure on every edit
    fit(el);
  });
  // Wrap points move with width and font metrics, not just content.
  $effect(() => {
    const el = inputEl;
    if (!el) return;
    const ro = new ResizeObserver(() => fit(el));
    ro.observe(el);
    void document.fonts?.ready.then(() => fit(el));
    return () => ro.disconnect();
  });

  // Per-session draft persistence: restore on switch, save on leave/send.
  // History rides along; the hero-typing stash seeds a fresh session's text.
  $effect(() => {
    const sid = app.activeId;
    if (!sid) return;
    const revision = app.draftRevisions[sid] ?? 0;
    const generation = localStorage.getItem(`dextui.generation.${sid}`);
    // The stash is consumed, not tracked: a reactive read of it (or of `text`)
    // here would re-run this effect on the next keystroke and reset history.
    const seed = untrack(() => app.pendingDraft);
    text = (localStorage.getItem(`dextui.draft.${sid}`) ?? "") + seed;
    hist = loadHistory(sid);
    histIdx = 0;
    stash = "";
    menuHidden = false;
    menuIdx = 0;
    if (seed) {
      app.pendingDraft = "";
      requestAnimationFrame(() => inputEl?.focus());
    }
    return () => {
      // Clearing/deleting must not be undone by this effect's draft teardown.
      if ((app.draftRevisions[sid] ?? 0) !== revision ||
          !app.sessions.some((s) => s.id === sid) ||
          localStorage.getItem(`dextui.generation.${sid}`) !== generation) return;
      if (text) localStorage.setItem(`dextui.draft.${sid}`, text);
      else localStorage.removeItem(`dextui.draft.${sid}`);
    };
  });

  // Gallery / card actions land here. `n` distinguishes repeated identical
  // requests; the effect never re-fires on its own text change because the
  // prefill object is consumed (nulled) synchronously.
  $effect(() => {
    const p = app.prefill;
    if (!p) return;
    app.prefill = null;
    text = p.text;
    menuHidden = false;
    menuIdx = 0;
    exitHistory();
    void tick().then(() => {
      const el = inputEl;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  });

  function loadHistory(sid: string): string[] {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(`dextui.history.${sid}`) ?? "[]");
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  function recordHistory(sid: string, line: string): void {
    if (!line.trim()) return;
    if (hist[hist.length - 1] !== line) hist.push(line);
    if (hist.length > HISTORY_CAP) hist = hist.slice(-HISTORY_CAP);
    localStorage.setItem(`dextui.history.${sid}`, JSON.stringify(hist));
  }

  // Any edit while recalling history exits history mode — the edit is the
  // new draft (standard shell behavior). Programmatic edits call this too,
  // since they don't fire `input`.
  function exitHistory() {
    if (histIdx > 0) {
      histIdx = 0;
      stash = "";
    }
  }

  function complete(c: string) {
    text = `${c} `;
    menuIdx = 0;
    exitHistory();
    inputEl?.focus();
  }

  function send() {
    const c = connection();
    if (!canSend || !c) return;
    const sid = app.activeId;
    const t = text;
    // Attachment paths ride the prompt as a tail the agent can act on; slash
    // commands leave the chips in place for the next real prompt.
    const slash = t.trim().startsWith("/");
    const block = slash ? "" : attachmentBlock(atts);
    const full = block ? (t.trim() ? `${t.trimEnd()}\n\n` : "") + block : t;
    recordHistory(sid, full);
    // Each send is nonce-tagged: a reconnect replay can't double-run it, and a
    // lost/rejected send restores its text (trackDelivery + cmd_ack).
    if (slash) {
      // An extension may claim the command locally; otherwise the host handles it.
      if (!runExtSlash(t, sid)) trackDelivery(c.slash(sid, t.trim()), { sessionId: sid, text: t, kind: "slash" });
    } else if (view.working && canSteer) trackDelivery(c.steer(sid, full), { sessionId: sid, text: full, kind: "steer" });
    else trackDelivery(c.prompt(sid, full), { sessionId: sid, text: full, kind: "prompt" });
    if (!slash) clearAttachments(sid);
    localStorage.removeItem(`dextui.draft.${sid}`);
    text = "";
    menuHidden = false;
    menuIdx = 0;
    histIdx = 0;
    stash = "";
  }

  function stop() {
    const c = connection();
    if (c && app.activeId) c.interrupt(app.activeId);
  }

  function onKey(e: KeyboardEvent) {
    const el = e.currentTarget as HTMLTextAreaElement;
    // IME composition (CJK etc.): Enter/arrows belong to the composer window.
    if (e.isComposing || e.keyCode === 229) return;
    if (slashOpen && slashList.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        menuIdx = (menuCur + 1) % slashList.length;
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        menuIdx = (menuCur - 1 + slashList.length) % slashList.length;
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const item = slashList[menuCur];
        if (item) complete(item.cmd);
        return;
      }
      // Enter accepts the highlighted item; an exact match (even when longer
      // siblings are listed, e.g. `report` vs `report-mine`) falls through to send.
      if (e.key === "Enter" && !e.shiftKey) {
        const typed = text.trim().toLowerCase();
        const exact = slashList.some((c) => c.cmd.toLowerCase() === typed);
        const item = slashList[menuCur];
        if (item && !exact) {
          e.preventDefault();
          complete(item.cmd);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        menuHidden = true;
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
      // Copy wins when text is selected; otherwise interrupt the running turn.
      if (view.working && el.selectionStart === el.selectionEnd) {
        e.preventDefault();
        stop();
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
      e.preventDefault();
      newSession();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === "[" || e.key === "]")) {
      e.preventDefault();
      stepSession(e.key === "[" ? -1 : 1);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
      return;
    }
    // History recall (shell semantics): ↑ only from the first *visual* row,
    // ↓ only from the last; editing a recalled line forks the draft (see
    // onInput). Soft wraps are invisible to string math, so let the browser
    // move the caret first: a native ↑ on the top row lands at 0 and a native
    // ↓ on the bottom row lands at the end — anywhere else it stays inside.
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      const caret = el.selectionStart ?? 0;
      if (el.selectionEnd !== caret) return;
      const up = e.key === "ArrowUp";
      const before = text.slice(0, caret);
      const after = text.slice(caret);
      if (up ? before.includes("\n") || hist.length === 0 : after.includes("\n") || histIdx === 0) return;
      const draft = text;
      const sid = app.activeId;
      requestAnimationFrame(() => {
        if (el.value !== draft || sid !== app.activeId || !el.isConnected) return;
        const pos = el.selectionStart ?? 0;
        if (up ? pos !== 0 : pos !== draft.length) return; // caret moved within the box
        if (up) {
          if (histIdx === 0) stash = draft; // first ↑ stashes the working draft
          histIdx = Math.min(histIdx + 1, hist.length);
          text = hist[hist.length - histIdx] ?? "";
        } else {
          histIdx -= 1;
          text = histIdx === 0 ? stash : (hist[hist.length - histIdx] ?? "");
        }
        void tick().then(() => el.setSelectionRange(0, 0));
      });
    }
  }

  function onInput() {
    menuHidden = false;
    exitHistory();
  }

  // ----- attachments -----
  let fileInput: HTMLInputElement | undefined = $state();
  let urlInput: HTMLInputElement | undefined = $state();
  let urlOpen = $state(false);
  let urlText = $state("");
  let dragging = $state(false);

  function onPick(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    if (canAttach && el.files?.length) attachFiles(app.activeId, [...el.files]);
    el.value = "";
  }
  function onDrop(e: DragEvent) {
    dragging = false;
    const files = [...(e.dataTransfer?.files ?? [])];
    if (canAttach && files.length > 0) {
      e.preventDefault();
      attachFiles(app.activeId, files);
    }
  }
  function onDragLeave(e: DragEvent) {
    // Leaving for a child still counts as inside; only a real exit clears.
    const to = e.relatedTarget as Node | null;
    if (!to || !(e.currentTarget as HTMLElement).contains(to)) dragging = false;
  }
  function onPaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.files ?? [])];
    if (canAttach && files.length > 0) {
      e.preventDefault();
      attachFiles(app.activeId, files);
    }
  }
  async function toggleUrl() {
    urlOpen = !urlOpen;
    await tick();
    (urlOpen ? urlInput : inputEl)?.focus();
  }
  function submitUrl() {
    const u = urlText.trim();
    if (!u) return;
    attachUrl(app.activeId, u);
    urlText = "";
    urlOpen = false;
  }
</script>

<!-- drop target: mouse-drag only — keyboard users have the [+] picker -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="c-root"
  class:drop={dragging}
  data-agent-id="composer.root"
  ondragover={(e) => {
    if (canAttach && e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
      dragging = true;
    }
  }}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
  {#if slashOpen && slashList.length > 0}
    <div class="c-menu" data-agent-id="composer.menu" data-state="open" bind:this={menuEl}>
      {#each slashList as c, i (c.cmd)}
        <button
          class="c-menu-row"
          class:cursor={i === menuCur}
          data-agent-id={`composer.menu.item.${c.cmd.slice(1)}`}
          data-state={i === menuCur ? "cursor" : "idle"}
          onclick={() => complete(c.cmd)}
          onmousemove={() => (menuIdx = i)}
        >
          <span class="c-cur">{i === menuCur ? "❯" : " "}</span>
          <span class="st-accent">{c.cmd}</span>
          <span class="dim">{c.desc}</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if urlOpen && canAttach}
    <div class="c-urlrow" data-agent-id="composer.attachurl.row">
      <span class="pg">⤓</span>
      <input
        class="c-url"
        placeholder="https://… — the host downloads it into the workspace"
        bind:this={urlInput}
        bind:value={urlText}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submitUrl();
          } else if (e.key === "Escape") {
            urlOpen = false;
            inputEl?.focus();
          }
        }}
        data-agent-id="composer.attachurl.input"
      />
      <button class="act accent" data-agent-id="composer.attachurl.go" onclick={submitUrl}>fetch</button>
    </div>
  {/if}
  {#if atts.length > 0}
    <div class="c-atts" data-agent-id="composer.attachments">
      {#each atts as a (a.id)}
        {@const kind = imageAttachmentKind(a)}
        <span class="c-att" class:err={a.status === "error"} data-agent-id="composer.attachment" data-state={a.status} title={a.error ?? a.path ?? a.name}>
          {#if a.thumb}<img class="c-thumb" src={a.thumb} alt="" />{/if}
          {#if a.status === "done" && a.path}
            <a class="c-attname" href={fileUrl(app.activeId, a.path, sessCwd)} target="_blank" rel="noopener noreferrer">{a.name}</a>
          {:else}
            <span class="c-attname">{a.name}</span>
          {/if}
          {#if a.status === "uploading"}
            <span class="faint">{a.size > 0 && a.progress > 0 ? `${Math.round(a.progress * 100)}%` : "…"}</span>
          {:else if a.status === "error"}
            <span class="c-attmeta">{a.error}</span>
          {:else if kind === "vision"}
            <span class="c-attmeta vision" data-agent-id="composer.attachment.vision" title="Dext can call read_image; pixel disclosure may require approval">vision compatible · approval on use</span>
          {:else if kind === "other-image" || kind === "large-image"}
            <span class="c-attmeta warn" data-agent-id="composer.attachment.convert" title={kind === "large-image" ? "read_image accepts source images up to 20 MiB" : "read_image accepts PNG, JPEG, and WebP"}>convert / OCR</span>
          {:else}
            <span class="faint">{a.path}</span>
          {/if}
          <button class="c-attx" data-agent-id="composer.attachment.remove" title="remove chip (the file stays in uploads/)" onclick={() => removeAttachment(app.activeId, a.id)}>✕</button>
        </span>
      {/each}
    </div>
  {/if}
  <input class="c-file" type="file" multiple bind:this={fileInput} onchange={onPick} data-agent-id="composer.attach.input" />

  <div class="c-row">
    <span class="pg" class:pg-busy={view.working}>❯</span>
    <textarea
      bind:this={inputEl}
      bind:value={text}
      onkeydown={onKey}
      oninput={onInput}
      onpaste={onPaste}
      rows="1"
      {placeholder}
      data-agent-id="composer.input"
      data-state={view.working ? "working" : "idle"}
    ></textarea>
    <span class="c-side">
      {#if canAttach}
        <button class="act" data-agent-id="composer.attach" title="attach files (or drop / paste them here)" onclick={() => fileInput?.click()}>[+]</button>
        <button class="act" data-agent-id="composer.attachurl" title="fetch a URL into the workspace" onclick={toggleUrl}>[⤓]</button>
      {/if}
      {#if histIdx > 0}
        <span class="faint" data-agent-id="composer.histmark">[↑{histIdx}]</span>
      {/if}
      {#if view.working}
        <button class="act err" data-agent-id="composer.stop" onclick={stop}>^c stop</button>
      {/if}
      <button
        class="act accent"
        data-agent-id={view.working && canSteer ? "composer.steer" : "composer.send"}
        data-state={canSend ? "ready" : "disabled"}
        onclick={send}
        disabled={!canSend}
      >
        [⏎] {view.working && canSteer ? "steer" : "send"}
      </button>
    </span>
  </div>
</div>

<style>
  .c-root {
    position: relative;
    padding: 4px 10px 6px;
  }
  .c-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }
  .pg {
    color: var(--green);
    font-weight: bold;
    padding-bottom: 3px;
    user-select: none;
  }
  .pg-busy {
    color: var(--yellow);
  }
  textarea {
    flex: 1;
    width: 100%;
    min-width: 0;
    resize: none;
    padding: 2px 0;
    line-height: 1.5;
    caret-color: var(--green);
  }
  .c-side {
    display: flex;
    gap: 12px;
    align-items: baseline;
    padding-bottom: 3px;
    flex-shrink: 0;
  }
  .c-root.drop {
    outline: 1px dashed var(--green);
    outline-offset: -4px;
  }
  .c-file {
    display: none;
  }
  .c-urlrow {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 2px 0 4px;
  }
  .c-url {
    flex: 1;
    min-width: 0;
  }
  .c-atts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 2px 0 4px 20px;
  }
  .c-att {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--line);
    background: var(--bg1);
    padding: 1px 6px;
    max-width: 100%;
    font-size: 11.5px;
  }
  .c-att.err {
    border-color: color-mix(in srgb, var(--red, #f85149) 45%, var(--line));
    color: var(--red, #f85149);
  }
  .c-attmeta.vision {
    color: var(--cyan);
  }
  .c-attmeta.warn {
    color: var(--yellow);
  }
  .c-thumb {
    width: 20px;
    height: 20px;
    object-fit: cover;
    display: block;
  }
  .c-attname,
  .c-attmeta {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .c-attx {
    padding: 0 2px;
  }
  .c-menu {
    position: absolute;
    bottom: 100%;
    left: 10px;
    right: 10px;
    margin-bottom: 2px;
    border: 1px solid var(--line);
    background: var(--bg1);
    z-index: 20;
    /* A host with many packs lists every `/pack run <name>`; keep it on screen. */
    max-height: min(50vh, 320px);
    overflow-y: auto;
  }
  .c-menu-row {
    display: flex;
    gap: 10px;
    width: 100%;
    padding: 3px 8px;
    align-items: baseline;
  }
  .c-menu-row.cursor {
    background: var(--fg);
    color: var(--bg);
  }
  .c-menu-row.cursor .st-accent,
  .c-menu-row.cursor .dim {
    color: var(--bg);
  }
  .c-cur {
    color: var(--cyan);
    width: 12px;
    flex-shrink: 0;
  }
  .c-menu-row.cursor .c-cur {
    color: var(--bg);
  }
  .st-accent {
    color: var(--cyan);
  }
  .dim {
    color: var(--dim);
  }
  @media (max-width: 560px) {
    .c-row {
      gap: 6px;
    }
    .c-side {
      gap: 8px;
    }
    .c-side .act {
      font-size: 11px;
    }
  }
</style>
