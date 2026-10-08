# Using DextUI on a phone

DextUI uses the same sessions, approvals and delivery protocol on desktop and phone. The phone layout changes how controls are presented, not what the agent is allowed to do.

## Composer and controls

At widths up to 600px, the composer is one nearly edge-to-edge rectangular bar with subtle corners. Attachment options, message input and Send/Queue share the same surface; the input is not a separate pill. An empty composer is about 58px tall. Buttons retain 44px touch targets, and message text stays at 16px to avoid iOS focus zoom.

- **Message:** starts at one line and grows with wrapped text. Long drafts scroll inside the input, capped at the smaller of 144px or roughly one quarter of the visible viewport, with a one-line minimum.
- **+ attachments:** opens **Attach files** and **Attach a link**. Tap outside or press Escape to dismiss it. Link entry and its unsent URL reset when switching sessions. Removing an attachment chip does not delete the uploaded workspace file.
- **Up arrow:** sends a message. It is disabled for an empty draft, while attachments are uploading, or when the connection/session cannot accept input.
- **Bent arrow during work:** queues a follow-up through the host's advertised `steering` capability. Core/host capabilities determine whether steering is applied live or delivered as a later turn. The control is labeled **Queue follow-up** for assistive technology.
- **Stop square:** interrupts current work without sending the draft. With no follow-up text or completed attachment, only Stop is shown on the right during work. Typing a follow-up reveals Queue alongside it.

Sending and steering retain the existing nonce-tagged delivery, reconnect replay and rejected/expired-draft restoration behavior. Phone send/stop pointer presses preserve input focus rather than deliberately dismissing the software keyboard.

## Keyboard behavior

Desktop Return sends, or accepts a slash completion before sending. Shift+Return inserts a newline. On touch-first layouts up to 900px, Return inserts a newline; use the explicit Send/Queue control or Ctrl/Cmd+Return to submit. This distinction is based on the browser's coarse-pointer media query, not on whether a physical keyboard is attached.

Slash suggestions are tappable. Escape dismisses suggestions without discarding the draft. Desktop history and Tab completion remain available. Ctrl/Cmd+B opens/closes session navigation, Ctrl/Cmd+K opens Finder, and Escape closes the active overlay or drawer.

## Sessions and status

At widths up to 900px, sessions move to an off-canvas drawer. The closed drawer is inert; opening it isolates the transcript/composer/status from keyboard focus. Tab wraps among visible enabled controls, and closing restores focus where appropriate. Finder opened above the drawer owns its own keyboard navigation. Selecting or creating a session closes the mobile drawer.

At every width, one shared compact header replaces the legacy status footer. Fine-pointer desktop uses a 32px row; phone/tablet and touch-first devices use a 44px bar made of 44px touch targets. Title, workspace/step, permission warning, state, context and overflow remain inline rather than stacking. Working is blue, Review amber, Done green and Failed red; tapping the state goes to progress, the pending decision, the latest result or error. Idle, Stopped, Closed and connection states remain distinct. A 2px progress edge appears during work, with a numeric total only when the runtime actually reports it.

On desktop the workspace or current step is followed by the amber Full auto shield/label on the same line. The bar uses the app's monospace chrome consistently, including model and effort. Phone widths use a compact title/workspace button capped at 112px (13px system type), rather than filling the header, and show Full auto as an amber shield only. A separate **Model** button opens model, effort and permissions; the state is a soft capsule and the context ring uses a 38px SVG with a 10px percentage. Title/workspace clicks open workspace selection on both phone and desktop; the context ring opens usage/session controls. The phone workspace picker is a bounded Find-sized popup, not full-screen. During work you can browse, but moving the current workspace is disabled. Find and settings move into **...** below 1100px, and appear inline with the model chip on wide screens. Background compaction, host restart and crew attention are signaled at overflow and detailed inside it. The composer remains the only persistent bottom bar on phones.

