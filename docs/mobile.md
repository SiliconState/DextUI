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

On phones, the bottom bar keeps session controls, Finder, settings and pending-decision access compact. Tap **...** for folder, usage, context and other details. Retry, failure, compaction and paused-crew status remain visible without opening details. Empty or unavailable closed Todos panels stay quiet; Finder's **Show session todos** action reveals them. Nonempty lists remain directly accessible.

Safe-area padding reserves space around notches and the home indicator. At normal zoom, `visualViewport` height and offset keep the shell above the software keyboard; menu geometry follows viewport resize/pan. Pinch zoom is left under browser control. Desktop retains its dense terminal layout.

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

Mock screenshots were captured at iPhone-sized viewports; the final unified 390px layout was visually inspected in light theme. Browser presets do not reliably prove a coarse pointer, so the test explicitly emulates that branch. Viewport simulation does not reproduce physical iOS Safari or Android keyboard behavior.

Before claiming real-device certification, manually check Safari and an installed iPhone PWA, Android Chrome, portrait/landscape safe areas, software-keyboard open/close, long drafts, uploads and accessibility navigation. Swipeable queues and haptics are not implemented by this layout pass.

## Deploying updates

The host serves `apps/web/dist` from disk. After a web-only update, rebuild and refresh the app; do not restart the host solely for UI changes. Host-code changes require a host restart. The lens-mark icon has versioned asset URLs; installed-app icon updates depend on the browser's manifest recheck, and reinstalling is the dependable fallback for a stale icon.
