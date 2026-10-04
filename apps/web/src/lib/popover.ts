// Status-bar popover geometry, shared by the settings menu and the session
// controls menu: desktop anchors to the trigger and opens away from the
// nearest vertical edge; mobile follows the visible viewport above the bottom
// bar. Both clamp horizontally; no anchor uses the bottom-right corner.

export interface PopoverAnchor {
  top: number;
  bottom: number;
  right: number;
}

/** `widthPx` is the menu's max content width; it is only used for clamping. */
export function popoverPos(a: PopoverAnchor | null, widthPx = 280, gap = 6): string {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Phone/tablet menus sit above the persistent bottom bar. CSS variables
  // track keyboard animation and viewport panning even while the menu is open;
  // a stored trigger rect would be stale as soon as the keyboard moves.
  if (matchMedia("(max-width: 900px)").matches) {
    const w = Math.min(widthPx, vw - 24);
    const right = a ? Math.max(12, Math.min(a.right, vw - 12 - w)) : 12;
    return `right:${right}px;top:calc(var(--mobile-viewport-top, 0px) + var(--mobile-viewport-height, 100dvh) - 60px - env(safe-area-inset-bottom, 0px));transform:translateY(-100%);max-height:calc(var(--mobile-viewport-height, 100dvh) - 84px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));overflow-y:auto;`;
  }
  const w = Math.min(widthPx, vw - 24);
  if (!a) return "right:12px;bottom:46px;";
  const right = Math.max(8, Math.min(a.right, vw - 8 - w));
  return a.top > vh / 2
    ? `right:${right}px;bottom:${vh - a.top + gap}px;`
    : `right:${right}px;top:${a.bottom + gap}px;`;
}
