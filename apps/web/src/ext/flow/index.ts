// flow extension: the builder's node types, a Finder command, and /flows.
// This is the reference for extension-registered flow nodes — a pack can add
// its own node type with registerFlowNode and it appears in the palette.
import { registerFlowNode, registerCommand, registerSlash } from "../registry";
import { openFlows } from "../../lib/flows.svelte";

registerFlowNode({
  type: "pack",
  label: "Pack",
  desc: "Run one of your tools (packs) on a task",
  fields: { pack: "pack", task: "textarea" },
  inputs: 1,
  outputs: 1,
});

registerFlowNode({
  type: "prompt",
  label: "Prompt",
  desc: "A helper does one step and writes a result",
  fields: { prompt: "textarea", agent: "text", model: "text" },
  inputs: 1,
  outputs: 1,
});

registerFlowNode({
  type: "gate",
  label: "Checkpoint",
  desc: "Pause and ask you before continuing",
  fields: { question: "textarea" },
  inputs: 1,
  outputs: 1,
});

registerFlowNode({
  type: "message",
  label: "Message",
  desc: "Send a note via Inbox (mesh) — e.g. to your accountant",
  fields: { to: "text", text: "textarea" },
  inputs: 1,
  outputs: 1,
});

registerFlowNode({
  type: "condition",
  label: "Condition",
  desc: "Continue only if the check is clearly true, else ask",
  fields: { expr: "textarea" },
  inputs: 1,
  outputs: 1,
});

registerCommand({
  slug: "flows.open",
  label: "Flows — build & run workflows (f)",
  hint: "f",
  group: "app",
  run: () => openFlows(),
});

registerSlash({
  cmd: "/flows",
  desc: "Open the flow builder",
  run: () => {
    openFlows();
    return true;
  },
});
