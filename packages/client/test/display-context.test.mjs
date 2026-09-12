import test from "node:test";
import assert from "node:assert/strict";
import { DISPLAY_CONTEXT, withDisplayContext } from "../../agentlinkd/src/display-context.mjs";

test("DextUI turns advertise the viewer without replacing the user request", () => {
  for (const prompt of ["Build a dashboard", "Continue the existing webpage", "/pack run report quarterly summary"]) {
    assert.equal(withDisplayContext(prompt), `${prompt}\n\n${DISPLAY_CONTEXT}`);
  }
  assert.match(DISPLAY_CONTEXT, /relative\/path\.html/);
  assert.match(DISPLAY_CONTEXT, /light, dark, or dim/);
  assert.match(DISPLAY_CONTEXT, /network,.*blocked/);
  assert.ok(DISPLAY_CONTEXT.length < 700, "keep the capability note compact");
});

test("native slash controls are not turned into malformed commands", () => {
  for (const prompt of ["/compact", "/effort high", "/model glm/glm-5.3", "/pack list"]) {
    assert.equal(withDisplayContext(prompt), prompt);
  }
});
