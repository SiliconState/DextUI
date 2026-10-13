<script lang="ts">
  // Page tools. Websites open in the person's own browser (their logins, their
  // extensions, no automation flags). Float keeps a small DextUI on top while
  // they browse. Preview frames a loopback dev server only after the host has
  // read its headers and found that it allows framing. No proxying, no remote
  // browser and no attempt to get past any site's protections.
  import { onDestroy, tick, mount, unmount } from "svelte";
  import type { SessionStore } from "@dextui/client";
  import { app } from "../../lib/state.svelte";
  import { browserTools, closeBrowserTools, closePreview, floatDocument, floatSupported, setFloatWindow, endFloat } from "./state.svelte";
  import { previewCandidate, recentWebLinks, webAddress } from "./policy";
  import { useSession } from "../../lib/useSession.svelte";
  import { useDialog } from "../../lib/dialog.svelte";
  import { popoverPos } from "../../lib/popover";
  import FloatPanel from "./FloatPanel.svelte";

  let { store, blocked = false }: { store: SessionStore | null; blocked?: boolean } = $props();
  const sess = useSession(() => (browserTools.open ? store : null));
  let error = $state("");
  let checking = $state(false);
  let narrow = $state(matchMedia("(max-width: 900px)").matches);
  let geometry = $state(0);
  let frameRevision = $state(0);
  let request = 0;
  let abort: AbortController | null = null;
  const dlg = useDialog(() => browserTools.open, () => document.querySelector<HTMLElement>(narrow ? '[data-agent-id="composer.attach.menu"]' : '[data-agent-id="browser.open"]'));
  const links = $derived(browserTools.open ? recentWebLinks(sess.view?.blocks ?? []) : []);
  const url = $derived.by(() => { try { return webAddress(browserTools.address); } catch { return ""; } });
  const canPreview = $derived(!!url && previewCandidate(url, location.href) && !narrow);
  const canFloat = $derived(!narrow && !!store && floatSupported());
  const position = $derived.by(() => {
    void geometry;
    const rect = document.querySelector('[data-agent-id="browser.open"]')?.getBoundingClientRect();
    return popoverPos(rect && rect.width ? { top: rect.top, bottom: rect.bottom, right: innerWidth - rect.right } : null, 340, 8, 520);
  });

  $effect(() => {
    const media = matchMedia("(max-width: 900px)");
    const change = () => { narrow = media.matches; geometry++; if (narrow) { closePreview(); endFloat(); } };
    media.addEventListener("change", change);
    window.addEventListener("resize", change);
    return () => { media.removeEventListener("change", change); window.removeEventListener("resize", change); };
  });
  // Another modal (runtime form, Finder…) or sign-out takes over: step aside.
  $effect(() => {
    if (blocked || app.needsToken) closeBrowserTools();
    if (app.needsToken) { closePreview(); endFloat(); }
  });
  $effect(() => {
    if (!browserTools.open) { request++; abort?.abort(); checking = false; error = ""; }
  });
  $effect(() => {
    const theme = app.resolvedTheme;
    const doc = floatDocument();
    if (doc) { doc.documentElement.dataset.theme = theme; }
  });
  onDestroy(() => { abort?.abort(); endFloat(); });

  async function preview() {
    if (!canPreview || checking) return;
    const chosen = url, id = ++request;
    checking = true; error = ""; abort?.abort(); abort = new AbortController();
    try {
      const token = localStorage.getItem("dextui.token") ?? "";
      const res = await fetch(`/preview/check?url=${encodeURIComponent(chosen)}`, { cache: "no-store", headers: { Authorization: `Bearer ${token}` }, signal: abort.signal });
      const out = await res.json().catch(() => ({})) as { allowed?: unknown; url?: unknown; message?: unknown };
      if (id !== request || !browserTools.open) return;
      if (!res.ok || out.allowed !== true || out.url !== chosen) {
        throw new Error(typeof out.message === "string" ? out.message : "This host cannot show a preview. Open the page in your browser instead.");
      }
      browserTools.preview = chosen;
      closeBrowserTools();
    } catch (e) {
      if (id === request && !(e instanceof DOMException && e.name === "AbortError")) error = e instanceof Error ? e.message : "The preview could not open.";
    } finally {
      if (id === request) checking = false;
    }
  }

  function copyStyles(target: Document) {
    for (const node of document.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style')) {
      if (node instanceof HTMLLinkElement) {
        const link = target.createElement("link");
        link.rel = "stylesheet";
        link.href = node.href; // absolute: the Float document has no useful base URL
        target.head.append(link);
      } else {
        target.head.append(node.cloneNode(true));
      }
    }
  }

  async function float() {
    if (!canFloat || browserTools.floating) return;
    error = "";
    let w: Window | null = null;
    try {
      const api = (window as unknown as { documentPictureInPicture: { requestWindow(opts: { width: number; height: number }): Promise<Window> } }).documentPictureInPicture;
      w = await api.requestWindow({ width: 380, height: 520 });
      const doc = w.document;
      doc.title = "DextUI";
      doc.documentElement.dataset.theme = app.resolvedTheme;
      copyStyles(doc);
      const target = doc.createElement("div");
      target.id = "app";
      doc.body.append(target);
      setFloatWindow(w);
      // The main composer unmounts (saving its draft) before the Float one
      // mounts and reads it: one draft writer per session at any time.
      browserTools.floating = true;
      closeBrowserTools();
      await tick();
      if (w.closed) { setFloatWindow(null); browserTools.floating = false; return; }
      const component = mount(FloatPanel, { target, props: { getStore: () => store, onReturn: () => { window.focus(); w?.close(); } } });
      const opened = w;
      opened.addEventListener("pagehide", () => {
        void unmount(component);
        if (floatDocument() === null || floatDocument() === opened.document) { setFloatWindow(null); browserTools.floating = false; }
      }, { once: true });
    } catch {
      w?.close();
      setFloatWindow(null);
      browserTools.floating = false;
      error = "Float could not open. It needs a current desktop Chrome or Edge.";
    }
  }

  function onKey(e: KeyboardEvent) {
    dlg.onKey(e);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeBrowserTools(); }
  }
  function pick(link: string) { browserTools.address = link; error = ""; document.getElementById("browser-address")?.focus(); }
