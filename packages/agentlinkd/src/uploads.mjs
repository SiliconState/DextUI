// Session-workspace uploads — the write half of the files surface.
//
// POST /sessions/:id/upload streams a raw body into <cwd>/uploads/<name>;
// POST /sessions/:id/fetch downloads an http(s) URL host-side into the same
// directory. Files land as plain workspace paths so dext reads them from
// disk and the files_read endpoint previews them — no protocol change.
//
// Rules: names are sanitized to a bare filename, collisions get -2/-3
// suffixes (never overwrite), writes are capped, and the uploads directory
// must be a real directory inside the workspace (a planted symlink would let
// a write land outside it).
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";

export const UPLOAD_MAX_BYTES = 64 * 1024 * 1024;
export const UPLOAD_DIR = "uploads";
const NAME_MAX = 120;
const FETCH_HEADER_MS = 15_000;
const FETCH_TOTAL_MS = 120_000;
const FETCH_REDIRECTS = 4;

/** Any filename (upload name, URL basename) → a safe basename for uploads/. */
export function sanitizeName(raw, fallback = "file") {
  let n = (String(raw ?? "").replaceAll("\\", "/").split("/").filter(Boolean).pop() ?? "")
    .replace(/\p{C}/gu, "")
    .replace(/^\.+/, "")
    .trim()
    .replace(/\s+/g, " ");
  if (!n || n === "." || n === "..") n = fallback;
  if (n.length > NAME_MAX) {
    const ext = path.extname(n).slice(0, 24);
    n = n.slice(0, NAME_MAX - ext.length).trimEnd() + ext;
  }
  return n;
}

/** Real uploads dir under cwd, or null when it cannot be made safe. */
export function uploadDirFor(cwd) {
  try {
    const dir = path.join(cwd, UPLOAD_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const real = fs.realpathSync(dir);
    const root = fs.realpathSync(cwd) + path.sep;
    if (!real.startsWith(root) || !fs.statSync(real).isDirectory()) return null;
    return real;
  } catch {
    return null;
  }
}

/** Stream a request body into <dir>/<sanitized name>, unique-ified on collision. */
export function receiveUpload(req, dir, rawName) {
  return new Promise((resolve) => {
    const declared = Number(req.headers?.["content-length"] ?? "");
    if (Number.isFinite(declared) && declared > UPLOAD_MAX_BYTES) {
      resolve({ error: "too_large", message: `over ${UPLOAD_MAX_BYTES} bytes` });
      return;
    }
    const name = sanitizeName(rawName);
    const stem = path.basename(name, path.extname(name));
    const ext = path.extname(name);
    let fd;
    let dest = null;
    for (let i = 1; i <= 999 && fd === undefined; i++) {
      const cand = path.join(dir, i === 1 ? name : `${stem}-${i}${ext}`);
      try {
        fd = fs.openSync(cand, "wx", 0o644);
        dest = cand;
      } catch (e) {
        if (e.code !== "EEXIST") {
          resolve({ error: "io", message: String(e.message ?? e) });
          return;
        }
      }
    }
    if (fd === undefined) {
      resolve({ error: "exists", message: "too many name collisions" });
      return;
    }
    let bytes = 0;
    let settled = false;
    const fail = (error, message) => {
      if (settled) return;
      settled = true;
      try { fs.closeSync(fd); } catch { /* gone */ }
      try { fs.unlinkSync(dest); } catch { /* partial file best-effort */ }
      resolve({ error, message });
    };
    req.on("data", (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > UPLOAD_MAX_BYTES) {
        // Stop reading but keep the socket: the route still owes the client a
        // 413 (destroying here would turn it into a connection reset).
        req.pause?.();
        fail("too_large", `over ${UPLOAD_MAX_BYTES} bytes`);
        return;
      }
      try {
        fs.writeSync(fd, chunk);
      } catch (e) {
        fail("io", String(e.message ?? e));
      }
    });
    req.on("error", (e) => fail("aborted", String(e.message ?? e)));
    req.on("close", () => fail("aborted", "connection closed mid-upload"));
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try { fs.closeSync(fd); } catch { /* already closed */ }
      resolve({ path: `${UPLOAD_DIR}/${path.basename(dest)}`, bytes, name: path.basename(dest) });
    });
  });
}

// ---------- host-side web fetch (SSRF-guarded) ----------

/** True when the address must not be fetched: this host's own machine. */
export function blockedAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local (cloud metadata)
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, "");
  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:hhhh:hhhh) judged as the IPv4 it wraps.
  const mapped = /^::ffff:(.+)$/.exec(v6)?.[1];
  if (mapped) {
    if (net.isIPv4(mapped)) return blockedAddress(mapped);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return blockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return true; // unparseable mapped form: refuse rather than guess
  }
  return (
    v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6)
  );
}

const err = (error, message) => ({ error, message });

