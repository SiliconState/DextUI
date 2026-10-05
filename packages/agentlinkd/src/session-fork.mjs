// Fork from a bounded coherent core snapshot, never infer Message counts from
// host seqs. Unknown/compacted-away/ambiguous selections fail closed.
import fs from "node:fs";
import { checkedPath } from "./session-files.mjs";
import { DISPLAY_CONTEXT } from "./display-context.mjs";
const CAP = 32 * 1024 * 1024;
const plain = (text) => String(text).replace(`\n\n${DISPLAY_CONTEXT}`, "").trim();
export function readForkSource(file, seat) {
  if (!checkedPath(file)) throw new Error("source checkpoint is missing");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > CAP) throw new Error("source checkpoint is not a bounded regular file");
    const buffer = Buffer.alloc(st.size + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size !== st.size) throw new Error("source checkpoint changed while reading");
    const bytes = buffer.subarray(0, size);
    const [header, ...messages] = bytes.toString("utf8").split("\n").filter((l) => l.trim()).map(JSON.parse);
    if (!header?.session_id || header.seat?.id !== seat || !header.sandbox) throw new Error("source checkpoint identity does not match the session");
    if (messages.some((m) => !m || typeof m.role !== "string" || !Array.isArray(m.content))) throw new Error("source checkpoint contains invalid messages");
    return { header, messages, bytes };
  } finally { fs.closeSync(fd); }
}
export function forkBoundary(messages, journal, atSeq) {
  if (atSeq === undefined) return messages.length;
  if (!Number.isSafeInteger(atSeq) || atSeq < 0) throw new Error("at_seq must be a non-negative integer");
  if (atSeq === 0) return 0;
  const event = journal.find((e) => e.seq === atSeq);
  if (!event) throw new Error("selected journal entry is no longer retained");
  const matches = [];
  messages.forEach((m, i) => {
    const blocks = m.content;
    if (event.event === "user_message" && m.role === "user" && blocks.some((b) => b.type === "text" && typeof event.data?.text === "string" && plain(b.text) === plain(event.data.text))) matches.push(i + 1);
    if (event.event === "text_block_complete" && m.role === "assistant" && blocks.some((b) => b.type === "text" && b.text === event.data)) matches.push(i + 1);
    if (event.event === "tool_call_result" && blocks.some((b) => b.type === "tool_result" && b.tool_use_id === event.data?.call_id)) matches.push(i + 1);
  });
  if (matches.length !== 1) throw new Error("selection is ambiguous, unsupported, or compacted away; choose another complete message");
  return matches[0];
}
/** Project only the retained authoritative messages, not old host approvals,
 * usage, transient jobs or the original journal's later events. */
export function forkEvents(messages) {
  const events = [];
  for (const m of messages) for (const b of m.content) {
    if (b.type === "text" && typeof b.text === "string") {
      events.push(m.role === "user" ? { event: "user_message", data: { text: plain(b.text) } } : { event: "text_block_complete", data: b.text });
    } else if (b.type === "tool_use") {
      events.push({ event: "tool_call_preview", data: { call_id: b.id, name: b.name, summary: `${b.name}: ${JSON.stringify(b.input)}`.slice(0, 1000) } });
    } else if (b.type === "tool_result") {
      const content = typeof b.content === "string" ? b.content : JSON.stringify(b.content) ?? "";
      events.push({ event: "tool_call_result", data: { call_id: b.tool_use_id, name: "", summary: "", ok: !b.is_error, content, preview: content.slice(0, 200) } });
    }
  }
  return events;
}
