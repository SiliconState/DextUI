// Flow builder host side: `.dext/flows/<name>.flow.json` under a session cwd.
// A flow is a small DAG of typed nodes; compile() turns it into a crew chain
// spec (crew run --spec) — crew is the executor, the flow file is the source
// of truth you can edit, save and version.
//
// Node types (v1):
//   pack      run a dext pack on a task (the pack's own runtime tools do the work)
//   prompt    a dext worker step (agent role, prompt, optional model/output)
//   gate      pause for a human decision (worker writes escalation.json → the
//             run pauses and lands in the Action Queue; answering resumes it)
//   message   send a mesh message (mesh send <to> — "tell my accountant")
//   condition a soft gate: continue when clearly true, escalate otherwise
//   (triggers are a P5 host-scheduler concern, not a node here)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { checkedPath } from "./session-files.mjs";

export const FLOW_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const FLOW_NODE_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const MESH_NODE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FLOW_FILE_CAP = 256 * 1024;
export const MAX_FLOW_NODES = 64;
export const MAX_FLOW_EDGES = 128;
export const NODE_TYPES = new Set(["pack", "prompt", "gate", "message", "condition"]);

const CAPS = { task: 4000, prompt: 4000, question: 500, text: 2000, expr: 500, label: 60, desc: 200 };

function clipped(v, n) {
  return typeof v === "string" ? v.slice(0, n) : undefined;
}

/** Validate one flow object (already JSON.parsed). Returns `{ ok, flow }` or
 *  `{ error }` — errors are always a string code the UI can show verbatim. */
