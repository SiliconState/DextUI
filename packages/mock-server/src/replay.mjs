// Fixture loading + replay pacing. Fixtures are real dext stream-json recordings.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(here, "..", "fixtures");

export function loadFixture(name) {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const v = JSON.parse(line);
    out.push({ event: v.event, data: v.data, delay: delayFor(v.event) });
  }
  return out;
}

function delayFor(event) {
  switch (event) {
    case "thinking_delta":
      return 3;
    case "text_delta":
      return 10;
    case "tool_call_preview":
      return 40;
    case "tool_call_start":
      return 50;
    case "tool_call_result":
      return 80;
    case "turn_start":
    case "turn_end":
    case "turn_diagnostics":
      return 15;
    default:
      return 5;
  }
}

/** Inject a synthetic approval pause after the tool_call_start event. */
export function withApprovalPause(script) {
  const out = [];
  for (const item of script) {
    out.push(item);
    if (item.event === "tool_call_start") {
      out.push({ pause: "approval" });
    }
  }
  return out;
}