On phones, every menu (This session, details, Settings, todos) drops down below the header and stays within the visible viewport. **This session** is a Settings-style list at most 304px wide: label on the left, current value on the right and hairline rows. Model, thinking and permissions each open their own themed choice list inside the same popup, rather than an unrelated native dropdown. Models are searchable and grouped by provider; selected values have checkmarks. Back returns to the original row and restores focus; Escape backs out before closing the popup. Full auto shows its value in amber. Model, thinking, one permission selector, token counts and rounded costs are visible by default; **Context and fork** reveals compaction preferences and branching. It does not take over the screen unless the visible viewport is very short, when the content scrolls inside its bounds. The permission values are unchanged. Full auto requires explicit confirmation, which resets on close. Unknown cost/context is not reported as zero. Fork uses the latest saved history without a sequence input on mobile. Desktop keeps its original controls and optional sequence input. Session details, Settings, controls and todos share theme-token colors, compact borders and chrome typography.

Mobile todos open in a themed popout from overflow's **Show todos** or Finder's **Show session todos**. There is no persistent todo/path strip stealing transcript space. The popout includes actual counts/progress and wraps long items; closing restores focus to the header. Desktop disclosure and its saved preference are independent and unchanged. The drawer groups known session activity into Needs you / Working / Idle, with timestamps. Swipe left reveals the same confirmed actions as the accessible menu button; swipes never delete a session directly. Older metadata cannot distinguish an unsubscribed working session from idle, so those rows say **Open to check activity**, not a fabricated runtime state.

Safe-area padding reserves space around notches and the home indicator. At normal zoom, `visualViewport` height and offset keep the shell above the software keyboard; menu geometry follows viewport resize/pan. Pinch zoom is left under browser control. Desktop retains its dense terminal layout.

## Answers, evidence and reports

At widths up to 600px, answers and user messages use a proportional 14px system font with a restrained 14/16px heading hierarchy; code and operational chrome stay monospace. Thinking/todo/table text is slightly denser. Inputs remain 16px to avoid phone zoom. Desktop transcript typography is unchanged. Tables use the same semantic DOM but reflow into labeled rows. Work details (tools, thinking and routine markers) collapse per visible user turn, preserving disclosure choices across sessions and resizing. Expanded steps wrap inside their card without nested scrollbars; tap for full output. Duplicate batch-start labels are omitted and repeated informational shell guidance becomes one expandable Tip with a count. Warnings, batch failures and authentication prompts are never filtered as guidance. More than 24 work rows initially show the newest 16 with Show earlier. Every answer, warning, authentication prompt and report stays visible. Unsuccessful tool steps are counted without claiming the agent retried or recovered; the current turn's failure flag drives the summary's failure color. **Show all** restores the lossless transcript presentation.

Tool **Details** opens Output / Command / Raw views, full-screen below 900px and in a side panel on desktop. Output decodes actual serialized JSON strings/streams, without rewriting literal code escapes. Search filters matching lines with original line numbers; Copy copies the selected tab. Exit code comes only from a completed shell-result envelope, never a matching line inside an inspected file. Duration uses a valid retained start/result pair and may be absent after replay. Empty output is distinguished from a search with no matches. Raw JSON remains available.

Phone inline diffs reduce to file names and addition/deletion counts; Open diff shows a viewport-height viewer with a wrap control. Tool-detail diffs share the same renderer without a nested vertical scroll box. Report cards become prominent phone launchers. Below 900px the report viewer is full-screen with Back, Share and an overflow menu for code, download and state actions. Share sends a local HTML file when supported, otherwise downloads a copy; it does not share a host access URL. Desktop retains its wide report panel and visible toolbar. Report content generation is unchanged.

## Reading history

Phone history keeps 14px system prose at a 21px line height, quiet prompt cards and consistent turn spacing. Code stays monospace; inputs remain 16px. Each visible turn retains Copy on its final prose block, even when notices or work follow it. Loading older history preserves the current reading anchor instead of jumping away. The Latest badge counts newly added blocks, not streamed token events or replacement snapshots.

