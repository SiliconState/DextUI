<script lang="ts">
  // Transcript blocks: terminal chrome (❯, status glyphs, rails) around
  // web-native content (real markdown, scrollable raw output). Structure rails
  // are CSS borders, never literal glyphs — glyph gutters shred when lines wrap.
  import type { ViewBlock as Block } from "@dextui/client";
  import { app, copyText, packOfPrompt, prefillComposer } from "../lib/state.svelte";
  import { fileUrl, htmlPathIn } from "../lib/files";
  import { prettyPath } from "../lib/markdown";
  import Markdown from "./Markdown.svelte";
  import Diff from "./Diff.svelte";
  import HtmlArtifact from "./HtmlArtifact.svelte";

  let { block, onInspect, sessionId = "" }: { block: Block; onInspect?: (b: Block) => void; sessionId?: string } = $props();

  // A successful write/edit whose summary names an .html file gets a live
  // preview card, so a generated dashboard shows up without a follow-up link.
  const WRITER = /write|edit|create|save|patch/i;
  const sessCwd = $derived(app.sessions.find((s) => s.id === sessionId)?.cwd ?? "");
  const htmlOut = $derived.by(() => {
    if (block.kind !== "tool" || block.status !== "ok" || !sessionId || !app.caps.includes("files_read")) return null;
    if (!WRITER.test(block.name)) return null;
    return htmlPathIn(block.summary);
  });

  function looksLikeDiff(t: string): boolean {
    return /^[-+]{3} |^@@ |^diff --git /m.test(t);
  }

  // Pack attribution: dext's `pack_start` stamps the turn's prompt block (the
  // fold does it), which is exact even when dext inferred the pack from plain
  // text. Older journals fall back to the `/pack run <name>` prefix, which the
  // host only ever accepts for catalog names.
  const userPack = $derived(block.kind === "user" ? (block.pack ?? packOfPrompt(block.text)) : null);
  const packMeta = $derived(block.kind === "view" ? app.packs.find((p) => p.name === block.pack) : undefined);

  function editPack(name: string) {
    const p = app.packs.find((x) => x.name === name);
    prefillComposer(`Edit the ${name} pack${p ? ` at ${p.path}` : ""}: `);
  }

  /** Deterministic fork through dext (`pack create --from`): the host copies
   *  the files, rewrites `name:` and refreshes the catalog; nothing is
   *  delegated to the model. Shelf `mine` keeps copies out of the originals'
   *  shelves. */
  function forkPack(name: string) {
    const sid = app.activeId;
    const cmd = `/pack create mine/${name}-mine --from ${name}`;
    if (app.conn && sid) app.conn.slash(sid, cmd);
    else prefillComposer(cmd);
  }

  const markerGlyph: Record<string, string> = {
    info: "·",
    note: "•",
    warn: "⚠",
    error: "✗",
  };
  const markerClass: Record<string, string> = {
    info: "st-faint",
    note: "st-cyan",
    warn: "st-yellow",
    error: "st-red",
  };

  const toolLabel: Record<string, string> = {
    preview: "… planned",
    running: "● running",
    ok: "✓ ok",
    failed: "✗ failed",
  };
  const toolClass: Record<string, string> = {
    preview: "st-yellow",
    running: "st-cyan pulse",
    ok: "st-green",
    failed: "st-red",
  };

  function tailLines(t: string): string {
    return t.split("\n").slice(-8).join("\n");
  }

  // Thinking is continuous reasoning, not a list — providers wrap it at
  // arbitrary newlines, so per-line bullets landed mid-sentence. Paragraphs
  // come from blank lines; soft wraps rejoin into sentences; explicit list
  // items ("- "/"1. ") keep their own line (rendered via pre-line).
  function thinkParas(t: string): string[] {
    return (t ?? "")
      .split(/\n\s*\n+/)
      .map((para) => {
        let out = "";
        for (const raw of para.split("\n")) {
          const line = raw.trim();
          if (!line) continue;
          out = out ? (/^([-*+]|\d+[.)])\s/.test(line) ? `${out}\n${line}` : `${out} ${line}`) : line;
        }
        return out;
      })
      .filter(Boolean);
  }
  const thinkWords = $derived(
    block.kind === "thinking" ? (block.text.trim().match(/\S+/g) ?? []).length : 0,
  );
  // Live: one flowing tail of the current thought, whitespace collapsed —
  // reads like the model's train of thought, not a stack of fragments.
  const thinkTail = $derived.by(() => {
    if (block.kind !== "thinking") return "";
    const t = (block.text ?? "").replace(/\s+/g, " ").trim();
    return t.length > 280 ? `… ${t.slice(-280)}` : t;
  });
  // Duration from the envelope timestamps the store stamps on the stream —
  // no host change needed. Sealed-without-complete blocks simply lack it.
  const thinkDur = $derived.by(() => {
    if (block.kind !== "thinking" || !block.complete) return "";
    const { startedAt, endedAt } = block;
    if (!startedAt || !endedAt || endedAt - startedAt < 1000) return "";
    return ` · ${Math.round((endedAt - startedAt) / 1000)}s`;
  });
