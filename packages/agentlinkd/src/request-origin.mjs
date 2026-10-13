// Browser request provenance. `Sec-Fetch-Site` and `Origin` are forbidden
// request headers: page scripts cannot set or forge them, so together they say
// which site made a browser request. Native clients (curl, Node, webhook
// senders, the test harness) send neither and are judged by their token alone.
//
// Why this matters for a single-operator host: any website open in any local
// browser can aim requests or WebSockets at the loopback control plane. It can never read the
// token, but wrong-token attempts feed the global auth lockout, and an
// `<img src=…?t=guess>` load/error pair is a token oracle. Cross-site browser
// requests are therefore refused before any token comparison and are never
// counted as failed sign-ins.

/** Extra origins accepted as same-site, e.g. a proxy that rewrites Host and
 * sends no X-Forwarded-Host: `AGENTLINKD_ALLOWED_ORIGINS=https://dext.example.com`. */
export function allowedOrigins(env = process.env) {
  return new Set(String(env.AGENTLINKD_ALLOWED_ORIGINS ?? "")
    .split(",").map((s) => s.trim().replace(/\/+$/, "").toLowerCase()).filter(Boolean));
}

function forwardedHost(req) {
  return String(req.headers["x-forwarded-host"] ?? "").split(",")[0].trim().toLowerCase();
}

/**
 * Classify a request:
 *   "same"   — a browser request from this host's own pages (or an allowed origin)
 *   "cross"  — a browser request initiated by another site, an opaque/sandboxed
 *              document, or a non-web scheme
 *   "native" — no browser provenance headers at all
 */
export function requestSite(req, extra = allowedOrigins()) {
  const site = String(req.headers["sec-fetch-site"] ?? "").toLowerCase();
  const rawOrigin = req.headers.origin;
  let origin = null;
  if (rawOrigin && rawOrigin !== "null") {
    try { origin = new URL(rawOrigin); } catch { return "cross"; }
  }
  // Opaque and non-web origins cannot be made safe by fetch metadata.
  if (rawOrigin === "null" || (origin && !["http:", "https:"].includes(origin.protocol))) return "cross";
  const allowed = origin && extra.has(origin.origin.toLowerCase());
  // The browser computed this relative to the real page origin, so it stays
  // correct behind proxies that rewrite Host. Trust it when present.
  if (site === "same-origin" || site === "none") return "same";
  if (site === "cross-site" || site === "same-site") return allowed ? "same" : "cross";
  // Older browsers without fetch metadata: fall back to comparing Origin.
  if (!origin) return site ? "cross" : "native";
  if (allowed) return "same";
  const host = String(req.headers.host ?? "").toLowerCase();
  const fwd = forwardedHost(req);
  const originHost = origin.host.toLowerCase();
  return originHost === host || (!!fwd && originHost === fwd) ? "same" : "cross";
}
