// Preloaded by `npm test` (node --import). On macOS os.tmpdir() lives under
// /var, a symlink to /private/var. The host refuses symlinked folders, so tests
// that create workspaces or state in the temp dir would fail for the wrong
// reason. Resolve it once; spawned hosts inherit the real path through TMPDIR.
import fs from "node:fs";
import os from "node:os";

try {
  const tmp = os.tmpdir();
  const real = fs.realpathSync(tmp);
  if (real !== tmp) process.env.TMPDIR = real;
} catch {
  // Leave TMPDIR alone; tests report their own failures.
}
