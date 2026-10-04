// Shared overlay-dialog behavior: focus the dialog on open, trap Tab within
// it, restore focus to the previously focused element on close. Call at
// component init (it registers an $effect).

const FOCUSABLE =
  "summary:not([tabindex='-1']), a[href]:not([tabindex='-1']), button:not([disabled]):not([tabindex='-1']), input:not([disabled]):not([tabindex='-1']), select:not([disabled]):not([tabindex='-1']), textarea:not([disabled]):not([tabindex='-1']), iframe:not([tabindex='-1']), [tabindex]:not([tabindex='-1'])";

export interface DialogHdl {
  /** Svelte action: `use:dlg.ref` on the dialog element. */
  ref: (n: HTMLElement) => void;
  /** Forward a window keydown; traps Tab while the dialog is open. */
  onKey: (e: KeyboardEvent) => void;
}

// CSS-hidden controls (including responsive desktop-only buttons) and inert
// descendants are not part of a dialog's actual tab order.
function available(el: HTMLElement): boolean {
  return el.isConnected && !el.closest("[inert]") && el.getClientRects().length > 0
    && !el.matches(":disabled, input[type='hidden']")
    && getComputedStyle(el).visibility === "visible";
}

export function useDialog(getOpen: () => boolean): DialogHdl {
  let node: HTMLElement | null = null;
  let prev: HTMLElement | null = null;

  $effect(() => {
    if (getOpen()) {
      prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const frame = requestAnimationFrame(() => {
        if (!node || !available(node)) return;
        const initial = node.querySelector<HTMLElement>("[data-dialog-initial]");
        const first = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].find(available);
        (initial && available(initial) ? initial : first ?? node).focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    } else if (prev) {
      // Don't steal focus from a newly opened overlay or a prefilled composer.
      const restore = prev;
      prev = null;
      // Wait for Svelte to remove inert and unmount the closing overlay.
      const frame = requestAnimationFrame(() => {
        const active = document.activeElement;
        if ((active === document.body || active === node || (active && node?.contains(active))) && available(restore)) {
          restore.focus({ preventScroll: true });
        }
      });
      return () => cancelAnimationFrame(frame);
    }
  });

  return {
    ref: (n: HTMLElement) => {
      node = n;
      return { destroy: () => { if (node === n) node = null; } };
    },
    onKey: (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== "Tab" || !node || !getOpen() || !available(node)) return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(available);
      if (items.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof Node && node.contains(active);
      if (e.shiftKey && (!inside || active === node || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    },
  };
}
