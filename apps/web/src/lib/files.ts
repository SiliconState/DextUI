// Session-workspace file URLs, shared by markdown images/artifacts and tool
// cards. Subresource loads (<img>/<iframe>) send no Authorization header; the
// file endpoint accepts ?t=<token> instead.

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
export function fileUrl(sessionId: string, href: string, cwd: string): string {
  const token = typeof localStorage !== "undefined" ? (localStorage.getItem("dextui.token") ?? "") : "";
  const path = normalizeHref(href, cwd).split("/").map(encodeURIComponent).join("/");
  return `/sessions/${encodeURIComponent(sessionId)}/file/${path}?t=${encodeURIComponent(token)}`;
}

export const isHtmlPath = (p: string): boolean => /\.html?$/i.test(p);

/** First .html/.htm path in a tool summary such as `write_file · /work/x.html (new file)`. */
export function htmlPathIn(text: string): string | null {
  const m = /(?:file:\/\/)?(?:\/|~\/|\.{1,2}\/|[\w.-]+\/)[^\s"'`()<>]*\.html?\b/i.exec(text);
  return m ? m[0] : null;
}
