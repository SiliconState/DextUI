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
    const below = `var(--safe-top, env(safe-area-inset-top, 0px)) + ${MOBILE_HEADER + 4}px`;
    const leftInset = "var(--safe-left, env(safe-area-inset-left, 0px))";
    const rightInset = "var(--safe-right, env(safe-area-inset-right, 0px))";
    return `right:clamp(calc(${rightInset} + 8px), ${right}px, calc(100vw - ${leftInset} - ${w + 8}px));max-width:calc(100vw - ${leftInset} - ${rightInset} - 16px);top:calc(var(--mobile-viewport-top, 0px) + ${below});max-height:max(0px, min(${maxHeightPx}px, calc(var(--mobile-viewport-height, 100dvh) - (${below}) - var(--safe-bottom, env(safe-area-inset-bottom, 0px)) - 8px)));overflow-y:auto;`;
  }
  const w = Math.min(widthPx, vw - 24);
  const right = a ? Math.max(8, Math.min(a.right, vw - 8 - w)) : 12;
  const above = a ? a.top > vh / 2 : true;
  const edge = Math.max(8, Math.min(a ? above ? vh - a.top + gap : a.bottom + gap : 46, vh - 8));
  const available = Math.max(0, vh - edge - 8);
  return `right:${right}px;${above ? "bottom" : "top"}:${edge}px;max-height:${Math.min(maxHeightPx, available)}px;overflow-y:auto;`;
}
