# Workspace `DEXT.md`: example for agents talking to DextUI

Copy this file to the session workspace (the `--cwd` the host launches dext
in, e.g. `~/dextui-workspace/DEXT.md`). dext reads it as project policy, so
every agent turn knows how to produce output the web UI can render. Keep the
live copy in sync with the renderer's actual capabilities (`Markdown.svelte`,
`Chart.svelte`, the host's session-files endpoint).

```markdown
# Workspace notes for dext agents (DextUI web host)

- Deliverables: write files under this workspace. To show them in the DextUI
  chat, reference them with RELATIVE paths in standard markdown:
  `![title](qc_charts/perf.png)` or `![dashboard](market_dashboard.html)`.
  Images render inline; `.html` files render in a sandboxed frame, and their
  nested relative images resolve. Do NOT use `file://` or `\\wsl.localhost\`
  paths in chat output, they cannot render there.
- Charts without files: a ```chart fence with JSON renders as an INTERACTIVE
  chart in the chat (hover values, drag points/bars to explore what-ifs with
  live min/max/mean/sum, click to highlight, sort by button or label,
  wheel-zoom/pan on lines, legend toggles, donut slice isolate). Spec:
  `{"type":"bar|hbar|line|spark|donut","labels":[...],"values":[...],"unit":"ms","x":"t","y":"v"}`
  Multi-series (line/bar): add `"series":[{"name":"a","values":[...]},...]`
  (all series same length; `values` optional then). Give related charts in one
  message the same `"dataset":"id"`: clicking/brushing one highlights the
  same index in its siblings. Caps: 31 points for bar/hbar/donut, 180 for
  line/spark, 8 series.
- The user can steer mid-turn: input sent while a turn runs is queued and
  auto-runs as the next turn, no need to ask them to stop anything.
- Python: `python3` exists, `pip3` does not. Create the venv once and reuse it
  (it persists across turns): `python3 -m venv .venv && .venv/bin/python -m ensurepip --upgrade`
  then `.venv/bin/pip install ...`.
- matplotlib has no display here: always `savefig()` into this workspace,
  never `plt.show()`.
- No chromium/chrome is installed, screenshot flows are unavailable. State
  the limitation instead of retrying.
```

The Python/browser bullets describe one particular host; adjust them to what
your machine actually has (the agent will otherwise plan around the wrong
constraints).

## Workbench (DextUI editing itself)

For the **workbench session**: cwd `~/DextUI`, opened from the Finder, add
these rules to that checkout's project policy (or keep them in the seeded
prompt the Finder inserts):

```markdown
# DextUI workbench

- This checkout is the app you are running in. Every edit is live after a rebuild.
- Prefer adding an extension under `apps/web/src/ext/<name>/` (fence, panel,
  Finder command, slash command, flow node) over editing App.svelte, Markdown.svelte,
  Finder.svelte or Composer.svelte. Zero runtime deps stays true.
- After web changes run `node packages/agentlinkd/scripts/ui-build.mjs` (add
  `--tests` for a full run). It builds into a staging dir and swaps in only if
  svelte-check passes; open tabs reload themselves. Do NOT run `vite build`
  directly, it empties the served `dist` mid-build.
- After host changes (`packages/agentlinkd/**`) write
  `{"reason":"<what changed>"}` to the restart request file shown by
  `/ui status` (default `~/.dextui/agentlinkd/restart.request`). The host
  restarts after your turn ends; do not kill it yourself.
- Run `npm test` before requesting a restart when you touched the host.
- If the UI is broken after your change: `node packages/agentlinkd/scripts/ui-build.mjs --rollback`.
```
