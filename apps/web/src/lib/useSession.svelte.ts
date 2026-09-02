// Bridges a framework-free SessionStore into Svelte 5 runes.
//
// One helper, one contract: `view` is a shallow copy of `store.state`, refreshed
// at most once per animation frame (or every 100 ms while the tab is hidden).
// Deltas arriving at 30 Hz therefore cost one object copy per frame, not one
// per token, and every derived downstream recomputes once per frame.
//
// Call at component init (it registers an $effect).

import type { SessionState, SessionStore } from "@dextui/client";

const HIDDEN_FLUSH_MS = 100;

export interface SessionView {
  readonly view: SessionState | null;
}

export function useSession(get: () => SessionStore | null | undefined): SessionView {
  let view = $state.raw<SessionState | null>(null);

  $effect(() => {
    const store = get();
    if (!store) {
      view = null;
      return;
    }
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      raf = 0;
      timer = undefined;
      view = { ...store.state };
    };
    flush();
    const unsub = store.subscribe(() => {
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      // rAF stalls in background tabs; keep a wall-clock fallback armed so the
      // title badge and queue still track while the user is elsewhere.
      if (hidden && !timer) timer = setTimeout(flush, HIDDEN_FLUSH_MS);
      if (!hidden && !raf) raf = requestAnimationFrame(flush);
    });
    return () => {
      unsub();
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
  });

  return {
    get view() {
      return view;
    },
  };
}
