// Popover geometry, shared by the settings, session controls, details and todo
// menus: desktop anchors to the trigger and opens away from the nearest
// vertical edge; mobile drops down from the top session header and follows the
// visible viewport (keyboard resize and pan). Both clamp horizontally.

export interface PopoverAnchor {
  top: number;
  bottom: number;
  right: number;
}

/** Mobile header height (px); keep in sync with StatusLine's touch layout. */
export const MOBILE_HEADER = 44;

/** `widthPx` is the menu's max content width; it is only used for clamping. */
export function popoverPos(a: PopoverAnchor | null, widthPx = 280, gap = 6, maxHeightPx = 440): string {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // CSS variables track keyboard animation and viewport panning even while
  // the menu is open; a stored trigger rect would go stale.
  if (matchMedia("(max-width: 900px)").matches) {
    const w = Math.min(widthPx, vw - 24);
    const right = a ? Math.max(8, Math.min(a.right, vw - 8 - w)) : 8;
    const below = `env(safe-area-inset-top, 0px) + ${MOBILE_HEADER + 4}px`;
    return `right:${right}px;top:calc(var(--mobile-viewport-top, 0px) + ${below});max-height:min(${maxHeightPx}px, calc(var(--mobile-viewport-height, 100dvh) - (${below}) - 8px));overflow-y:auto;`;
  }
  const w = Math.min(widthPx, vw - 24);
  if (!a) return "right:12px;bottom:46px;";
  const right = Math.max(8, Math.min(a.right, vw - 8 - w));
  return a.top > vh / 2
    ? `right:${right}px;bottom:${vh - a.top + gap}px;`
    : `right:${right}px;top:${a.bottom + gap}px;`;
}
