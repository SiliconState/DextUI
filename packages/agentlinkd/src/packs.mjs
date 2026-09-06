// Pack catalog for agentlinkd: parse `dext pack list --json` (or the older
// `--verbose` text), read the optional `ui-*` front-matter keys from each
// PACK.md, merge the curated gallery (gallery.json), and compute which
// requirements this host cannot satisfy.
// Pure functions except readPackUi/listPackFiles/loadGallery (filesystem, symlink-refusing).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { checkedPath } from "./session-files.mjs";

export const PACK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PACK_MD_CAP = 1024 * 1024;
const ARTIFACTS = new Set(["html", "chart", "table", "markdown", "file", "none"]);
/** Who a pack is for. `everyone` (or an empty list) shows in every persona's gallery. */
export const PERSONAS = new Set(["accountant", "business", "developer", "everyone"]);
/** Sandboxed panel: an .html file inside the pack (no dotfiles/traversal). */
const PACK_PANEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9_-]{0,63})*\.html$/;
const MAX_PACK_ACTIONS = 4;

/** Permissiveness order of dext approval profiles (`ask` behaves like a prompt; headless dext denies). */
export const APPROVAL_RANK = { never: 0, ask: 0, "auto-read": 1, "auto-write": 2, always: 3 };

/** Default curated gallery file, shipped beside this package. Overridable with
 *  `--gallery=<file>` / `DEXTUI_GALLERY` so a workspace (or DextUI editing
 *  itself) can curate without touching code. */
export const GALLERY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "gallery.json");
const GALLERY_CAP = 512 * 1024;

/** Bound one ui object from any source (gallery.json, `--json` ui block,
 *  PACK.md) to the wire shape; unknown keys and bad values are dropped. */
export function sanitizeUi(raw) {
  if (!raw || typeof raw !== "object") return {};
  const ui = {};
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : undefined);
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x).map((x) => x.slice(0, 64)).slice(0, 16) : undefined);
  const sp = str(raw.starter_prompt, 400);
  if (sp !== undefined) ui.starter_prompt = sp;
  if (typeof raw.artifact === "string" && ARTIFACTS.has(raw.artifact.toLowerCase())) ui.artifact = raw.artifact.toLowerCase();
  if (Number.isFinite(raw.time_to_first_artifact) && raw.time_to_first_artifact >= 0) ui.time_to_first_artifact = Math.round(raw.time_to_first_artifact);
  const req = list(raw.requires);
  if (req) ui.requires = req;
  if (typeof raw.gallery === "boolean") ui.gallery = raw.gallery;
  const tags = list(raw.tags);
  if (tags) ui.tags = tags;
  const icon = str(raw.icon, 32);
  if (icon) ui.icon = icon;
  const title = str(raw.title, 48);
  if (title) ui.title = title;
  const personas = list(raw.personas);
  if (personas) ui.personas = personas.map((p) => p.toLowerCase()).filter((p) => PERSONAS.has(p));
  if (typeof raw.panel === "string" && PACK_PANEL_RE.test(raw.panel)) ui.panel = raw.panel;
  if (Array.isArray(raw.actions)) {
    ui.actions = raw.actions
      .filter((a) => a && typeof a.label === "string" && typeof a.prompt === "string")
      .map((a) => ({ label: a.label.trim().slice(0, 32), prompt: a.prompt.trim().slice(0, 400) }))
      .filter((a) => a.label && a.prompt)
      .slice(0, MAX_PACK_ACTIONS);
  }
  return ui;
}

/** Read + sanitize gallery.json → `{ name: ui }`. Missing/invalid → {} (never throws). */
export function loadGallery(file = GALLERY_FILE) {
  try {
    if (!checkedPath(file)) return {};
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > GALLERY_CAP) return {};
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    const packs = v && typeof v === "object" && v.packs && typeof v.packs === "object" ? v.packs : {};
    const out = {};
    for (const [name, ui] of Object.entries(packs)) if (PACK_NAME_RE.test(name)) out[name] = sanitizeUi(ui);
    return out;
  } catch {
    return {};
  }
}

