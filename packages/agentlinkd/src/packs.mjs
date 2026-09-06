// Pack catalog for agentlinkd: parse `dext pack list --verbose`, read the
// optional `ui-*` front-matter keys from each PACK.md, merge curated day-1
// defaults, and compute which requirements this host cannot satisfy.
// Pure functions except readPackUi/listPackFiles (filesystem, symlink-refusing).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { checkedPath } from "./session-files.mjs";

export const PACK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PACK_MD_CAP = 1024 * 1024;
const ARTIFACTS = new Set(["html", "chart", "table", "markdown", "file", "none"]);
/** Sandboxed panel: an .html file inside the pack (no dotfiles/traversal). */
const PACK_PANEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9_-]{0,63})*\.html$/;
const MAX_PACK_ACTIONS = 4;

/** Permissiveness order of dext approval profiles (`ask` behaves like a prompt; headless dext denies). */
export const APPROVAL_RANK = { never: 0, ask: 0, "auto-read": 1, "auto-write": 2, always: 3 };

/** Curated day-1 gallery. Keyed by pack name; PACK.md `ui-*` keys override. */
export const GALLERY_DEFAULTS = {
  "hello-chart": {
    starter_prompt: "Run hello-chart",
    artifact: "chart", time_to_first_artifact: 10, requires: [], gallery: true, tags: ["sample"], icon: "chart",
  },
  report: {
    starter_prompt: "Summarise this workspace: what is here, what looks unfinished, top 3 risks — as an HTML report",
    artifact: "html", time_to_first_artifact: 45, requires: ["approval:auto-write"], gallery: true, tags: ["research", "summary"], icon: "report",
  },
  autoresearch: {
    starter_prompt: "Pick one measurable thing in this workspace (a test suite's wall time, a script's runtime, a bundle size), try 3 variations, keep the best, show the numbers as a chart",
    artifact: "chart", time_to_first_artifact: 90, requires: ["approval:auto-write"], gallery: true, tags: ["research", "loop"], icon: "loop",
  },
  crew: {
    starter_prompt: "Plan a 3-worker crew to audit this repo for dead code, TODOs and missing tests; show the plan only",
    artifact: "table", time_to_first_artifact: 40, requires: [], gallery: true, tags: ["orchestration"], icon: "crew",
  },
  packopt: {
    starter_prompt: "Show me what packopt would optimise in the report pack; do not apply changes",
    artifact: "table", time_to_first_artifact: 60, requires: ["approval:auto-write"], gallery: true, tags: ["optimization", "meta"], icon: "tune",
  },
  agent_browser: {
    starter_prompt: "Fetch the title and first heading of example.com",
    artifact: "markdown", time_to_first_artifact: 20, requires: ["chromium"], gallery: true, tags: ["engineering", "browser"], icon: "browser",
  },
  lightpanda: {
    starter_prompt: "Fetch the title and first heading of example.com",
    artifact: "markdown", time_to_first_artifact: 15, requires: ["lightpanda"], gallery: true, tags: ["engineering", "browser"], icon: "browser",
  },
};

export function defaultUi(name) {
  return {
    starter_prompt: `/pack run ${name} `,
    artifact: "markdown",
    time_to_first_artifact: 0,
    requires: [],
    gallery: false,
    tags: [],
  };
}

/** Parse `dext pack list --verbose` (Packs N found / name / wrapped description / source: / shelf: / path:). */
export function parsePackListing(text) {
  const packs = [];
  let cur = null;
  for (const raw of String(text ?? "").split("\n")) {
    if (/^Packs\s+\d+\s+found/.test(raw) || /^\s*$/.test(raw)) continue;
    const name = /^ {2}(\S.*?)\s*$/.exec(raw);
    if (name) {
      // Any 2-space line starts a new entry; an invalid name still ends the previous one.
      if (PACK_NAME_RE.test(name[1])) {
        cur = { name: name[1], description: "", source: "", path: "", shelf: undefined };
        packs.push(cur);
      } else cur = null;
      continue;
    }
    if (!cur) continue;
    const field = /^ {4}(source|shelf|path):\s*(.*)$/.exec(raw);
    if (field) {
      if (field[1] === "shelf") cur.shelf = field[2].trim() || undefined;
      else cur[field[1]] = field[2].trim();
      continue;
    }
    if (/^ {4}\S/.test(raw)) cur.description = cur.description ? `${cur.description} ${raw.trim()}` : raw.trim();
  }
  return packs.filter((p) => p.path);
}

