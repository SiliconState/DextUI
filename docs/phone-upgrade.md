# Phone-first UX upgrade

## Audit and guardrails

The existing desktop workflow is the baseline, not a redesign target. The audit found useful foundations already shipped: viewport-aware shell sizing, nonce-tagged send/steer/stop delivery, focus-trapped mobile navigation, docked approvals, routine tool grouping, todo push refresh and a token-free sandboxed report viewer.

The largest presentation gaps were the bottom stack, missing in-page session state, inaccessible touch labels, raw-only inspection and phone readability. The work below leaves the agent, host storage, event fold and delivery semantics unchanged. Responsive styling moves shared components; the phone work disclosure is a presentation wrapper around the same blocks, not a second transcript model.

## Phases delivered

1. **Session hierarchy and touch decisions.** One shared header now replaces the legacy footer at all sizes; the desktop transcript/sidebar and input workflow remain intact. Surface title, short workspace name, state, context and full-auto warning. Keep one bottom composer. Mobile todos use a themed popout with real progress and no internal path. Approval cards get direct command/path previews and 44px actions. Mobile navigation groups known attention and offers swipe-to-reveal, with the accessible menu retained. Session controls gain a compact phone popover, permissions confirmation, context action, rounded costs and latest-history fork.
2. **Answers, evidence and results.** Phone prose is proportional; code remains mono. Tables reflow without duplicating their DOM. Fold technical work per visible user turn, not agent answers. Replace the raw-only inspector with readable/searchable/copyable Output / Command / Raw views. Keep desktop side-panel placement. Phone diffs use a compact launcher and full-height detail with wrapping. Report cards become prominent on phones; full-screen report surfaces prioritize Back and Share with other actions in overflow. Desktop report chrome stays visible.
3. **Verification.** Add pure helper tests and a loopback browser matrix at 390, 768 and 1280px across light, dim and dark. Capture each phase's session, controls, approval and simulated keyboard states; phase 2 also captures reports, tool output and a diff. Include the matrix in the normal browser gate. Physical phone certification is still manual.

## Fresh-eyes correction pass

The first pass had real structural problems: stacked header controls, tiny inherited sheet labels, duplicate permission controls, missing per-container width assertions, lost phone disclosure choices, and fake zero values for unavailable cost/context.

The correction replaces the legacy status/footer markup entirely with one 56px priority-based header. State is an actionable colored pill; context is a ring opening controls; Full auto is a persistent amber shield/label. Phone subtitle content truncates, never wraps into another toolbar row. Find/settings and secondary actions move to overflow; wide screens expose model/Find/settings inline. Working progress uses a 3px edge strip and actual reported totals only.

Single-column phone controls have readable labels, one permission policy control and explicit unknown metrics. Confirmation resets on close. Technical disclosure state is keyed with the other transcript disclosures and survives session switches/resizing. Tool/diff/report actions stay within their containers, wrap controls remain outside scrolling output, warnings and long identifiers wrap safely, and mobile todo reveal no longer changes the desktop preference. Modal backgrounds are inert and short-viewport overflow actions scroll on focus.

Verification now includes 144 header width/theme/state/permission combinations, long unbroken fixture content, per-container geometry, state navigation, focus restoration, disclosure persistence and keyboard simulation. Screenshots are under local `patches/fresh-eyes-review/`; dedicated fixture entries do not ship with the production app. Physical-device validation is still outstanding.

## Compact theme integration

The later refinement keeps desktop transcript/sidebar/diff behavior intact and reduces only its status bar to 32px for fine-pointer input. Title, workspace and Full auto now share one line; model/effort typography blends with the existing mono chrome. Touch layouts use a 44px bar of 44px targets, a single-line system-type title, a soft state capsule and an accessible amber Full auto shield.

Mobile session controls use the same compact themed popover style as Settings, capped at 304px wide. Secondary context/fork controls are folded by default. Details and todos use the same surface, border, palette and typography. Mobile todos are a popout, not a persistent strip; desktop todos remain unchanged. Closing a todo popout returns focus to the header rather than a removed overflow item. Mobile menus open downward from the top header; the earlier bottom anchoring dated from the removed footer.

