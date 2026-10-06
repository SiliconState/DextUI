// Never reflect auth command output wholesale: it may contain credentials.
export function authWriteError(result, op) {
  const text = `${result?.stderr ?? ""}\n${result?.stdout ?? ""}`;
  if (/unsafe writable mode|invalid provider catalog JSON|symlink|symbolic link/.test(text)) return authStatusError(result);
  if (/invalid ChatGPT access token format/.test(text)) return "Invalid ChatGPT token format. Paste the accessToken from the session page, or its complete single-line JSON.";
  return `${op === "logout" ? "Sign-out" : "Sign-in"} could not be confirmed. Check provider status before retrying; the credential may already have been saved.`;
}

/** CORE markers can include suffixes; unresolved is not an authenticated seat. */
const AUTH_MARKERS = new Set(["auth", "key", "none", "web", "oauth", "token", "session", "failed", "expired", "missing", "absent", "unknown", "present", "ok", "disabled", "off"]);
export function normaliseAuthMarker(value) {
  const raw = String(value ?? "none").trim().replace(/^[^\w]+|[^\w]+$/g, "").toLowerCase();
  if (/unresolved/.test(raw)) return "missing";
  if (raw.startsWith("env:")) return "key";
  if (raw === "not-required") return "present";
  const marker = raw.replace(/[^\w].*$/, "");
  return AUTH_MARKERS.has(marker) ? marker : "key";
}
export function authStatusError(result) {
  const text = `${result?.err ?? ""}\n${result?.stderr ?? ""}`;
  const mode = /provider state has unsafe writable mode (0[0-7]{3})/.exec(text)?.[1];
  if (mode) return `Dext cannot read providers.json: unsafe permissions ${mode}. Ask the host owner to make that file owner-only (0600), then refresh providers.`;
  if (/invalid provider catalog JSON/.test(text)) return "Dext cannot read providers.json: invalid provider catalog. Repair it on the host, then refresh providers.";
  if (/symlink|symbolic link/.test(text)) return "Dext refused unsafe provider state on the host. Check its file ownership and links, then refresh providers.";
  return "Dext could not read provider status. Check the host's authentication configuration, then refresh providers.";
}