function yamlScalar(v) {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1).trim();
  return t;
}

function yamlList(v) {
  const t = yamlScalar(v);
  const inner = t.startsWith("[") && t.endsWith("]") ? t.slice(1, -1) : t;
  return inner.split(",").map(yamlScalar).filter(Boolean).slice(0, 16);
}

/** Flat `ui-*` keys from PACK.md front matter. Same line grammar as dext's parser. */
export function parsePackUi(text) {
  const lines = String(text ?? "").split("\n");
  if (lines[0]?.trim() !== "---") return {};
  const ui = {};
  for (const line of lines.slice(1)) {
    const t = line.trim();
    if (t === "---") break;
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf(":");
    if (i < 0) continue;
    const key = t.slice(0, i).trim().toLowerCase().replace(/_/g, "-");
    const value = t.slice(i + 1);
    switch (key) {
      case "ui-starter-prompt": ui.starter_prompt = yamlScalar(value).slice(0, 400); break;
      case "ui-artifact": { const a = yamlScalar(value).toLowerCase(); if (ARTIFACTS.has(a)) ui.artifact = a; break; }
      case "ui-time-to-first-artifact": { const n = Number(yamlScalar(value)); if (Number.isFinite(n) && n >= 0) ui.time_to_first_artifact = Math.round(n); break; }
      case "ui-requires": ui.requires = yamlList(value); break;
      case "ui-gallery": ui.gallery = /^(true|yes|1)$/i.test(yamlScalar(value)); break;
      case "ui-tags": ui.tags = yamlList(value); break;
      case "ui-icon": ui.icon = yamlScalar(value).slice(0, 32); break;
      case "ui-panel": { const p = yamlScalar(value); if (PACK_PANEL_RE.test(p)) ui.panel = p; break; }
      case "ui-actions": ui.actions = parsePackActions(value); break;
      default: break;
    }
  }
  return ui;
}

/** `label | prompt ; label2 | prompt2` — semicolons separate actions, the
 *  first `|` splits label from prompt. Prompts keep starter-prompt caps. */
function parsePackActions(value) {
  const out = [];
  for (const part of String(value ?? "").split(";")) {
    if (out.length >= MAX_PACK_ACTIONS) break;
    const i = part.indexOf("|");
    if (i < 0) continue;
    const label = part.slice(0, i).trim().slice(0, 32);
    const prompt = part.slice(i + 1).trim().slice(0, 400);
    if (label && prompt) out.push({ label, prompt });
  }
  return out;
}

/** Read PACK.md without following symlinks; unreadable/oversized → {}. */
export function readPackUi(packDir) {
  const file = path.join(packDir, "PACK.md");
  try {
    if (!checkedPath(file)) return {};
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > PACK_MD_CAP) return {};
      const buf = Buffer.alloc(Math.min(st.size, 64 * 1024));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return parsePackUi(buf.toString("utf8", 0, n));
    } finally { fs.closeSync(fd); }
  } catch { return {}; }
}

function onPath(bin, env) {
  return (env.PATH ?? "").split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin)));
}

/** Requirements this host cannot satisfy for a session at `approval`. */
export function unmetRequirements(requires, { approval, env = process.env } = {}) {
  const out = [];
  for (const r of requires) {
    const [kind, arg] = r.split(":");
    if (kind === "approval") {
      if (approval !== undefined && (APPROVAL_RANK[arg] ?? 99) > (APPROVAL_RANK[approval] ?? 0)) out.push(r);
    } else if (kind === "chromium") {
      if (!["agent-browser", "chromium", "chromium-browser", "google-chrome", "chrome"].some((b) => onPath(b, env))) out.push(r);
    } else if (kind === "lightpanda") {
      if (!onPath("lightpanda", env)) out.push(r);
    } else if (kind === "connector") {
      out.push(r); // no connector proxy in local mode
    }
    // Unknown kinds are informational; never block on what we cannot check.
  }
  return out;
}