Inline diff viewers isolate the background and restore focus to their launcher. Session switches, host resets and authentication loss close session-scoped popups instead of silently retargeting them. Closed disclosures are excluded from modal tab order.

## Verification and limitations

Run the normal web verification chain:

```sh
cd apps/web && npx svelte-check
cd ../.. && npm test
cd apps/web && npm run build
```

Root `npm run typecheck` and `npm run build` also check/build all workspaces. `npm run smoke:browser` runs the browser gates separately. Browser tests visibly skip when `agent-browser` is absent; a skipped gate is not a browser pass.

The browser suite builds an isolated `apps/web/dist.smoke` and runs a loopback mock host. It checks:

- Layout at 320x640, 375x667, 390x844, 430x932, 600x800 and 900x700, with desktop restoration afterward.
- Unified bar width, non-pill input, 44px controls, short placeholders, bounded composer height and no document-level horizontal overflow.
- Drawer tab boundaries, nested Finder focus, navigation shortcuts and New-session dismissal.
- Attachment-menu Escape/focus and link-entry cancellation.
- Touch Return, Send/Queue delivery, preserved input focus and Stop.
- Quiet Todos access through Finder, open-menu breakpoint changes, and simulated software-keyboard viewport resizing/panning.

The phone review gate additionally checks 390x844, 768x1024 and 1280x900 in light, dim and dark: shared header placement, controls, full-auto confirmation, approvals, report overflow/code/back, tool tabs/search/raw, wrap toggling and simulated keyboard-open layout. It builds a separate `dist.phone-review` and uses only a loopback mock. Capture its screenshot matrix with:

```sh
REVIEW_PHASE=2 SCREENSHOTS=patches/phone-upgrade/review bash apps/web/scripts/phone-review-test.sh
```

The adversarial header gate adds all 144 combinations of 360/390/499/501/768/1280px, light/dim/dark, Working/Review/Done/Failed and Full auto on/off. It checks compact one-row geometry, title ellipsis, inline warning placement, nonduplicate state/context, real progress totals, state navigation, focus restoration, popup size/theme parity, mobile todo isolation, long content, disclosure persistence and keyboard bounds. It also checks a realistic 70-turn history spanning the 300-block window: older-history anchors, per-turn Copy, font roles, snapshot/new-activity counts, modal isolation, reset behavior and delayed-share races. Its dedicated fixture entry is excluded from production builds. Capture the current compact pass with:

```sh
SCREENSHOTS=patches/compact-theme-review/header-matrix bash apps/web/scripts/header-review-test.sh
```

Phase captures live under local `patches/phone-upgrade/phase-{1,2}/`, not published screenshots. The matrix includes mock session, controls, approvals, keyboard-open, report and tool-detail surfaces. Narrow presentation helpers also have losslessness and JSON-decoding tests. Browser presets do not reliably prove a coarse pointer, so the original gate explicitly emulates that branch. Viewport simulation does not reproduce physical iOS Safari or Android keyboard behavior.

Before claiming real-device certification, manually check Safari and an installed iPhone PWA, Android Chrome, portrait/landscape safe areas, software-keyboard open/close, long drafts, uploads, native sharing and accessibility navigation. Dedicated dictation, quick replies, workspace `@` search, message long-press branching, swipe-between-files, edge navigation, swipe-down dismissal and haptics remain follow-up work. Notifications still require browser permission and opt-in, work only while the live app is hidden, and are not server Web Push. See [phone-upgrade.md](phone-upgrade.md) for the audit, tradeoffs and minimal provenance proposal.

## Deploying updates

The host serves `apps/web/dist` from disk. After a web-only update, rebuild and refresh the app; do not restart the host solely for UI changes. Host-code changes require a host restart. The lens-mark icon has versioned asset URLs; installed-app icon updates depend on the browser's manifest recheck, and reinstalling is the dependable fallback for a stale icon.
