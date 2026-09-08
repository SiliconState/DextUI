// Uploads: name sanitising, address guards, streamed writes with caps and
// collision suffixes, and the uploads-directory symlink refusal. The fetch
// happy path needs a public network peer, so it is covered by its guards.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { UPLOAD_DIR, assertFetchable, blockedAddress, fileNameFromResponse, receiveUpload, sanitizeName, uploadDirFor } from "../src/uploads.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "uploads-"));

test("sanitizeName: basename only, no controls/dots, capped length keeping the extension", () => {
  assert.equal(sanitizeName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeName("..\\..\\windows\\system32\\x.ini"), "x.ini");
  assert.equal(sanitizeName(".hidden"), "hidden");
  assert.equal(sanitizeName("a\u0000b\u001fc d.pdf"), "abc d.pdf");
  assert.equal(sanitizeName(""), "file");
  assert.equal(sanitizeName(".."), "file");
  assert.equal(sanitizeName("   "), "file");
  const long = sanitizeName(`${"x".repeat(400)}.pdf`);
  assert.ok(long.length <= 120 && long.endsWith(".pdf"), long);
});

test("blockedAddress: every shape of this-machine address is refused", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.0.1", "172.31.9.9", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::", "::1", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::FFFF:C0A8:0001", "[::1]"]) {
    assert.equal(blockedAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(blockedAddress(ip), false, ip);
  }
});

test("assertFetchable: credentials, ports, and this-machine hosts are refused before any connect", async () => {
  const rejects = async (url, why) => {
    try {
      await assertFetchable(new URL(url));
    } catch (e) {
      assert.ok(e.error, `${why} -> error object`);
      return e.error;
    }
    assert.fail(`${why} was accepted`);
  };
  assert.equal(await rejects("https://user:pw@example.com/f.pdf", "credentials"), "bad_url");
  assert.equal(await rejects("http://localhost/x", "localhost"), "blocked_host");
  assert.equal(await rejects("http://127.0.0.1/x", "loopback literal"), "blocked_host");
  assert.equal(await rejects("http://[::1]/x", "bracketed v6 loopback"), "blocked_host");
  assert.equal(await rejects("http://[::ffff:7f00:1]/x", "hex-mapped v4 loopback"), "blocked_host");
  assert.equal(await rejects("http://10.0.0.5/x", "private literal"), "blocked_host");
  assert.equal(await rejects("http://nas/x", "single label"), "blocked_host");
  assert.equal(await rejects("http://printer.local/x", "mDNS"), "blocked_host");
  assert.equal(await rejects("http://example.com:8788/x", "the host's own port"), "bad_port");
  assert.equal(await rejects("ftp://example.com/f", "scheme"), "bad_url");
});

test("fileNameFromResponse: URL basename, decoded, extension from content-type when the path has none", () => {
  const res = (ct) => ({ headers: new Map(ct ? [["content-type", ct]] : []) });
  assert.equal(fileNameFromResponse(new URL("https://x.test/a/b/Q1%20report.pdf?v=2"), res()), "Q1 report.pdf");
  assert.equal(fileNameFromResponse(new URL("https://x.test/img/123"), res("image/png; charset=binary")), "123.png");
  assert.equal(fileNameFromResponse(new URL("https://x.test/"), res("application/pdf")), "download.pdf");
  assert.equal(fileNameFromResponse(new URL("https://x.test/%E0%A4%A"), res()), "%E0%A4%A"); // bad escape: raw basename, no throw
});

const fakeReq = (chunks, len) => {
  const req = new EventEmitter();
  req.headers = len === undefined ? {} : { "content-length": String(len) };
  queueMicrotask(() => {
    for (const c of chunks) req.emit("data", Buffer.from(c));
    req.emit("end");
  });
  return req;
};

test("receiveUpload: streams to uploads/, reports the cwd-relative path", async () => {
  const dir = tmp();
  const out = await receiveUpload(fakeReq(["hello ", "world"], 11), dir, "notes.txt");
  assert.deepEqual(Object.keys(out).sort(), ["bytes", "name", "path"]);
  assert.equal(out.path, `${UPLOAD_DIR}/notes.txt`);
  assert.equal(out.bytes, 11);
  assert.equal(fs.readFileSync(path.join(dir, "notes.txt")).toString(), "hello world");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("receiveUpload: name collisions get -2/-3, never overwrite; hostile names collapse", async () => {
  const dir = tmp();
  const first = await receiveUpload(fakeReq(["a"], 1), dir, "report.pdf");
  const second = await receiveUpload(fakeReq(["b"], 1), dir, "report.pdf");
  assert.equal(first.path, `${UPLOAD_DIR}/report.pdf`);
  assert.equal(second.path, `${UPLOAD_DIR}/report-2.pdf`);
  assert.equal(fs.readFileSync(path.join(dir, "report.pdf")).toString(), "a");
  const sneaky = await receiveUpload(fakeReq(["c"], 1), dir, "../report.pdf");
  assert.equal(sneaky.path, `${UPLOAD_DIR}/report-3.pdf`); // traversal reduced to its basename, then uniquified
  fs.rmSync(dir, { recursive: true, force: true });
});

test("receiveUpload: over-cap bodies are refused by content-length and unlinked mid-stream", { timeout: 10000 }, async () => {
  const dir = tmp();
  const declared = await receiveUpload(fakeReq(["x"], 65 * 1024 * 1024 + 1), dir, "big.bin");
  assert.equal(declared.error, "too_large");
  const req = new EventEmitter();
  req.headers = {};
  let paused = false;
  req.pause = () => { paused = true; };
  const done = receiveUpload(req, dir, "big.bin");
  req.emit("data", Buffer.alloc(64 * 1024 * 1024));
  req.emit("data", Buffer.from("!"));
  const streamed = await done;
  assert.equal(streamed.error, "too_large");
  assert.equal(paused, true, "stops reading without destroying the socket");
  assert.equal(fs.existsSync(path.join(dir, "big.bin")), false, "partial file unlinked");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("receiveUpload: a connection that dies mid-body aborts and leaves nothing behind", async () => {
  const dir = tmp();
  const req = new EventEmitter();
  req.headers = {};
  const done = receiveUpload(req, dir, "gone.txt");
  req.emit("data", Buffer.from("partial"));
  req.emit("close");
  const out = await done;
  assert.equal(out.error, "aborted");
  assert.equal(fs.readdirSync(dir).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("uploadDirFor: real dir under cwd; a planted symlink named uploads/ is refused", () => {
  const ws = tmp();
  const outside = tmp();
  const dir = uploadDirFor(ws);
  assert.ok(dir && dir.startsWith(fs.realpathSync(ws) + path.sep));
  fs.rmdirSync(path.join(ws, UPLOAD_DIR));
  fs.symlinkSync(outside, path.join(ws, UPLOAD_DIR));
  assert.equal(uploadDirFor(ws), null, "symlinked uploads dir escapes the workspace");
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