</script>

{#if block.kind === "user"}
  <div class="b-user" data-agent-id="block.user" data-pack={userPack ?? undefined}>
    <span class="pg">❯</span>
    {#if userPack}<span class="pack-badge st-magenta" data-agent-id="block.user.pack" title="Run through this pack">▣ {userPack}</span>{/if}
    <span class="b-user-text">{block.text}</span>
  </div>
{:else if block.kind === "text"}
  <div class="b-text" data-agent-id="block.text">
    <Markdown src={block.text} {sessionId} />
    {#if !block.complete}<span class="blink cursor">▊</span>{/if}
    <button class="act hover-act" data-agent-id="block.text.copy" onclick={() => copyText(block.text, "Copied")}>Copy</button>
  </div>
{:else if block.kind === "thinking"}
  {#if block.complete}
    <details class="b-think done" data-agent-id="block.thinking" data-state="complete">
      <summary><span class="faint">▸ thinking · {thinkWords} words{thinkDur}</span></summary>
      <div class="think-body">
        {#each thinkParas(block.text) as p, i (i)}
          <p class="think-p">{p}</p>
        {/each}
      </div>
    </details>
  {:else}
    <details class="b-think live" open data-agent-id="block.thinking" data-state="thinking">
      <summary><span class="faint">▾ thinking · streaming…</span></summary>
      <p class="think-p stream"><span class="think-dots" aria-hidden="true"><span class="d"></span><span class="d"></span><span class="d"></span></span>{thinkTail}</p>
    </details>
  {/if}
{:else if block.kind === "tool"}
  <div class="tool" data-agent-id={`tool.${block.call_id}`} data-state={block.status}>
    <div class="tool-head">
      <span class="tool-name">{block.name}</span>
      <span class="faint">·</span>
      <span class="dim tool-summary" class:cmd={/bash|shell/i.test(block.name)}>{block.summary}</span>
      <span class={`tool-status ${toolClass[block.status] ?? "st-faint"}`} data-agent-id={`tool.${block.call_id}.status`}>
        {toolLabel[block.status] ?? block.status}
      </span>
      {#if onInspect}
        <button class="act hover-act" data-agent-id={`tool.${block.call_id}.inspect`} onclick={() => onInspect?.(block)}>Raw</button>
      {/if}
    </div>
    {#if block.output_tail}
      {#if looksLikeDiff(block.output_tail)}
        <Diff text={block.output_tail} />
      {:else}
        <pre class="tool-pre" data-agent-id={`tool.${block.call_id}.tail`}>{tailLines(block.output_tail)}</pre>
      {/if}
    {/if}
    {#if block.content}
      <details class="tool-full">
        <summary><span class="faint">▸ output ({block.content.split("\n").length} lines)</span></summary>
        {#if looksLikeDiff(block.content)}
          <Diff text={block.content} />
        {:else}
          <pre class="tool-pre" data-agent-id={`tool.${block.call_id}.content`}>{block.content}</pre>
        {/if}
      </details>
    {/if}
    {#if htmlOut}
      <div class="tool-artifact" data-agent-id={`tool.${block.call_id}.artifact`}>
        <HtmlArtifact src={fileUrl(sessionId, htmlOut, sessCwd)} name={prettyPath(htmlOut, sessCwd)} />
      </div>
    {/if}
  </div>
{:else if block.kind === "marker"}
  <div class={`b-marker ${markerClass[block.level] ?? "st-faint"}`} data-agent-id="block.marker">
    {markerGlyph[block.level] ?? "·"} {block.text}
  </div>
{:else if block.kind === "slash"}
  <div class="b-slash" data-agent-id="block.slash">
    <pre class="slash-pre">{block.text}</pre>
    <button class="act hover-act" data-agent-id="block.slash.copy" onclick={() => copyText(block.text, "Copied")}>Copy</button>
  </div>
{:else if block.kind === "view"}
  <div class="tool view" data-agent-id={`view.${block.pack}`}>
    <div class="tool-head">
      <span class="st-magenta">▣ {block.pack}</span>
      <span class="faint">·</span>
      <span class="dim tool-summary">{block.title}</span>
    </div>
    <div class="view-body">
      <Markdown src={block.markdown} sessionId={sessionId} />
    </div>
    {#if packMeta}
      <div class="view-foot" data-agent-id={`view.${block.pack}.actions`}>
        <button class="act" data-agent-id={`view.${block.pack}.rerun`} onclick={() => prefillComposer(`/pack run ${block.pack} `)}>Run again</button>
        <button class="act" data-agent-id={`view.${block.pack}.edit`} title={packMeta.path} onclick={() => editPack(block.pack)}>Edit pack</button>
        <button class="act" data-agent-id={`view.${block.pack}.fork`} onclick={() => forkPack(block.pack)}>Make my own</button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .pg {
    color: var(--green);
    font-weight: bold;
    user-select: none;
  }
  .b-user {
    width: 100%;
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  .b-user-text {
    white-space: pre-wrap;
    color: var(--fg);
  }
  .pack-badge {
    flex-shrink: 0;
    font-size: 11px;
    border: 1px solid var(--line);
    padding: 0 5px;
  }
  .view-foot {
    display: flex;
    gap: 12px;
    padding: 4px 8px 6px;
    border-top: 1px solid var(--line);
    font-size: 11px;
  }
  .b-text {
    position: relative;
    width: 100%;
  }
  .cursor {
    color: var(--green);
  }
  .hover-act {
    visibility: hidden;
    margin-left: 8px;
  }
  .b-text .hover-act {
    position: absolute;
    top: 0;
    right: 0;
  }
  .b-text:hover .hover-act,
  .tool:hover .hover-act,
  .b-slash:hover .hover-act {
    visibility: visible;
  }
  .b-think {
    width: 100%;
  }
  .b-think.live {
    background: var(--bg1);
    padding: 4px 8px;
  }
  .b-think.done summary {
    cursor: pointer;
    user-select: none;
    list-style: none;
  }
  .b-think.done summary::-webkit-details-marker {
    display: none;
  }
  .b-think.done[open] summary {
    margin-bottom: 2px;
  }
  .b-think.live summary {
    cursor: pointer;
    user-select: none;
    list-style: none;
  }
  .b-think.live summary::-webkit-details-marker {
    display: none;
  }
  .think-body {
    background: var(--bg1);
    padding: 4px 10px 6px;
    display: grid;
    gap: 6px;
  }
  /* Thinking is prose, not a list: quiet italic text. */
  .think-p {
    margin: 0;
    color: var(--dim);
    font-style: italic;
    line-height: 1.55;
    white-space: pre-line; /* explicit list items keep their line */
  }
  .think-p.stream {
    color: var(--dim);
  }
  /* Streaming thought indicator: three dots pulsing in sequence —
     "working on it" in terminal language, borrowed from no one. */
  .think-dots {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-right: 6px;
  }
  .think-dots .d {
    width: 3.5px;
    height: 3.5px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.25;
    animation: think-dot 1.2s ease-in-out infinite;
  }
  .think-dots .d:nth-child(2) { animation-delay: 0.2s; }
  .think-dots .d:nth-child(3) { animation-delay: 0.4s; }
  @keyframes think-dot {
    0%, 100% { opacity: 0.25; }
    50% { opacity: 1; }
  }
  /* Tool / pack cards: CSS rail, hover accent — never glyph gutters. */
  .tool {
    width: 100%;
    min-width: 0;
    border-left: 2px solid var(--line);
    padding: 2px 0 2px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    transition: border-color 0.12s ease-out;
  }
  .tool:hover {
    border-left-color: var(--cyan);
  }
  .tool[data-state="failed"] {
    border-left-color: color-mix(in srgb, var(--red) 55%, var(--line));
  }
  .tool.view {
    border-left-color: color-mix(in srgb, var(--magenta) 40%, var(--line));
  }
  .tool-head {
    display: flex;
    gap: 6px;
    align-items: baseline;
  }
  /* For shell tools the summary *is* the command — set it in mono. */
  .tool-summary.cmd {
    font-family: var(--mono, monospace);
    color: var(--fg);
  }
  .tool-name {
    color: var(--cyan);
    font-weight: bold;
    flex-shrink: 0;
  }
  .tool-summary {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .tool-status {
    margin-left: auto;
    flex-shrink: 0;
  }
  .tool-pre {
    white-space: pre;
    overflow-x: auto;
    max-height: 14rem;
    overflow-y: auto;
    color: var(--dim);
    font-size: 12px;
    line-height: 1.5;
    background: var(--bg1);
    border: 1px solid var(--line);
    border-radius: 3px;
    padding: 6px 10px;
    margin: 3px 0 4px;
  }
  .tool-full summary {
    cursor: pointer;
    user-select: none;
    list-style: none;
  }
  .tool-full summary::-webkit-details-marker {
    display: none;
  }
  .tool-artifact {
    margin-top: 4px;
    max-width: 960px;
  }
  .view-body {
    width: 100%;
  }
  .b-marker {
    width: 100%;
    white-space: pre-wrap;
  }
  .b-slash {
    position: relative;
    width: 100%;
    min-width: 0;
    border-left: 2px solid color-mix(in srgb, var(--cyan) 35%, var(--line));
    padding-left: 10px;
  }
  .slash-pre {
    white-space: pre;
    overflow-x: auto;
    color: var(--dim);
    font-size: 12px;
  }
  .st-faint {
    color: var(--faint);
  }
  .st-cyan {
    color: var(--cyan);
  }
  .st-yellow {
    color: var(--yellow);
  }
  .st-red {
    color: var(--red);
  }
  .st-green {
    color: var(--green);
  }
  .st-magenta {
    color: var(--magenta);
  }
  .dim {
    color: var(--dim);
  }
  .faint {
    color: var(--faint);
  }
</style>
