// bridge.mjs: one persistent `dext --input ndjson --output stream-json` child
// per session. The host writes JSON frames to stdin (user | steer | control |
// interrupt | permission | close) and reads stream-json events from stdout.
//
// dext's interactive loop routes each frame by its own busy state: user text
// while a turn runs is *real* steering (folded into the next model request,
// `steering_received`), `/effort …` while busy is a live runtime control, and
// `permission_request` events block the tool until the host answers over the
// same pipe. One-shot `-p` children (server.mjs runTurn) remain the fallback
// for binaries without `--input`.

import { spawn } from "node:child_process";

export const BRIDGE_FRAMES = ["user", "steer", "control", "interrupt", "permission", "close"];

/** `dext --help` advertises `--input ndjson` from the stdin-bridge patch on. */
export function probeNdjsonSupport(dextOutput) {
  const help = dextOutput(["--help"]);
  return typeof help === "string" && help.includes("--input ndjson");
}

/** Build argv for a bridged child; `resume` replays the seat's session. */
export function bridgeArgs({ cwd, approval, effort, seat, resume }) {
  const args = ["--input", "ndjson", "--output", "stream-json", "--cd", cwd, "--approval", approval, "--effort", effort, "--seat", seat];
  if (resume) args.push("--resume");
  return args;
}

/**
 * Spawn a bridged child. Callbacks:
 *   onEvent({event, data})  every stdout event line (including `ready`)
 *   onNoise(line)           non-JSON stdout (should be empty; surfaced for diagnostics)
 *   onStderr(text)          stderr chunks
 *   onExit(code, signal)    once, after stdout is drained
 */
export function spawnBridge({ bin, args, cwd, env, maxBuffer = 4 * 1024 * 1024, onEvent, onNoise, onStderr, onExit }) {
  const child = spawn(bin, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdin.on("error", () => {}); // EPIPE after exit is not an error for the host

  let buf = "";
  let ready = null;
  let exited = false;
  let readyResolve;
  let readyReject;
  const readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  readyPromise.catch(() => {}); // callers that never await still must not crash

  const handleLine = (line) => {
    const t = line.trim();
    if (!t) return;
    let v;
    try {
      v = JSON.parse(t);
    } catch {
      onNoise?.(t);
      return;
    }
    if (!v || typeof v.event !== "string") return;
    if (v.event === "ready" && !ready) {
      ready = v.data ?? {};
      readyResolve(ready);
    }
    onEvent?.(v);
  };

  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    if (buf.length > maxBuffer) {
      buf = "";
      onStderr?.(`dext emitted more than ${maxBuffer} bytes without a newline`);
      signal(child, "SIGKILL");
      return;
    }
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      handleLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  child.stderr.on("data", (d) => onStderr?.(d.toString("utf8")));

  let finished = false;
  const finish = (code, sig) => {
    if (finished) return;
    finished = true;
    exited = true;
    if (buf.trim()) handleLine(buf);
    buf = "";
    if (!ready) readyReject(new Error(`dext exited before ready (code ${code ?? sig ?? "?"})`));
    onExit?.(code, sig);
  };
  child.on("error", (err) => {
    onStderr?.(String(err));
    setTimeout(() => finish(null, null), 500);
  });
  child.on("close", (code, sig) => finish(code, sig));

  const write = (frame) => {
    if (exited || !child.stdin.writable) return false;
    try {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
      return true;
    } catch {
      return false;
    }
  };

  return {
    child,
    get pid() {
      return child.pid;
    },
    get ready() {
      return ready;
    },
    get exited() {
      return exited;
    },
    whenReady: () => readyPromise,
    write,
    user: (text, seq, confirmSecret = false) => write({ type: "user", text, ...(seq ? { seq } : {}), ...(confirmSecret ? { confirm_secret: true } : {}) }),
    steer: (text, seq) => write({ type: "steer", text, ...(seq ? { seq } : {}) }),
    control: (command, seq) => write({ type: "control", command, ...(seq ? { seq } : {}) }),
    interrupt: () => write({ type: "interrupt" }),
    permission: (id, choice) => write({ type: "permission", id, choice }),
    /** Graceful stop: close frame + EOF; dext autosaves and exits. */
    close: () => {
      write({ type: "close" });
      try {
        child.stdin.end();
      } catch {
        /* already gone */
      }
    },
    kill: (sig) => signal(child, sig),
  };
}

/** Signal the whole process group (tool descendants too), direct-child fallback. */
export function signal(child, sig) {
  if (!child?.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* gone */
    }
  }
}

/** Map a core `permission_request` to the AgentLink `permission.request` shape. */
export function toPermissionRequest(d) {
  return {
    request_id: String(d.id),
    tool: String(d.tool ?? ""),
    summary: typeof d.summary === "string" ? d.summary : "",
    input: d.input,
  };
}

/** Host `permission.respond` choices → dext bridge choices. */
export function toBridgeChoice(choice) {
  switch (choice) {
    case "allow":
    case "allow_once":
    case "once":
      return "once";
    case "allow_always":
    case "always":
      return "always";
    case "deny":
      return "deny";
    default:
      return null;
  }
}
