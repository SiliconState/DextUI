<script lang="ts">
  import { onMount } from "svelte";
  import { closeBrowser } from "../lib/browser.svelte";
  import { boundedResponseText } from "../lib/files";
  let { suspended = false }: { suspended?: boolean } = $props();
  let phase = $state("idle");
  let notice = $state("");
  let address = $state("");
  let currentURL = $state("");
  let title = $state("");
  let back = $state(false), forward = $state(false), loading = $state(false);
  let width = $state(1100), height = $state(760), viewportHeight = $state(760);
  let canvas: HTMLCanvasElement;
  let viewport: HTMLDivElement;
  let dialog = $state<{ kind: string; message: string; defaultPrompt: string } | null>(null);
  let prompt = $state("");
  let paste = $state("");
  let socket: WebSocket | null = null;
  let generation = 0;
  let abort: AbortController | null = null;
  let resizeTimer: ReturnType<typeof setTimeout>;
  let startTimer: ReturnType<typeof setTimeout>;
  let lastViewport = "";
  let moveFrame = 0;
  let pendingMove: Record<string, unknown> | null = null;
  // Trackpads emit wheel events faster than the host's per-second message
  // budget; accumulate deltas and send at most one wheel per frame.
  let pendingWheel: { type: string; kind: string; x: number; y: number; dx: number; dy: number; modifiers: number } | null = null;
  let wheelFrame = 0;
  // PointerEvent.detail is 0 in browsers, so count clicks for remote dblclick.
  let lastPress = { at: 0, x: 0, y: 0, button: -1, count: 0 };
  let composing = false;
  const externalURL = $derived(/^https?:\/\//i.test(currentURL) ? currentURL : "");

  function send(message: Record<string, unknown>) {
    if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 32768) socket.send(JSON.stringify(message));
  }
  function flushWheel() {
    cancelAnimationFrame(wheelFrame); wheelFrame = 0;
    if (pendingWheel) send(pendingWheel);
    pendingWheel = null;
  }
  function resetInput() {
    cancelAnimationFrame(moveFrame); moveFrame = 0; pendingMove = null;
    cancelAnimationFrame(wheelFrame); wheelFrame = 0; pendingWheel = null;
    composing = false;
    if (phase === "live") send({ type: "resetInput" });
  }
  function end() {
    generation++;
    clearTimeout(startTimer); clearTimeout(resizeTimer);
    resetInput();
    abort?.abort(); abort = null;
    send({ type: "close" }); socket?.close(); socket = null;
    lastViewport = "";
    phase = "idle"; dialog = null;
  }
  function close() { end(); closeBrowser(); }
  async function start() {
    end(); const run = generation;
    phase = "starting"; notice = ""; currentURL = ""; title = ""; address = ""; back = false; forward = false;
    abort = new AbortController();
    startTimer = setTimeout(() => {
      if (run !== generation || phase !== "starting") return;
      end(); notice = "Browser start timed out. Check the host and try again.";
    }, 20000);
    try {
      const res = await fetch("/browser/ticket", { method: "POST", headers: { authorization: `Bearer ${localStorage.getItem("dextui.token") ?? ""}` }, signal: abort.signal });
      if (run !== generation) return;
      const raw = await boundedResponseText(res, 8192);
      if (run !== generation) return;
      let data; try { data = JSON.parse(raw); } catch { throw new Error("This host does not support Browser yet. Update and restart agentlinkd."); }
      if (!res.ok) throw new Error(data.error || "Could not open browser.");
      if (!/^[a-f0-9]{48}$/.test(data.ticket)) throw new Error("Invalid browser ticket.");
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/browser/stream`, `dext-browser.${data.ticket}`);
      socket = ws; ws.binaryType = "arraybuffer";
      ws.onmessage = async event => {
        if (run !== generation) return;
        if (event.data instanceof ArrayBuffer) {
          if (event.data.byteLength < 5) return;
          const id = new DataView(event.data).getUint32(0);
          // Always ACK, including skipped frames, or host delivery stalls.
          if (event.data.byteLength > 4 * 1024 * 1024) { send({ type: "ack", id }); return; }
          let image: ImageBitmap | undefined;
          try {
            image = await createImageBitmap(new Blob([event.data.slice(4)], { type: "image/jpeg" }));
            if (run !== generation || !canvas) return;
            if (canvas.width !== image.width || canvas.height !== image.height) { canvas.width = image.width; canvas.height = image.height; }
            canvas.getContext("2d", { alpha: false })?.drawImage(image, 0, 0);
          } catch { if (run === generation) notice = "Could not decode browser frame."; }
          finally { image?.close(); if (run === generation) send({ type: "ack", id }); }
          return;
        }
        let m; try { m = JSON.parse(event.data); } catch { return; }
        if (m.type === "ping") { send({ type: "pong" }); return; }
        if (m.type === "ready") { clearTimeout(startTimer); phase = "live"; resize(); visibility(); }
        if (m.type === "ready" || m.type === "size") { width = m.width; height = m.height; }
        if (m.type === "state") {
          currentURL = m.url; title = m.title; back = m.back; forward = m.forward; loading = m.loading;
          if (document.activeElement?.getAttribute("data-agent-id") !== "browser.address") address = m.url === "about:blank" ? "" : m.url;
        }
        if (m.type === "error" || m.type === "notice") notice = m.message;
        if (m.type === "dialog") { dialog = m; prompt = m.defaultPrompt; }
        if (m.type === "dialogClosed") dialog = null;
      };
      ws.onclose = () => { if (run === generation) { end(); notice ||= "Browser closed. Temporary cookies and page state were discarded."; } };
      ws.onerror = () => { if (run === generation) notice = "Browser connection failed. Check the host and try again."; };
    } catch (e) { if (run === generation) { end(); notice = e instanceof Error ? e.message : "Browser failed to start."; } }
  }
  function navigate(event: SubmitEvent) { event.preventDefault(); notice = ""; send({ type: "navigate", url: address.trim() }); canvas?.focus(); }
  function visibility() {
    if (phase !== "live") return;
    const visible = !document.hidden && !suspended;
    if (!visible) resetInput();
    send({ type: "visible", value: visible, hidden: document.hidden });
  }
  $effect(() => { void suspended; visibility(); });
  function resize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!viewport || phase !== "live") return;
      viewportHeight = viewport.clientHeight;
      const nextWidth = Math.min(1600, Math.max(360, Math.round(viewport.clientWidth)));
      const nextHeight = Math.min(1200, Math.max(240, Math.round(viewport.clientHeight)));
      const size = `${nextWidth}x${nextHeight}`;
      if (size === lastViewport) return;
      lastViewport = size;
      send({ type: "resize", width: nextWidth, height: nextHeight });
    }, 180);
  }
  onMount(() => {
    const observer = new ResizeObserver(resize); observer.observe(viewport);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("blur", resetInput);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("blur", resetInput); end(); };
  });
  function mods(e: MouseEvent | KeyboardEvent) { return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0); }
  function position(e: MouseEvent) { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * width / r.width, y: (e.clientY - r.top) * height / r.height }; }
  function mouse(e: PointerEvent, kind: string) {
    if (phase !== "live" || suspended || document.hidden) return;
    e.preventDefault();
    if (kind === "mousePressed") {
      canvas.focus(); canvas.setPointerCapture(e.pointerId);
      const now = performance.now(), near = Math.hypot(e.clientX - lastPress.x, e.clientY - lastPress.y) < 5;
      const count = now - lastPress.at < 500 && near && e.button === lastPress.button ? Math.min(3, lastPress.count + 1) : 1;
      lastPress = { at: now, x: e.clientX, y: e.clientY, button: e.button, count };
    }
    const count = kind === "mouseMoved" ? 0 : lastPress.count || 1;
    const message = { type: "mouse", kind, ...position(e), button: ["left", "middle", "right"][e.button] ?? "none", buttons: e.buttons, count, modifiers: mods(e) };
    if (kind === "mouseMoved") {
      pendingMove = message;
      if (!moveFrame) moveFrame = requestAnimationFrame(() => { moveFrame = 0; if (pendingMove) send(pendingMove); pendingMove = null; });
    } else {
      flushWheel();
      cancelAnimationFrame(moveFrame); moveFrame = 0;
      if (pendingMove) send(pendingMove);
      pendingMove = null; send(message);
    }
  }
  function wheel(e: WheelEvent) {
    if (phase !== "live" || suspended || document.hidden) return;
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? height : 1;
    const at = position(e), modifiers = mods(e);
    if (pendingWheel && pendingWheel.modifiers === modifiers) {
      pendingWheel.dx += e.deltaX * scale; pendingWheel.dy += e.deltaY * scale;
      pendingWheel.x = at.x; pendingWheel.y = at.y;
    } else {
      flushWheel();
      pendingWheel = { type: "mouse", kind: "mouseWheel", ...at, dx: e.deltaX * scale, dy: e.deltaY * scale, modifiers };
    }
    if (!wheelFrame) wheelFrame = requestAnimationFrame(flushWheel);
  }
  function key(e: KeyboardEvent, kind: string) {
    // Let app shortcuts work when the remote page is not interactive.
    if (phase !== "live" || suspended || document.hidden) return;
    // While live, keys belong to the page; never trigger single-key app shortcuts.
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); canvas.blur(); return; } // escape from remote keyboard capture
    if (e.isComposing || composing) return;
    if ((e.ctrlKey || e.metaKey) && ["v", "c", "x", "l"].includes(e.key.toLowerCase())) return;
    e.preventDefault();
    send({ type: "key", kind, key: e.key, code: e.code, keyCode: e.keyCode, modifiers: mods(e) });
  }
</script>

<aside class="browser-pane" aria-label="Host browser" data-agent-id="browser.pane" inert={suspended}>
  <header><span>Browser <small>on your host · temporary</small></span><button class="act" onclick={close} data-agent-id="browser.close">Close</button></header>
  <form onsubmit={navigate} class="navigation">
    <button type="button" class="act" disabled={!back || phase !== "live"} onclick={() => send({ type: "back" })} aria-label="Back">‹</button>
    <button type="button" class="act" disabled={!forward || phase !== "live"} onclick={() => send({ type: "forward" })} aria-label="Forward">›</button>
    <button type="button" class="act" disabled={phase !== "live"} onclick={() => send({ type: loading ? "stop" : "reload" })} aria-label={loading ? "Stop loading" : "Reload"}>{loading ? "×" : "↻"}</button>
    <input bind:value={address} disabled={phase !== "live"} placeholder="Website or localhost:port" aria-label="Browser address" data-agent-id="browser.address" />
    <button class="act" disabled={phase !== "live"} type="submit">Go</button>
    {#if externalURL}<a href={externalURL} target="_blank" rel="noopener noreferrer" aria-label="Open externally in your regular browser" title="Open in your regular browser">↗</a>{/if}
  </form>
  {#if notice}<div class="notice" role="status">{notice}<button class="act" onclick={() => notice = ""} aria-label="Dismiss">×</button></div>{/if}
  {#if dialog}<section class="notice" aria-label="Website dialog"><p>{dialog.message}</p>{#if dialog.kind === "prompt"}<input aria-label="Website prompt response" bind:value={prompt} />{/if}<button class="act" onclick={() => { send({ type: "dialog", accept: true, text: prompt }); dialog = null; }}>OK</button><button class="act" onclick={() => { send({ type: "dialog", accept: false }); dialog = null; }}>Cancel</button></section>{/if}
  <div class="viewport" bind:this={viewport}>
    <!-- The streamed page is pixels, never executable DOM in the paired UI. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <canvas bind:this={canvas} tabindex={phase === "live" ? 0 : -1} aria-label="Remote browser page. Escape releases keyboard focus. Use Open externally for screen-reader access." style={`aspect-ratio:${width}/${height};width:min(100%,${viewportHeight * width / height}px)`} onpointerdown={e => mouse(e, "mousePressed")} onpointerup={e => mouse(e, "mouseReleased")} onpointermove={e => mouse(e, "mouseMoved")} onpointercancel={resetInput} onlostpointercapture={e => { if (e.buttons) resetInput(); }} onblur={resetInput} onwheel={wheel} oncontextmenu={e => e.preventDefault()} onkeydown={e => key(e, "keyDown")} onkeyup={e => key(e, "keyUp")} onpaste={e => { e.preventDefault(); send({ type: "text", text: e.clipboardData?.getData("text/plain").slice(0, 8192) ?? "" }); }} oncompositionstart={() => composing = true} oncompositionend={e => { composing = false; send({ type: "text", text: e.data }); }}></canvas>
    {#if phase !== "live"}<div class="empty"><h2>A little room for the web</h2><p>Browse beside your conversation using a separate browser session on your host. Your personal browser profile is never attached.</p><button class="act accent" disabled={phase === "starting"} onclick={start} data-agent-id="browser.start">{phase === "starting" ? "Starting browser…" : "Start browser"}</button><p class="faint">Uses installed Chrome, Edge, Brave or Chromium on the host. Nothing is downloaded. Close ends the session. No uploads, downloads, audio or shared logins.</p></div>{/if}
  </div>
  <footer><span title={title}>{title || "Private page content stays out of the chat journal"}</span><details><summary>Send text</summary><form onsubmit={e => { e.preventDefault(); send({ type: "text", text: paste }); paste = ""; }}><input aria-label="Text to insert into focused page field" bind:value={paste} maxlength="8192" /><button class="act" disabled={phase !== "live"}>Insert</button></form></details></footer>
</aside>

<style>
  .browser-pane { min-width:0; min-height:0; display:flex; flex-direction:column; height:100%; background:var(--bg); border-left:1px solid var(--line); }
  header, .navigation, footer { min-width:0; display:flex; align-items:center; gap:10px; padding:10px 12px; border-bottom:1px solid var(--line); flex:none; }
  header { justify-content:space-between; font-weight:600; } small { color:var(--dim); font-size:10px; font-weight:400; }
  .navigation input { min-width:0; flex:1; background:var(--bg1); color:var(--fg); border:1px solid var(--line); padding:7px; border-radius:4px; }
  .navigation .act { min-width:24px; } .notice { padding:10px 12px; background:var(--bg1); border-bottom:1px solid var(--line); overflow-wrap:anywhere; font-size:12px; } .notice > button { margin-left:10px; }
  .viewport { position:relative; min-height:0; flex:1; display:flex; align-items:center; justify-content:center; overflow:hidden; background:var(--bg1); }
  canvas { display:block; flex:none; max-width:100%; height:auto; object-fit:contain; touch-action:none; outline-offset:-2px; }
  .empty { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:32px; text-align:center; background:var(--bg); gap:16px; }
  h2 { font-size:17px; font-weight:500; } p { max-width:42ch; line-height:1.6; font-size:12px; }
  footer { position:relative; border-top:1px solid var(--line); border-bottom:0; font-size:10px; color:var(--dim); justify-content:space-between; } footer > span { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; } details { flex:none; } details form { position:absolute; bottom:100%; right:0; max-width:100%; display:flex; gap:8px; padding:8px; background:var(--bg1); border:1px solid var(--line); } details input { width:180px; min-width:0; }
  @media(max-width:900px) { .act { min-height:44px; } .navigation { gap:6px; padding:6px; } header { padding:4px 12px; } small { display:none; } input { font-size:16px; } }
</style>