Expanded phone work details fit their card: each step wraps to at most two lines (humanized summary over tool name and status), with no inner scrollbars or sideways panning; tapping a step opens full output. Batch labels, which repeat the steps beneath them, are omitted on phones. Backend shell guidance becomes a quiet **Bash tip** row inside the work container, including the warning-level advisory events emitted by core; identical repeats collapse with a count, warning-level tips retain amber styling, and the full text stays one tap away. Recognized batch-failure notices also stay inside the active/completed work container. Show all retains a work container for these notices and tips while restoring rich tools. The collapsed summary keeps title, a permanently visible **n steps**, and passed/failed icons and counts on the same 44px row. Narrow layouts compact outcome wording before hiding the title or total, keeping complete outcome labels in the accessible name; no overall task success or retry is inferred. Expanded thinking sits close beneath its label, without stacked row/body padding; 44px disclosure targets remain intact. Metadata-to-thinking spacing is balanced, and failure notices retain a little vertical padding. Batch-start labels stay inspectable when execution stops before their tools start. Turns with more than 24 rows show the newest 16 with **Show earlier**. User prompts render as a soft card, Copy appears once per answer rather than on every narration block, and the jump button counts new transcript blocks, not raw journal events.

Phone user/assistant prose is 14px with restrained headings, while code/work chrome stays mono and editable inputs stay 16px to prevent focus zoom. Theme/popup parity, default popup bounds, mobile todo progress/focus, desktop restoration and input-type-aware header sizing are covered by the browser gates. Current captures live in local `patches/refine-review/`.

The final routing pass gives title/workspace its own bounded Find-sized folder popup on both phone and desktop. The phone title button is capped at 112px rather than stretching across the header, Model is a separate entry, and the context ring/percentage are larger (38px SVG, 10px text). Browsing is allowed during work, while moving the active session remains disabled. Long folder names no longer push rows or Close beyond the popup.

Phone model, effort and permission rows drill into themed choice lists within the same popup. Models support provider groups and search; selections show checkmarks, Back restores row focus, and Full auto retains explicit confirmation. Desktop selectors remain unchanged. The regression fixture checks each routing path, choices, focus and keyboard-open bounds, plus expanded 31-step work with long unbroken identifiers and repeated tips.

## Meticulous correctness and history pass

The later audit adds a realistic 70-turn phone-history fixture, not only long-identifier geometry tests. Older-history loading preserves the reading anchor; final prose keeps Copy even with trailing notices; replacement snapshots no longer inflate the Latest badge. Phone prompts have consistent turn spacing and prose remains 14px system type with a 21px line height.

Session-scoped popups now close on switching, host resets and authentication loss. Runtime drawer status invalidates for compaction and session-state events. The inline diff viewer is mounted outside the inert transcript, isolates its background and restores launcher focus. Closed disclosure descendants are excluded from dialog tab order. Warning/auth markers are never swallowed as desktop work metadata. Workspace choices are blocked while a listing is loading, and late native-sharing failures cannot overwrite a replacement report's status. Tool metadata is limited to completed shell envelopes and valid retained timestamp pairs; empty output is not mislabeled as a failed search.

Verification: 378 tests, all browser gates, the 144-case matrix, expanded-work stress, picker routing/focus/keyboard checks and multi-turn history checks. Captures are local under `patches/meticulous-review/final/`. Physical-device keyboard and native-share certification remain outstanding.

## Deliberate tradeoffs