/** Curated gallery, loaded once at import. Kept under the historical export
 *  name; `buildCatalog({ gallery })` overrides it per call. */
export const GALLERY_DEFAULTS = loadGallery(process.env.DEXTUI_GALLERY || GALLERY_FILE);

export function defaultUi(name) {
  return {
    starter_prompt: `/pack run ${name} `,
    artifact: "markdown",
    time_to_first_artifact: 0,
    requires: [],
    gallery: false,
    tags: [],
    personas: [],
  };
}

/** Parse `dext pack list --json` (one array; `ui` optional per pack). Returns
 *  null when the text is not that shape so callers can fall back to the
 *  verbose-text parser for older dext binaries. */
export function parsePackListingJson(text) {
  const t = String(text ?? "").trim();
  if (!t.startsWith("[")) return null;
  let v;
  try {
    v = JSON.parse(t);
  } catch {
    return null;
  }
  if (!Array.isArray(v)) return null;
  const packs = [];
  for (const p of v) {
    if (!p || typeof p !== "object" || typeof p.name !== "string" || !PACK_NAME_RE.test(p.name) || typeof p.path !== "string" || !p.path) continue;
    packs.push({
      name: p.name,
      description: typeof p.description === "string" ? p.description : "",
      source: typeof p.source === "string" ? p.source : "",
      path: p.path,
      shelf: typeof p.shelf === "string" && p.shelf ? p.shelf : undefined,
      ...(typeof p.runtime === "string" && p.runtime ? { runtime: p.runtime } : {}),
      ...(Array.isArray(p.credential_env) ? { credential_env: p.credential_env.filter((e) => typeof e === "string").slice(0, 32) } : {}),
      ...(p.ui && typeof p.ui === "object" ? { ui: sanitizeUi(p.ui) } : {}),
    });
  }
  return packs;
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
      case "ui-title": { const t = yamlScalar(value).slice(0, 48); if (t) ui.title = t; break; }
      case "ui-personas": ui.personas = yamlList(value).map((p) => p.toLowerCase()).filter((p) => PERSONAS.has(p)); break;
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

/** Full catalog entries from a listing (JSON or verbose text), with defaults,
 *  the curated gallery, dext's own `ui` block and PACK.md overrides merged —
 *  in that order, later wins. */
export function buildCatalog(listingText, { approval, env = process.env, readUi = readPackUi, gallery = GALLERY_DEFAULTS } = {}) {
  const listing = parsePackListingJson(listingText) ?? parsePackListing(listingText);
  return listing.map((p) => {
    const { ui: coreUi, ...rest } = p;
    const ui = { ...defaultUi(p.name), ...(gallery[p.name] ?? {}), ...(coreUi ?? {}), ...readUi(p.path) };
    ui.requires = [...new Set(ui.requires)];
    return { ...rest, ui, unmet: unmetRequirements(ui.requires, { approval, env }) };
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
    try {
      fs.writeFileSync(tmp, text, { flag: "wx" });
      fs.renameSync(tmp, abs);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* never created, or already gone */ }
      throw err;
    }
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
    { cmd: "/pack list", desc: "List installed packs" },
    { cmd: "/pack create", desc: "Scaffold <shelf>/<name>, or copy one with --from <pack>" },
    { cmd: "/pack inspect", desc: "Show a pack's PACK.md summary" },
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
  if (/^(create|new)$/.test(verb)) {
    // `/pack create <shelf>/<name> [--from <pack>]` (also `--from=<pack>`).
    let from;
    for (let i = 2; i < words.length; i++) {
      if (words[i] === "--from" && words[i + 1]) from = words[++i];
      else if (words[i].startsWith("--from=")) from = words[i].slice("--from=".length);
    }
    return { sub: "create", selector: words[1] ?? "", ...(from ? { from } : {}) };
  }
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
