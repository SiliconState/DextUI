// Extension registry — the additive surface for DextUI editing itself.
//
// An extension is a folder under `apps/web/src/ext/<name>/` with an
// `index.ts` that calls the `register*` functions below at module load.
// `ext/index.ts` auto-imports every folder (Vite glob), so adding a feature
// is "add a folder, rebuild" — no edits to App.svelte, Markdown.svelte,
// Finder.svelte or the Composer. Core consults these registries at render
// time; nothing here is reactive, registration happens once at startup.
//
// Kinds:
//   fence     ```<lang> fences in markdown → a Svelte component ({ text, lang })
//   panel     a component shown in the panels row above the composer ({ store })
//   command   a Finder entry (⌘K) with a run() callback
//   slash     a client-side /command claimed before the host sees it
//   flowNode  a node type for the flow builder (P4): schema + compile hook
import type { Component } from "svelte";
import type { SessionStore } from "@dextui/client";

export interface FenceExt {
  lang: string;
  /** Rendered with props `{ text, lang }`. Must escape everything itself (no {@html}). */
  component: Component<{ text: string; lang: string }>;
  /** Shown in the block's chrome (e.g. "csv table"). */
  label?: string;
}

export interface PanelExt {
  id: string;
  title: string;
  /** Rendered with `{ store }` for the active session (null when none). */
  component: Component<{ store: SessionStore | null }>;
  /** Hidden until this returns true (e.g. only when a pack is installed). */
  when?: () => boolean;
}

export interface CommandExt {
  slug: string;
  label: string;
  hint?: string;
  group?: string;
  when?: () => boolean;
  run: () => void;
}

export interface SlashExt {
  /** e.g. "/flow" — matched on the first token, case-insensitive. */
  cmd: string;
  desc: string;
  /** Return true when handled locally; false lets the host handle it. */
  run: (text: string, sessionId: string) => boolean;
}

export interface FlowNodeExt {
  type: string;
  label: string;
  /** Short plain-language sentence for the palette. */
  desc: string;
  /** Field schema: name → kind; the builder renders a form from it. */
  fields: Record<string, "text" | "textarea" | "pack" | "number" | "boolean" | "path">;
  /** Ports: how many inputs/outputs the node accepts (0 = none, -1 = many). */
  inputs: number;
  outputs: number;
}

const fences = new Map<string, FenceExt>();
const panels: PanelExt[] = [];
const commands: CommandExt[] = [];
const slashes = new Map<string, SlashExt>();
const flowNodes = new Map<string, FlowNodeExt>();

export function registerFence(ext: FenceExt): void {
  fences.set(ext.lang.toLowerCase(), ext);
}
export function fenceFor(lang: string | undefined | null): FenceExt | undefined {
  return lang ? fences.get(lang.toLowerCase()) : undefined;
}

export function registerPanel(ext: PanelExt): void {
  const i = panels.findIndex((p) => p.id === ext.id);
  if (i >= 0) panels[i] = ext;
  else panels.push(ext);
}
export function activePanels(): PanelExt[] {
  return panels.filter((p) => !p.when || p.when());
}

export function registerCommand(ext: CommandExt): void {
  const i = commands.findIndex((c) => c.slug === ext.slug);
  if (i >= 0) commands[i] = ext;
  else commands.push(ext);
}
export function activeCommands(): CommandExt[] {
  return commands.filter((c) => !c.when || c.when());
}

export function registerSlash(ext: SlashExt): void {
  slashes.set(ext.cmd.toLowerCase(), ext);
}
/** Try client-side slash handlers; true when one consumed the text. */
export function runSlash(text: string, sessionId: string): boolean {
  const first = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const ext = slashes.get(first);
  return ext ? ext.run(text.trim(), sessionId) : false;
}
export function slashCommands(): { cmd: string; desc: string }[] {
  return [...slashes.values()].map((s) => ({ cmd: s.cmd, desc: s.desc }));
}

export function registerFlowNode(ext: FlowNodeExt): void {
  flowNodes.set(ext.type, ext);
}
export function flowNodeTypes(): FlowNodeExt[] {
  return [...flowNodes.values()];
}
export function flowNode(type: string): FlowNodeExt | undefined {
  return flowNodes.get(type);
}

/** For the workbench and `/__agent` drivers: what is registered right now. */
export function extSummary(): { fences: string[]; panels: string[]; commands: string[]; slashes: string[]; flowNodes: string[] } {
  return {
    fences: [...fences.keys()],
    panels: panels.map((p) => p.id),
    commands: commands.map((c) => c.slug),
    slashes: [...slashes.keys()],
    flowNodes: [...flowNodes.keys()],
  };
}