- **No change to steering.** The existing host capability determines whether a running follow-up is applied live or queued for a later turn. Relabeling this as a guaranteed queue would be misleading. Stop keeps the unsent draft and sends no new instruction.
- **No fabricated receipt.** The canonical block model does not preserve all historic turn outcomes, durations or retry counts. Summaries report actual steps and unsuccessful calls, not guessed retries or historical success. Current-turn failure drives the failure summary. Warnings, interruptions and authentication prompts remain visible. QA/backups embedded in an ordinary answer are not stripped by text heuristics.
- **No imaginary session status.** Unsubscribed session metadata lacks a runtime working flag. Needs-you is available globally, and working is accurate for subscribed stores. Other live rows explicitly say Open to check activity. A future lightweight runtime summary in SessionMeta is preferable to subscribing to every transcript.
- **No blind autonomy.** Full auto requires a confirmation, retains the existing `/approval always` behavior and shows a persistent warning. Always allow on an approval still uses the core's existing scope; this UI does not invent a narrower pattern grant.
- **No access-token sharing.** Native report sharing exports the HTML as a file, with a download fallback. It never exports an authenticated workspace URL. External share targets receive the report only after the user chooses Share.
- **No desktop transcript takeover.** Desktop retains the mono transcript, rich Bash cards, inline diffs, sidebar, popovers and keyboard shortcuts. Touch targets and labels also respond to pointer/hover capability rather than width alone.

## Follow-up work, not shipped

- Actionable closed-app notifications need service-worker push handling, server-side subscriptions, expiry/revocation and fail-closed approval actions. Browser permission cannot be granted by default. Existing hidden-tab notifications remain opt-in; unsupported platforms must not claim success.
- Exact turn receipts need durable turn boundaries/outcome/timing metadata. Prefer that small optional projection extension over heuristically classifying generated prose as operational logs.
- Message-level fork needs a stable mapping from displayed messages to authoritative complete-message history. Local ViewBlock IDs are not journal sequence numbers or core message indexes. Latest-history fork is the safe phone affordance now; per-message fork/retry/edit/long-press is deferred.
- Dedicated dictation, context-aware quick replies, workspace `@` search, richer touch command sheets, edge-swipe navigation, swipe-down dismissal, file-to-file diff gestures and haptics are follow-up UI work. The existing slash completion and attachment picker remain available. OS keyboard dictation is usable without adding an unreviewed speech service.

## Smallest claim-provenance protocol proposal

Add one optional extension event after a completed assistant message, for example `x-dext.claim_sources`. Existing text/tool events remain unchanged, and older clients may ignore it.

```json
{
  "version": 1,
  "message_seq": 120,
  "claims": [
    {
      "start_byte": 0,
      "end_byte": 42,
      "sources": [
        { "result_seq": 117, "call_id": "check-7", "line_start": 3, "line_end": 5 }
      ]
    }
  ]
}
```

Contract:

- `message_seq` identifies the canonical journaled `text_block_complete`, never a UI block ID. Host adapters map core message identity to this sequence. References are scoped to the session generation and cleared on clear/delete/fork remapping.
- Claim ranges are half-open UTF-8 byte offsets in that completed message, avoiding disagreement between Rust bytes and JavaScript UTF-16 indexes. The client converts offsets for display and rejects invalid or overlapping ranges.
- `result_seq` and `call_id` identify the exact journaled tool result, not a later rerun. Line ranges are inclusive, one-based lines of the unmodified canonical result content, split on LF. Any readable-output decoding must preserve a mapping back to raw lines; otherwise show the referenced raw content.
- A reference means **source attached**, not **claim proved**. The UI opens the exact excerpt and lets the user assess support. Missing output, invalid ranges or pruned results show Source unavailable, never a green verified badge.
- Only explicitly annotated claims can be labeled Unverified when `sources` is empty. Absence of this event means Provenance not provided for the answer; it must not label every sentence false or verified.
- Validate bounded counts, message/result identities, generation, offsets and line ranges before rendering. Journal the optional metadata for replay and include it in snapshots only when the fold genuinely adopts the extension.

This is a proposal only. No provenance or agent output contract has changed in this upgrade.

## Reproducing the review

See [mobile.md](mobile.md) for the verification chain and device checklist. To capture the browser matrix:

```sh
REVIEW_PHASE=2 SCREENSHOTS=patches/phone-upgrade/review bash apps/web/scripts/phone-review-test.sh
```

Screenshots are mock data in local ignored `patches/phone-upgrade/`, not published real sessions. The isolated test builds are removed on exit. A production web build followed by refresh deploys these UI changes; no host restart is needed.
