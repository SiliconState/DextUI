<script lang="ts">
  // Full-height right-side home for interactive HTML reports. File reports are
  // fetched by the trusted parent, then rendered as srcdoc: the sandbox never
  // receives the bearer query string. Chat keeps only its compact launcher.
  import { boundedResponseBlob, boundedResponseText } from "../lib/files";
  import { ARTIFACT_STATE_MAX, artifactStateName, validateArtifactState, validateStateReceipt } from "../lib/artifact-state";
  import { app, currentResolvedTheme } from "../lib/state.svelte";
  import { artifact, closeArtifact } from "../lib/artifact.svelte";
  import { useDialog } from "../lib/dialog.svelte";

  const dlg = useDialog(() => !!artifact.document);
  let mode = $state<"report" | "code">("report");
  let reportHtml = $state("");
  let reportSource = $state("");
  let reportLoading = $state(false);
  let reportFailed = $state(false);
  let frame = $state<HTMLIFrameElement | null>(null);

  const item = $derived(artifact.document);
  let saveRequest = $state("");
  let pendingState = $state<string | null>(null);
  let saveBusy = $state(false);
  let saveNotice = $state("");
  let restoreBusy = $state(false);
  let restoreInput = $state<HTMLInputElement | undefined>();
  let requestTimer: ReturnType<typeof setTimeout> | undefined;
  let viewGeneration = 0;
  let requestDeadline = 0;
  let showFullState = $state(false);
  const canSave = $derived(!!item?.sessionId && app.caps.includes("files_write"));

  $effect(() => {
    artifact.revision;
    currentResolvedTheme();
    frame;
    viewGeneration++;
    showFullState = false;
    saveRequest = "";
    pendingState = null;
    saveNotice = "";
    clearTimeout(requestTimer);
    return () => clearTimeout(requestTimer);
  });

  function requestState() {
    if (!frame?.contentWindow || !canSave || saveBusy || restoreBusy || reportLoading || reportFailed || saveRequest || pendingState !== null) return;
    const requestId = crypto.randomUUID();
    saveRequest = requestId;
    requestDeadline = Date.now() + 5000;
    pendingState = null;
    saveNotice = "Waiting for report state…";
    frame.contentWindow.postMessage({ dextArtifact: "state.request", requestId }, "*");
    requestTimer = setTimeout(() => {
      if (saveRequest !== requestId) return;
      saveRequest = "";
      saveNotice = "Report did not provide state. It must support state.request.";
    }, 5000);
  }

  async function saveState() {
    const current = item;
    const text = pendingState;
    if (!current?.sessionId || !canSave || text === null || saveBusy) {
      saveNotice = "Cannot save: session or pending state unavailable.";
      return;
    }
    const revision = artifact.revision;
    const generation = viewGeneration;
    saveBusy = true;
    const ctl = new AbortController();
    const deadline = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(`/sessions/${encodeURIComponent(current.sessionId)}/upload?name=${encodeURIComponent(artifactStateName(current.name))}`, {
        method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: text, signal: ctl.signal,
      });
      const out = JSON.parse(await boundedResponseText(res, 8192));
      if (!res.ok) throw new Error(out.message || "Could not save state.");
      const savedPath = validateStateReceipt(out, new TextEncoder().encode(text).length);
      if (artifact.revision === revision && viewGeneration === generation) {
        pendingState = null;
        saveNotice = `Saved ${savedPath}`;
      }
    } catch (e) {
      if (artifact.revision === revision && viewGeneration === generation) saveNotice = ctl.signal.aborted
        ? "Save timed out; it may have reached disk. Check uploads before retrying."
        : `Save not confirmed: ${e instanceof Error ? e.message : "request failed"}. Snapshot retained for retry.`;
    } finally { clearTimeout(deadline); saveBusy = false; }
  }

  async function restoreState(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || restoreBusy || saveBusy || saveRequest || pendingState !== null || reportLoading || reportFailed) return;
    const target = frame;
    if (!target?.contentWindow) return;
    const revision = artifact.revision;
    const generation = viewGeneration;
    restoreBusy = true;
    try {
      if (file.size > ARTIFACT_STATE_MAX) throw new Error("State exceeds 1 MiB.");
      const json = validateArtifactState(await file.text());
      if (artifact.revision !== revision || viewGeneration !== generation || frame !== target) return;
      target.contentWindow?.postMessage({ dextArtifact: "state.restore", json }, "*");
      saveNotice = "State sent to report; restoration requires report support.";
    } catch (e) { if (artifact.revision === revision && viewGeneration === generation && frame === target) saveNotice = e instanceof Error ? e.message : "Invalid state."; }
    finally { restoreBusy = false; }
  }
  const source = $derived(item?.html ?? reportHtml);
  const codeText = $derived(item?.code ?? item?.html ?? reportSource);

  const authHeaders = (): HeadersInit => {
    const token = localStorage.getItem("dextui.token") ?? "";
    return token ? { authorization: `Bearer ${token}` } : {};
  };

  const REPORT_MAX_BYTES = 8 * 1024 * 1024;

  async function responseText(res: Response): Promise<string> {
    return boundedResponseText(res, REPORT_MAX_BYTES);
  }

  async function inlineReportImages(html: string, src: string, signal: AbortSignal): Promise<string> {
    const base = new URL(src, location.origin);
    const filePrefix = /^\/sessions\/[^/]+\/file\//.exec(base.pathname)?.[0];
    if (!filePrefix) return html;
    const token = base.searchParams.get("t");
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const refs = new Set<string>();
    const add = (raw: string | null) => {
      const value = raw?.trim();
      if (value && !value.startsWith("#") && !/^(?:data|blob):/i.test(value)) refs.add(value);
    };
    for (const el of parsed.querySelectorAll("img[src], input[type='image'][src]")) add(el.getAttribute("src"));
    for (const el of parsed.querySelectorAll("img[srcset], source[srcset]")) {
      const raw = el.getAttribute("srcset") ?? "";
      if (raw.includes("data:")) continue; // commas inside data URLs are not candidate separators
      for (const part of raw.split(",")) add(/^(\s*)(\S+)/.exec(part)?.[2] ?? null);
    }
    const css = [...parsed.querySelectorAll<HTMLElement>("[style]")].map((el) => el.getAttribute("style") ?? "")
      .concat([...parsed.querySelectorAll("style")].map((el) => el.textContent ?? ""));
    for (const text of css) for (const match of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(match[1] ?? null);

    const replacements = new Map<string, string>();
    let total = 0;
    for (const raw of [...refs].slice(0, 32)) {
      let url: URL;
      try { url = new URL(raw, base); } catch { continue; }
      if (url.origin !== location.origin || !url.pathname.startsWith(filePrefix)) continue;
      if (token) url.searchParams.set("t", token);
      try {
        const res = await fetch(url, { signal, headers: authHeaders() });
        if (!res.ok || !(res.headers.get("content-type") ?? "").toLowerCase().startsWith("image/")) continue;
        const blob = await boundedResponseBlob(res, 4 * 1024 * 1024);
        if (total + blob.size > 12 * 1024 * 1024) continue;
        total += blob.size;
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        replacements.set(raw, data);
      } catch {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      }
    }
    const replace = (raw: string): string => replacements.get(raw.trim()) ?? raw;
    for (const el of parsed.querySelectorAll("img[src], input[type='image'][src]")) {
      const raw = el.getAttribute("src");
      if (raw) el.setAttribute("src", replace(raw));
    }
    for (const el of parsed.querySelectorAll("img[srcset], source[srcset]")) {
      const raw = el.getAttribute("srcset");
      if (raw && !raw.includes("data:")) el.setAttribute("srcset", raw.split(",").map((part) => {
        const match = /^(\s*)(\S+)(.*)$/.exec(part);
        return match ? `${match[1]}${replace(match[2] ?? "")}${match[3]}` : part;
      }).join(","));
    }
    const replaceCss = (text: string): string => text.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (all, quote: string, raw: string) => {
      const hit = replacements.get(raw.trim());
      return hit ? `url(${quote}${hit}${quote})` : all;
    });
    for (const el of parsed.querySelectorAll<HTMLElement>("[style]")) el.setAttribute("style", replaceCss(el.getAttribute("style") ?? ""));
    for (const el of parsed.querySelectorAll("style")) el.textContent = replaceCss(el.textContent ?? "");
    return `<!doctype html>\n${parsed.documentElement.outerHTML}`;
  }

  // Fetch workspace reports outside the iframe. Besides giving file reports a
  // source view, this prevents untrusted report JS from seeing ?t=<token> in
  // location.href. A revision guards close/reopen and stale response races.
  $effect(() => {
    const revision = artifact.revision;
    const src = item?.src;
    mode = "report";
    reportHtml = "";
    reportSource = "";
    reportFailed = false;
    reportLoading = !!src;
    if (!src) return;
    const ctl = new AbortController();
    fetch(src, { signal: ctl.signal, headers: authHeaders() })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return responseText(res);
      })
      .then(async (text) => {
        const rendered = await inlineReportImages(text, src, ctl.signal);
        if (artifact.revision !== revision) return;
        reportSource = text;
        reportHtml = rendered;
        reportLoading = false;
      })
      .catch(() => {
        if (ctl.signal.aborted || artifact.revision !== revision) return;
        reportFailed = true;
        reportLoading = false;
      });
    return () => ctl.abort();
  });

  // CSP is parsed before any model-authored markup. Inline scripts/styles keep
  // self-contained reports interactive, while network, navigation, forms and
  // parent access stay unavailable in the opaque-origin sandbox.
  const doc = $derived.by(() => {
    if (!source) return undefined;
    const theme = currentResolvedTheme();
    const fullDocument = /<html[\s>]/i.test(source);
    const shell = fullDocument
      ? source
      : `<!doctype html><html><head><style>body{margin:16px;font:13px/1.45 system-ui,sans-serif;color:light-dark(#242830,#c8cfd9);background:light-dark(#f4f2ec,#0b0d10)}:root[data-theme=dim] body{color:#cdd4de;background:#1b1f27}</style></head><body>${source}</body></html>`;
    const parsed = new DOMParser().parseFromString(shell, "text/html");
    parsed.documentElement.dataset.theme = theme;
    parsed.documentElement.style.colorScheme = theme === "light" ? "light" : "dark";

    const meta = parsed.createElement("meta");
    meta.httpEquiv = "Content-Security-Policy";
    meta.content = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; script-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'";
    const scheme = parsed.createElement("meta");
    scheme.name = "color-scheme";
    scheme.content = "light dark";
    const bridge = parsed.createElement("script");
    bridge.textContent = 'addEventListener("keydown",function(e){if(e.key==="Escape")parent.postMessage({dextArtifact:"close"},"*")},true)';
    parsed.head.prepend(meta, scheme, bridge);
    return `<!doctype html>\n${parsed.documentElement.outerHTML}`;
  });

  function downloadCopy() {
    const current = item;
    if (!current) return;
    const raw = current.html ?? reportSource;
    if (!raw) return;
    const url = URL.createObjectURL(new Blob([raw], { type: "text/html;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    const base = current.name.split(/[\\/]/).pop() || "report.html";
    link.download = /\.html?$/i.test(base) ? base : `${base}.html`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  $effect(() => {
    const el = frame;
    if (!el) return;
    const onMessage = (e: MessageEvent) => {
      if (frame !== el || e.source !== el.contentWindow) return;
      if (e.data?.dextArtifact === "close") closeArtifact();
      if (e.data?.dextArtifact !== "state.response" || !saveRequest || e.data.requestId !== saveRequest) return;
      saveRequest = "";
      clearTimeout(requestTimer);
      if (Date.now() > requestDeadline) {
        saveNotice = "Report state arrived too late. Request a fresh snapshot.";
        return;
      }
      showFullState = false;
      try {
        pendingState = validateArtifactState(e.data.json);
        saveNotice = "Review this data before saving. Only save state from reports you trust.";
      } catch { saveNotice = "Invalid report state: JSON object/array required, maximum 1 MiB."; }
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  });

  function onKey(e: KeyboardEvent) {
    dlg.onKey(e);
    if (e.key === "Escape") {
      closeArtifact();
      e.preventDefault();
      e.stopPropagation();
    }
  }
</script>

{#if item}
  <div class="insp-scrim" data-agent-id="artifact.scrim" onclick={closeArtifact} onkeydown={() => {}} role="presentation"></div>
  <div
    class="insp artifact-sheet"
    role="dialog"
    aria-modal="true"
    aria-labelledby="artifact-title"
    tabindex="-1"
    use:dlg.ref
    data-agent-id="artifact.overlay"
    data-state={reportFailed ? "failed" : reportLoading ? "loading" : mode}
    onkeydown={onKey}
  >
    <header class="insp-head">
      <span class="st-cyan">Interactive report</span>
      <span class="dim title" id="artifact-title" title={item.name}>{item.name}</span>
      <span class="insp-acts">
        <button class="act" class:on={mode === "report"} data-agent-id="artifact.report" onclick={() => (mode = "report")}>Report</button>
        <button class="act" class:on={mode === "code"} data-agent-id="artifact.code" disabled={reportLoading || reportFailed} onclick={() => (mode = "code")}>Code</button>
        <button class="act" data-agent-id="artifact.download" disabled={reportLoading || reportFailed} onclick={downloadCopy}>Download</button>
        <button class="act" data-agent-id="artifact.state.request" disabled={!canSave || reportLoading || reportFailed || saveBusy || restoreBusy || !!saveRequest || pendingState !== null} onclick={requestState}>Save state</button>
        <button class="act" disabled={reportLoading || reportFailed || saveBusy || restoreBusy || !!saveRequest || pendingState !== null} onclick={() => restoreInput?.click()}>Restore state</button>
        <input hidden bind:this={restoreInput} data-agent-id="artifact.state.file" type="file" accept=".json,application/json" onchange={restoreState} />
        <button class="act" data-agent-id="artifact.close" data-dialog-initial onclick={closeArtifact}>esc</button>
      </span>
    </header>
    {#if saveNotice || saveBusy || pendingState !== null}
      <section class="save-state" aria-live="polite" data-agent-id="artifact.state.status">
        <span>{saveBusy ? "Saving…" : saveNotice}</span>
        {#if pendingState !== null}
          <p>New file: uploads/{artifactStateName(item.name)} · {new TextEncoder().encode(pendingState).length} bytes. Never overwrites existing files.</p>
          <pre>{showFullState ? pendingState : pendingState.slice(0, 2000)}{!showFullState && pendingState.length > 2000 ? "\n… preview truncated" : ""}</pre>
          {#if pendingState.length > 2000}<button class="act" onclick={() => (showFullState = !showFullState)}>{showFullState ? "Short preview" : "Review full JSON"}</button>{/if}
          <button class="act" data-agent-id="artifact.state.confirm" disabled={saveBusy} onclick={saveState}>Save JSON to workspace</button>
          <button class="act" disabled={saveBusy} onclick={() => { pendingState = null; saveNotice = "Save cancelled."; }}>Cancel</button>
        {/if}
      </section>
    {/if}
    <div class="body">
      {#if reportLoading}
        <p class="state dim pulse" data-agent-id="artifact.loading">Loading report…</p>
      {:else if reportFailed}
        <p class="state st-red" data-agent-id="artifact.error">Could not load this report from the session workspace.</p>
      {:else}
        <div class="report" class:hidden={mode === "code"}>
          {#key `${artifact.revision}\u001f${currentResolvedTheme()}`}
            <iframe bind:this={frame} sandbox="allow-scripts" title={item.name} srcdoc={doc} onload={() => frame?.contentWindow?.postMessage({ theme: currentResolvedTheme() }, "*")} data-agent-id="artifact.frame"></iframe>
          {/key}
        </div>
        {#if mode === "code"}<pre data-agent-id="artifact.source">{codeText}</pre>{/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .save-state { flex: none; max-height: 40vh; overflow: auto; padding: 10px 16px; border-bottom: 1px solid var(--line); font-size: 12px; }
  .save-state pre { margin: 8px 0; padding: 8px; max-height: 100px; height: auto; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
  .save-state .act { margin-right: 16px; }
  .artifact-sheet {
    width: min(76rem, 96vw);
  }
  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .insp-acts {
    display: flex;
    gap: 12px;
    align-items: baseline;
    flex: none;
    flex-wrap: wrap;
  }
  .act.on {
    color: var(--fg);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .body {
    flex: 1;
    min-height: 0;
    background: var(--bg);
  }
  .report {
    width: 100%;
    height: 100%;
  }
  .report.hidden {
    display: none;
  }
  iframe {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    background: var(--bg);
    color-scheme: inherit;
  }
  .state {
    padding: 16px;
  }
  .body > pre {
    width: 100%;
    height: 100%;
    overflow: auto;
    padding: 12px 14px;
    color: var(--dim);
    background: var(--bg1);
    font-size: 11.5px;
    line-height: 1.45;
    white-space: pre;
  }
  @media (max-width: 700px) {
    .artifact-sheet {
      width: 100vw;
    }
    .insp-head {
      flex-wrap: wrap;
    }
    .title {
      order: 3;
      width: 100%;
    }
  }
</style>
