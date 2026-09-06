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

  // Pack attribution for a turn comes from its own journaled prompt: the host
  // accepts `/pack run <name>` only for catalog names, so the prefix is
  // authoritative and replays on old journals without a new event.
  const userPack = $derived(block.kind === "user" ? packOfPrompt(block.text) : null);
  const packMeta = $derived(block.kind === "view" ? app.packs.find((p) => p.name === block.pack) : undefined);

  function editPack(name: string) {
    const p = app.packs.find((x) => x.name === name);
    prefillComposer(`Edit the ${name} pack${p ? ` at ${p.path}` : ""}: `);
  }

  function forkPack(name: string) {
    const p = app.packs.find((x) => x.name === name);
    const shelf = p?.shelf ?? "mine";
    prefillComposer(`Make my own copy of the ${name} pack: run \`dext pack create ${shelf}/${name}-mine\`, copy the files from ${p?.path ?? `the ${name} pack directory`} into it (keep the original untouched), set name: ${name}-mine in PACK.md, then `);
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
</script>

{#if block.kind === "user"}
  <div class="b-user" data-agent-id="block.user" data-pack={userPack ?? undefined}>
    <span class="pg">❯</span>
    {#if userPack}<span class="pack-badge st-magenta" data-agent-id="block.user.pack" title="run through this pack">▣ {userPack}</span>{/if}
    <span class="b-user-text">{block.text}</span>
  </div>
{:else if block.kind === "text"}
  <!-- TUI idiom: a swim-lane card — `┌─ dext` label, body under a rail, `└` close.
       The rail is a CSS border (glyph gutters shred on wrap); the single-line
       header/footer glyphs are safe. -->
  <div class="b-text" data-agent-id="block.text" data-state={block.complete ? "complete" : "streaming"}>
    <div class="lane-head">
      <span class="faint">┌─</span>
      <span class="lane-name">dext</span>
      {#if !block.complete}<span class="st-blue pulse lane-live">●</span>{/if}
      <button class="act hover-act" data-agent-id="block.text.copy" onclick={() => copyText(block.text, "copied")}>copy</button>
    </div>
    <div class="lane-body">
      <Markdown src={block.text} {sessionId} />
      {#if !block.complete}<span class="blink cursor">▊</span>{/if}
    </div>
    <span class="faint lane-foot">└</span>
  </div>
{:else if block.kind === "thinking"}
  {#if block.complete}
    <details class="b-think done" data-agent-id="block.thinking" data-state="complete">
      <summary><span class="faint">▸ thinking ({block.text.split("\n").length} lines)</span></summary>
      <div class="think-body">
        {#each block.text.split("\n").filter((l) => l.trim()) as line, i (i)}
          <div class="think-line"><span class="t-marker">•</span> {line}</div>
        {/each}
      </div>
    </details>
  {:else}
    <div class="b-think live" data-agent-id="block.thinking" data-state="thinking">
      {#each block.text.split("\n").slice(-6) as line, i (i)}
        <div class="think-line"><span class="t-marker">•</span> {line}</div>
      {/each}
    </div>
  {/if}
{:else if block.kind === "tool"}
  <div class="tool" data-agent-id={`tool.${block.call_id}`} data-state={block.status}>
    <div class="tool-head">
      <span class="tool-name">{block.name}</span>
      <span class="faint">·</span>
      <span class="dim tool-summary">{block.summary}</span>
      <span class={`tool-status ${toolClass[block.status] ?? "st-faint"}`} data-agent-id={`tool.${block.call_id}.status`}>
        {toolLabel[block.status] ?? block.status}
      </span>
      {#if onInspect}
        <button class="act hover-act" data-agent-id={`tool.${block.call_id}.inspect`} onclick={() => onInspect?.(block)}>raw</button>
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
    <button class="act hover-act" data-agent-id="block.slash.copy" onclick={() => copyText(block.text, "copied")}>copy</button>
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
        <button class="act" data-agent-id={`view.${block.pack}.rerun`} onclick={() => prefillComposer(`/pack run ${block.pack} `)}>run again</button>
        <button class="act" data-agent-id={`view.${block.pack}.edit`} title={packMeta.path} onclick={() => editPack(block.pack)}>edit pack</button>
        <button class="act" data-agent-id={`view.${block.pack}.fork`} onclick={() => forkPack(block.pack)}>make my own</button>
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
    min-width: 0;
  }
  .lane-head {
    display: flex;
    gap: 6px;
    align-items: baseline;
    user-select: none;
    line-height: 1.2;
  }
  .lane-name {
    color: var(--blue);
    font-weight: bold;
  }
  .lane-live {
    font-size: 9px;
  }
  .lane-body {
    border-left: 1px solid var(--line);
    margin-left: 0.45ch;
    padding: 3px 0 3px 12px;
    min-width: 0;
  }
  .b-text:hover .lane-body {
    border-left-color: color-mix(in srgb, var(--blue) 45%, var(--line));
  }
  .lane-foot {
    display: block;
    line-height: 1;
    user-select: none;
  }
  .cursor {
    color: var(--green);
  }
  .hover-act {
    visibility: hidden;
    margin-left: 8px;
  }
  .b-text .hover-act {
    margin-left: auto;
  }
  .b-text:hover .hover-act,
  .tool:hover .hover-act,
  .b-slash:hover .hover-act {
    visibility: visible;
  }
  /* Thinking, as in the TUI: italic, dim, `•` markers on a tinted background —
     never a lane, never a rail, so it cannot be mistaken for the reply. */
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
  .think-body {
    background: var(--bg1);
    padding: 4px 8px;
  }
  .think-line {
    color: var(--dim);
    font-style: italic;
    font-size: 12.5px;
    white-space: pre-wrap;
  }
  .t-marker {
    color: var(--faint);
    font-style: normal;
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
    max-height: 20rem;
    overflow-y: auto;
    color: var(--dim);
    font-size: 12px;
    background: var(--bg1);
    padding: 4px 8px;
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
  .st-blue {
    color: var(--blue);
  }
  .dim {
    color: var(--dim);
  }
  .faint {
    color: var(--faint);
  }
</style>
