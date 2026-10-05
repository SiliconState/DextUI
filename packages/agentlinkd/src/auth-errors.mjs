// Never reflect auth command output wholesale: it may contain credentials.
export function authStatusError(result) {
  const text = `${result?.err ?? ""}\n${result?.stderr ?? ""}`;
  const mode = /provider state has unsafe writable mode (0[0-7]{3})/.exec(text)?.[1];
  if (mode) return `Dext cannot read providers.json: unsafe permissions ${mode}. Ask the host owner to make that file owner-only (0600), then refresh providers.`;
  if (/invalid provider catalog JSON/.test(text)) return "Dext cannot read providers.json: invalid provider catalog. Repair it on the host, then refresh providers.";
  if (/symlink|symbolic link/.test(text)) return "Dext refused unsafe provider state on the host. Check its file ownership and links, then refresh providers.";
  return "Dext could not read provider status. Check the host's authentication configuration, then refresh providers.";
}
