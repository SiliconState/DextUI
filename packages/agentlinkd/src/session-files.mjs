// Inventory only seat-owned data. Never delete a workspace or follow symlinks.
import fs from "node:fs";
import path from "node:path";

export function checkedPath(p) {
  const absolute = path.resolve(p);
  let at = path.parse(absolute).root;
  for (const part of absolute.slice(at.length).split(path.sep).filter(Boolean)) {
    at = path.join(at, part);
    try {
      if (fs.lstatSync(at).isSymbolicLink()) throw new Error(`symlink refused: ${at}`);
    } catch (err) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
  }
  return true;
}

function directories(p) {
  if (!checkedPath(p)) return [];
  return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(p, e.name));
}

function header(p) {
  if (!checkedPath(p)) return null;
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return JSON.parse(buf.toString("utf8", 0, n).split("\n", 1)[0]);
  } finally { fs.closeSync(fd); }
}

export function seatFiles(seat, env = process.env) {
  if (!/^dextui-[a-f0-9]+$/.test(seat)) throw new Error("refusing to purge a non-DextUI seat");
  const home = path.resolve(env.DEXT_HOME ?? path.join(env.USERPROFILE ?? env.HOME ?? "", ".dext"));
  const projects = directories(path.join(home, "projects"));
  const roots = new Set(projects.map((p) => path.join(p, "sessions")));
  if (env.DEXT_SESSIONS_DIR) roots.add(path.resolve(env.DEXT_SESSIONS_DIR));
  const transcripts = [];
  const records = [];
  for (const root of roots) {
    for (const dir of directories(root)) {
      const file = path.join(dir, "_latest.jsonl");
      // A corrupt unrelated transcript is not proof of ownership.
      let h;
      try { h = header(file); } catch (err) {
        if (err instanceof SyntaxError) continue;
        throw err;
      }
      if (h?.seat?.id === seat) {
        transcripts.push(dir);
        if (env.DEXT_LOGS_DIR) {
          const logs = path.join(path.resolve(env.DEXT_LOGS_DIR), path.basename(dir));
          if (checkedPath(logs)) records.push(logs);
        }
      }
    }
  }
  for (const project of projects) {
    const dir = path.join(project, "seats", seat);
    if (!checkedPath(dir)) continue;
    const recordFile = path.join(dir, "seat.json");
    if (checkedPath(recordFile)) {
      const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
      if (record.id !== seat) throw new Error(`seat record mismatch: ${recordFile}`);
    }
    records.push(dir);
  }
  return { transcripts, records };
}

export function purgeSeat(seat) {
  const { transcripts, records } = seatFiles(seat);
  // Inventory validates all paths before deleting any of them. Recursive rm
  // unlinks nested symlinks rather than following them.
  for (const dir of [...transcripts, ...records]) {
    checkedPath(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
