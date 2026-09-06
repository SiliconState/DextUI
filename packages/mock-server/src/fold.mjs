// Server-side journal fold: builds session.snapshot blocks from a journal.
// Mirrors the client store's projection so both stay honest against fixtures.

const TAIL_CAP = 4000;

export function foldMeta(journal) {
  let turnUsage;
  let sessionUsage;
  let contextChars;
  let diagnostics;
  let compacting = false;
  let failed = false;
  for (const env of journal) {
    const d = env.data;
    switch (env.event) {
      case "turn_start":
        failed = false;
        break;
      case "usage_update":
        turnUsage = d?.turn;
        sessionUsage = d?.session;
        break;
      case "turn_end":
        failed = !!d?.failed;
        if (d?.usage) sessionUsage = d.usage;
        break;
      case "history_context_updated":
        contextChars = d?.chars;
        break;
      case "turn_diagnostics":
        diagnostics = d;
        break;
      case "compact_start":
        compacting = true;
        break;
      case "compact_end":
      case "compact_failed":
        compacting = false;
        break;
      default:
        break;
    }
  }
  return { turnUsage, sessionUsage, contextChars, diagnostics, compacting, failed };
}

export function fold(journal) {
  const blocks = [];
  const toolIndex = new Map();
  const pendingRequests = new Map();
  let openText = null;
  let openThinking = null;

  // End of turn (or interrupt): no streaming block may stay open. Seal every
  // incomplete text/thinking block, not just the current pointers — a stream
  // that moved on without a *_block_complete leaves orphans behind, and the
  // client's sealOpenBlocks() closes those too (parity).
  const sealOpen = () => {
    for (const b of blocks) {
      if ((b.kind === "text" || b.kind === "thinking") && b.complete === false) b.complete = true;
    }
    openText = null;
    openThinking = null;
  };

  const mergeTool = (d, patch) => {
    // name/summary are sticky: an event that omits them (or sends "") never
    // clears what an earlier event set — tool_call_preview often carries the
    // only summary, and later start/result events may omit it entirely.
    const summary = d.summary || "";
    let i = toolIndex.get(d.call_id);
    if (i === undefined) {
      i = blocks.push({
        kind: "tool",
        call_id: d.call_id,
        name: d.name,
        summary,
        status: "preview",
      }) - 1;
      toolIndex.set(d.call_id, i);
    } else {
      if (summary) blocks[i].summary = summary;
      if (d.name) blocks[i].name = d.name;
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
        // Text ends any open thinking (providers may skip thinking_block_complete);
        // client parity with SessionStore.appendStream.
        if (openThinking) {
          openThinking.complete = true;
          openThinking = null;
        }
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
        if (openText) {
          openText.complete = true;
          openText = null;
        }
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
      case "tool_batch_start":
        blocks.push({ kind: "marker", level: "note", text: `Batch: ${(d.labels ?? []).join(" · ")}` });
        break;
      case "tool_batch_end":
        if ((d.failed ?? 0) > 0) blocks.push({ kind: "marker", level: "warn", text: `Batch: ${d.failed} tool call(s) failed.` });
        break;
      case "runtime_view":
        blocks.push({ kind: "view", pack: d.pack, title: d.title, markdown: d.markdown });
        break;
      case "pack_start": {
        // Client parity: stamp the most recent user block with the pack dext activated.
        if (typeof d?.name !== "string" || !d.name) break;
        for (let i = blocks.length - 1; i >= 0; i--) {
          if (blocks[i].kind === "user") {
            if (blocks[i].pack !== d.name) blocks[i] = { kind: "user", text: blocks[i].text, pack: d.name };
            break;
          }
        }
        break;
      }
      case "local_auth_prompt":
        blocks.push({ kind: "marker", level: "warn", text: `Credentials requested by ${d.tool}: ${d.message}` });
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
      case "compact_failed":
        blocks.push({ kind: "marker", level: "warn", text: `Compaction failed: ${d.message}` });
        break;
      case "permission.request":
        pendingRequests.set(d.request_id, d);
        break;
      case "permission.resolved": {
        const request = pendingRequests.get(d.request_id);
        pendingRequests.delete(d.request_id);
        if (request) {
          blocks.push({
            kind: "marker",
            level: d.choice === "deny" ? "warn" : "info",
            text: `${request.tool}: ${d.choice}`,
          });
        }
        break;
      }
      case "permission.timeout": {
        const request = pendingRequests.get(d.request_id);
        pendingRequests.delete(d.request_id);
        if (request) blocks.push({ kind: "marker", level: "warn", text: `${request.tool}: approval timed out (denied)` });
        break;
      }
      case "turn_end":
        sealOpen();
        break;
      case "interrupted":
        sealOpen();
        blocks.push({ kind: "marker", level: "warn", text: "Interrupted." });
        break;
      case "steering_received":
        blocks.push({ kind: "marker", level: "note", text: `Steering: ${d.preview}` });
        break;
      // Events the client store also surfaces as markers (parity is asserted by
      // the fold-equivalence test); keep the wording byte-identical.
      case "http_retry":
        blocks.push({ kind: "marker", level: "warn", text: `Provider retry #${d.attempt} in ${d.wait_secs}s: ${d.reason}` });
        break;
      case "reasoning_mode_changed":
        blocks.push({ kind: "marker", level: "note", text: `Reasoning mode → ${d.mode}` });
        break;
      case "runtime_control":
        blocks.push({ kind: "marker", level: "info", text: `Runtime control: ${String(d)}` });
        break;
      case "runtime_control_applied": {
        const parts = [];
        if (d.model_changed) parts.push("model");
        if (d.effort_changed) parts.push("effort");
        if (d.mode_changed) parts.push("mode");
        if (d.stream_aborted) parts.push("stream aborted");
        blocks.push({
          kind: "marker",
          level: d.stream_aborted ? "warn" : "note",
          text: `Runtime control applied (${d.commands} command${d.commands === 1 ? "" : "s"})${parts.length ? `: ${parts.join(", ")}` : ""}`,
        });
        break;
      }
      case "login_input_mode":
        blocks.push({
          kind: "marker",
          level: "warn",
          text: `Login required${d?.provider ? ` for ${d.provider}` : ""} — complete it in the dext TUI.`,
        });
        break;
      default:
        break;
    }
  }
  return blocks;
}
