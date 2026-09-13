// Host-side validation/projection for Dext's host-neutral pack UI channel.
// Values returned by a user are deliberately not handled here: they travel
// directly from the WebSocket command into the bridge and are never persisted.

const PACK_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SAFE_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const FIELD_TYPES = new Set(["text", "textarea", "number", "boolean", "select", "multiselect"]);
const PROGRESS_STATES = new Set(["running", "completed", "error"]);
const text = (v, max = 2000) => typeof v === "string" ? v.slice(0, max) : undefined;

function option(v) {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return { value: v, label: String(v).slice(0, 500) };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const value = v.value;
  if (!(typeof value === "string" || typeof value === "number" || typeof value === "boolean")) return null;
  return { value, label: text(v.label, 500) ?? String(value).slice(0, 500) };
}

function validDefault(type, value, options) {
  if (value === undefined) return true;
  if (type === "text" || type === "textarea") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  const has = (candidate) => options.some((item) => Object.is(item.value, candidate));
  if (type === "select") return has(value);
  return Array.isArray(value) && value.every(has);
}

function formParams(params) {
  if (!Array.isArray(params.fields) || params.fields.length > 64) return null;
  const ids = new Set();
  const fields = [];
  for (const raw of params.fields) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !SAFE_ID.test(raw.id ?? "") || ids.has(raw.id) || !FIELD_TYPES.has(raw.type)) return null;
    ids.add(raw.id);
    const options = Array.isArray(raw.options) ? raw.options.slice(0, 128).map(option) : [];
    if (options.some((v) => !v) || ((raw.type === "select" || raw.type === "multiselect") && options.length === 0)) return null;
    if (Object.hasOwn(raw, "default") && !validDefault(raw.type, raw.default, options)) return null;
    fields.push({
      id: raw.id,
      label: text(raw.label, 500) ?? raw.id,
      type: raw.type,
      ...(raw.required === true ? { required: true } : {}),
      ...(Object.hasOwn(raw, "default") ? { default: raw.default } : {}),
      ...(options.length ? { options } : {}),
      ...(text(raw.placeholder, 500) !== undefined ? { placeholder: text(raw.placeholder, 500) } : {}),
      ...(text(raw.description) !== undefined ? { description: text(raw.description) } : {}),
    });
  }
  return {
    title: text(params.title, 500) ?? "Pack input",
    ...(text(params.description) !== undefined ? { description: text(params.description) } : {}),
    submit_label: text(params.submit_label, 100) ?? "Continue",
    fields,
  };
}

function progressParams(params) {
  const id = SAFE_ID.test(params.id ?? "") ? params.id : "default";
  const current = Number.isFinite(params.current) ? Number(params.current) : undefined;
  const total = Number.isFinite(params.total) && params.total > 0 ? Number(params.total) : undefined;
  const state = PROGRESS_STATES.has(params.state) ? params.state : "running";
  return {
    id,
    title: text(params.title, 500) ?? "Pack progress",
    ...(text(params.message) !== undefined ? { message: text(params.message) } : {}),
    ...(current !== undefined ? { current } : {}),
    ...(total !== undefined ? { total } : {}),
    state,
  };
}

/** Validate and reduce a core ui.request to the baseline methods DextUI renders. */
export function normalizeUiRequest(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "request must be an object" };
  if (!SAFE_ID.test(data.id ?? "")) return { error: "invalid transport id" };
  if (!SAFE_ID.test(data.request_id ?? "")) return { error: "invalid request id" };
  if (!PACK_NAME.test(data.pack ?? "")) return { error: "invalid pack name" };
  if (data.method !== "form" && data.method !== "progress") return { error: "unsupported UI method" };
  if (!data.params || typeof data.params !== "object" || Array.isArray(data.params)) return { error: "params must be an object" };
  try {
    const encoded = JSON.stringify(data.params);
    if (encoded === undefined || Buffer.byteLength(encoded) > 64 * 1024 || hasUnsafeControl(data.params)) return { error: "params exceed bounds" };
  } catch {
    return { error: "params are not serializable" };
  }
  const params = data.method === "form" ? formParams(data.params) : progressParams(data.params);
  if (!params) return { error: `invalid ${data.method} params` };
  if (Buffer.byteLength(JSON.stringify(params)) > 64 * 1024) return { error: `${data.method} params exceed bounds` };
  return {
    request: {
      id: data.id,
      pack: data.pack,
      request_id: data.request_id,
      method: data.method,
      params,
      received_at: Date.now(),
    },
  };
}

export function progressKey(request) {
  return `${request.pack}:${request.params.id}`;
}

export function validUiResponse(frame) {
  if (frame.status === "cancelled") return { status: "cancelled" };
  if (frame.status === "ok") {
    if (frame.value === undefined) return { status: "ok" };
    try {
      const json = JSON.stringify(frame.value);
      if (json === undefined || Buffer.byteLength(json) > 64 * 1024 || hasUnsafeControl(frame.value)) return null;
    } catch {
      return null;
    }
    return { status: "ok", value: frame.value };
  }
  return null;
}

function hasUnsafeControl(value) {
  if (typeof value === "string") return [...value].some((ch) => ch !== "\n" && ch !== "\t" && /\p{Cc}/u.test(ch));
  if (Array.isArray(value)) return value.some(hasUnsafeControl);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, item]) => hasUnsafeControl(key) || hasUnsafeControl(item));
  }
  return false;
}
