// Read headers from an explicitly selected loopback dev server. No DNS, body
// proxying, credentials, redirect following, header rewriting or public URLs.
import http from "node:http";

export function previewURL(value, protectedPorts = []) {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\\x00-\x1f]/.test(value)) throw new Error("Use a local HTTP dev-server address.");
  const u = new URL(value);
  if (u.protocol !== "http:" || u.username || u.password || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) throw new Error("Preview supports loopback HTTP dev servers only.");
  const port = Number(u.port || 80);
  if (protectedPorts.includes(port)) throw new Error("The DextUI control plane cannot be previewed.");
  return u;
}
export function framingAllowed(headers, targetOrigin, appOrigin) {
  if (headers["x-frame-options"]) return false; // Conservative: even unknown XFO values.
  const policies = Array.isArray(headers["content-security-policy"]) ? headers["content-security-policy"] : String(headers["content-security-policy"] || "").split(/,(?=\s*[a-z-]+\s)/);
  for (const policy of policies) {
    const ancestors = /(?:^|;)\s*frame-ancestors\s+([^;]+)/i.exec(policy);
    if (!ancestors) continue;
    const sources = ancestors[1].trim().split(/\s+/);
    if (!sources.some(s => s === "*" || s === appOrigin || s === "'self'" && targetOrigin === appOrigin)) return false;
  }
  return true;
}
export async function checkPreview(value, { protectedPorts = [], appOrigin, timeout = 2500 } = {}) {
  const u = previewURL(value, protectedPorts);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname === "[::1]" ? "::1" : "127.0.0.1", port: u.port || 80,
      path: u.pathname + u.search, method: "HEAD", headers: { Host: u.host }, maxHeaderSize: 16384, agent: false }, res => {
      res.destroy();
      if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error("Preview requires a successful response without redirects."));
      if (!framingAllowed(res.headers, u.origin, appOrigin)) return reject(new Error("This server does not permit framing. Open it in your browser instead."));
      resolve({ url: u.href, allowed: true });
    });
    const timer = setTimeout(() => req.destroy(new Error("The dev server did not respond in time.")), timeout);
    req.once("close", () => clearTimeout(timer));
    req.once("error", () => reject(new Error("Cannot preview this dev server. Check its address and framing policy.")));
    req.end();
  });
}
