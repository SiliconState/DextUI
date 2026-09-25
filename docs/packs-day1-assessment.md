# Packs Day-1: implementation assessment

Source: `~/dextui-workspace/dextui-packs-day1.md` (proposal, 2026-09-05).
Verified against `~/DextUI` (master) and `~/Dext/src` on 2026-09-05. Author of
origin: DextUI (agentlinkd + apps/web). Core items are handed to the dext-core
agent via the `mesh` pack; nothing below waits on them.

## Verdict

Worth doing, and doable in DextUI alone, but not as written. Six of the
document's load-bearing assumptions are false against the real codebases, and
one blocker is missing entirely: **packs cannot be run from the web today.**
The composer routes any `/`-prefixed text to the `slash` command, and
`agentlinkd`'s `handleSlash` accepts only `/help` and `/approval`; `/pack …`
returns `unsupported`. Every gallery click in the proposal would have hit that
wall. Fixing it is the day-1 enabler; the gallery is decoration on top.

## Findings (proposal → reality)

| # | Proposal assumes | Reality (file:line) | Decision |
|---|---|---|---|
| 1 | `dext pack list --json` | Does not exist. Only `--verbose\|-v\|--paths` (`main.rs:23646`). Verbose text is stable: `Packs N found`, then per pack `name` / wrapped description / `source:` / `shelf:` / `path:` | Parse verbose text like `discoverModels()` parses `auth models`. Core nice-to-have: `--json` |
| 2 | `/pack create --from <pack>` for forking | Does not exist. `create_pack(root, selector, project)` only (`packs.rs:364`) | "Make my own" prefills a prompt asking dext to `dext pack create` then copy files. Core nice-to-have: `--from` |
| 3 | Metadata in `pack.toml` with a `[ui]` table | No TOML anywhere. Metadata is `PACK.md` YAML front matter, flat `key: value`, keys `name`/`description`/`credential-env`; unknown keys ignored (`packs.rs:119-149`, `_ => {}`) | Flat front-matter keys `ui-starter-prompt`, `ui-artifact`, `ui-time-to-first-artifact`, `ui-requires`, `ui-gallery`, `ui-tags`, `ui-icon`. agentlinkd reads `PACK.md` itself; backward compatible today; core can adopt the same keys verbatim |
| 4 | Profiles `auto-read` / `auto-edit` | dext profiles: `ask\|auto-read\|auto-write\|never\|always` (`main.rs:23171`) | `approval:auto-write`. Permissiveness rank: never < auto-read < auto-write < always |
| 5 | `/pack run` reaches dext from the web | Rejected by `handleSlash` (`server.mjs:897-917`) | Host handles `/pack run\|list\|create\|inspect`. Run → `runTurn(s, task, {pack})` adds `--pack <name>` to the one-shot argv (`main.rs:23140`); task still on stdin. Name must resolve in the catalog, never pass free text to `--pack` |
| 6 | "Edit pack opens Finder at the pack dir" | Finder is a command palette (`Finder.svelte`), not a file browser | "Edit pack" prefills the composer with an edit prompt naming the pack path; dext edits in place; `packs.changed` refreshes |
| 7 | Welcome turn journaled as `user_message{hidden}` + `runtime_view`, triggered by `session.create{first_session}` from a control plane | No control plane in local mode; `hidden` needs fold changes in both mock and client folds and pollutes every export; the gallery is client-rendered from `hello_ok.packs` anyway (§3.3 says so) | **Not journaled.** Gallery renders client-side when a session is empty. Revisit for hosted mode |
| 8 | New sequenced event `turn_meta {pack}` after `turn_start` | Host already journals the prompt as `user_message`; a `/pack run <name>` prefix is authoritative and replays on old journals | Badge derived client-side from the turn's user block. No protocol change. Long-term home is a dext-core event (`pack_start`), handed off |
| 9 | `fs.watch` → `discoverPacks()` on change | `dextOutput()` is `spawnSync` (15 s timeout). Sync on the event loop would stall every WebSocket client | Boot stays sync (matches models). Refresh is async `execFile`, debounced 500 ms, serialized |
| 10 | Telemetry to `POST /telemetry`; sharing via presigned tarballs; OIDC | All need the hosted control plane | Out of scope for local day 1 (phases B/E). No no-op stubs, nothing pretends to record |
| 11 | `samples/hello-chart` ships with the platform | Shelves live in `~/.dext/shelves`, outside the repo | Shipped in-repo at `packages/agentlinkd/sample-packs/hello-chart/`; one-line install in README. Curated day-1 starter prompts live host-side in `GALLERY_DEFAULTS` keyed by pack name so the gallery is populated without editing installed packs; `PACK.md` `ui-*` keys override |
| 12 | Approval guard is a mitigation | Under `auto-read` (this host's default) every file-writing pack is denied silently by headless dext | Guard is load-bearing. `report`, `autoresearch`, `packopt` declare `approval:auto-write`; the host refuses with `pack_requires_profile` and the client offers one-click `/approval auto-write` |

Also verified: dext infers pack invocation from prompt text starting with
`run|use|start|launch|invoke|execute|apply <name>` (`packs.rs:656-670`,
`main.rs:17505-17527`). The host does not rely on it, `--pack` is explicit,
but it means "run report on this repo" typed by hand already works once the
slash barrier is gone.

## What ships (DextUI only)

Protocol: capability `packs`; `hello_ok.packs: PackInfo[]`; control event
`packs.changed {packs[]}`; error code `pack_requires_profile` with
`data.required`.

agentlinkd: `discoverPacks()` (verbose parse + `PACK.md` `ui-*` + defaults);
`/pack run|list|create|inspect` in `handleSlash`; `--pack` argv in `runTurn`;
`GET /packs`, `GET /packs/:name` (shallow, symlink-refusing, no contents);
`fs.watch` on `~/.dext/shelves`, `~/.dext/packs`, `<cwd>/.dext/shelves`
(recursive, debounced, async refresh, `packs.changed` push); `/pack run <name>`
also accepted through `prompt.submit` so `/__agent` drivers can use it;
dynamic `COMMANDS` so the `/` menu lists every pack.

apps/web: `PackGallery.svelte` (hero + empty session + `g` overlay; greyed
cards show the unmet requirement); pack badge on turns; `view` blocks get a
footer (Run again · Edit pack · Make my own); "packs" section in the rail;
composer `prefill`; toast actions (one-click profile switch).

mock-server: three fake packs, `/pack run` → echo turn with a `runtime_view`,
so the browser smoke and dev flow exercise the gallery without dext.

## Handed to dext-core (not blocking)

1. `dext pack list --json`: machine-readable catalog.
2. `PACK.md` front matter: recognise the `ui-*` keys (parser already ignores
   unknown keys; this is about `pack inspect` echoing them).
3. `pack_start {name, task_preview}` `AgentEvent` when a pack activates
   (`main.rs:17520`), so hosts stop inferring attribution from prompt text.
4. `dext pack create <shelf>/<name> --from <pack>`: fork.
5. Confirm/document `--pack <name>` + stdin prompt in `-p` mode (agentlinkd
   depends on it; verified by argv assertion against a fake dext only, a
   provider round-trip was not available while writing this).

## Risks accepted

- `--pack` + stdin composition (item 5 above) is verified structurally, not
  end-to-end. If it fails, the model still receives the task without the
  pack prompt; the badge and the audit trail are still correct.
- Gallery packs that depend on Chromium (`agent_browser`, `lightpanda`) are
  shown greyed with `requires: chromium` when `agent-browser`/`chromium` is
  not on PATH; never hidden.
