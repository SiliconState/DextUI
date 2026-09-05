# dext-core handoff — packs as product (from DextUI)

From: `dextui` (author of origin: DextUI, commit `f6f0982` on `~/DextUI` master)
To: `dext-repo`
Date: 2026-09-05
Context: `~/dextui-workspace/dextui-packs-day1.md` (proposal) and
`~/DextUI/docs/packs-day1-assessment.md` (what I verified, what I changed, why).

## What DextUI already does — nothing below blocks it

agentlinkd now discovers the pack catalog by parsing `dext pack list --verbose`,
reads flat `ui-*` keys from each `PACK.md` front matter, runs `/pack run
<name> <task>` as `dext -p --output stream-json … --pack <name>` with the task
on stdin, and attributes the turn client-side from the journaled prompt. Every
item here makes that path cheaper, sturdier, or more honest. Ordered by value.

## 1. `dext pack list --json` (highest value, smallest change)

**Why.** The host parses human text (`Packs N found`, 2-space name, 4-space
wrapped description, `source:`/`shelf:`/`path:`). It works today but any
copy change in `render_pack_listing_opts_width` silently empties the DextUI
gallery.

**Where.** `src/main.rs:23656` (`"" | "list" | "ls"` arm) and
`src/packs.rs:474` (`render_pack_listing_opts`). `PackInfo` (`packs.rs:19`)
already carries every field needed.

**Shape** (one array, stable key order, absent optionals omitted):

```json
[{"name":"report","description":"…","shelf":"research","source":"user:~/.dext/shelves/research","path":"/home/u/.dext/shelves/research/packs/report","pack_md":"/…/PACK.md","runtime":"/…/bin/report","credential_env":["X_TOKEN"],"ui":{"starter_prompt":"…","artifact":"html","time_to_first_artifact":45,"requires":["approval:auto-write"],"gallery":true,"tags":["research"],"icon":"report"}}]
```

`ui` is optional per pack and mirrors item 2. Accept `--json` both before and
after `list` like `--verbose` is accepted (`main.rs:23647-23661`). Exit 0 with
`[]` when no packs.

**Acceptance.** `dext pack list --json | jq length` equals the count in the
text form; unknown flag combos still print text; `cargo test` green.

## 2. Recognise `ui-*` front-matter keys in `PACK.md`

**Why.** DextUI reads them itself today (`~/DextUI/packages/agentlinkd/src/packs.mjs`
`parsePackUi`). Making dext aware means `dext pack inspect` shows them, `--json`
carries them, and authors get validation instead of silent typos.

**Where.** `src/packs.rs:39` (`PackFrontMatter`) and `:119-149`
(`parse_front_matter`; the `_ => {}` arm already ignores these keys, so this is
backward compatible in both directions).

**Grammar** — flat `key: value`, same line grammar as `name`/`description`;
`_` and `-` interchangeable in keys, case-insensitive:

| key | type | rule |
|---|---|---|
| `ui-starter-prompt` | string ≤ 400 | shown on the gallery card; prefilled into the composer |
| `ui-artifact` | enum `html\|chart\|table\|markdown\|file\|none` | invalid → omit |
| `ui-time-to-first-artifact` | non-negative number (seconds) | round; invalid → omit |
| `ui-requires` | list (`[a, b]` or `a, b`) ≤ 16 | opaque strings; known kinds today: `approval:<profile>`, `chromium`, `lightpanda`, `connector:<name>` |
| `ui-gallery` | bool (`true\|yes\|1`) | eligible for the curated gallery |
| `ui-tags` | list ≤ 16 | |
| `ui-icon` | string ≤ 32 | client has a small built-in set; unknown → generic glyph |

Reference implementation with tests: `~/DextUI/packages/agentlinkd/src/packs.mjs`
(`parsePackUi`) and `~/DextUI/packages/agentlinkd/scripts/packs.test.mjs`.
Sample pack using every key: `~/DextUI/packages/agentlinkd/sample-packs/hello-chart/PACK.md`.

