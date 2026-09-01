import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { ensureStarted } from "./lib/state.svelte";

ensureStarted();

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    /* PWA is progressive; ignore */
  });
}