</script>

{#if browserTools.open}
  <div class="browser-scrim" role="presentation" onclick={closeBrowserTools} onkeydown={() => {}} data-agent-id="browser.scrim"></div>
  <div class="browser-menu compact-popover" style={position} role="dialog" aria-modal="true" aria-label="Open a page" tabindex="-1" use:dlg.ref onkeydown={onKey} data-agent-id="browser.menu">
    <header>
      <h2>Open a page</h2>
      <button class="act close" aria-label="Close" data-agent-id="browser.menu.close" onclick={closeBrowserTools}>✕</button>
    </header>
    <label for="browser-address">Website or local dev server</label>
    <input id="browser-address" data-dialog-initial data-agent-id="browser.address" bind:value={browserTools.address} placeholder="example.com or localhost:5173" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false"
      oninput={() => { error = ""; }}
      onkeydown={(e) => { if (e.key === "Enter" && url) { e.preventDefault(); document.querySelector<HTMLAnchorElement>('[data-agent-id="browser.external"]')?.click(); } }} />
    <div class="browser-actions">
      {#if url}
        <a class="primary" data-agent-id="browser.external" href={url} target="_blank" rel="noopener noreferrer" onclick={closeBrowserTools}>Open in your browser ↗</a>
      {:else}
        <span class="primary disabled" aria-disabled="true">Open in your browser ↗</span>
      {/if}
      {#if canPreview}
        <button class="act accent" data-agent-id="browser.preview.open" disabled={checking} onclick={preview}>{checking ? "Checking…" : "Preview beside chat"}</button>
      {/if}
    </div>
    {#if error}<p role="alert" class="error" data-agent-id="browser.error">{error}</p>{/if}
    {#if links.length}
      <h3>From this conversation</h3>
      <div class="browser-links">
        {#each links as link (link)}<button data-agent-id="browser.recent" title={link} onclick={() => pick(link)}>{link}</button>{/each}
      </div>
    {/if}
    {#if canFloat}
      <div class="float-option">
        <button class="act accent" data-agent-id="browser.float.open" disabled={browserTools.floating} onclick={float}>{browserTools.floating ? "DextUI is floating" : "Float DextUI"}</button>
        <p>A small window with status, decisions and your message box stays on top while you browse.</p>
      </div>
    {/if}
    <p class="disclosure">Pages open in this device's browser with your own logins. DextUI does not drive, watch or proxy them.</p>
  </div>
{/if}

{#if browserTools.preview}
  <aside class="preview-panel" inert={blocked} aria-label="Local preview" data-agent-id="browser.preview">
    <header>
      <span class="preview-url" title={browserTools.preview}>{browserTools.preview}</span>
      <button class="act" data-agent-id="browser.preview.reload" onclick={() => frameRevision++}>Reload</button>
      <a class="act" href={browserTools.preview} target="_blank" rel="noopener noreferrer" data-agent-id="browser.preview.external" title="Open in your browser">↗<span class="sr-only">Open in your browser</span></a>
      <button class="act" data-agent-id="browser.preview.close" aria-label="Close preview" onclick={closePreview}>✕</button>
    </header>
    {#key `${browserTools.preview}:${frameRevision}`}
      <iframe src={browserTools.preview} title="Local preview" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" referrerpolicy="no-referrer" data-agent-id="browser.preview.frame"></iframe>
    {/key}
  </aside>
{/if}

<style>
  .browser-scrim { position: fixed; inset: 0; z-index: 36; }
  .browser-menu { position: fixed; z-index: 37; width: min(340px, calc(100vw - 24px)); display: flex; flex-direction: column; gap: 6px; padding: 10px; background: var(--bg3); color: var(--fg); border: 1px solid var(--line); border-radius: 3px; box-shadow: 0 8px 32px #0005; font: 13px/1.45 var(--sans); animation: fade-in 0.1s ease-out; }
  header { display: flex; align-items: center; gap: 8px; min-width: 0; }
  h2 { flex: 1; font-size: 13px; font-weight: 600; }
  h3 { margin-top: 6px; font-size: 11px; font-weight: 500; color: var(--faint); letter-spacing: 0.04em; }
  .close { min-width: 28px; min-height: 28px; text-align: center; }
  label { color: var(--faint); font-size: 11px; letter-spacing: 0.04em; }
  input { width: 100%; padding: 6px 8px; border: 1px solid var(--line); background: var(--bg1); color: var(--fg); font: 13px var(--mono); }
  input:focus-visible { border-color: var(--cyan); outline-offset: 0; }
  .browser-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  .primary { display: inline-flex; align-items: center; min-height: 30px; padding: 4px 10px; border: 1px solid var(--cyan); color: var(--cyan); text-decoration: none; }
  .primary:hover { background: color-mix(in srgb, var(--cyan) 12%, transparent); }
  .primary.disabled { border-color: var(--line); color: var(--faint); cursor: default; }
  .primary.disabled:hover { background: none; }
  .error { color: var(--red); }
  .browser-links { display: flex; flex-direction: column; }
  .browser-links button { padding: 4px 0; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px var(--mono); }
  .browser-links button:hover { color: var(--fg); }
  .float-option { display: flex; flex-direction: column; gap: 2px; padding-top: 8px; border-top: 1px solid var(--line); }
  .float-option button { align-self: flex-start; }
  p { color: var(--dim); }
  .disclosure { color: var(--faint); font-size: 11px; }
  .preview-panel { grid-area: preview; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--bg1); border-left: 1px solid var(--line); }
  .preview-panel header { min-height: 32px; padding: 0 8px; border-bottom: 1px solid var(--line); font: 12px/1.4 var(--sans); }
  .preview-url { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dim); font-family: var(--mono); }
  .preview-panel a { text-decoration: none; }
  iframe { flex: 1; width: 100%; min-height: 0; border: 0; background: var(--bg); }
  @media (max-width: 900px) {
    .preview-panel { display: none; }
    .browser-menu { font-size: 14px; }
    .browser-menu button, .browser-menu .primary { min-height: 44px; }
    .close { min-width: 44px; }
    input { min-height: 44px; font-size: 16px; }
  }
</style>
