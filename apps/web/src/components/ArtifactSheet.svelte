<script lang="ts">
  // Full-height right-side home for interactive HTML reports. File reports are
  // fetched by the trusted parent, then rendered as srcdoc: the sandbox never
  // receives the bearer query string. Chat keeps only its compact launcher.
  import { boundedResponseBlob, boundedResponseText } from "../lib/files";
  import { currentResolvedTheme } from "../lib/state.svelte";
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
      if (e.source === el.contentWindow && e.data?.dextArtifact === "close") closeArtifact();
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
        <button class="act" data-agent-id="artifact.close" data-dialog-initial onclick={closeArtifact}>esc</button>
      </span>
    </header>
    <div class="body">
      {#if reportLoading}
        <p class="state dim pulse" data-agent-id="artifact.loading">Loading report…</p>
      {:else if reportFailed}
        <p class="state st-red" data-agent-id="artifact.error">Could not load this report from the session workspace.</p>
      {:else}
        <div class="report" class:hidden={mode === "code"}>
          {#key `${artifact.revision}\u001f${currentResolvedTheme()}`}
            <iframe bind:this={frame} sandbox="allow-scripts" title={item.name} srcdoc={doc} data-agent-id="artifact.frame"></iframe>
          {/key}
        </div>
        {#if mode === "code"}<pre data-agent-id="artifact.source">{codeText}</pre>{/if}
      {/if}
    </div>
  </div>
{/if}

<style>
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
  pre {
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
