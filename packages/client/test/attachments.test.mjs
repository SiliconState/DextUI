import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("../../../apps/web/src/lib/attachments.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { attachmentBlock, imageAttachmentKind } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

const done = (name, type, size = 1024) => ({ name, path: `uploads/${name}`, type, size, status: "done" });

test("native-vision attachment detection matches read_image formats and source cap", () => {
  assert.equal(imageAttachmentKind(done("screen.png", "image/png")), "vision");
  assert.equal(imageAttachmentKind(done("photo.JPEG", "")), "vision");
  assert.equal(imageAttachmentKind(done("shot.webp", "application/octet-stream")), "vision");
  assert.equal(imageAttachmentKind(done("large.png", "image/png", 20 * 1024 * 1024 + 1)), "large-image");
  assert.equal(imageAttachmentKind(done("motion.gif", "image/gif")), "other-image");
  assert.equal(imageAttachmentKind(done("vector.svg", "")), "other-image");
  assert.equal(imageAttachmentKind(done("brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")), "file");
});

test("attachment handoff names read_image, consent, limits, and fallbacks without misrouting documents", () => {
  const prompt = attachmentBlock([
    done("screen.png", "image/png"),
    done("motion.gif", "image/gif"),
    done("huge.webp", "image/webp", 21 * 1024 * 1024),
    done("brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    { ...done("pending.png", "image/png"), status: "uploading" },
  ]);
  assert.match(prompt, /Attached image ready for native vision/);
  assert.match(prompt, /call read_image\(path\)/);
  assert.match(prompt, /maximum two per turn/);
  assert.match(prompt, /request approval before sanitized pixels are sent/);
  assert.match(prompt, /image input is unavailable.*OCR\/conversion/s);
  assert.match(prompt, /not accepted directly by read_image:[\s\S]*motion\.gif/);
  assert.match(prompt, /20 MiB source limit:[\s\S]*huge\.webp/);
  assert.match(prompt, /format-aware tools[\s\S]*brief\.docx/);
  assert.doesNotMatch(prompt, /pending\.png/);
});
