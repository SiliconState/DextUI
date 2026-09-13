// Notification side-channel. Fires only while the document is hidden, wired
// from the Connection's onEvent tap in state.svelte.ts — never from the
// coalesced per-frame view, so a background tab still notifies promptly.

import type { SessionStore } from "@dextui/client";
import type { Envelope, PackUiRequestEvent, PermissionRequestEvent, TurnEndEvent } from "@dextui/protocol";
import { activate, app } from "./state.svelte";
import { fmtTokens } from "./markdown";

/** tag → first-notify time. Reconnect replays re-deliver envelopes; this keeps
 *  a replayed envelope from re-firing a notification the user already saw. */
const seen = new Map<string, number>();
const SEEN_CAP = 300;

function fire(
  title: string,
  body: string,
  tag: string,
  sessionId: string,
  opts: { requireInteraction?: boolean; dedupe?: string } = {},
): void {
  if (app.notify !== "on") return;
  if (typeof document !== "undefined" && !document.hidden) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const key = opts.dedupe ?? tag;
  if (seen.has(key)) return;
  if (seen.size > SEEN_CAP) seen.clear();
  seen.set(key, Date.now());
  try {
    const n = new Notification(title, {
      body,
      tag,
      icon: "/icon.svg",
      requireInteraction: opts.requireInteraction ?? false,
    });
    n.onclick = () => {
      window.focus();
      activate(sessionId);
      n.close();
    };
  } catch {
    // Some platforms reject the constructor (Android Chrome); ignore quietly.
  }
}

/** Data-plane observer; call once per envelope after it is folded into `store`. */
export function notifyEvent(env: Envelope, store: SessionStore): void {
  const sid = store.state.id;
  const title = store.state.title || sid;
  switch (env.event) {
    case "permission.request": {
      const p = env.data as PermissionRequestEvent;
      fire(`Approval needed · ${p.tool}`, p.summary.slice(0, 80), `${sid}:${p.request_id}`, sid, {
        requireInteraction: true,
      });
      return;
    }
    case "ui.request": {
      const request = env.data as Extract<PackUiRequestEvent, { method: "form" }>;
      fire(`Input needed · ${request.pack}`, request.params.title.slice(0, 80), `${sid}:ui:${request.id}`, sid, {
        requireInteraction: true,
      });
      return;
    }
    case "turn_end": {
      const t = env.data as TurnEndEvent;
      if (t.failed) {
        fire("Turn failed", `✗ ${title}`, `${sid}:turn`, sid, { dedupe: `${sid}:turn:${env.seq ?? ""}` });
        return;
      }
      const u = t.usage;
      const body = `✓ ${title} · ↑${fmtTokens(u.input)} ↓${fmtTokens(u.output)}${
        u.cost_usd > 0 ? ` $${u.cost_usd.toFixed(4)}` : ""
      }`;
      fire("Turn finished", body, `${sid}:turn`, sid, { dedupe: `${sid}:turn:${env.seq ?? ""}` });
      return;
    }
    case "error": {
      const text = typeof env.data === "string" ? env.data : JSON.stringify(env.data);
      fire(`dext · ${title}`, text.slice(0, 120), `${sid}:err:${env.seq ?? ""}`, sid);
      return;
    }
    default:
      return;
  }
}
