// Composer attachments: files uploaded into the session workspace
// (files_write) whose cwd-relative paths ride the prompt, so dext reads them
// from disk like any workspace file. Chips are per session; removing a chip
// never deletes the uploaded file (the agent may still be told about it).

export interface Attachment {
  id: number;
  name: string;
  size: number;
  status: "uploading" | "done" | "error";
  progress: number; // 0..1, file uploads only
  path?: string; // cwd-relative, once done
  error?: string;
  thumb?: string; // object URL for image chips
}

const store = $state<Record<string, Attachment[]>>({});
let seq = 0;

const token = (): string =>
  typeof localStorage !== "undefined" ? (localStorage.getItem("dextui.token") ?? "") : "";

export function attachmentsFor(sid: string): Attachment[] {
  return store[sid] ?? [];
}

export function removeAttachment(sid: string, id: number): void {
  const hit = (store[sid] ?? []).find((a) => a.id === id);
  if (hit?.thumb) URL.revokeObjectURL(hit.thumb);
  store[sid] = (store[sid] ?? []).filter((a) => a.id !== id);
}

/** Called on send: the paths are already quoted in the prompt. */
export function clearAttachments(sid: string): void {
  for (const a of store[sid] ?? []) if (a.thumb) URL.revokeObjectURL(a.thumb);
  store[sid] = [];
}

export const humanSize = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** The prompt tail that tells the agent which workspace files to read. */
export function attachmentBlock(list: Attachment[]): string {
  const done = list.filter((a) => a.status === "done" && a.path);
  if (done.length === 0) return "";
  const lines = done.map((a) => `- ${a.path} (${humanSize(a.size)})`).join("\n");
  return `Attached file${done.length > 1 ? "s" : ""} in the workspace:\n${lines}`;
}

function patch(sid: string, id: number, fields: Partial<Attachment>): void {
  const cur = (store[sid] ?? []).find((a) => a.id === id);
  if (cur) Object.assign(cur, fields);
}

/** Upload File objects (picker, drop, paste) into <cwd>/uploads. */
export function attachFiles(sid: string, files: File[]): void {
  for (const f of files) {
    const id = ++seq;
    store[sid] = [
      ...(store[sid] ?? []),
      {
        id,
        name: f.name || `paste-${id}`,
        size: f.size,
        status: "uploading",
        progress: 0,
        thumb: f.type.startsWith("image/") && f.size < 8 * 1024 * 1024 ? URL.createObjectURL(f) : undefined,
      },
    ];
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/sessions/${encodeURIComponent(sid)}/upload?name=${encodeURIComponent(f.name || `paste-${id}`)}`);
    xhr.setRequestHeader("authorization", `Bearer ${token()}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) patch(sid, id, { progress: e.loaded / e.total });
    };
    xhr.onload = () => {
      let body: { path?: string; name?: string; message?: string } = {};
      try { body = JSON.parse(xhr.responseText) as typeof body; } catch { /* below */ }
      if (xhr.status === 200 && body.path) patch(sid, id, { status: "done", path: body.path, name: body.name ?? f.name });
      else patch(sid, id, { status: "error", error: body.message ?? `HTTP ${xhr.status}` });
    };
    xhr.onerror = () => patch(sid, id, { status: "error", error: "network error" });
    xhr.send(f);
  }
}

/** Ask the host to download a URL into <cwd>/uploads. */
export function attachUrl(sid: string, url: string, name?: string): void {
  const id = ++seq;
  const clean = url.trim();
  if (!clean) return;
  store[sid] = [...(store[sid] ?? []), { id, name: name?.trim() || clean.split("/").filter(Boolean).pop() || "fetched", size: 0, status: "uploading", progress: 0 }];
  fetch(`/sessions/${encodeURIComponent(sid)}/fetch`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token()}` },
    body: JSON.stringify({ url: clean, name }),
  })
    .then(async (r) => {
      let body: { path?: string; name?: string; bytes?: number; error?: string; message?: string } = {};
      try { body = (await r.json()) as typeof body; } catch { /* below */ }
      if (r.ok && body.path) patch(sid, id, { status: "done", path: body.path, name: body.name, size: body.bytes ?? 0 });
      else patch(sid, id, { status: "error", error: body.message ?? body.error ?? `HTTP ${r.status}` });
    })
    .catch(() => patch(sid, id, { status: "error", error: "network error" }));
}