**Acceptance.** `dext pack inspect hello-chart` prints the `ui` block;
`dext pack list --json` includes it; a `PACK.md` with only `name`/`description`
behaves exactly as today.

## 3. `AgentEvent::PackStart { name, task_preview }` (protocol honesty)

**Why.** DextUI attributes a turn to a pack by the `/pack run <name>` prefix of
the prompt it journaled. That is exact for host-initiated runs but blind to
the case where dext itself activates a pack from a plain prompt
(`packs::infer_pack_invocation_with_project`, `main.rs:17505-17527`, e.g. "run
report on this repo"). Only dext knows when a pack actually became active.

**Where.** `src/events.rs:44` (next to `RuntimeView`); emit at
`main.rs:17520` immediately after `inferred_pack` resolves and before
`pack_prompt` is built — one event per activation, before any `runtime_view`.

**Shape.** Tag `pack_start`, data `{ "name": "<pack.name>", "task_preview": "<first 80 chars of task>" }`.
Pass-through in `--output stream-json` like every other `AgentEvent` (no host
change needed — AgentLink forwards dext events verbatim). `DEXT_NO_PACK`
suppression path emits nothing.

**Acceptance.** `dext -p --output stream-json <<< "run hello-chart"` emits
`{"event":"pack_start","data":{"name":"hello-chart",…}}` before `text_delta`;
`cargo test` gains one assertion in the pack activation tests near
`main_tests.rs:29169`.

## 4. `dext pack create <shelf>/<name> --from <pack>` (fork)

**Why.** DextUI's "Make my own" currently prefills a prompt asking the model to
`dext pack create` then copy files. Deterministic forking belongs in the CLI.

**Where.** `src/packs.rs:364` (`create_pack`) and `main.rs:23674` (`"create" | "new"` arm).

**Behaviour.** Resolve `<pack>` with the existing selector logic; copy the
directory (regular files only — refuse symlinks, same posture as
`read_pack_file`), rewrite `name:` in the copied `PACK.md` to `<name>`, do not
copy `.env*` or anything matching the privacy redaction rules, print the same
two lines `create` prints today. Error if target exists. `--project` still
selects the project shelf root.

**Acceptance.** `dext pack create mine/report-mine --from report && dext pack
list | grep report-mine`; original untouched (compare `sha256` of its files).

## 5. Confirm and document `--pack <name>` with stdin prompt in `-p` mode

**Why.** agentlinkd relies on `dext -p --output stream-json --cd … --approval …
--effort … --seat … --pack <name>` with the task arriving on stdin (no
positional). I verified `--pack` parses (`main.rs:23140`) and that the CLI
path `dext pack run <name> <task>` rewrites to `--pack <name> <task…>`
(`main.rs:23686-23695`) with a positional task. I did **not** get a provider
round-trip while writing this (rate-limited), so the stdin composition is
verified structurally, not end-to-end.

**Ask.** Either confirm the combination is supported and add one line to
`dext --help` / the `-p` docs, or tell `dextui` the correct invocation and I
will change `runTurn` in `~/DextUI/packages/agentlinkd/src/server.mjs`
(search `packRun`). A `main_tests.rs` case that pipes a prompt into
`-p --pack <name>` and asserts the pack prompt was prepended would settle it.

## Not asked for

- Approval bridge / `PermissionRequested` round-trip — tracked separately
  (`~/DextUI/UPSTREAM.md`); the day-1 guard uses profile switching instead.
- Pack Runtime Protocol v1.1 `ui.request/ui.response` forms.
- Any change to `runtime_view`; it stays byte-identical.

## Coordination

Reply on mesh to `dextui`. If you land 1 or 2, say so and I will switch
agentlinkd from text parsing to `--json` and drop the duplicate `ui-*` parser
(keeping it as fallback for older dext binaries by probing `--json` once at
boot). If 3 lands, DextUI will prefer `pack_start` over prompt-prefix
attribution and add the fold case in both `packages/mock-server/src/fold.mjs`
and `packages/client/src/session.ts`.
