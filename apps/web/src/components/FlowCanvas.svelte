<script lang="ts">
  // Flow builder canvas: zero-dep SVG. Drag nodes, drag port→port to connect,
  // wheel zoom, background drag pans, Delete removes the selection. The right
  // form edits the selected node (fields come from the ext registry, so a pack
  // can add a node type without touching this file). Save writes
  // .dext/flows/<name>.flow.json; Run compiles to a crew spec and starts it.
  import type { FlowNode, FlowNodeType } from "@dextui/protocol";
  import { flows, flowsEnabled, openFlow, newFlow, saveFlow, deleteFlow, runFlow, compileFlow_, closeFlows, addTrigger, removeTrigger, hookFor } from "../lib/flows.svelte";
  import { flowNodeTypes, flowNode } from "../ext";
  import { app, pushToast } from "../lib/state.svelte";
  import { packTitle } from "../lib/display";
  import { useDialog } from "../lib/dialog.svelte";

  const dlg = useDialog(() => flows.open);

  const W = 176;
  const H = 48;
  const GYPH: Record<string, string> = { pack: "▮", prompt: "❯", gate: "◆", message: "✉", condition: "◇" };

  let pan = $state({ x: 0, y: 0 });
  let zoom = $state(1);
  let selected = $state<string | null>(null); // node id or "edge:from:to"
  let showPreview = $state(false);
  let view = $state<"canvas" | "list">("canvas");
  let svgEl: SVGSVGElement | undefined = $state();
  let drag = $state<{ kind: "node" | "pan" | "edge"; id?: string; dx: number; dy: number; px: number; py: number; mx: number; my: number } | null>(null);

  const draft = $derived(flows.draft);
  /** Can this host execute flows at all? Editing and compiling are local;
   *  running needs the crew engine (the host reports availability). */
  const canRun = $derived(flows.executor === "crew");
  const types = $derived(flowNodeTypes());
  const nodeById = $derived(new Map((draft?.nodes ?? []).map((n) => [n.id, n])));

  /** Auto-layout nodes that never got a position (imported files). */
  function layout(nodes: FlowNode[]): Map<string, { x: number; y: number }> {
    const m = new Map<string, { x: number; y: number }>();
    nodes.forEach((n, i) => m.set(n.id, { x: n.x ?? 60 + (i % 4) * 240, y: n.y ?? 80 + Math.floor(i / 4) * 120 }));
    return m;
  }
  const pos = $derived(layout(draft?.nodes ?? []));

  /** The sequential chain — the order steps actually run — for the list view. */
  const isLinked = (id: string) => (draft?.edges ?? []).some(([a, b]) => a === id || b === id);
  const chainNodes = $derived.by(() => {
    const nodes = draft?.nodes ?? [];
    const edges = draft?.edges ?? [];
    const nextOf = new Map(edges.map(([a, b]) => [a, b] as const));
    const seen = new Set<string>();
    const order: FlowNode[] = [];
    const walk = (start: string) => {
      let id: string | undefined = start;
      while (id && !seen.has(id)) {
        seen.add(id);
        const n = nodes.find((x) => x.id === id);
        if (n) order.push(n);
        id = nextOf.get(id);
      }
    };
    for (const n of nodes) if (!edges.some(([, b]) => b === n.id)) walk(n.id);
    for (const n of nodes) walk(n.id); // cycles/free nodes still get a row
    return order.filter((n) => isLinked(n.id));
  });
  const freeNodes = $derived((draft?.nodes ?? []).filter((n) => !isLinked(n.id)));

  /** List-view reorder: swap neighbors and rewrite the chain's edges — the
   *  only wiring a sequential flow has. Free (unconnected) steps never move
   *  here; they are linked in the map view. */
  function moveStep(id: string, dir: -1 | 1) {
    if (!draft) return;
    const order = chainNodes.map((n) => n.id);
    const i = order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    const a = order[i] ?? "";
    const b = order[j] ?? "";
    order[i] = b;
    order[j] = a;
    const moved = order.map((nid) => draft.nodes.find((n) => n.id === nid)).filter((n): n is FlowNode => !!n);
    draft.edges = order.slice(0, -1).map((a, k) => [a, order[k + 1]] as [string, string]);
    draft.nodes = [...moved, ...freeNodes];
    markDirty();
  }

  function toWorld(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = svgEl!.getBoundingClientRect();
    return { x: (e.clientX - r.left - pan.x) / zoom, y: (e.clientY - r.top - pan.y) / zoom };
  }

  function edgePath(a: string, b: string): string {
    const p1 = pos.get(a);
    const p2 = pos.get(b);
    if (!p1 || !p2) return "";
    const x1 = p1.x + W;
    const y1 = p1.y + H / 2;
    const x2 = p2.x;
    const y2 = p2.y + H / 2;
    const dx = Math.max(48, Math.abs(x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  function markDirty() {
    if (draft) draft.dirty = true;
  }

  function addNode(type: FlowNodeType) {
    if (!draft) return;
    const spec = flowNode(type);
    if (!spec) return;
    let i = draft.nodes.length + 1;
    let id = `${type}-${i}`;
    while (draft.nodes.some((n) => n.id === id)) id = `${type}-${++i}`;
    const node: FlowNode = { id, type, label: spec.label, x: 80 + draft.nodes.length * 40, y: 80 + draft.nodes.length * 40 };
    if (type === "pack") { node.pack = app.packs[0]?.name ?? ""; node.task = ""; }
    if (type === "prompt") node.prompt = "";
    if (type === "gate") node.question = "";
    if (type === "message") { node.to = ""; node.text = ""; }
    if (type === "condition") node.expr = "";
    draft.nodes = [...draft.nodes, node];
    if (view === "list") {
      // In the list view, "added" means "runs last": join the chain's tail.
      const tail = chainNodes.at(-1);
      if (tail) draft.edges = [...draft.edges, [tail.id, id]];
    }
    selected = id;
    markDirty();
  }

  function removeSelected() {
    if (!draft || !selected) return;
    if (selected.startsWith("edge:")) {
      const [, a, b] = selected.split(":");
      draft.edges = draft.edges.filter(([x, y]) => !(x === a && y === b));
    } else {
      draft.nodes = draft.nodes.filter((n) => n.id !== selected);
      draft.edges = draft.edges.filter(([a, b]) => a !== selected && b !== selected);
    }
    selected = null;
    markDirty();
  }

  function onNodeDown(e: PointerEvent, id: string) {
    e.stopPropagation();
    selected = id;
    const w = toWorld(e);
    const p = pos.get(id)!;
    drag = { kind: "node", id, dx: w.x - p.x, dy: w.y - p.y, px: 0, py: 0, mx: 0, my: 0 };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }

  function onPortDown(e: PointerEvent, id: string) {
    e.stopPropagation();
    e.preventDefault();
    const w = toWorld(e);
    drag = { kind: "edge", id, dx: 0, dy: 0, px: w.x, py: w.y, mx: w.x, my: w.y };
  }

  function onCanvasDown(e: PointerEvent) {
    selected = null;
    drag = { kind: "pan", dx: e.clientX - pan.x, dy: e.clientY - pan.y, px: 0, py: 0, mx: 0, my: 0 };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }

  function onMove(e: PointerEvent) {
    if (!drag) return;
    if (drag.kind === "node" && draft && drag.id) {
      const w = toWorld(e);
      const n = draft.nodes.find((x) => x.id === drag!.id)!;
      n.x = Math.round(w.x - drag.dx);
      n.y = Math.round(w.y - drag.dy);
      draft.nodes = [...draft.nodes];
      markDirty();
    } else if (drag.kind === "pan") {
      pan = { x: e.clientX - drag.dx, y: e.clientY - drag.dy };
    } else if (drag.kind === "edge") {
      const w = toWorld(e);
      drag = { ...drag, mx: w.x, my: w.y };
    }
  }

  function onUp(e: PointerEvent) {
    if (!drag) return;
    if (drag.kind === "edge" && draft && drag.id) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const target = el?.closest?.("[data-node]")?.getAttribute("data-node");
      if (target && target !== drag.id) {
        // Executor contract: one sequential chain — a node has at most one
        // outgoing and one incoming edge (branch/join is refused at save; the
        // guard here tells you at draw time, before the work is lost).
        const fromBusy = draft.edges.some(([a]) => a === drag!.id);
        const toBusy = draft.edges.some(([, b]) => b === target);
        if (fromBusy || toBusy) {
          pushToast("warn", "Steps run one after another — each step has one outgoing and one incoming connection. Use a Condition step or a separate flow for branching.");
        } else if (!draft.edges.some(([a, b]) => a === drag!.id && b === target)) {
          draft.edges = [...draft.edges, [drag.id, target]];
          markDirty();
        }
      }
    }
    drag = null;
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const w = toWorld(e);
    const next = Math.min(2.5, Math.max(0.3, zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    pan = { x: e.clientX - (svgEl!.getBoundingClientRect().left + 0) - w.x * next - pan.x + w.x * zoom + pan.x - (w.x * next - w.x * zoom), y: 0 };
    // simpler: recompute so the point under the cursor stays put
    const r = svgEl!.getBoundingClientRect();
    pan = { x: e.clientX - r.left - w.x * next, y: e.clientY - r.top - w.y * next };
    zoom = next;
  }

  function setField(key: string, v: string) {
    if (!draft || !selected || selected.startsWith("edge:")) return;
    const n = draft.nodes.find((x) => x.id === selected);
    if (!n) return;
    (n as unknown as Record<string, unknown>)[key] = v;
    draft.nodes = [...draft.nodes];
    markDirty();
  }

  function renameMeta(key: "name" | "title" | "desc", v: string) {
    if (!draft) return;
    const value = key === "name" ? v.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) : v;
    if (key === "name") draft.name = value;
    else if (key === "title") draft.title = value;
    else draft.desc = value;
    markDirty();
  }

  const selNode = $derived(draft && selected && !selected.startsWith("edge:") ? draft.nodes.find((n) => n.id === selected) : null);
  const selSpec = $derived(selNode ? flowNode(selNode.type) : null);

  function setTrigger(i: number, key: string, v: string | boolean) {
    if (!draft?.triggers) return;
    const t = { ...draft.triggers[i] } as Record<string, unknown>;
    if (key === "mode") {
      if (v === "every") { delete t.daily_at; delete t.weekday; t.every = 60; }
      else { delete t.every; t.daily_at = "09:00"; }
    } else if (key === "every") t.every = Math.max(15, Math.min(10080, Number(v) || 60));
    else if (key === "weekday") { if (v === "") delete t.weekday; else t.weekday = Number(v); }
    else t[key] = v;
    draft.triggers = draft.triggers.map((x, k) => (k === i ? (t as unknown as typeof x) : x));
    markDirty();
  }
  const armed = $derived(draft ? flows.triggers.filter((t) => t.name === draft.name) : []);
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
</script>

{#if flows.open}
  <div class="insp-scrim" data-agent-id="flows.scrim" onclick={closeFlows} onkeydown={() => {}} role="presentation"></div>
  <div class="insp gallery-overlay flows" role="dialog" aria-modal="true" aria-label="Flows" tabindex="-1" use:dlg.ref data-agent-id="flows.overlay" data-state={draft ? "edit" : "list"}>
    <div class="insp-head">
      <span class="st-magenta">Flows</span>
      <span class="dim">{draft ? (draft.title || draft.name) : "Workflows in this folder"}</span>
      <span class="insp-acts">
        {#if draft}
          <button class="act" data-agent-id="flows.back" onclick={() => { flows.draft = null; flows.preview = ""; }} aria-label="Back to the flow list">← Flows</button>
          <button class="act" data-agent-id="flows.save" onclick={saveFlow} title="Save (Ctrl+S)">{draft.dirty ? "[⌃s] Save*" : "Saved"}</button>
          <button class="act" data-agent-id="flows.compile" onclick={() => { showPreview = !showPreview; if (!flows.preview) compileFlow_(); }} title="Show the crew spec this flow compiles to (works without the crew engine)">Spec</button>
          <button class="act accent" data-agent-id="flows.run" onclick={runFlow} disabled={!canRun}
            title={canRun ? "Run this flow with the crew engine" : "This host has no crew engine — edit and Spec still work; Run is off"}>▶ Run</button>
          {#if !canRun}<span class="faint" data-agent-id="flows.executor.off">no crew engine — Run is off, editing and Spec still work</span>{/if}
        {/if}
        <button class="act" data-agent-id="flows.close" onclick={closeFlows}>esc</button>
      </span>
    </div>

    <div class="insp-body body">
      {#if !draft}
        <ul class="flist" data-agent-id="flows.list">
          {#each flows.list as f (f.name)}
            {@const launch = flows.launches.find((l) => l.name === f.name)}
            <li class="frow" data-agent-id={`flows.row.${f.name}`} data-launch={launch?.state ?? ""}>
              <button class="fmain" data-agent-id={`flows.open.${f.name}`} onclick={() => openFlow(f.name)}>
                <span class="st-cyan">{f.title}</span>
                <span class="dim truncate">{f.desc}</span>
                <span class="faint">{f.nodes} nodes</span>
                {#if launch}
                  {#if launch.state === "failed"}
                    <span class="st-red" title={launch.error || "run failed"} data-agent-id={`flows.launch.${f.name}`}>✗ run failed</span>
                  {:else if launch.state === "starting"}
                    <span class="st-yellow pulse" data-agent-id={`flows.launch.${f.name}`}>● running</span>
                  {:else}
                    <span class="st-green" title="last run exited 0" data-agent-id={`flows.launch.${f.name}`}>✓ ran</span>
                  {/if}
                {/if}
              </button>
              <button class="act del" data-agent-id={`flows.delete.${f.name}`} onclick={() => deleteFlow(f.name)}>
                {flows.confirmDelete === f.name ? "Really delete?" : "Delete"}
              </button>
            </li>
          {/each}
        </ul>
        <button class="act accent" data-agent-id="flows.new" onclick={newFlow}>+ New flow</button>
        {#if !flowsEnabled()}<p class="dim">Flows need a host with the flows capability.</p>{/if}
        {#if flows.list.length === 0}<p class="dim">No flows in this folder yet. A flow is a small graph of steps — packs, prompts, checkpoints — saved as <span class="st-cyan">.dext/flows/*.flow.json</span> and run by the crew engine.</p>{/if}
      {:else}
        <div class="meta">
          <input class="m-in" value={draft.name} placeholder="flow-name" oninput={(e) => renameMeta("name", e.currentTarget.value)} data-agent-id="flows.meta.name" />
          <input class="m-in grow" value={draft.title ?? ""} placeholder="Title (shown to you)" oninput={(e) => renameMeta("title", e.currentTarget.value)} data-agent-id="flows.meta.title" />
          <input class="m-in grow" value={draft.desc ?? ""} placeholder="One line: what it does" oninput={(e) => renameMeta("desc", e.currentTarget.value)} data-agent-id="flows.meta.desc" />
        </div>
        <div class="palette" data-agent-id="flows.palette">
          {#each types as t (t.type)}
            <button class="chip" title={t.desc} data-agent-id={`flows.add.${t.type}`} onclick={() => addNode(t.type as FlowNodeType)}>+ {GYPH[t.type] ?? "·"} {t.label}</button>
          {/each}
          <span class="faint ph">{view === "canvas" ? "Drag nodes · drag ○→ to connect · click to edit · Del removes · or switch to List" : "Steps run top to bottom · select to edit · ↑↓ reorders"}</span>
          <button class="chip" class:on={view === "canvas"} aria-pressed={view === "canvas"} data-agent-id="flows.view.canvas" onclick={() => { view = "canvas"; }} title="Map view — drag steps and connections">Map</button>
          <button class="chip" class:on={view === "list"} aria-pressed={view === "list"} data-agent-id="flows.view.list" onclick={() => { view = "list"; }} title="List view — keyboard-first step list">List</button>
        </div>

        <div class="work">
          {#if view === "canvas"}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <svg bind:this={svgEl} class="canvas" data-agent-id="flows.canvas"
            onpointerdown={onCanvasDown} onpointermove={onMove} onpointerup={onUp} onwheel={onWheel}
            tabindex="-1" role="application" aria-label="Flow canvas">
            <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
              {#each draft.edges as [a, b] (a + ":" + b)}
                {@const sel = selected === `edge:${a}:${b}`}
                <path class="edge" class:sel d={edgePath(a, b)} data-agent-id={`flows.edge.${a}.${b}`} data-edge={`edge:${a}:${b}`}
                  onclick={(e) => { e.stopPropagation(); selected = `edge:${a}:${b}`; }} onkeydown={() => {}} />
              {/each}
              {#if drag?.kind === "edge" && drag.id}
                {@const p = pos.get(drag.id)}
                {#if p}
                  <path class="edge ghost" d={`M ${p.x + W} ${p.y + H / 2} L ${drag.mx} ${drag.my}`} />
                {/if}
              {/if}
              {#each draft.nodes as n (n.id)}
                {@const p = pos.get(n.id)!}
                <g transform={`translate(${p.x} ${p.y})`} data-node={n.id}>
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <rect class="node" class:sel={selected === n.id} width={W} height={H} rx="3" data-agent-id={`flows.node.${n.id}`}
                    onpointerdown={(e) => onNodeDown(e, n.id)} />
                  <text class="n-glyph" x="8" y="20">{GYPH[n.type] ?? "·"}</text>
                  <text class="n-label" x="24" y="20">{(n.label || n.id).slice(0, 22)}</text>
                  <text class="n-type" x="8" y="37">{n.type}{n.type === "pack" && n.pack ? `: ${n.pack}` : ""}</text>
                  <circle class="port in" cx="0" cy={H / 2} r="4" />
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <circle class="port out" cx={W} cy={H / 2} r="5" data-agent-id={`flows.port.${n.id}`} onpointerdown={(e) => onPortDown(e, n.id)} />
                </g>
              {/each}
            </g>
          </svg>
          {:else}
          <div class="steps" data-agent-id="flows.steps">
            <p class="dim steps-hint">Steps run top to bottom — one after another. Select a step to edit it on the right.</p>
            <ol class="step-list">
              {#each chainNodes as n, i (n.id)}
                <li class="step-row" class:sel={selected === n.id} data-agent-id={`flows.step.${i}`} data-state={selected === n.id ? "selected" : ""}>
                  <button class="fmain step-main" data-agent-id={`flows.step.${i}.select`} onclick={() => { selected = n.id; }}
                    aria-label={`Edit step ${i + 1}: ${n.label || n.id}`} aria-current={selected === n.id ? "true" : undefined}>
                    <span class="st-cyan">{i + 1}. {GYPH[n.type] ?? "·"} {n.label || n.id}</span>
                    <span class="faint">{n.type}{n.type === "pack" && n.pack ? `: ${n.pack}` : ""}</span>
                  </button>
                  <button class="act" data-agent-id={`flows.step.${i}.up`} onclick={() => moveStep(n.id, -1)} disabled={i === 0}
                    aria-label={`Move step ${i + 1} up`} title="Move earlier">↑</button>
                  <button class="act" data-agent-id={`flows.step.${i}.down`} onclick={() => moveStep(n.id, 1)} disabled={i === chainNodes.length - 1}
                    aria-label={`Move step ${i + 1} down`} title="Move later">↓</button>
                </li>
              {/each}
              {#if chainNodes.length === 0}<li class="faint steps-hint">No connected steps yet — add one from the palette; it joins the chain's end.</li>{/if}
            </ol>
            {#if freeNodes.length}
              <p class="faint steps-hint">Not connected yet (won't run — link them in Map view):</p>
              <ul class="step-list free">
                {#each freeNodes as n (n.id)}
                  <li class="step-row" class:sel={selected === n.id}>
                    <button class="fmain step-main" onclick={() => { selected = n.id; }} aria-label={`Edit unconnected step ${n.label || n.id}`}>
                      <span class="st-yellow">{GYPH[n.type] ?? "·"} {n.label || n.id}</span>
                      <span class="faint">{n.type}</span>
                    </button>
                    <button class="act del" onclick={() => { selected = n.id; removeSelected(); }} aria-label={`Delete unconnected step ${n.label || n.id}`}>Delete</button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
          {/if}

          {#if selNode && selSpec}
            <aside class="form" data-agent-id="flows.form">
              <div class="f-head"><span class="st-cyan">{selSpec.label}</span> <span class="faint">{selNode.id}</span></div>
              <label>Label <input value={selNode.label ?? ""} oninput={(e) => setField("label", e.currentTarget.value)} data-agent-id="flows.field.label" /></label>
              {#each Object.entries(selSpec.fields) as [key, kind] (key)}
                {#if kind === "textarea"}
                  <label>{key} <textarea rows="3" value={(selNode as unknown as Record<string, string>)[key] ?? ""} oninput={(e) => setField(key, e.currentTarget.value)} data-agent-id={`flows.field.${key}`}></textarea></label>
                {:else if kind === "pack"}
                  <label>{key}
                    <select value={(selNode as unknown as Record<string, string>)[key] ?? ""} onchange={(e) => setField(key, e.currentTarget.value)} data-agent-id={`flows.field.${key}`}>
                      {#each app.packs as p (p.name)}<option value={p.name}>{packTitle(p)}</option>{/each}
                    </select>
                  </label>
                {:else}
                  <label>{key} <input value={(selNode as unknown as Record<string, string>)[key] ?? ""} oninput={(e) => setField(key, e.currentTarget.value)} data-agent-id={`flows.field.${key}`} /></label>
                {/if}
              {/each}
              {#if selNode.type === "condition" || selNode.type === "gate"}
                <p class="faint form-note">This step guides the worker's model — it is not a hard program branch. The worker decides using it.</p>
              {/if}
              <button class="act del" data-agent-id="flows.node.delete" onclick={removeSelected}>Delete node</button>
            </aside>
          {:else if selected?.startsWith("edge:")}
            <aside class="form"><p class="dim">Connection</p><button class="act del" data-agent-id="flows.edge.delete" onclick={removeSelected}>Remove connection</button></aside>
          {/if}
        </div>

        {#if showPreview && flows.preview}
          <pre class="preview" data-agent-id="flows.preview">{flows.preview}</pre>
        {/if}

        <!-- triggers: what starts this flow besides ▶ run (validated by the host on save) -->
        <section class="trig" data-agent-id="flows.triggers">
          <div class="trig-head">
            <span class="st-magenta">Starts when</span>
            <span class="faint" data-agent-id="flows.triggers.note">{canRun ? "Manual (▶) always works ·" : "No crew engine: triggers stay armed but cannot fire until one is installed ·"}</span>
            <button class="chip" data-agent-id="flows.trigger.add.schedule" onclick={() => addTrigger("schedule")}>+ On a schedule</button>
            <button class="chip" data-agent-id="flows.trigger.add.watch" onclick={() => addTrigger("watch")}>+ Files change</button>
            <button class="chip" data-agent-id="flows.trigger.add.mesh" onclick={() => addTrigger("mesh")}>+ Message arrives</button>
            <button class="chip" data-agent-id="flows.trigger.add.webhook" onclick={() => addTrigger("webhook")}>+ Web hook</button>
          </div>
          {#each draft.triggers ?? [] as t, i (i)}
            <div class="trig-row" data-agent-id={`flows.trigger.${i}`} data-state={t.enabled === false ? "off" : "on"}>
              <label class="on"><input type="checkbox" checked={t.enabled !== false} onchange={(e) => setTrigger(i, "enabled", e.currentTarget.checked)} /> {t.kind}</label>
              {#if t.kind === "schedule"}
                <select value={t.every ? "every" : "daily"} onchange={(e) => setTrigger(i, "mode", e.currentTarget.value)}>
                  <option value="daily">Daily at</option>
                  <option value="every">Every N minutes</option>
                </select>
                {#if t.every}
                  <input type="number" min="15" max="10080" value={t.every} onchange={(e) => setTrigger(i, "every", e.currentTarget.value)} />
                {:else}
                  <input type="time" value={t.daily_at ?? "09:00"} onchange={(e) => setTrigger(i, "daily_at", e.currentTarget.value)} />
                  <select value={t.weekday === undefined ? "" : String(t.weekday)} onchange={(e) => setTrigger(i, "weekday", e.currentTarget.value)}>
                    <option value="">Every day</option>
                    {#each DAYS as d, k (k)}<option value={String(k)}>{d}</option>{/each}
                  </select>
                {/if}
              {:else if t.kind === "watch"}
                <span class="faint">Folder</span> <input value={t.path ?? "."} placeholder=". (this folder)" onchange={(e) => setTrigger(i, "path", e.currentTarget.value)} />
              {:else if t.kind === "mesh"}
                <span class="faint">As node</span> <input value={t.node ?? ""} onchange={(e) => setTrigger(i, "node", e.currentTarget.value)} />
                <span class="faint">From</span> <input value={t.from ?? ""} placeholder="anyone" onchange={(e) => setTrigger(i, "from", e.currentTarget.value)} />
              {:else}
                {@const hook = hookFor(draft.name)}
                <span class="faint">POST</span> <code class="hook">{hook ? `${location.origin}${hook}` : "(Save to get the URL)"}</code>
              {/if}
              <button class="act del" data-agent-id={`flows.trigger.${i}.remove`} onclick={() => removeTrigger(i)}>Remove</button>
            </div>
          {/each}
          {#if armed.length}
            <p class="faint">Armed on the host: {armed.map((a) => `${a.detail}${a.last ? ` (last ${new Date(a.last).toLocaleString()})` : ""}`).join(" · ")}</p>
          {/if}
        </section>
        {#if flows.started === draft.name}
          <p class="st-green">▶ Running — watch the crew rail for progress and checkpoints.</p>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .flows { max-width: 1080px; }
  .body { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
  .flist { list-style: none; display: grid; gap: 4px; padding: 0; margin: 0; }
  .frow { display: flex; gap: 8px; align-items: center; }
  .fmain { display: grid; grid-template-columns: 12em 1fr 5em; gap: 10px; flex: 1; padding: 6px 8px; background: var(--bg1); border: 1px solid var(--line); color: inherit; font: inherit; text-align: left; }
  .fmain:hover { border-color: var(--cyan); background: var(--bg2); }
  .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .meta { display: flex; gap: 6px; flex-wrap: wrap; }
  .m-in { border-bottom: 1px solid var(--line); padding: 2px 4px; min-width: 0; }
  .m-in.grow { flex: 1; }
  .palette { display: flex; gap: 6px; flex-wrap: wrap; align-items: baseline; }
  .ph { font-size: 11px; margin-left: auto; }
  .work { display: flex; gap: 8px; min-height: 340px; }
  .canvas { flex: 1; min-height: 340px; border: 1px solid var(--line); background: var(--bg0, var(--bg1)); cursor: grab; touch-action: none; }
  .node { fill: var(--bg1); stroke: var(--line); cursor: move; }
  .node.sel { stroke: var(--cyan); stroke-width: 2; }
  .n-glyph { fill: var(--cyan); font-size: 13px; }
  .n-label { fill: var(--fg); font-size: 12px; font-weight: bold; }
  .n-type { fill: var(--dim); font-size: 10px; }
  .port { fill: var(--bg2); stroke: var(--dim); }
  .port.out { cursor: crosshair; stroke: var(--cyan); }
  .edge { fill: none; stroke: var(--dim); stroke-width: 2; cursor: pointer; }
  .edge:hover { stroke: var(--cyan); }
  .edge.sel { stroke: var(--yellow); }
  .edge.ghost { stroke: var(--cyan); stroke-dasharray: 4 3; pointer-events: none; }
  .form { width: 260px; flex: none; border: 1px solid var(--line); background: var(--bg1); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; max-height: 420px; overflow-y: auto; }
  .f-head { display: flex; justify-content: space-between; }
  .form label { display: grid; gap: 2px; font-size: 11px; color: var(--dim); }
  .form input, .form textarea, .form select { background: var(--bg0, var(--bg2)); border: 1px solid var(--line); color: var(--fg); font: inherit; padding: 3px 6px; }
  .del { color: var(--yellow, #e3b341); }
  .preview { max-height: 200px; overflow: auto; border: 1px solid var(--line); background: var(--bg1); padding: 8px; font-size: 11px; white-space: pre-wrap; }
  .trig { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--line); padding-top: 8px; }
  .trig-head { display: flex; gap: 6px; flex-wrap: wrap; align-items: baseline; }
  .trig-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; font-size: 12px; padding: 4px 8px; background: var(--bg1); border: 1px solid var(--line); }
  .trig-row[data-state="off"] { opacity: 0.55; }
  .trig-row input, .trig-row select { background: var(--bg2); border: 1px solid var(--line); color: var(--fg); font: inherit; padding: 2px 5px; }
  .trig-row input[type="number"] { width: 6em; }
  .on { display: flex; gap: 4px; align-items: center; color: var(--cyan); }
  .hook { user-select: all; font-size: 11px; color: var(--fg); }
  .steps { flex: 1; min-height: 340px; border: 1px solid var(--line); background: var(--bg0, var(--bg1)); padding: 10px 12px; overflow-y: auto; }
  .steps-hint { margin: 2px 0 8px; }
  .step-list { list-style: none; display: grid; gap: 4px; padding: 0; margin: 0 0 10px; }
  .step-row { display: flex; gap: 6px; align-items: center; }
  .step-row.sel .step-main { border-color: var(--cyan); }
  .step-main { grid-template-columns: 16em 1fr; }
  .step-row .act:disabled { opacity: 0.35; cursor: default; }
  .act:disabled { opacity: 0.5; cursor: not-allowed; }
  .chip.on { border-color: var(--cyan); color: var(--cyan); }
  .form-note { font-size: 11px; }
</style>
