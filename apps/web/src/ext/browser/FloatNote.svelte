<script lang="ts">
  import { endFloat } from "./state.svelte";
</script>
<div class="float-note" data-agent-id="browser.float.note">
  <span>The message box is in the Float window.</span>
  <button class="act accent" data-agent-id="browser.float.end" onclick={endFloat}>Bring it back</button>
</div>
<style>
  .float-note { display: flex; align-items: center; gap: 12px; padding: 6px 10px; color: var(--dim); font: 12px/1.4 var(--sans); }
  .float-note button { min-height: 28px; }
</style>