/** Full catalog entries from a listing, with defaults and PACK.md overrides merged. */
export function buildCatalog(listingText, { approval, env = process.env, readUi = readPackUi } = {}) {
  return parsePackListing(listingText).map((p) => {
    const ui = { ...defaultUi(p.name), ...(GALLERY_DEFAULTS[p.name] ?? {}), ...readUi(p.path) };
    ui.requires = [...new Set(ui.requires)];
    return { ...p, ui, unmet: unmetRequirements(ui.requires, { approval, env }) };
  }).sort((a, b) => {
    // Gallery cards first, fastest artifact first; everything else alphabetical.
    if (a.ui.gallery !== b.ui.gallery) return a.ui.gallery ? -1 : 1;
    if (a.ui.gallery) {
      const d = (a.ui.time_to_first_artifact || 1e9) - (b.ui.time_to_first_artifact || 1e9);
      if (d !== 0) return d;
    }
    return a.name.localeCompare(b.name);
  });
}

/** Shallow, read-only directory listing (no contents, no symlink targets).
 *  Never throws: a symlinked ancestor yields an empty listing, like readPackUi. */
export function listPackFiles(packDir) {
  try {
    if (!checkedPath(packDir)) return [];
    return fs.readdirSync(packDir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") && !e.isSymbolicLink())
      .slice(0, 200)
      .map((e) => {
        if (e.isDirectory()) return { name: e.name, kind: "dir" };
        let bytes;
        try { bytes = fs.lstatSync(path.join(packDir, e.name)).size; } catch { /* listing only */ }
        return { name: e.name, kind: "file", bytes };
      });
  } catch { return []; }
}

// ---------- pack file editing (x-agentlinkd.pack.{files,file,write}) ----------

/** Per-file cap for the pack editor: large enough for real PACK.md/src files,
 *  small enough that a client cannot ask the host to slurp binaries or logs. */
export const PACK_FILE_CAP = 256 * 1024;

/** The editable text surface of a pack: relative paths only, no dotfiles or
 *  dot-directories (rules out .git), no traversal (segments cannot be `..`),
 *  at most 12 segments, and a text-extension allowlist (rules out bin/crew). */
export const PACK_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,11}\.(?:md|txt|json|js|mjs|cjs|ts|svelte|html|css|sh|py|rs|toml|yaml|yml|xml|svg)$/;

/** "ok" | "missing" | "refused" — checkedPath conflates missing and symlink;
 *  the editor needs the distinction (no_file/no_dir vs bad_path). */
function pathState(p) {
  try {
    return checkedPath(p) ? "ok" : "missing";
  } catch {
    return "refused";
  }
}

/** Resolve a client-supplied relative path against a pack dir, or null when it
 *  leaves the editable surface. The regex already excludes `..`, absolute
 *  paths, and dotfiles, so join is traversal-safe. */
export function resolvePackPath(packDir, rel) {
  if (typeof rel !== "string" || rel.length > 512 || !PACK_FILE_RE.test(rel)) return null;
  return path.join(packDir, ...rel.split("/"));
}

/** Read one editable pack file. Symlinks — the final component or any
 *  ancestor, including the pack dir itself — are refused; missing parents and
 *  missing files are `no_file`; oversized or non-text files report errors
 *  rather than truncating. */
export function readPackFile(packDir, rel, { cap = PACK_FILE_CAP } = {}) {
  const abs = resolvePackPath(packDir, rel);
  if (!abs) return { error: "bad_path" };
  try {
    const parent = pathState(path.dirname(abs));
    if (parent === "missing") return { error: "no_file" };
    if (parent !== "ok") return { error: "bad_path" };
    const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return { error: "bad_path" };
      if (st.size > cap) return { error: "too_large" };
      const buf = Buffer.alloc(st.size);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.toString("utf8", 0, n);
      if (text.includes("\0")) return { error: "not_text" };
      return { path: rel, bytes: n, text };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { error: err?.code === "ENOENT" ? "no_file" : "bad_path" };
  }
}

/** Atomically write one editable pack file. Never follows symlinks, never
 *  creates directories (a missing parent is `no_dir`), never writes over a
 *  non-regular file. The caller refreshes the pack catalog afterwards. */
