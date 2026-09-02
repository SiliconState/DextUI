import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { ensureStarted } from "./lib/state.svelte";

ensureStarted();

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;

// Injected by vite `define` (see vite.config.ts); versions the SW registration
// so each build owns a fresh cache name.
declare const __BUILD_ID__: string;

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register(`/sw.js?v=${__BUILD_ID__}`).catch(() => {
    /* PWA is progressive; ignore */
  });
}
