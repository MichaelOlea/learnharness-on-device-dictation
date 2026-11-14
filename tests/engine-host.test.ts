/** EngineHost lifecycle against scripted stand-in engines (no native code). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { EngineMode } from "../src/contract.ts";
import { EngineHost, findNode, type EngineConfig } from "../src/engine-host.ts";
import type { EngineReply } from "../src/engine-worker.ts";
import { fileURLToPath } from "node:url";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "odd-engine-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** A fake engine speaking the real protocol over either transport. The `addon`
 * field of the load request selects its behaviour. */
const FAKE = `
const { parentPort } = require("node:worker_threads");
const inWorker = Boolean(parentPort);
const send = message => inWorker ? parentPort.postMessage(message) : process.send(message);
const handle = request => {
  if (request.type === "shutdown") { if (inWorker) parentPort.close(); else process.exit(0); return; }
  if (request.type === "load") {
    if (request.addon === "fail-everywhere") return send({ type: "load-error", message: "cannot load" });
    if (request.addon === "fail-in-worker" && inWorker) return send({ type: "load-error", message: "library validation refused it" });
    if (request.addon === "crash-on-load") process.exit(3);
    if (request.addon === "never") return;
    if (request.addon === "slow") { const until = Date.now() + 400; while (Date.now() < until); }
    return send({ type: "loaded", loadMs: 5, version: inWorker ? "worker" : "process" });
  }
  if (request.type === "audio") {
    if (request.pcm[0] === 666) process.exit(7);
    return send({ type: "text", session: request.session, text: "n=" + request.pcm.length + " first=" + request.pcm[0], processed: request.pcm.length });
  }
};
if (inWorker) parentPort.on("message", handle); else { process.on("message", handle); process.on("disconnect", () => process.exit(0)); }
`;
const script = path.join(scratch, "fake-engine.cjs");
fs.writeFileSync(script, FAKE);

const config = (addon: string): EngineConfig => ({ addon, encoder: "e", decoder: "d", joiner: "j", tokens: "t", threads: 1, latencyMs: 560 });
function host(mode: EngineMode, nodePath = "") {
  const replies: EngineReply[] = [];
  const stopped: string[] = [];
  let changes = 0;
  const options = { mode, nodePath, unloadAfterMinutes: 0 };
  const engine = new EngineHost(script, () => options, {
    reply: reply => replies.push(reply), stopped: message => stopped.push(message), changed: () => { changes++; },
  });
  return { engine, replies, stopped, options, changes: () => changes };
}
const until = async (condition: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!condition()) { if (Date.now() > deadline) throw new Error("timed out waiting"); await new Promise(resolve => setTimeout(resolve, 10)); }
};

test("loads in a worker thread, exchanges audio and text, unloads", async () => {
  const h = host("auto");
  assert.equal(h.engine.state, "unloaded");
  const loading = h.engine.ensure(config("ok"));
  assert.equal(h.engine.state, "loading");
  assert.equal(h.engine.ensure(config("ok")), loading, "a second request joins the same load");
  await loading;
  assert.deepEqual([h.engine.state, h.engine.mode, h.engine.loadMs], ["ready", "in-process", 5]);
  await h.engine.ensure(config("ok")); // already loaded: resolves immediately
  const pcm = new Int16Array([42, 1, 2]);
  h.engine.post({ type: "audio", session: "s", pcm }, [pcm.buffer]);
  await until(() => h.replies.length === 1);
  assert.deepEqual(h.replies[0], { type: "text", session: "s", text: "n=3 first=42", processed: 3 });
  assert.equal(pcm.length, 0, "the buffer was transferred, not copied");
  h.engine.unload();
  assert.equal(h.engine.state, "unloaded");
  assert.deepEqual(h.stopped, [], "an intended unload is not a crash");
  h.engine.dispose();
  await assert.rejects(h.engine.ensure(config("ok")), /disabled/);
});

test("runs in a separate Node.js process when asked to", async () => {
  const h = host("external");
  await h.engine.ensure(config("ok"));
  assert.deepEqual([h.engine.state, h.engine.mode], ["ready", "external"]);
  h.engine.post({ type: "audio", session: "s", pcm: new Int16Array([7, 7]) });
  await until(() => h.replies.length === 1);
  assert.deepEqual(h.replies[0], { type: "text", session: "s", text: "n=2 first=7", processed: 2 });
  h.engine.dispose();
});