/** Validate one fetch target: scheme, port, credentials, and resolved addresses. */
export async function assertFetchable(u) {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw err("bad_url", "http(s) only");
  if (u.username || u.password) throw err("bad_url", "credentials in the URL are refused");
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  if (port !== 80 && port !== 443) throw err("bad_port", `port ${port} refused (80/443 only)`);
  // IPv6 literals arrive bracketed from URL.hostname.
  const h = u.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (net.isIP(h)) {
    if (blockedAddress(h)) throw err("blocked_host", `${h} is not a public address`);
    return;
  }
  // Single-label and local names resolve to (or alias) this machine's own
  // network; only global names are fetchable.
  if (!h.includes(".") || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) {
    throw err("blocked_host", `${h} is not a public host`);
  }
  let addrs;
  try {
    addrs = await dns.lookup(h, { all: true });
  } catch {
    throw err("bad_host", `cannot resolve ${h}`);
  }
  const bad = addrs.find((a) => blockedAddress(a.address));
  if (bad) throw err("blocked_host", `${h} resolves to a private address`);
}

const TYPE_EXT = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
  "text/html": ".html",
  "application/json": ".json",
  "text/csv": ".csv",
  "text/plain": ".txt",
};

/** Basename from the final URL path, with an extension from content-type when the path has none. */
export function fileNameFromResponse(u, res) {
  let base = "";
  try {
    base = path.basename(decodeURIComponent(u.pathname));
  } catch {
    base = path.basename(u.pathname);
  }
  if (!base) base = "download";
  if (!path.extname(base)) {
    const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    base += TYPE_EXT[mime] ?? "";
  }
  return base;
}

/** Download a public http(s) URL into <dir>, guarded and capped. */
export async function fetchToFile(rawUrl, dir, { name } = {}) {
  let u;
  try {
    u = new URL(String(rawUrl).trim());
  } catch {
    return err("bad_url", "not a URL");
  }
  const ctrl = new AbortController();
  const total = setTimeout(() => ctrl.abort(), FETCH_TOTAL_MS);
  let headers = setTimeout(() => ctrl.abort(), FETCH_HEADER_MS);
  try {
    for (let hop = 0; ; hop++) {
      if (hop > FETCH_REDIRECTS) return err("too_many_redirects", `over ${FETCH_REDIRECTS} redirects`);
      try {
        await assertFetchable(u);
      } catch (e) {
        return e.error ? e : err("bad_url", String(e.message ?? e));
      }
      let res;
      try {
        res = await fetch(u, {
          redirect: "manual",
          signal: ctrl.signal,
          headers: { "user-agent": "DextUI/1.0 (session file attach)" },
        });
      } catch (e) {
        if (ctrl.signal.aborted) return err("timeout", "timed out");
        return err("fetch_failed", String(e.cause?.code ?? e.message ?? e));
      }
      if (headers) {
        clearTimeout(headers);
        headers = null;
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!loc) return err("fetch_failed", `redirect without location (${res.status})`);
        try {
          u = new URL(loc, u);
        } catch {
          return err("bad_url", `bad redirect target: ${loc.slice(0, 120)}`);
        }
        headers = setTimeout(() => ctrl.abort(), FETCH_HEADER_MS);
        continue;
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        return err("http_error", `HTTP ${res.status}`);
      }
      const len = Number(res.headers.get("content-length") ?? "");
      if (Number.isFinite(len) && len > UPLOAD_MAX_BYTES) {
        await res.body?.cancel().catch(() => {});
        return err("too_large", `over ${UPLOAD_MAX_BYTES} bytes`);
      }
      const wanted = sanitizeName(name || fileNameFromResponse(u, res));
      const stem = path.basename(wanted, path.extname(wanted));
      const ext = path.extname(wanted);
      let fd;
      let dest = null;
      for (let i = 1; i <= 999 && fd === undefined; i++) {
        const cand = path.join(dir, i === 1 ? wanted : `${stem}-${i}${ext}`);
        try {
          fd = fs.openSync(cand, "wx", 0o644);
          dest = cand;
        } catch (e) {
          if (e.code !== "EEXIST") return err("io", String(e.message ?? e));
        }
      }
      if (fd === undefined) return err("exists", "too many name collisions");
      // Web ReadableStream: async-iterable in Node, but not an EventEmitter.
      let bytes = 0;
      let failure = "";
      try {
        for await (const chunk of res.body) {
          bytes += chunk.length;
          if (bytes > UPLOAD_MAX_BYTES) {
            failure = "too_large";
            break;
          }
          fs.writeSync(fd, chunk);
        }
      } catch {
        failure = failure || (ctrl.signal.aborted ? "timeout" : "io");
      }
      try { fs.closeSync(fd); } catch { /* already closed */ }
      if (failure) {
        try { ctrl.abort(); } catch { /* already gone */ }
        try { await res.body.cancel(); } catch { /* already gone */ }
        try { fs.unlinkSync(dest); } catch { /* best effort */ }
        const why = { too_large: `over ${UPLOAD_MAX_BYTES} bytes`, timeout: "timed out" }[failure] ?? "download failed mid-stream";
        return err(failure, why);
      }
      return {
        path: `${UPLOAD_DIR}/${path.basename(dest)}`,
        bytes,
        name: path.basename(dest),
        type: res.headers.get("content-type") ?? undefined,
      };
    }
  } finally {
    clearTimeout(total);
    if (headers) clearTimeout(headers);
  }
}
