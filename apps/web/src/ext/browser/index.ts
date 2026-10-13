import { registerCommand } from "../registry";
import { openBrowserTools } from "./state.svelte";

registerCommand({ slug: "browser.open", label: "Open a page — link, Float or local preview", group: "app", run: openBrowserTools });
