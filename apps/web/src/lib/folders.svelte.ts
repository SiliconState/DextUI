// Folder picker state: consumer sessions are "a folder", chosen by click
// inside the host's confined root (hello_ok.home). Listings arrive as
// x-agentlinkd.dirs.list control replies; the picker never sees anything the
// host refuses to list (outside root, dot-dirs, symlinks).
import type { DirsListReply, Envelope } from "@dextui/protocol";
import { app, pushToast } from "./state.svelte";

export type FolderIntent = "open" | "move";

export const folders = $state({
  open: false,
  loading: false,
  listing: null as DirsListReply | null,
  /** What choosing a folder means: open a new session there, or move `moveId` to it. */
  intent: "open" as FolderIntent,
  /** Session being moved (intent "move"). */
  moveId: "",
  /** What to do with the chosen folder (default: open a session there). */
  onPick: null as ((path: string) => void) | null,
  /** Composer text to seed once the session opens (e.g. a pack starter). */
  seed: "",
  /** Move this client asked for and is waiting on; the matching
   *  session.configured{cwd} toasts once. Journal replay never toasts. */
  pendingMove: null as { id: string; path: string } | null,
});

export function foldersEnabled(): boolean {
  return app.caps.includes("dirs") && !!app.conn?.home;
}

/** A session can move folders when it exists, is not exited, and is between
 *  turns — the host refuses mid-turn (the agent's tool calls resolve paths
 *  against the folder right now), so the UI never offers it. */
export function movableSession(id = app.activeId): { id: string; title: string; cwd: string } | null {
  if (!id || !foldersEnabled()) return null;
  const s = app.sessions.find((x) => x.id === id);
  if (!s || s.status === "exited" || app.conn?.session(id).state.working) return null;
  return { id: s.id, title: s.title, cwd: s.cwd ?? "" };
}

/** Open the picker at `path` (default: the root). `seed` prefills the composer of the session that opens.
 *  `intent: "move"` targets `session` (default: the active one) and starts inside its current folder. */
export function openFolderPicker(opts: { path?: string; seed?: string; onPick?: (path: string) => void; intent?: FolderIntent; session?: string } = {}): void {
  const c = app.conn;
  if (!c || !foldersEnabled()) return;
  let intent: FolderIntent = opts.intent ?? "open";
  let moveId = "";
  let start = opts.path;
  if (intent === "move") {
    const m = movableSession(opts.session);
    if (!m) {
      const s = app.sessions.find((x) => x.id === (opts.session ?? app.activeId));
      const working = s && c.session(s.id).state.working;
      pushToast("warn", working ? "Wait for the current turn to finish before changing folders" : "No session to move — pick a folder to start one");
      if (working) return;
      intent = "open";
    } else {
      moveId = m.id;
      if (!start && m.cwd && (m.cwd === c.home || m.cwd.startsWith(c.home + "/"))) start = m.cwd;
    }
  }
  folders.open = true;
  folders.intent = intent;
  folders.moveId = moveId;
  folders.seed = opts.seed ?? "";
  folders.onPick = opts.onPick ?? null;
  navigate(start ?? c.home);
}

export function closeFolderPicker(): void {
  folders.open = false;
  folders.onPick = null;
  folders.seed = "";
  folders.intent = "open";
  folders.moveId = "";
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

/** Distinct live-session folders under the picker root, most recent first
 *  (the rail's session order is recency). Shown as one-click chips. */
export function recentFolders(limit = 4): string[] {
  const home = app.conn?.home ?? "";
  if (!home) return [];
  const out: string[] = [];
  for (const s of app.sessions) {
    if (s.status === "exited" || !s.cwd || !s.cwd.startsWith(home + "/")) continue;
    if (!out.includes(s.cwd)) out.push(s.cwd);
    if (out.length >= limit) break;
  }
  return out;
}

/** Move a session to `path`: the host confines the path, refuses mid-turn,
 *  and (bridge) restarts the child at the next turn boundary with history
 *  intact. Confirmation arrives as session.configured{cwd} + an info marker. */
export function moveSession(id: string, path: string): void {
  const c = app.conn;
  const s = app.sessions.find((x) => x.id === id);
  if (!c || !s) return;
  if (s.cwd === path) {
    pushToast("ok", `Already in ${shortFolder(path)}`);
    return;
  }
  if (c.session(id).state.working) {
    pushToast("warn", "Wait for the current turn to finish before changing folders");
    return;
  }
  folders.pendingMove = { id, path };
  c.configureSession(id, { cwd: path });
  if (s.status === "cold") c.openSession({ id });
}

/** Choose a folder (`path`, default the listed one) with the picker's current
 *  intent; `intent` overrides it (⇧⏎ flips to the other action). */
export function pickCurrent(path?: string, intent?: FolderIntent): void {
  const c = app.conn;
  const p = path ?? folders.listing?.path;
  if (!p || !c) return;
  const hook = folders.onPick;
  const seed = folders.seed;
  const want = intent ?? folders.intent;
  const moveId = folders.moveId || app.activeId;
  closeFolderPicker();
  if (want === "move") {
    if (moveId) moveSession(moveId, p);
    return;
  }
  if (hook) {
    hook(p);
    return;
  }
  const existing = app.sessions.find((s) => s.cwd === p && s.status !== "exited");
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
  c.openSession({ cwd: p, approval: "auto-write" });
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

/** Session-plane tap (wired from state.svelte.ts): the confirmation of a
 *  move this client asked for. Other clients' moves (and replayed history)
 *  show through the scrollback marker and the status line instead. */
export function onFolderEvent(env: Envelope): void {
  if (env.event !== "session.configured") return;
  const d = env.data as { cwd?: string };
  const pending = folders.pendingMove;
  if (!pending || typeof d?.cwd !== "string" || env.session !== pending.id) return;
  if (d.cwd !== pending.path) return;
  folders.pendingMove = null;
  pushToast("ok", `Moved to ${shortFolder(d.cwd)}`);
}

/** Short display of a path relative to the picker root. */
export function shortFolder(p: string): string {
  const home = app.conn?.home ?? "";
  if (home && p === home) return "Home";
  if (home && p.startsWith(home + "/")) return p.slice(home.length + 1);
  return p;
}