export function validateFlow(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "flow must be a JSON object" };
  if (raw.version !== 1) return { error: "flow.version must be 1" };
  if (typeof raw.name !== "string" || !FLOW_NAME_RE.test(raw.name)) return { error: `flow name must match ${FLOW_NAME_RE}` };
  const nodes = raw.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return { error: "flow needs at least one node" };
  if (nodes.length > MAX_FLOW_NODES) return { error: `at most ${MAX_FLOW_NODES} nodes` };
  const edges = Array.isArray(raw.edges) ? raw.edges : [];
  if (edges.length > MAX_FLOW_EDGES) return { error: `at most ${MAX_FLOW_EDGES} edges` };

  const clean = [];
  const ids = new Set();
  for (const [i, n] of nodes.entries()) {
    if (!n || typeof n !== "object") return { error: `node ${i}: must be an object` };
    if (typeof n.id !== "string" || !FLOW_NODE_RE.test(n.id)) return { error: `node ${i}: id must match ${FLOW_NODE_RE}` };
    if (ids.has(n.id)) return { error: `duplicate node id '${n.id}'` };
    ids.add(n.id);
    if (!NODE_TYPES.has(n.type)) return { error: `node '${n.id}': unknown type '${n.type}'` };
    const node = { id: n.id, type: n.type };
    if (n.label !== undefined) {
      node.label = clipped(n.label, CAPS.label);
      if (!node.label) return { error: `node '${n.id}': label must be a string` };
    }
    for (const axis of ["x", "y"]) {
      if (n[axis] !== undefined) {
        if (typeof n[axis] !== "number" || !Number.isFinite(n[axis])) return { error: `node '${n.id}': ${axis} must be a number` };
        node[axis] = Math.round(Math.max(-10000, Math.min(10000, n[axis])));
      }
    }
    switch (n.type) {
      case "pack": {
        if (typeof n.pack !== "string" || !FLOW_NAME_RE.test(n.pack)) return { error: `node '${n.id}': pack needs a valid pack name` };
        node.pack = n.pack;
        node.task = clipped(n.task, CAPS.task);
        if (!node.task) return { error: `node '${n.id}': pack needs a task` };
        break;
      }
      case "prompt": {
        node.prompt = clipped(n.prompt, CAPS.prompt);
        if (!node.prompt) return { error: `node '${n.id}': prompt is required` };
        if (n.agent !== undefined) {
          if (typeof n.agent !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(n.agent)) return { error: `node '${n.id}': bad agent name` };
          node.agent = n.agent;
        }
        if (n.model !== undefined) {
          if (typeof n.model !== "string" || n.model.length > 120) return { error: `node '${n.id}': bad model` };
          node.model = n.model;
        }
        break;
      }
      case "gate": {
        node.question = clipped(n.question, CAPS.question);
        if (!node.question) return { error: `node '${n.id}': gate needs a question for the human` };
        break;
      }
      case "message": {
        if (typeof n.to !== "string" || !MESH_NODE_RE.test(n.to)) return { error: `node '${n.id}': message needs a valid recipient (mesh node name)` };
        node.to = n.to;
        node.text = clipped(n.text, CAPS.text);
        if (!node.text) return { error: `node '${n.id}': message needs text` };
        break;
      }
      case "condition": {
        node.expr = clipped(n.expr, CAPS.expr);
        if (!node.expr) return { error: `node '${n.id}': condition needs an expression` };
        break;
      }
    }
    clean.push(node);
  }

  const seenPairs = new Set();
  const adj = new Map([...ids].map((id) => [id, []]));
  for (const e of edges) {
    if (!Array.isArray(e) || e.length !== 2 || !ids.has(e[0]) || !ids.has(e[1])) return { error: "edges must be [from, to] with existing node ids" };
    if (e[0] === e[1]) return { error: `node '${e[0]}' cannot feed itself` };
    const key = `${e[0]}→${e[1]}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    adj.get(e[0]).push(e[1]);
  }
  // Cycle check (iterative DFS over the DAG).
  const mark = new Map();
  for (const id of ids) {
    if (mark.get(id) === 2) continue;
    const stack = [[id, false]];
    while (stack.length) {
      const [cur, done] = stack.pop();
      if (done) { mark.set(cur, 2); continue; }
      const m = mark.get(cur) ?? 0;
      if (m === 1) return { error: `cycle through node '${cur}' — flows are acyclic` };
      if (m === 2) continue;
      mark.set(cur, 1);
      stack.push([cur, true]);
      for (const next of adj.get(cur)) stack.push([next, false]);
    }
  }

  const flow = {
    version: 1,
    name: raw.name,
    nodes: clean,
    edges: [...seenPairs].map((p) => p.split("→")),
  };
  if (typeof raw.title === "string" && raw.title.trim()) flow.title = raw.title.trim().slice(0, 60);
  if (typeof raw.desc === "string" && raw.desc.trim()) flow.desc = raw.desc.trim().slice(0, CAPS.desc);
  return { ok: true, flow };
}

/** Kahn topological order; disconnected nodes keep declaration order at the end. */
export function topoOrder(flow) {
  const indeg = new Map(flow.nodes.map((n) => [n.id, 0]));
  const out = new Map(flow.nodes.map((n) => [n.id, []]));
  for (const [a, b] of flow.edges) {
    indeg.set(b, indeg.get(b) + 1);
    out.get(a).push(b);
  }
  const ready = flow.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order = [];
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    for (const next of out.get(id)) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) ready.push(next);
    }
  }
  for (const n of flow.nodes) if (!order.includes(n.id)) order.push(n.id);
  return order;
}

const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");

/** Compile a validated flow to a crew chain spec (crew run --spec). Nodes run
 *  in topological order as sequential chain steps; `{previous}` and friends
 *  are crew's own template variables. `meshBin` is the resolved mesh binary. */
export function compileFlow(flow, { meshBin = "mesh", packs = null } = {}) {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const steps = [];
  for (const id of topoOrder(flow)) {
    const n = byId.get(id);
    const label = n.label ?? n.id;
    const base = { agent: "worker", label, output: `${n.id}.md` };
    switch (n.type) {
      case "pack": {
        if (packs && !packs.has(n.pack)) throw Object.assign(new Error(`unknown pack '${n.pack}'`), { code: "no_pack" });
        steps.push({
          ...base,
          // "run <name>" hits dext's pack inference; the pack's runtime tools do the real work.
          task: `run ${n.pack} — ${esc(n.task)}\n\nPrevious step output (if relevant):\n{previous}`,
        });
        break;
      }
      case "prompt": {
        steps.push({
          ...base,
          ...(n.agent ? { agent: n.agent } : {}),
          ...(n.model ? { model: n.model } : {}),
          task: `${n.prompt}\n\nPrevious step output (if relevant):\n{previous}`,
        });
        break;
      }
      case "gate": {
        steps.push({
          agent: "worker",
          label,
          // No output file: the checkpoint produces a decision, not a deliverable.
          task: [
            `You are the human checkpoint "${esc(label)}" in a workflow. Do NOT do any other work.`,
            `Ask the human: ${esc(n.question)}`,
            `Write escalation.json in your current directory with exactly: {"question": ${JSON.stringify(esc(n.question))}, "reason": "flow checkpoint"}`,
            "If you cannot write files, end your final reply with: ESCALATION: " + esc(n.question),
            "The run pauses until the human answers; their answer comes back to you.",
          ].join("\n"),
        });
        break;
      }
      case "message": {
        steps.push({
          ...base,
          task: [
            "Send one message with your shell tool, then finish.",
            `Body text (resolve {previous} from the context below): ${n.text}`,
            "Run exactly: printf '%s' \"<the resolved body>\" | " + `"${meshBin}" send ${n.to}`,
            "Quote carefully; do not invent content. If the send fails, say so.",
            "Context — previous step output:\n{previous}",
          ].join("\n"),
        });
        break;
      }
      case "condition": {
        steps.push({
          agent: "worker",
          label,
          output: `${n.id}.md`,
          task: [
            `Evaluate this condition against the previous output: ${esc(n.expr)}`,
            "If it is clearly true, reply with exactly one line: PASS: <why>",
            "If it is false or unclear, write escalation.json in your current directory:",
            `{"question": ${JSON.stringify(esc(`"${n.expr}" was not true — continue anyway?`))}, "reason": "flow condition"} and stop.`,
            "Previous step output:\n{previous}",
          ].join("\n"),
        });
        break;
      }
    }
  }
  return {
    task: flow.title ?? flow.name,
    steps,
  };
}

// ---------- IO (confined to <cwd>/.dext/flows) ----------

export function flowsDir(cwd, { create = false } = {}) {
  const dir = path.join(cwd, ".dext", "flows");
  // checkedPath throws on a symlinked component (refuse) and returns false on
  // a missing one (safe to create). mkdir only ever happens after the check.
  let ok;
  try {
    ok = checkedPath(dir);
  } catch {
    return null;
  }
  if (!ok) {
    if (!create) return null;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      return null;
    }
  }
  return dir;
}

/** List flows: summaries only (name, title, desc, counts, mtime). */
export function listFlows(cwd) {
  const dir = flowsDir(cwd);
  if (!dir) return [];
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".flow.json") && FLOW_NAME_RE.test(f.slice(0, -".flow.json".length)));
  } catch {
    return [];
  }
  const out = [];
  for (const f of names.sort().slice(0, 64)) {
    const file = path.join(dir, f);
    try {
      if (fs.lstatSync(file).isSymbolicLink()) continue;
      const st = fs.statSync(file);
      if (st.size > FLOW_FILE_CAP) continue;
      const v = JSON.parse(fs.readFileSync(file, "utf8"));
      const name = f.slice(0, -".flow.json".length);
      out.push({
        name,
        title: typeof v.title === "string" ? v.title.slice(0, 60) : name,
        desc: typeof v.desc === "string" ? v.desc.slice(0, 200) : "",
        nodes: Array.isArray(v.nodes) ? v.nodes.length : 0,
        edges: Array.isArray(v.edges) ? v.edges.length : 0,
        mtime: Math.round(st.mtimeMs),
      });
    } catch {
      /* unreadable or invalid: list it empty rather than drop */
      out.push({ name: f.slice(0, -".flow.json".length), title: f, desc: "(unreadable)", nodes: 0, edges: 0, mtime: 0 });
    }
  }
  return out;
}

export function readFlow(cwd, name) {
  if (!FLOW_NAME_RE.test(name)) return { error: "bad_name" };
  const dir = flowsDir(cwd);
  if (!dir) return { error: "no_dir" };
  const file = path.join(dir, `${name}.flow.json`);
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return { error: "refused" };
    const st = fs.statSync(file);
    if (!st.isFile()) return { error: "no_flow" };
    if (st.size > FLOW_FILE_CAP) return { error: "too_large" };
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    const check = validateFlow(v);
    if (!check.ok) return { error: `invalid: ${check.error}` };
    return { ok: true, flow: check.flow };
  } catch (err) {
    if (err?.code === "ENOENT") return { error: "no_flow" };
    return { error: err instanceof SyntaxError ? "invalid_json" : "read_failed" };
  }
}

/** Atomic write (tmp + rename), never follows symlinks, validates first. */
export function writeFlow(cwd, raw) {
  const check = validateFlow(raw);
  if (!check.ok) return { error: check.error };
  const dir = flowsDir(cwd, { create: true });
  if (!dir) return { error: "no_dir" };
  try {
    const file = path.join(dir, `${check.flow.name}.flow.json`);
    try {
      if (fs.lstatSync(file).isSymbolicLink()) return { error: "refused" };
    } catch {
      /* new file */
    }
    const text = JSON.stringify(check.flow, null, 2) + "\n";
    if (Buffer.byteLength(text) > FLOW_FILE_CAP) return { error: "too_large" };
    const tmp = path.join(dir, `.dextui-${crypto.randomBytes(6).toString("hex")}.tmp`);
    try {
      fs.writeFileSync(tmp, text, { flag: "wx" });
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* gone */ }
      return { error: "write_failed" };
    }
    return { ok: true, flow: check.flow, bytes: Buffer.byteLength(text) };
  } catch {
    return { error: "write_failed" };
  }
}

export function deleteFlow(cwd, name) {
  if (!FLOW_NAME_RE.test(name)) return { error: "bad_name" };
  const dir = flowsDir(cwd);
  if (!dir) return { error: "no_dir" };
  const file = path.join(dir, `${name}.flow.json`);
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return { error: "refused" };
    fs.unlinkSync(file);
    return { ok: true };
  } catch (err) {
    return { error: err?.code === "ENOENT" ? "no_flow" : "delete_failed" };
  }
}
