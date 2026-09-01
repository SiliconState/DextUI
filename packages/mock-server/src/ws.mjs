// Minimal RFC 6455 WebSocket server primitives. Zero dependencies (Node 22+).
// Server → client frames are unmasked; client → server frames are masked.

import crypto from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const OP_TEXT = 0x1;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

export function acceptKey(key) {
  return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

export function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

/** Incremental frame parser with continuation support. */
export class FrameParser {
  constructor({ onMessage, onClose, onPing }) {
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.onPing = onPing;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
  }

  push(chunk) {
    if (this.buf.length === 0) this.buf = chunk;
    else this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      let f;
      try {
        f = this.tryReadFrame();
      } catch (err) {
        this.onClose?.(Buffer.alloc(0));
        return;
      }
      if (!f) return;
      if (f.opcode === OP_CLOSE) {
        this.onClose?.(f.payload);
        return;
      }
      if (f.opcode === OP_PING) {
        this.onPing?.(f.payload);
        continue;
      }
      if (f.opcode === OP_PONG) continue;
      if (f.opcode === OP_TEXT || f.opcode === 0x2) {
        if (!f.fin) {
          this.fragments.push(f.payload);
          continue;
        }
        this.onMessage(f.payload);
      } else if (f.opcode === 0) {
        this.fragments.push(f.payload);
        if (f.fin) {
          const full = Buffer.concat(this.fragments);
          this.fragments = [];
          this.onMessage(full);
        }
      }
    }
  }

  tryReadFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > 64n * 1024n * 1024n) throw new Error("frame too large");
      len = Number(big);
      off = 10;
    }
    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4);
      off += 4;
    }
    if (b.length < off + len) return null;
    let payload = b.subarray(off, off + len);
    if (mask) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    this.buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }
}
