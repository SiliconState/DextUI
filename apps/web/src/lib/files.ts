// Session-workspace file URLs, shared by markdown images/artifacts and tool
// cards. Subresource loads (<img>/<iframe>) send no Authorization header; the
// file endpoint accepts ?t=<token> for browser-native subresource loads. The
// artifact sheet instead fetches HTML with an Authorization header so report
// code never receives the token.

/** Read a response without allowing an advertised 64 MiB workspace file to
 * become an unbounded in-memory preview. */
export async function boundedResponseBytes(res: Response, cap: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > cap) throw new Error("file too large to preview");
  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > cap) throw new Error("file too large to preview");
    return bytes;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      throw new Error("file too large to preview");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

export async function boundedResponseText(res: Response, cap: number): Promise<string> {
  return new TextDecoder().decode(await boundedResponseBytes(res, cap));
}

export async function boundedResponseBlob(res: Response, cap: number): Promise<Blob> {
  const type = res.headers.get("content-type") ?? "application/octet-stream";
  return new Blob([await boundedResponseBytes(res, cap)], { type });
}

/** Models emit file paths in several shapes — relative ("qc_charts/x.png"),
 *  absolute file URIs, WSL UNC URIs. Only paths under the session cwd are
 *  servable; relativize everything to that. */
export function normalizeHref(href: string, cwd: string): string {
  let p = href.replaceAll("\\", "/");
  if (p.startsWith("file://")) {
    p = p.slice(7);
    const wsl = /^wsl\.localhost\/[^/]+(\/.*)$/.exec(p);
    if (wsl && wsl[1]) p = wsl[1];
  }
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep raw */
  }
  if (cwd && p.startsWith(`${cwd}/`)) p = p.slice(cwd.length + 1);
  return p.replace(/^\//, "");
}

/** Path-shaped URL so an HTML artifact's nested relative assets resolve. */
export function fileUrl(
  sessionId: string,
  href: string,
  cwd: string,
  opts: { queryToken?: boolean } = {},
): string {
  const token = typeof localStorage !== "undefined" ? (localStorage.getItem("dextui.token") ?? "") : "";
  const path = normalizeHref(href, cwd).split("/").map(encodeURIComponent).join("/");
  const query = new URLSearchParams();
  if (opts.queryToken !== false && token) query.set("t", token);
  const suffix = query.size ? `?${query}` : "";
  return `/sessions/${encodeURIComponent(sessionId)}/file/${path}${suffix}`;
}

export const isHtmlPath = (p: string): boolean => /\.html?$/i.test(p);
export const isPdfPath = (p: string): boolean => /\.pdf$/i.test(p);
export const isTextPath = (p: string): boolean => /\.(txt|md|csv|json|log|xml|ya?ml|tsv)$/i.test(p);
export const isDocumentPath = (p: string): boolean => /\.(rtf|docx?|odt|xlsx?|ods|pptx?|odp)$/i.test(p);
/** Extensions the host's files_read endpoint serves — previewable/openable. */
export const servablePath = (p: string): boolean =>
  /\.(png|jpe?g|gif|webp|avif|bmp|tiff?|heic|heif|svg|html?|pdf|txt|md|csv|json|log|xml|ya?ml|tsv|rtf|docx?|odt|xlsx?|ods|pptx?|odp)$/i.test(p);