export function writePackFile(packDir, rel, text, { cap = PACK_FILE_CAP } = {}) {
  const abs = resolvePackPath(packDir, rel);
  if (!abs) return { error: "bad_path" };
  if (typeof text !== "string") return { error: "bad_request" };
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > cap) return { error: "too_large" };
  try {
    if (pathState(packDir) !== "ok") return { error: "bad_path" };
    let existing = null;
    try {
      existing = fs.lstatSync(abs);
    } catch {
      /* new file */
    }
    if (existing && !existing.isFile()) return { error: "bad_path" };
    const parent = pathState(path.dirname(abs));
    if (parent !== "ok") {
      // Missing parent + new file → the editor creates files in existing
      // dirs only; a symlinked parent is always a confinement refusal, even
      // when the target itself resolves to a real file through it.
      if (!existing && parent === "missing") return { error: "no_dir" };
      return { error: "bad_path" };
    }
    const tmp = path.join(packDir, `.dextui-${crypto.randomBytes(6).toString("hex")}.tmp`);
    fs.writeFileSync(tmp, text, { flag: "wx" });
    fs.renameSync(tmp, abs);
    return { path: rel, bytes };
  } catch {
    return { error: "write_failed" };
  }
}

/** Recursive listing for the pack editor: relative paths, real directories
 *  only (never descends into symlinks), dotfiles skipped, depth- and
 *  entry-capped, each file flagged against the editable allowlist. */
export function listPackTree(packDir, { maxEntries = 500, maxDepth = 8 } = {}) {
  const out = [];
  const walk = (dir, prefix, depth) => {
    let entries;
    try {
      // Byte order, not locale: listings must be deterministic across hosts.
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxEntries) return;
      if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        out.push({ path: prefix + e.name, kind: "dir" });
        if (depth + 1 <= maxDepth) walk(path.join(dir, e.name), `${prefix}${e.name}/`, depth + 1);
      } else if (e.isFile()) {
        let bytes;
        try {
          bytes = fs.lstatSync(path.join(dir, e.name)).size;
        } catch {
          /* listing only */
        }
        out.push({ path: prefix + e.name, kind: "file", bytes, editable: PACK_FILE_RE.test(prefix + e.name) });
      }
    }
  };
  try {
    if (pathState(packDir) !== "ok") return [];
    walk(packDir, "", 0);
    return out;
  } catch {
    return [];
  }
}

/** `/` completion entries: one per pack plus the management verbs. */
export function packCommands(catalog) {
  return [
    ...catalog.map((p) => ({ cmd: `/pack run ${p.name}`, desc: p.description.slice(0, 90) })),
    { cmd: "/pack list", desc: "list installed packs" },
    { cmd: "/pack create", desc: "scaffold <shelf>/<name> (next: describe it in chat)" },
    { cmd: "/pack inspect", desc: "show a pack's PACK.md summary" },
  ];
}

/** Parse `/pack …` text. Returns null when it is not a pack command. */
export function parsePackSlash(raw) {
  const m = /^\/packs?\b\s*(.*)$/s.exec(String(raw ?? "").trim());
  if (!m) return null;
  const rest = m[1].trim();
  if (!rest || /^(list|ls)$/.test(rest)) return { sub: "list" };
  const words = rest.split(/\s+/);
  const verb = words[0];
  // Strip tokens positionally (never by search: a name like "un" occurs inside "run").
  const afterVerb = rest.slice(verb.length).trimStart();
  if (/^(run|use|start)$/.test(verb)) {
    const name = words[1] ?? "";
    const task = name ? afterVerb.slice(name.length).trim() : "";
    return { sub: "run", name, task };
  }
  if (/^(inspect|info|show)$/.test(verb)) return { sub: "inspect", name: words[1] ?? "" };
  if (/^(create|new)$/.test(verb)) return { sub: "create", selector: words[1] ?? "" };
  // `/pack <name> <task>` shorthand, mirroring the CLI.
  if (PACK_NAME_RE.test(verb) && words.length > 1) return { sub: "run", name: verb, task: afterVerb.trim() };
  return { sub: "unknown", verb };
}

/** Structured slash rendering of the catalog. */
export function renderPackList(catalog) {
  if (catalog.length === 0) return "packs: none installed\n  create one: /pack create <shelf>/<name>";
  const w = Math.max(...catalog.map((p) => p.name.length));
  const lines = [`packs  ${catalog.length} installed`];
  for (const p of catalog) {
    const flags = [p.ui.gallery ? "gallery" : "", ...p.unmet.map((u) => `needs ${u}`)].filter(Boolean).join(", ");
    lines.push(`  ${p.name.padEnd(w)}  ${p.shelf ?? "-"}  ${p.description.slice(0, 70)}${flags ? `  [${flags}]` : ""}`);
  }
  lines.push("", "run: /pack run <name> <task>   inspect: /pack inspect <name>   create: /pack create <shelf>/<name>");
  return lines.join("\n");
}
