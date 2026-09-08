import type { CrewEventsChunk, CrewEventCursor, Envelope } from "@dextui/protocol";
import { SessionStore } from "./session.js";

export interface WorkerPermission {
  id: string; tool: string; summary: string; choices: string[]; sent?: boolean;
}
/** Worker-local projection only: never registered with the parent's session store. */
export class CrewTranscript {
  store = new SessionStore("worker");
  cursor?: CrewEventCursor;
  permissions: WorkerPermission[] = [];
  available = false;
  gap = false;
  ended = false;
  interactive = false;
  reset(): void {
    this.store = new SessionStore("worker");
    this.cursor = undefined;
    this.permissions = [];
    this.available = false;
    this.gap = false;
    this.ended = false;
    this.interactive = false;
  }
  accept(chunk: CrewEventsChunk, subscription: string): boolean {
    if (chunk.subscription !== subscription) return false;
    if (chunk.unavailable) { this.available = false; this.permissions = []; return true; }
    if (chunk.reset || this.cursor?.attempt !== chunk.attempt) this.reset();
    this.available = true;
    this.gap ||= chunk.gap;
    this.interactive = chunk.interactive;
    for (const record of chunk.events) {
      if (record.attempt !== chunk.attempt || record.seq <= (this.cursor?.seq ?? 0)) continue;
      if (this.cursor && record.seq !== this.cursor.seq + 1) { this.gap = true; this.permissions = []; }
      const data = record.data as Record<string, unknown> | undefined;
      if (record.event === "transcript_gap") {
        this.gap = true;
      } else if (record.event === "permission_request" && typeof data?.id === "string") {
        this.permissions = [{ id: data.id, tool: String(data.tool ?? "tool"), summary: String(data.summary ?? ""), choices: Array.isArray(data.choices) ? data.choices.filter((c): c is string => ["once", "always", "deny"].includes(String(c))) : [] }];
      } else if (record.event === "permission_resolved") {
        this.permissions = this.permissions.filter((p) => p.id !== data?.id);
      } else if (record.event === "worker_exit") {
        this.permissions = [];
      } else {
        this.store.apply({ v: 1, seq: record.seq, ts: record.ts, event: record.event, data: record.data } as Envelope);
      }
      this.cursor = { attempt: chunk.attempt, seq: record.seq };
    }
    this.cursor ??= { attempt: chunk.attempt, seq: chunk.seq };
    this.ended = chunk.ended;
    if (chunk.permission !== undefined) this.permissions = chunk.permission ? [{ ...chunk.permission }] : [];
    if (this.ended) this.permissions = [];
    // Bound the renderer, including tool lookup state, independently of journal size.
    const state = this.store.state;
    let chars = 0;
    let start = state.blocks.length;
    while (start > 0 && state.blocks.length - start < 200) {
      const cost = JSON.stringify(state.blocks[start - 1]).length;
      if (chars + cost > 512 * 1024) break;
      chars += cost;
      start--;
    }
    if (start > 0) {
      state.blocks = state.blocks.slice(start);
      state.toolIndex = new Map();
      state.blocks.forEach((b, i) => { if (b.kind === "tool") state.toolIndex.set(b.call_id, i); });
      this.gap = true;
    }
    return true;
  }
}
