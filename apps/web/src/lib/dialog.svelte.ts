// Shared overlay-dialog behavior: focus the dialog on open, trap Tab within
// it, restore focus to the previously focused element on close. Call at
// component init (it registers an $effect).

const FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export interface DialogHdl {
  /** Svelte action: `use:dlg.ref` on the dialog element. */
  ref: (n: HTMLElement) => void;
  /** Forward a window keydown; traps Tab while the dialog is open. */
  onKey: (e: KeyboardEvent) => void;
}

export function useDialog(getOpen: () => boolean): DialogHdl {
  let node: HTMLElement | null = null;
  let prev: HTMLElement | null = null;

  $effect(() => {
    if (getOpen()) {
      prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      requestAnimationFrame(() => {
        if (!node) return;
        (node.querySelector<HTMLElement>(FOCUSABLE) ?? node).focus();
      });
    } else if (prev) {
      prev.focus();
      prev = null;
    }
  });

  return {
    ref: (n: HTMLElement) => {
      node = n;
    },
    onKey: (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !node || !getOpen()) return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof Node && node.contains(active);
      if (e.shiftKey && (!inside || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    },
  };
}
