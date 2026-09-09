// Isolated tests for pack credential persistence: first-time saves, atomic
// replacement, and symlink confinement. No real operator state.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { writePackCredentials, readPackCredentials, credentialsFile, parseEnvFile } from "../src/pack-credentials.mjs";

const tempRoot = fs.mkdtempSync(path.join(process.cwd(), ".cred-test-"));
const home = path.join(tempRoot, "dext");

test("first-time credential save succeeds (file did not exist)", () => {
  const file = credentialsFile(home, "alpha");
  assert.equal(fs.existsSync(file), false, "fixture starts without a credentials file");
  writePackCredentials(home, "alpha", { ALPHA_TOKEN: "s3cret" });
  assert.equal(readPackCredentials(home, "alpha").ALPHA_TOKEN, "s3cret", "value round-trips on first save");
  const st = fs.statSync(file);
  assert.equal(st.mode & 0o777, 0o600, "file mode 0600");
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700, "dir mode 0700");
});

test("replacement is atomic and leaves no tmp files behind", () => {
  const file = credentialsFile(home, "alpha");
  writePackCredentials(home, "alpha", { ALPHA_TOKEN: "second" });
  assert.equal(readPackCredentials(home, "alpha").ALPHA_TOKEN, "second");
  const leftovers = fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "no temp files remain");
});

test("a pre-created .tmp symlink is never followed", () => {
  const file = credentialsFile(home, "beta");
  writePackCredentials(home, "beta", { BETA_TOKEN: "one" });
  const outside = path.join(tempRoot, "outside-target.txt");
  fs.writeFileSync(outside, "do not touch");
  // Plant the old-style predictable temp name as a symlink to escape.
  fs.symlinkSync(outside, `${file}.tmp`);
  writePackCredentials(home, "beta", { BETA_TOKEN: "two" });
  assert.equal(fs.readFileSync(outside, "utf8"), "do not touch", "symlinked tmp target untouched");
  assert.equal(readPackCredentials(home, "beta").BETA_TOKEN, "two", "real file updated");
  assert.ok(fs.lstatSync(`${file}.tmp`).isSymbolicLink(), "planted symlink left as-is (not followed, not clobbered)");
});

test("a symlinked credentials file is refused", () => {
  const evil = path.join(tempRoot, "evil.env");
  fs.writeFileSync(evil, "X=1");
  fs.mkdirSync(path.dirname(credentialsFile(home, "gamma")), { recursive: true, mode: 0o700 });
  fs.symlinkSync(evil, credentialsFile(home, "gamma"));
  assert.throws(() => writePackCredentials(home, "gamma", { GAMMA_TOKEN: "x" }), /symlink refused/);
  assert.equal(fs.readFileSync(evil, "utf8"), "X=1", "symlink target untouched");
});

test("a symlinked credentials directory is refused", () => {
  const realDir = path.join(tempRoot, "real-creds");
  fs.mkdirSync(realDir, { recursive: true });
  fs.symlinkSync(realDir, path.join(home, "packs", "credentials-link"));
  const homeLink = path.join(tempRoot, "dext-link");
  fs.mkdirSync(homeLink, { recursive: true });
  fs.symlinkSync(realDir, path.join(homeLink, "packs"));
  assert.throws(() => writePackCredentials(homeLink, "delta", { D: "x" }), /refused/);
});

test("empty values remove the file; missing file removal is a no-op", () => {
  writePackCredentials(home, "alpha", {});
  assert.equal(fs.existsSync(credentialsFile(home, "alpha")), false, "empty save deletes the file");
  writePackCredentials(home, "alpha", {}); // absent: no throw
});

test("parseEnvFile keeps values containing '=' and skips junk", () => {
  // Values are everything after the first `=` (leading space preserved by design).
  const v = parseEnvFile("A=b=c\n# comment\n\nbad-line\nB= spaced");
  assert.deepEqual(v, { A: "b=c", B: " spaced" });
});

process.on("exit", () => fs.rmSync(tempRoot, { recursive: true, force: true }));
