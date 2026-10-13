import { app } from "../../lib/state.svelte";

// Page tools: links open in the person's own browser; Float keeps a small
// DextUI on top; Preview frames a loopback dev server beside the chat.
export const browserTools = $state({ open: false, address: "", preview: "", floating: false });
let floatWindow: Window | null = null;

export const floatSupported = () =>
  typeof window !== "undefined" && "documentPictureInPicture" in window && matchMedia("(min-width: 901px)").matches;
export function openBrowserTools() {
  app.settingsOpen = false; app.sessionCtlOpen = false; app.contextOpen = false;
  app.statusDetailsOpen = false; app.todosOpen = false;
  browserTools.open = true;
}
export function closeBrowserTools() { browserTools.open = false; }
export function closePreview() { browserTools.preview = ""; }
export function setFloatWindow(w: Window | null) { floatWindow = w; }
export function floatDocument(): Document | null { return floatWindow && !floatWindow.closed ? floatWindow.document : null; }
/** Close the floating window; its pagehide handler restores the main composer. */
export function endFloat() { floatWindow?.close(); }
