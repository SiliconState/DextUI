// Status-bar popover geometry, shared by the settings menu and the session
// controls menu: anchor to the trigger's viewport rect, open away from the
// nearest vertical edge, right-aligned to the trigger — clamped so a trigger
// far from the right edge can't push the menu off-screen left. No anchor →
// default bottom-right corner (palette entries with no trigger).

export interface PopoverAnchor {
  top: number;
  bottom: number;
  right: number;
}

/** `widthPx` is the menu's max content width; it is only used for clamping. */
export function popoverPos(a: PopoverAnchor | null, widthPx = 280, gap = 6): string {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(widthPx, vw - 24);
  if (!a) return "right:12px;bottom:46px;";
  const right = Math.max(8, Math.min(a.right, vw - 8 - w));
  return a.top > vh / 2
    ? `right:${right}px;bottom:${vh - a.top + gap}px;`
    : `right:${right}px;top:${a.bottom + gap}px;`;
}
