// Folder picking for consumer sessions ("work in a folder", not "type a repo
// path"). Confined to one root (the operator's HOME by default): every
// request path must resolve under it, no symlinks anywhere on the way, no
// dot-directories, listings capped. Pure functions over `fs`; the host maps
// them onto x-agentlinkd.dirs.{list,create}.
import fs from "node:fs";
import path from "node:path";
import { checkedPath } from "./session-files.mjs";

const MAX_ENTRIES = 300;
export const DIR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,79}$/;

/** Resolve `requested` (absolute, or relative to `root`) and confine it. */
export function confine(root, requested) {
  const base = path.resolve(root);
  const abs = typeof requested === "string" && requested.trim() ? path.resolve(base, requested.trim()) : base;
  if (abs !== base && !abs.startsWith(base + path.sep)) return { error: "outside_root" };
  // No dot-segment anywhere under the root (~/.dext, ~/.ssh, …).
  const rel = abs === base ? "" : abs.slice(base.length + 1);
  if (rel.split(path.sep).some((seg) => seg.startsWith("."))) return { error: "hidden" };
  let ok;
  try {
    ok = checkedPath(abs);
  } catch {
    return { error: "refused" };
  }
  if (!ok) return { error: "missing" };
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return { error: "missing" };
  }
  if (!st.isDirectory()) return { error: "not_dir" };
  return { abs, rel };
}

/** `{ path, rel, parent, dirs: [{name, has_children?}], truncated }` or `{ error }`. */
export function listDirs(root, requested) {
  const c = confine(root, requested);
  if (c.error) return c;
  const base = path.resolve(root);
  let entries;
  try {
    entries = fs.readdirSync(c.abs, { withFileTypes: true });
  } catch {
    return { error: "unreadable" };
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const truncated = dirs.length > MAX_ENTRIES;
  const files = entries.filter((e) => e.isFile() && !e.name.startsWith(".")).length;
  return {
    path: c.abs,
    rel: c.rel,
    parent: c.abs === base ? null : path.dirname(c.abs),
    root: base,
    dirs: dirs.slice(0, MAX_ENTRIES).map((name) => ({ name })),
    files,
    truncated,
  };
}

/** Create one folder under a confined parent. Never creates parents. */
export function createDir(root, parent, name) {
  if (typeof name !== "string" || !DIR_NAME_RE.test(name) || name.startsWith(".")) return { error: "bad_name" };
  const c = confine(root, parent);
  if (c.error) return c;
  const abs = path.join(c.abs, name);
  try {
    fs.mkdirSync(abs);
  } catch (err) {
    return { error: err?.code === "EEXIST" ? "exists" : "create_failed" };
  }
  return { path: abs, rel: c.rel ? `${c.rel}/${name}` : name };
}