test("automatic mode falls back to a separate process when the library cannot load in-process", async () => {
  const h = host("auto");
  await h.engine.ensure(config("fail-in-worker"));
  assert.deepEqual([h.engine.state, h.engine.mode], ["ready", "external"]);
  h.engine.dispose();

  const strict = host("in-process");
  await assert.rejects(strict.engine.ensure(config("fail-in-worker")), /only loads native libraries signed by its own publisher/);
  assert.equal(strict.engine.state, "error");
  assert.match(strict.engine.error ?? "", /library validation refused it/);
  strict.engine.dispose();
});

test("reports a failure in both places, then recovers on the next attempt", async () => {
  const h = host("auto");
  await assert.rejects(h.engine.ensure(config("fail-everywhere")), /could not be loaded: cannot load.*separate-process engine also failed: cannot load/s);
  assert.equal(h.engine.state, "error");
  await h.engine.ensure(config("ok"));
  assert.equal(h.engine.state, "ready");
  h.engine.dispose();

  const missing = host("external", path.join(scratch, "no-such-node"));
  await assert.rejects(missing.engine.ensure(config("ok")), /No runnable Node\.js was found/);
  missing.engine.dispose();
});

test("reloads when the configuration changes", async () => {
  const h = host("in-process");
  await h.engine.ensure(config("ok"));
  const before = h.changes();
  await h.engine.ensure({ ...config("ok"), threads: 4 });
  assert.equal(h.engine.state, "ready");
  assert.ok(h.changes() > before, "listeners heard about the reload");
  h.options.mode = "external";
  await h.engine.ensure({ ...config("ok"), threads: 4 });
  assert.equal(h.engine.mode, "external");
  h.engine.dispose();
});

test("an engine that dies is reported once and can be started again", async () => {
  for (const mode of ["in-process", "external"] as const) {
    const h = host(mode);
    await h.engine.ensure(config("ok"));
    h.engine.post({ type: "audio", session: "s", pcm: new Int16Array([666]) });
    await until(() => h.stopped.length === 1);
    assert.match(h.stopped[0]!, /stopped unexpectedly \(exit code 7\)/);
    assert.equal(h.engine.state, "error");
    await h.engine.ensure(config("ok"));
    assert.equal(h.engine.state, "ready");
    h.engine.dispose();
  }
  const h = host("in-process");
  await assert.rejects(h.engine.ensure(config("crash-on-load")), /stopped unexpectedly/);
  assert.deepEqual(h.stopped, [], "a crash while loading is a load failure, not a session failure");
  h.engine.dispose();
});

test("unloading during a load abandons it without starting a fallback", async () => {
  const h = host("auto");
  const loading = h.engine.ensure(config("never"));
  h.engine.unload();
  await assert.rejects(loading, /unloaded/);
  assert.equal(h.engine.state, "unloaded");
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(h.engine.state, "unloaded", "no late fallback revived it");
  h.engine.dispose();
});

test("an in-process engine is asked to leave mid-call, never force-stopped", async () => {
  // Stand-in for a native call that must not be interrupted: a busy 400 ms load.
  const h = host("in-process");
  const loading = h.engine.ensure(config("slow"));
  await new Promise(resolve => setTimeout(resolve, 100));
  h.engine.unload(); // while "inside the native call"
  await assert.rejects(loading, /unloaded/);
  assert.equal(h.engine.busy, false);
  await h.engine.ensure(config("ok"));
  h.engine.post({ type: "audio", session: "s", pcm: new Int16Array([1]) });
  await until(() => h.replies.length === 1);
  const source = fs.readFileSync(fileURLToPath(new URL("../src/engine-host.ts", import.meta.url)), "utf8");
  assert.equal(/\.terminate\(\)/.test(source.replace(/\/\/.*$/gm, "")), false, "the engine worker is never terminated");
  h.engine.dispose();
});

test("findNode honours an explicit path and otherwise searches", () => {
  assert.equal(findNode(process.execPath), process.execPath);
  assert.equal(findNode(path.join(scratch, "missing")), undefined);
  assert.equal(findNode(scratch), undefined, "a directory is not an executable");
  assert.equal(findNode(""), process.execPath, "plain Node.js uses itself");
});
