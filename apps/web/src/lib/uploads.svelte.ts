// Composer attachments: files uploaded into the session workspace
// (files_write) whose cwd-relative paths ride the prompt, so dext reads them
// from disk like any workspace file. Chips are per session; removing a chip
// never deletes the uploaded file (the agent may still be told about it).
import { attachmentBlock, humanSize, imageAttachmentKind } from "./attachments";

export { attachmentBlock, humanSize, imageAttachmentKind };

export interface Attachment {
  id: number;
  name: string;
  size: number;
  status: "uploading" | "done" | "error";
  progress: number; // 0..1, file uploads only
  path?: string; // cwd-relative, once done
  error?: string;
  type?: string; // browser/host MIME hint; the workspace file remains authoritative
  thumb?: string; // object URL for image chips
}

const store = $state<Record<string, Attachment[]>>({});
const transfers = new Map<string, { abort: () => void }>();
let seq = 0;
const transferKey = (sid: string, id: number): string => `${sid}\u001f${id}`;

const token = (): string =>
  typeof localStorage !== "undefined" ? (localStorage.getItem("dextui.token") ?? "") : "";

export function attachmentsFor(sid: string): Attachment[] {
  return store[sid] ?? [];
}

export function removeAttachment(sid: string, id: number): void {
  const hit = (store[sid] ?? []).find((a) => a.id === id);
  if (!hit) return;
  transfers.get(transferKey(sid, id))?.abort();
  transfers.delete(transferKey(sid, id));
  if (hit.thumb) URL.revokeObjectURL(hit.thumb);
  const next = (store[sid] ?? []).filter((a) => a.id !== id);
  if (next.length) store[sid] = next;
  else delete store[sid];
}

/** Called on send: the paths are already quoted in the prompt. */
export function clearAttachments(sid: string): void {
  for (const a of store[sid] ?? []) {
    transfers.get(transferKey(sid, a.id))?.abort();
    transfers.delete(transferKey(sid, a.id));
    if (a.thumb) URL.revokeObjectURL(a.thumb);
  }
  delete store[sid];
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
        type: f.type || undefined,
        thumb: f.type.startsWith("image/") && f.size < 8 * 1024 * 1024 ? URL.createObjectURL(f) : undefined,
      },
    ];
    const xhr = new XMLHttpRequest();
    transfers.set(transferKey(sid, id), xhr);
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
    xhr.onloadend = () => transfers.delete(transferKey(sid, id));
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
  const ctl = new AbortController();
  transfers.set(transferKey(sid, id), ctl);
  fetch(`/sessions/${encodeURIComponent(sid)}/fetch`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token()}` },
    body: JSON.stringify({ url: clean, name }),
    signal: ctl.signal,
  })
    .then(async (r) => {
      let body: { path?: string; name?: string; bytes?: number; type?: string; error?: string; message?: string } = {};
      try { body = (await r.json()) as typeof body; } catch { /* below */ }
      if (r.ok && body.path) patch(sid, id, { status: "done", path: body.path, name: body.name, size: body.bytes ?? 0, type: body.type });
      else patch(sid, id, { status: "error", error: body.message ?? body.error ?? `HTTP ${r.status}` });
    })
    .catch(() => {
      if (!ctl.signal.aborted) patch(sid, id, { status: "error", error: "network error" });
    })
    .finally(() => transfers.delete(transferKey(sid, id)));
}
