// Exercise the actual framework state functions without browser/user credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { compileModule } from "svelte/compiler";

let fixtureId = 0;
async function fixture() {
  let source = fs.readFileSync("apps/web/src/lib/connectors.svelte.ts", "utf8").replace('import { app, pushToast } from "./state.svelte";', 'export const app = {caps: ["provider_auth"], conn: null, modelCatalog: []}; export const toasts = []; const pushToast = (...args) => toasts.push(args);');
  source = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const compiled = compileModule(source, { generate: "server", filename: "connectors.svelte.js" }).js.code.replace("'svelte/internal/server'", JSON.stringify(import.meta.resolve("svelte/internal/server")));
  return import(`data:text/javascript;base64,${Buffer.from(compiled + `\n//fixture-${++fixtureId}`).toString("base64")}`);
}
const reply = (changed) => ({ event: "x-agentlinkd.auth.status", data: { active: "deepseek", providers: [{ id: "deepseek", label: "DeepSeek", model: "test", auth: "key", active: true }], model_catalog: [{ provider: "deepseek", models: ["test"] }], ...(changed ? { changed } : {}) } });

test("provider state preserves pending writes across unrelated refresh/error/broadcast; only matching receipt resolves", async () => {
  const m = await fixture(); let sends = 0;
  m.app.conn = { authLogin() { sends++; return true; }, authStatus() { sends++; }, authLogout() { return true; } };
  m.loginProvider("deepseek", "fixture-key"); assert.equal(m.providers.pending, true);
  m.loginProvider("deepseek", "duplicate"); m.refreshProviders(); assert.equal(sends, 1);
  m.onConnectorsControl(reply()); assert.equal(m.providers.pending, true);
  m.onConnectorsControl({ event: "error", data: { cmd: "x-agentlinkd.auth.status", code: "busy", message: "Try again" } }); assert.equal(m.providers.pending, true);
  m.onConnectorsControl(reply("other")); assert.equal(m.providers.pending, true);
  m.onConnectorsControl(reply("deepseek")); assert.equal(m.providers.pending, false);
});

test("provider disconnect releases pending admission and refresh reconciles unknown outcome without retrying key", async () => {
  const m = await fixture(); let sends = 0;
  m.app.conn = { authLogin() { sends++; return true; }, authStatus() { sends++; } };
  m.loginProvider("deepseek", "fixture-key"); m.onProviderConnectionLost();
  assert.equal(m.providers.pending, false); assert.match(m.providers.error, /Refresh/);
  m.onConnectorsControl(reply()); assert.equal(m.providers.error, ""); assert.equal(sends, 1);
  m.app.conn.authLogin = () => false;
  m.loginProvider("deepseek", "offline-key"); assert.equal(m.providers.pending, false); assert.match(m.providers.error, /Not sent/);
});

test("empty provider status retains last list/catalog and does not report false sign-out", async () => {
  const m = await fixture(); m.onConnectorsControl(reply());
  m.onConnectorsControl({ event: "x-agentlinkd.auth.status", data: { providers: [], model_catalog: [], changed: "deepseek" } });
  assert.equal(m.providers.items.length, 1); assert.equal(m.app.modelCatalog.length, 1);
  assert.match(m.providers.error, /unavailable/); assert.equal(m.toasts.length, 0);
});
