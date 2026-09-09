<script lang="ts">
  // Transcript blocks: terminal chrome (❯, status glyphs, rails) around
  // web-native content (real markdown, scrollable raw output). Structure rails
  // are CSS borders, never literal glyphs — glyph gutters shred when lines wrap.
  import type { ViewBlock as Block } from "@dextui/client";
  import { app, copyText, packOfPrompt, prefillComposer } from "../lib/state.svelte";
  import { fmtTokens } from "../lib/markdown";
  import { humanizeTool, humanizeLabel, parseRunMeta, isBashAdvisory, looksLikeDiff, toolStatusDisplay } from "../lib/display";
  import { packForAuthMarker, openPackCredentials } from "../lib/packcreds.svelte";
  import Markdown from "./Markdown.svelte";
  import Diff from "./Diff.svelte";

  let { block, onInspect, sessionId = "" }: { block: Block; onInspect?: (b: Block) => void; sessionId?: string } = $props();
  let compactOpen = $state(false);

  // Pack attribution: dext's `pack_start` stamps the turn's prompt block (the
  // fold does it), which is exact even when dext inferred the pack from plain
  // text. Older journals fall back to the `/pack run <name>` prefix, which the
  // host only ever accepts for catalog names.
  const userPack = $derived(block.kind === "user" ? (block.pack ?? packOfPrompt(block.text)) : null);
  // A local_auth_prompt marker offers the credentials dialog for the pack it
  // belongs to (active pack when known, else name/tool/message inference).
  const authPack = $derived(block.kind === "marker" && block.auth ? packForAuthMarker(block.auth) : null);
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
  // Batch start markers carry "Batch: label · label · …"; the failure marker
  // ("Batch: N tool call(s) failed.") must never parse as a label list.
  function batchLabels(text: string): string[] | null {
    if (!text.startsWith("Batch: ")) return null;
    const rest = text.slice(7);
    return /^[a-z_][\w-]*: /i.test(rest) ? rest.split(" · ") : null;
  }
  function batchFail(text: string): number | null {
    const m = text.match(/^Batch: (\d+) tool call\(s\) failed\.?$/);
    return m ? Number(m[1]) : null;
  }
  const isShell = (n: string): boolean => /^(bash|sh|shell)$/i.test(n);
  const markerClass: Record<string, string> = {
    info: "st-faint",
    note: "st-cyan",
    warn: "st-yellow",
    error: "st-red",
  };
  // Core's run-status annotations ("[objective: … | checkpoints: …]",
  // "[phase:probe] note") render as quiet meta rows, not raw prose.
  const runMeta = $derived(block.kind === "marker" ? parseRunMeta(block.text) : null);

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
  // Live tail of the current thought. Truncation is silent and lands on a
  // word boundary — the rotating mark already says "in progress", so there
  // is no ellipsis beside it.
  const thinkTail = $derived.by(() => {
    if (block.kind !== "thinking") return "";
    const t = (block.text ?? "").replace(/\s+/g, " ").trim();
    if (t.length <= 560) return t;
    const cut = t.slice(-560);
    const sp = cut.indexOf(" ");
    return sp > 0 && sp < 40 ? cut.slice(sp + 1) : cut;
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
      <summary><span class="faint"><span class="caret" aria-hidden="true">▸</span> Thinking · {thinkWords} words{thinkDur}</span></summary>
      <div class="think-body">
        {#each thinkParas(block.text) as p, i (i)}
          <p class="think-p">{p}</p>
        {/each}
      </div>
    </details>
  {:else}
    <details class="b-think live" open data-agent-id="block.thinking" data-state="thinking">
      <summary><span class="faint"><span class="caret" aria-hidden="true">▸</span> Thinking</span> <span class="think-radar" aria-hidden="true"><span class="core"></span><span class="ring"></span><span class="ring r2"></span></span></summary>
      <p class="think-p stream">{thinkTail}</p>
    </details>
  {/if}
{:else if block.kind === "tool"}
  {@const status = toolStatusDisplay(block.name, block.status, block.content)}
  <div class="tool" data-agent-id={`tool.${block.call_id}`} data-state={block.status}>
    <div class="tool-head">
      <span class="tool-name">{block.name}</span>
      <span class="faint">·</span>
      <span class="dim tool-summary" class:cmd={isShell(block.name)}>{humanizeTool(block.name, block.summary)}</span>
      <span class={`tool-status ${status.className}`} data-agent-id={`tool.${block.call_id}.status`}>
        {status.label}
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
  </div>
{:else if block.kind === "compact"}
  <details class="b-compact" bind:open={compactOpen} data-agent-id="block.compact" data-state={block.status}>
    <summary>
      <span class={block.status === "failed" ? "st-red" : block.status === "running" ? "st-magenta pulse" : "st-cyan"}>
        {block.status === "running" ? "●" : block.status === "failed" ? "✗" : "✓"}
      </span>
      <span>{block.status === "running" ? "Compacting context…" : block.status === "failed" ? "Compaction failed" : block.before === 0 && block.after === 0 ? "Context already compact" : "Context compacted"}</span>
      {#if block.status === "complete" && block.before !== undefined && block.after !== undefined}
        <span class="faint">· {block.before} → {block.after} messages</span>
      {/if}
      {#if block.status === "complete" && block.contextTokens !== undefined}
        <span class="faint">· {fmtTokens(block.contextTokens)} context</span>
      {/if}
      {#if block.status !== "running"}<span class="faint compact-reveal">details</span>{/if}
    </summary>
    {#if compactOpen && block.summary}
      <div class="compact-detail" data-agent-id="block.compact.summary"><Markdown src={block.summary} {sessionId} /></div>
    {:else if compactOpen && block.message}
      <pre class="compact-error" data-agent-id="block.compact.error">{block.message}</pre>
    {/if}
  </details>
{:else if block.kind === "marker"}
  {#if block.level !== "error" && !block.auth && isBashAdvisory(block.text)}
    <details class="bash-advisory" data-agent-id="block.marker.advisory" data-state={block.level}>
      <summary>Bash guidance <span class="faint">· details</span></summary>
      <pre>{block.text}</pre>
    </details>
  {:else if batchLabels(block.text)}
    {@const labels = batchLabels(block.text)!}
    <details class="b-marker batch" data-agent-id="block.marker.batch" data-state={block.level}>
      <summary>
        <span class={markerClass[block.level] ?? "st-faint"}>{markerGlyph[block.level] ?? "•"}</span>
        <span class="dim">Batch · {labels.length} {labels.length === 1 ? "call" : "calls"}</span>
        <span class="dim batch-first">— {humanizeLabel(labels[0] ?? "")}</span>
        {#if labels.length > 1}<span class="faint">+{labels.length - 1} more</span>{/if}
        <span class="faint batch-raw">raw</span>
      </summary>
      <ul class="batch-list" data-agent-id="block.marker.batch.raw">
        {#each labels as l, i (i)}<li>{l}</li>{/each}
      </ul>
    </details>
  {:else if batchFail(block.text) !== null}
    {@const n = batchFail(block.text)!}
    <div class={`b-marker ${markerClass[block.level] ?? "st-faint"}`} data-agent-id="block.marker">
      {markerGlyph[block.level] ?? "⚠"} Batch · {n} {n === 1 ? "call" : "calls"} failed
    </div>
  {:else if runMeta}
    {@const meta = runMeta!}
    {#if meta.phase}
      <div class="b-meta phase" data-agent-id="block.marker.meta" data-state={block.level} title={block.text}>
        <span class="meta-k">phase</span>
        <span class="meta-pill">{meta.phase}</span>
        {#if meta.note}<span class="meta-note">— {meta.note}</span>{/if}
      </div>
    {:else}
      <details class="b-meta" data-agent-id="block.marker.meta" data-state={block.level}>
        <summary>
          <span class="meta-k">objective</span>
          <span class="meta-line">{meta.objective}</span>
          {#if meta.checkpoints.length}
            <span class="meta-count">· {meta.checkpoints.length} {meta.checkpoints.length === 1 ? "checkpoint" : "checkpoints"}</span>
          {/if}
        </summary>
        <div class="meta-body">
          {#if meta.objective}<p class="meta-obj">{meta.objective}</p>{/if}
          {#each meta.checkpoints as c, i (i)}<p class="meta-chk">— {c}</p>{/each}
        </div>
      </details>
    {/if}
  {:else}
    <div class={`b-marker ${markerClass[block.level] ?? "st-faint"}`} data-agent-id="block.marker">
      {markerGlyph[block.level] ?? "·"} {block.text}
      {#if authPack}
        <button class="act hover-act" data-agent-id="block.marker.creds" data-pack={authPack} title="Values are stored on the host and handed to dext as environment — never shown in chat" onclick={() => openPackCredentials(authPack)}>Provide credentials…</button>
      {/if}
    </div>
  {/if}
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
  .bash-advisory { color: var(--dim); font-size: 12px; }
  .bash-advisory summary { cursor: pointer; width: fit-content; }
  .bash-advisory pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; margin: 6px 0 2px; padding-left: 10px; border-left: 1px solid var(--line); }
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
  /* Caret follows the real open state (details[open]), so a live block the
     user folds reads truthfully — the radar keeps pulsing in the header, the
     caret shows which way it opens. */
  .caret {
    display: inline-block;
    transition: rotate 0.12s ease-out;
  }
  .b-think[open] .caret {
    rotate: 90deg;
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
    line-height: 1.55;
    max-height: calc(4 * 1.55em);
    overflow: hidden;
  }
  .b-compact {
    width: 100%;
    border-left: 2px solid color-mix(in srgb, var(--cyan) 45%, var(--line));
    padding: 3px 0 3px 10px;
    color: var(--dim);
  }
  .b-compact[data-state="running"] {
    border-left-color: color-mix(in srgb, var(--magenta) 55%, var(--line));
  }
  .b-compact[data-state="failed"] {
    border-left-color: color-mix(in srgb, var(--red) 55%, var(--line));
  }
  .b-compact summary {
    display: flex;
    align-items: baseline;
    gap: 7px;
    width: fit-content;
    cursor: pointer;
    list-style: none;
  }
  .b-compact summary::-webkit-details-marker {
    display: none;
  }
  .b-compact[data-state="running"] summary {
    cursor: default;
  }
  .compact-reveal {
    font-size: 11px;
  }
  .compact-detail,
  .compact-error {
    max-height: 18rem;
    overflow: auto;
    margin: 7px 0 3px;
    padding: 8px 10px;
    border: 1px solid var(--line);
    background: var(--bg1);
    color: var(--dim);
  }
  .compact-detail :global(:first-child) {
    margin-top: 0;
  }
  .compact-detail :global(:last-child) {
    margin-bottom: 0;
  }
  .compact-error {
    white-space: pre-wrap;
  }
  /* Streaming thought indicator: a radar target — core dot with two
     concentric rings pinging outward in staggered waves. Pure CSS geometry,
     centered by construction (glyph rotation visibly pivots on the
     baseline), pulses and moves, and is no lab's mark. */
  .think-radar {
    position: relative;
    display: inline-block;
    width: 12px;
    height: 12px;
    margin-right: 7px;
    vertical-align: -1px;
    color: var(--cyan);
  }
  .think-radar .core {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 4px;
    height: 4px;
    margin: -2px 0 0 -2px;
    border-radius: 50%;
    background: currentColor;
  }
  .think-radar .ring {
    position: absolute;
    inset: 0;
    border: 1px solid currentColor;
    border-radius: 50%;
    opacity: 0;
    animation: think-ping 1.8s cubic-bezier(0.2, 0.6, 0.4, 1) infinite;
  }
  .think-radar .r2 {
    animation-delay: 0.6s;
  }
  @keyframes think-ping {
    0% {
      transform: scale(0.3);
      opacity: 0.9;
    }
    70% {
      opacity: 0.15;
    }
    100% {
      transform: scale(1);
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .think-radar .ring {
      animation: none;
      transform: scale(1);
      opacity: 0.35;
    }
    .think-radar .r2 {
      transform: scale(0.65);
      opacity: 0.2;
    }
  }
  /* Run-status annotations (objective/phase info markers): steering state,
     not conversation — one quiet line each. Label + CSS-clamped text buys back
     the real estate raw prose wrapped over; details opens the full charter.
     Tokens only, so light/dark themes both hold. */
  .b-meta {
    width: 100%;
    min-width: 0;
    font-size: 12px;
    color: var(--faint);
  }
  .b-meta.phase {
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  .b-meta summary {
    cursor: pointer;
    user-select: none;
    list-style: none;
    min-width: 0;
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  .b-meta summary::-webkit-details-marker {
    display: none;
  }
  .meta-k {
    flex-shrink: 0;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .meta-pill {
    flex-shrink: 0;
    font-size: 11px;
    border: 1px solid var(--line);
    background: var(--bg1);
    padding: 0 5px;
    color: var(--dim);
  }
  .meta-line,
  .meta-note {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--dim);
  }
  .meta-count {
    flex-shrink: 0;
  }
  .meta-body {
    display: grid;
    gap: 4px;
    padding: 2px 0 2px 2px;
    font-size: 12px;
  }
  .meta-body p {
    margin: 0;
    color: var(--dim);
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
  .view-body {
    width: 100%;
  }
  .b-marker {
    width: 100%;
    white-space: pre-wrap;
  }
  /* Batch markers: one natural-language line; opening it swaps in the raw
     per-call list, one label per line, mono. */
  .b-marker.batch {
    width: 100%;
  }
  .b-marker.batch summary {
    display: flex;
    gap: 8px;
    align-items: baseline;
    width: 100%;
    cursor: pointer;
    user-select: none;
    list-style: none;
  }
  .b-marker.batch summary::-webkit-details-marker {
    display: none;
  }
  .batch-first {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .batch-raw {
    flex-shrink: 0;
    font-size: 10px;
    letter-spacing: 0.05em;
  }
  .batch-list {
    margin: 2px 0 4px;
    padding: 2px 8px;
    list-style: none;
    border-left: 2px solid var(--line);
    display: grid;
    gap: 1px;
  }
  .batch-list li {
    font-family: var(--mono, monospace);
    font-size: 11.5px;
    color: var(--dim);
    white-space: pre-wrap;
    word-break: break-word;
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
