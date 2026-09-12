// Data-only snapshots: never accept a report-selected path or executable file.
export const ARTIFACT_STATE_MAX = 1024 * 1024;
export function validateArtifactState(text: unknown): string {
  if (typeof text !== "string" || text.length > ARTIFACT_STATE_MAX || new TextEncoder().encode(text).length > ARTIFACT_STATE_MAX) {
    throw new Error("State must be JSON text no larger than 1 MiB.");
  }
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object") throw new Error("State must be a JSON object or array.");
  return text;
}

export function validateStateReceipt(raw: unknown, bytes: number): string {
  if (!raw || typeof raw !== "object") throw new Error("Invalid save receipt.");
  const value = raw as Record<string, unknown>;
  if (typeof value.path !== "string" || !/^uploads\/[a-z0-9_-]+\.state(?:-\d+)?\.json$/i.test(value.path) || value.bytes !== bytes) {
    throw new Error("Invalid save receipt.");
  }
  return value.path;
}

export function artifactStateName(title: string): string {
  return `${title.replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "report"}.state.json`;
}
