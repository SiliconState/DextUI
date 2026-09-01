// Server-side journal fold: builds session.snapshot blocks from a journal.
// Mirrors the client store's projection so both stay honest against fixtures.

const TAIL_CAP = 4000;

export function fold(journal) {
  const blocks = [];
  const toolIndex = new Map();
  let openText = null;
  let openThinking = null;

  const mergeTool = (d, patch) => {
    let i = toolIndex.get(d.call_id);
    if (i === undefined) {
      i = blocks.push({
        kind: "tool",
        call_id: d.call_id,
        name: d.name,
        summary: d.summary ?? "",
        status: "preview",
      }) - 1;
      toolIndex.set(d.call_id, i);
    }
    Object.assign(blocks[i], patch);
  };

  for (const env of journal) {
    const d = env.data;
    switch (env.event) {
      case "user_message":
        openText = null;
        openThinking = null;
        blocks.push({ kind: "user", text: d.text });
        break;
      case "text_delta":
        // Only append when the open text block is still the last block — tool
        // cards or markers in between must start a fresh block (client parity).
        if (openText && blocks[blocks.length - 1] === openText) openText.text += d;
        else {
          openText = { kind: "text", text: d, complete: false };
          blocks.push(openText);
        }
        break;
      case "text_block_complete":
        if (openText && blocks[blocks.length - 1] === openText) {
          openText.text = d;
          openText.complete = true;
        } else blocks.push({ kind: "text", text: d, complete: true });
        openText = null;
        break;
      case "thinking_delta":
        if (openThinking && blocks[blocks.length - 1] === openThinking) openThinking.text += d;
        else {
          openThinking = { kind: "thinking", text: d, complete: false };
          blocks.push(openThinking);
        }
        break;
      case "thinking_block_complete":
        if (openThinking && blocks[blocks.length - 1] === openThinking) {
          openThinking.text = d;
          openThinking.complete = true;
        } else blocks.push({ kind: "thinking", text: d, complete: true });
        openThinking = null;
        break;
      case "tool_call_preview":
        mergeTool(d, { status: "preview" });
        break;
      case "tool_call_start":
        mergeTool(d, { status: "running" });
        break;
      case "tool_output_delta": {
        const i = toolIndex.get(d.call_id);
        if (i !== undefined) {
          const b = blocks[i];
          b.output_tail = ((b.output_tail ?? "") + d.text).slice(-TAIL_CAP);
        }
        break;
      }
      case "tool_call_result":
        mergeTool(d, { status: d.ok ? "ok" : "failed", content: d.content });
        break;
      case "info":
        blocks.push({ kind: "marker", level: "info", text: d });
        break;
      case "warn":
        blocks.push({ kind: "marker", level: "warn", text: d });
        break;
      case "error":
        blocks.push({ kind: "marker", level: "error", text: d });
        break;
      case "slash":
        blocks.push({ kind: "slash", text: d, structured: false });
        break;
      case "structured_slash":
        blocks.push({ kind: "slash", text: d, structured: true });
        break;
      case "compact_end":
        blocks.push({ kind: "marker", level: "note", text: `Context compacted: ${d.before} → ${d.after} chars.` });
        break;
      case "interrupted":
        blocks.push({ kind: "marker", level: "warn", text: "Interrupted." });
        break;
      case "steering_received":
        blocks.push({ kind: "marker", level: "note", text: `Steering: ${d.preview}` });
        break;
      default:
        break;
    }
  }
  return blocks;
}
