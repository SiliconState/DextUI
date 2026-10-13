<script lang="ts">
  import { browserTools, openBrowserTools, closeBrowserTools } from "./state.svelte";
</script>
<button class="browser-launcher" type="button" aria-label="Open a page" title="Open a page · Float · local preview" aria-haspopup="dialog" aria-expanded={browserTools.open} data-agent-id="browser.open" onclick={() => browserTools.open ? closeBrowserTools() : openBrowserTools()}>
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></svg>
</button>
<style>
  .browser-launcher { display:flex; align-self:center; align-items:center; justify-content:center; width:28px; height:24px; color:var(--dim); border:1px solid transparent; border-radius:3px; }
  .browser-launcher:hover, .browser-launcher[aria-expanded="true"] { background:var(--bg2); color:var(--cyan); border-color:var(--line); }
  @media (pointer:coarse) { .browser-launcher { width:44px; height:44px; } }
  @media (max-width:600px) { .browser-launcher { display:none; } }
</style>
