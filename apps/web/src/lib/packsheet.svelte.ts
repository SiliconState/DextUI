// PackSheet state: the pack editor overlay. Files arrive as whole-file
// payloads (host-capped at 256 KB, binaries/symlinks refused); saves are
// atomic host-side and the refreshed catalog follows via packs.changed.
import type { Envelope, PackFileEntry, PackFileReply, PackFilesReply, PackWriteReply } from "@dextui/protocol";
import { PACK_EXT } from "@dextui/protocol";
import { app, pushToast, prefillComposer, packStarter } from "./state.svelte";

export const packSheet = $state({
  open: false,
  pack: "",
  files: [] as PackFileEntry[],
  sel: "",
  text: "",
  savedText: "",
  /** file listing in flight */
  listing: false,
  /** file body in flight */
  loading: false,
  saving: false,
  error: "",
  /** sandboxed panel overlay (pack-declared `ui-panel`) */
  panelOpen: false,
  panelFile: "",
  panelHtml: "",
  panelLoading: false,
});

export function packEditEnabled(): boolean {
  return app.caps.includes("pack_edit");
}

export function packSheetDirty(): boolean {
  return packSheet.open && packSheet.text !== packSheet.savedText;
}

export function openPackSheet(name: string): void {
  const c = app.conn;
  if (!c || !packEditEnabled()) return;
  packSheet.open = true;
  packSheet.pack = name;
  packSheet.files = [];
  packSheet.sel = "";
  packSheet.text = "";
  packSheet.savedText = "";
  packSheet.error = "";
  packSheet.loading = false;
  packSheet.saving = false;
  packSheet.listing = true;
  app.galleryOpen = false;
  c.packFiles(name);
}

/** Open the pack's declared HTML panel in a fully sandboxed iframe. */
export function openPackPanel(name: string): void {
  const c = app.conn;
  const file = app.packs.find((x) => x.name === name)?.ui.panel;
  if (!c || !packEditEnabled() || !file) return;
  packSheet.panelOpen = true;
  packSheet.pack = name;
  packSheet.panelFile = file;
  packSheet.panelHtml = "";
  packSheet.panelLoading = true;
  packSheet.error = "";
  app.galleryOpen = false;
  c.packFile(name, file);
}

export function closePackSheet(): void {
  if (packSheet.saving) return; // never drop a save in flight mid-rename
  packSheet.open = false;
  packSheet.pack = "";
  packSheet.files = [];
  packSheet.sel = "";
  packSheet.text = "";
  packSheet.savedText = "";
  packSheet.error = "";
  closePackPanel();
}

export function closePackPanel(): void {
  packSheet.panelOpen = false;
  packSheet.panelFile = "";
  packSheet.panelHtml = "";
  packSheet.panelLoading = false;
}

export function selectFile(path: string): void {
  const c = app.conn;
  const entry = packSheet.files.find((f) => f.path === path);
  if (!c || !packSheet.open || path === packSheet.sel || !entry || entry.kind !== "file" || !entry.editable) return;
  packSheet.sel = path;
  packSheet.text = "";
  packSheet.savedText = "";
  packSheet.error = "";
  packSheet.loading = true;
  c.packFile(packSheet.pack, path);
}

export function savePackFile(): void {
  const c = app.conn;
  if (!c || !packSheet.open || !packSheet.sel || !packSheetDirty() || packSheet.saving) return;
  packSheet.saving = true;
  packSheet.error = "";
  c.packWrite(packSheet.pack, packSheet.sel, packSheet.text);
}

/** Prefill the composer with this pack's starter prompt and close the sheet. */
export function runWithPack(): void {
  const p = app.packs.find((x) => x.name === packSheet.pack);
  if (!p) return;
  prefillComposer(packStarter(p));
  closePackSheet();
}

/** Control-plane tap (registered from state.svelte.ts beside onCrewControl). */
export function onPackControl(env: Envelope): void {
  switch (env.event) {
    case `${PACK_EXT}.files`: {
      const d = env.data as PackFilesReply | undefined;
      if (!d || d.pack !== packSheet.pack) return;
      packSheet.listing = false;
      packSheet.files = (d.files ?? []).filter((f) => f && typeof f.path === "string");
      if (!packSheet.files.some((f) => f.path === packSheet.sel)) {
        const first =
          packSheet.files.find((f) => f.path === "PACK.md" && f.editable) ??
          packSheet.files.find((f) => f.kind === "file" && f.editable);
        if (first) selectFile(first.path);
      }
      break;
    }
    case `${PACK_EXT}.file`: {
      const d = env.data as PackFileReply | undefined;
      if (!d || d.pack !== packSheet.pack) return;
      if (packSheet.panelOpen && d.path === packSheet.panelFile) {
        packSheet.panelLoading = false;
        packSheet.panelHtml = d.text;
        return;
      }
      if (d.path !== packSheet.sel) return;
      packSheet.loading = false;
      packSheet.text = d.text;
      packSheet.savedText = d.text;
      break;
    }
    case `${PACK_EXT}.write`: {
      const d = env.data as PackWriteReply | undefined;
      if (!d || d.pack !== packSheet.pack) return;
      packSheet.saving = false;
      packSheet.savedText = packSheet.text;
      pushToast("ok", `saved ${d.pack}/${d.path} (${d.bytes}B)`);
      const c = app.conn;
      if (c) {
        // Refresh sizes (and pick up a newly created file) — cheap.
        packSheet.listing = true;
        c.packFiles(packSheet.pack);
      }
      break;
    }
    case "error": {
      // Only ours while a sheet request is in flight; everything else is
      // handled by the app-level onControlError.
      if (!packSheet.saving && !packSheet.loading && !packSheet.panelLoading) return;
      const d = env.data as { code?: string; message?: string } | undefined;
      packSheet.saving = false;
      packSheet.loading = false;
      packSheet.panelLoading = false;
      packSheet.error = d?.message ?? d?.code ?? "request failed";
      break;
    }
  }
}
