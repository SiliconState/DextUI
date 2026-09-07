import test from "node:test";
import assert from "node:assert/strict";
import { CrewLogBuffer } from "../dist/index.js";

function chunk(bytes, start = 0, extra = {}) {
  const data = Buffer.from(bytes);
  return { run: "run-test", worker: "0", subscription: "new", generation: "generation", start, offset: start + data.length, bytes: start + data.length, reset: start === 0, gap: false, data: data.toString("base64"), ...extra };
}

test("obsolete subscription frames cannot reset or clear the selected log", () => {
  const buffer = new CrewLogBuffer();
  assert.deepEqual(buffer.accept(chunk("current"), "new").lines, ["current"]);
  assert.equal(buffer.accept(chunk("old", 0, { subscription: "old" }), "new"), "stale");
  assert.equal(buffer.accept({ subscription: "old", unavailable: true }, "new"), "stale");
  assert.deepEqual(buffer.accept(chunk(" data", 7), "new").lines, ["current data"]);
});

test("UTF-8 decoder survives chunks and reconnect; gaps reset partial characters", () => {
  const buffer = new CrewLogBuffer();
  const bytes = Buffer.from("💖");
  buffer.accept(chunk(bytes.subarray(0, 2)), "new");
  const rest = chunk(bytes.subarray(2), 2, { subscription: "reconnected" });
  assert.deepEqual(buffer.accept(rest, "reconnected").lines, ["💖"]);
  assert.equal(buffer.accept(chunk("duplicate", 2), "new"), "resync");
  const reset = chunk("fresh", 10, { reset: true, gap: true });
  assert.deepEqual(buffer.accept(reset, "new").lines, ["[Earlier log output unavailable or outside the retained window]", "fresh"]);
});

test("unavailability retains replay state; line clipping is reported", () => {
  const buffer = new CrewLogBuffer();
  const first = chunk("x".repeat(500));
  const result = buffer.accept(first, "new");
  assert.equal(result.truncated, true);
  assert.equal(result.lines[0].length, 400);
  assert.equal(buffer.accept({ subscription: "new", unavailable: true }, "new"), "unavailable");
  assert.equal(buffer.cursor.offset, 500);
  assert.equal(buffer.accept(chunk("", 500), "new").lines[0].length, 400);
});
