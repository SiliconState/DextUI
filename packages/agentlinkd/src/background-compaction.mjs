// Disposable child-owned status, never restored from a journal or index.
const PHASES = new Set(["running", "ready", "waiting", "applied", "failed", "cancelled", "discarded"]);
const ACTIVE = new Set(["running", "ready", "waiting"]);
export function backgroundState() {
  return { current: null, epoch: 0, retired: new Set(), known: new Map() };
}
export function clearBackground(state) {
  if (state.current) retire(state, state.current.job_id);
  state.current = null;
}
function retire(state, id) {
  state.retired.add(id);
  if (state.retired.size > 128) state.retired.delete(state.retired.values().next().value);
}
export function acceptBackgroundApplication(state, jobId) {
  if (!state.known.has(jobId) || state.known.get(jobId)) return false;
  state.known.set(jobId, true);
  return true;
}

/** The surrounding host additionally fences every callback by child/seat epoch. */
export function acceptBackground(state, data, sessionId) {
  if (!data || data.version !== 1 || data.session_id !== sessionId || !sessionId ||
      !Number.isSafeInteger(data.session_epoch) || data.session_epoch < state.epoch ||
      typeof data.job_id !== "string" || !data.job_id || data.job_id.length > 256 ||
      typeof data.origin_turn_id !== "string" || data.origin_turn_id.length > 256 ||
      !PHASES.has(data.phase) || data.blocking !== (data.phase === "waiting") ||
      typeof data.reason !== "string" || data.reason.length > 2000 ||
      ![data.elapsed_ms, data.wait_ms, data.before_chars].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      (data.after_chars !== undefined && (!Number.isSafeInteger(data.after_chars) || data.after_chars < 0)) ||
      typeof data.usage_known !== "boolean" || state.retired.has(data.job_id)) return false;
  const current = state.current;
  if (data.phase === "running") {
    if (current && (current.job_id !== data.job_id || current.session_epoch !== data.session_epoch)) retire(state, current.job_id);
    if (state.retired.has(data.job_id)) return false;
    if (!state.known.has(data.job_id)) state.known.set(data.job_id, false);
    if (state.known.size > 128) state.known.delete(state.known.keys().next().value);
  } else if (!current || current.job_id !== data.job_id || current.session_epoch !== data.session_epoch) return false;
  state.epoch = data.session_epoch;
  if (ACTIVE.has(data.phase)) state.current = { ...data };
  else { retire(state, data.job_id); state.current = null; }
  return true;
}
