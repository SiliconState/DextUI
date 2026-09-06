// Folder picker state: consumer sessions are "a folder", chosen by click
// inside the host's confined root (hello_ok.home). Listings arrive as
// x-agentlinkd.dirs.list control replies; the picker never sees anything the
// host refuses to list (outside root, dot-dirs, symlinks).
import type { DirsListReply, Envelope } from "@dextui/protocol";
import { app, pushToast } from "./state.svelte";

export const folders = $state({
  open: false,
  loading: false,
  listing: null as DirsListReply | null,
  /** What to do with the chosen folder (default: open a session there). */
  onPick: null as ((path: string) => void) | null,
  /** Composer text to seed once the session opens (e.g. a pack starter). */
  seed: "",
});

export function foldersEnabled(): boolean {
  return app.caps.includes("dirs") && !!app.conn?.home;
}

/** Open the picker at `path` (default: the root). `seed` prefills the composer of the session that opens. */
export function openFolderPicker(opts: { path?: string; seed?: string; onPick?: (path: string) => void } = {}): void {
  const c = app.conn;
  if (!c || !foldersEnabled()) return;
  folders.open = true;
  folders.seed = opts.seed ?? "";
  folders.onPick = opts.onPick ?? null;
  navigate(opts.path ?? c.home);
}

export function closeFolderPicker(): void {
  folders.open = false;
  folders.onPick = null;
  folders.seed = "";
}

export function navigate(path: string): void {
  const c = app.conn;
  if (!c) return;
  folders.loading = true;
  c.dirsList(path);
}

export function createFolder(name: string): void {
  const c = app.conn;
  if (!c || !folders.listing) return;
  folders.loading = true;
  c.dirsCreate(folders.listing.path, name);
}

/** Choose the current folder: open a session there (or run the caller's hook). */
export function pickCurrent(): void {
  const l = folders.listing;
  const c = app.conn;
  if (!l || !c) return;
  const hook = folders.onPick;
  const seed = folders.seed;
  closeFolderPicker();
  if (hook) {
    hook(l.path);
    return;
  }
  const existing = app.sessions.find((s) => s.cwd === l.path && s.status !== "exited");
  if (existing) {
    app.activeId = existing.id;
    if (existing.status === "cold") c.openSession({ id: existing.id });
    c.subscribe(existing.id);
    if (seed) app.prefill = { text: seed, n: Date.now() };
    return;
  }
  if (seed) app.pendingDraft = seed;
  // Consumer packs write files (ledgers, invoices): auto-write from the start
  // so the first run is not refused for a missing permission.
  c.openSession({ cwd: l.path, approval: "auto-write" });
}

/** Control-plane tap (wired from state.svelte.ts). */
export function onDirsControl(env: Envelope): void {
  if (env.event === "x-agentlinkd.dirs.list") {
    const d = env.data as DirsListReply;
    if (!d || typeof d.path !== "string") return;
    folders.loading = false;
    folders.listing = { ...d, dirs: [...(d.dirs ?? [])] };
    if (d.created) pushToast("ok", `Folder created: ${d.created.split("/").pop()}`);
    return;
  }
  if (env.event === "error") {
    const d = env.data as { code: string; message: string; cmd?: string };
    if (typeof d?.cmd === "string" && d.cmd.startsWith("x-agentlinkd.dirs.")) {
      folders.loading = false;
      pushToast("warn", d.message);
    }
  }
}

/** Short display of a path relative to the picker root. */
export function shortFolder(p: string): string {
  const home = app.conn?.home ?? "";
  if (home && p === home) return "home";
  if (home && p.startsWith(home + "/")) return p.slice(home.length + 1);
  return p;
}
