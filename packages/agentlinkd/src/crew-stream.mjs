// A single selected log per connection. Cursors are observations, never file paths.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const CHUNK_BYTES = 32 * 1024;
const WINDOW_BYTES = 64 * 1024;

export function readLogChunk(source, cursor) {
  const fd = fs.openSync(source.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("not a regular log");
    const generation = createHash("sha256").update(`${source.attempt}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`).digest("hex").slice(0, 32);
    const valid = cursor?.generation === generation && Number.isSafeInteger(cursor.offset) && cursor.offset >= 0 && cursor.offset <= stat.size;
    const reset = !valid || stat.size - cursor.offset > WINDOW_BYTES;
    const start = reset ? Math.max(0, stat.size - WINDOW_BYTES) : cursor.offset;
    const data = Buffer.alloc(Math.min(CHUNK_BYTES, stat.size - start));
    const count = fs.readSync(fd, data, 0, data.length, start);
    return { generation, offset: start + count, start, reset, gap: reset && (!!cursor || start > 0), bytes: stat.size, data: data.subarray(0, count).toString("base64") };
  } finally { fs.closeSync(fd); }
}

export function subscribeLog({ source, cursor = null, send, writable = () => true, intervalMs = 250 }) {
  let closed = false;
  let watcher;
  let directory;
  let observed = cursor;
  let missing = false;
  let lastTick = 0;
  function tick() {
    if (closed || !writable() || Date.now() - lastTick < 100) return;
    lastTick = Date.now();
    try {
      const current = source();
      if (!current) {
        if (!missing) { send({ unavailable: true }); missing = true; }
        return;
      }
      const nextDirectory = path.dirname(current.file);
      if (directory !== nextDirectory || !watcher) {
        watcher?.close();
        directory = nextDirectory;
        try {
          const installed = fs.watch(directory, { persistent: false }, tick);
          watcher = installed;
          installed.on("error", () => { installed.close(); if (watcher === installed) watcher = undefined; });
        } catch { /* timer is also the lost-notification reconciliation path */ }
      }
      const chunk = readLogChunk(current, observed);
      if (!chunk.reset && chunk.start === chunk.offset && !missing) return;
      if (send(chunk) !== false) {
        observed = { generation: chunk.generation, offset: chunk.offset };
        missing = false;
      }
    } catch {
      if (!missing) { send({ unavailable: true }); missing = true; }
    }
  }
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return () => { closed = true; clearInterval(timer); watcher?.close(); };
}
