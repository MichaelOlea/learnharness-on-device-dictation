import assert from "node:assert/strict";
import test from "node:test";
import { MAX_LAG_MS, MAX_SESSION_MS, SESSION_IDLE_MS } from "../src/contract.ts";
import type { EngineConfig } from "../src/engine-host.ts";
import type { EngineReply, EngineRequest } from "../src/engine-worker.ts";
import { Sessions } from "../src/sessions.ts";

const config: EngineConfig = { addon: "a", encoder: "e", decoder: "d", joiner: "j", tokens: "t", threads: 1, latencyMs: 560 };
const audio = (samples: number, value = 1000) => Buffer.from(new Int16Array(samples).fill(value).buffer).toString("base64");
const tick = () => new Promise(resolve => setImmediate(resolve));

/** A scripted engine: records requests and lets the test answer them. */
function harness(options: { loads?: "now" | "manual" | "fail"; installed?: boolean } = {}) {
  const requests: EngineRequest[] = [];
  let release: (() => void) | undefined;
  let clock = 1_000_000;
  const mock = test.mock.timers;
  const engine = {
    ensure(_config: EngineConfig): Promise<void> {
      if (options.loads === "fail") return Promise.reject(new Error("no engine"));
      if (options.loads === "manual") return new Promise(resolve => { release = resolve; });
      return Promise.resolve();
    },
    post(request: EngineRequest) { requests.push(request); },
    keepAlive() { /* not under test */ },
  };
  const sessions = new Sessions({
    engine, now: () => clock,
    configuration: requested => {
      if (options.installed === false) throw new Error("not installed");
      return { config, language: typeof requested === "string" ? requested : "en-US" };
    },
  });
  return {
    sessions, requests, mock,
    loaded: () => release?.(),
    advance: (ms: number) => { clock += ms; },
    reply: (reply: EngineReply) => sessions.reply(reply),
    of: <T extends EngineRequest["type"]>(type: T) => requests.filter(request => request.type === type) as Extract<EngineRequest, { type: T }>[],
  };
}

test("streams audio in order and returns only text the caller does not have", async () => {
  const h = harness();
  const start = h.sessions.start("window-owner-1");
  assert.equal(start.state, "loading");
  await tick();
  assert.deepEqual(h.of("start"), [{ type: "start", session: start.session, language: "en-US" }]);

  let update = h.sessions.push(start.session, audio(1600), 0);
  assert.equal(update.state, "listening");
  assert.equal(update.text, "");
  assert.equal(update.lagMs, 100);
  assert.equal(h.of("audio")[0]!.pcm.length, 1600);
  assert.equal(h.of("audio")[0]!.pcm[0], 1000);

  h.reply({ type: "text", session: start.session, text: "Hello", processed: 1600 });
  update = h.sessions.push(start.session, audio(1600), 0);
  assert.deepEqual([update.text, update.length, update.lagMs], ["Hello", 5, 100]);
  h.reply({ type: "text", session: start.session, text: "Hello world", processed: 3200 });
  update = h.sessions.push(start.session, "", 5);
  assert.deepEqual([update.text, update.length, update.lagMs], [" world", 11, 0]);
  // Asking again with a stale or absurd offset never throws or duplicates beyond the request.
  assert.equal(h.sessions.push(start.session, "", 11).text, "");
  assert.equal(h.sessions.push(start.session, "", 999).text, "");
  assert.equal(h.sessions.push(start.session, "", -3).text, "Hello world");

  const finishing = h.sessions.finish(start.session, audio(800), 11);
  await tick();
  assert.equal(h.of("audio").length, 3);
  assert.equal(h.of("finish").length, 1);
  h.reply({ type: "done", session: start.session, text: "Hello world again", processed: 4000 });
  const final = await finishing;
  assert.deepEqual([final.state, final.reason, final.text, final.length], ["ended", "finished", " again", 17]);
  assert.equal(h.sessions.active, false);
  // The result stays readable for a request that was already on its way.
  assert.equal(h.sessions.push(start.session, audio(100), 0).text, "Hello world again");
  assert.equal(h.of("audio").length, 3, "audio after the end is not forwarded");
  h.sessions.dispose();
});

test("a session can be started in the language its caller asks for", async () => {
  const h = harness();
  const start = h.sessions.start("window-owner-1", "de-DE");
  await tick();
  assert.deepEqual(h.of("start"), [{ type: "start", session: start.session, language: "de-DE" }]);
  h.sessions.dispose();
});

test("audio spoken while the model loads is queued, not lost", async () => {
  const h = harness({ loads: "manual" });
  const start = h.sessions.start("window-owner-1");
  assert.equal(h.sessions.push(start.session, audio(1600, 1), 0).state, "loading");
  assert.equal(h.sessions.push(start.session, audio(1600, 2), 0).lagMs, 200);
  assert.equal(h.requests.length, 0);
  h.loaded();
  await tick();
  assert.deepEqual(h.requests.map(request => request.type), ["start", "audio", "audio"]);
  assert.deepEqual(h.of("audio").map(request => request.pcm[0]), [1, 2]);
  assert.equal(h.sessions.push(start.session, "", 0).state, "listening");
  h.sessions.dispose();
});

test("finishing before the model has loaded still flushes once it has", async () => {
  const h = harness({ loads: "manual" });
  const start = h.sessions.start("window-owner-1");
  const finishing = h.sessions.finish(start.session, audio(1600), 0);
  await tick();
  assert.equal(h.requests.length, 0);
  h.loaded();
  await tick();
  assert.deepEqual(h.requests.map(request => request.type), ["start", "audio", "finish"]);
  h.reply({ type: "done", session: start.session, text: "ok", processed: 1600 });
  assert.equal((await finishing).text, "ok");
  h.sessions.dispose();
});

test("one microphone owner: another window is refused, the same window restarts", async () => {
  const h = harness();
  const first = h.sessions.start("window-owner-1");
  await tick();
  assert.throws(() => h.sessions.start("window-owner-2"), /another window/);
  const second = h.sessions.start("window-owner-1");
  assert.notEqual(second.session, first.session);
  assert.equal(h.of("cancel")[0]!.session, first.session);
  assert.equal(h.sessions.push(first.session, "", 0).reason, "cancelled");
  // Replies for the replaced session are ignored.
  h.reply({ type: "text", session: first.session, text: "stale", processed: 1 });
  assert.equal(h.sessions.push(second.session, "", 0).text, "");
  h.sessions.dispose();
});

test("cancel discards unfinished speech but keeps text already delivered", async () => {
  const h = harness();
  const start = h.sessions.start("window-owner-1");
  await tick();
  h.reply({ type: "text", session: start.session, text: "kept", processed: 10 });
  const update = h.sessions.cancel(start.session);
  assert.deepEqual([update.state, update.reason, update.text], ["ended", "cancelled", ""]);
  assert.equal(h.of("cancel").length, 1);
  assert.equal(h.sessions.push(start.session, "", 0).text, "kept");
  assert.equal(h.sessions.active, false);
  h.sessions.dispose();
});

test("reports engine failures and missing installation", async () => {
  assert.throws(() => harness({ installed: false }).sessions.start("window-owner-1"), /not installed/);
  let h = harness({ loads: "fail" });
  let start = h.sessions.start("window-owner-1");
  await tick();
  let update = h.sessions.push(start.session, audio(100), 0);
  assert.deepEqual([update.state, update.reason, update.error], ["ended", "error", "no engine"]);
  h.sessions.dispose();

  h = harness();
  start = h.sessions.start("window-owner-1");
  await tick();
  h.reply({ type: "session-error", session: start.session, message: "decoder exploded" });
  assert.equal(h.sessions.push(start.session, "", 0).error, "decoder exploded");
  start = h.sessions.start("window-owner-1");
  await tick();
  h.sessions.engineStopped("engine gone");
  update = h.sessions.push(start.session, "", 0);
  assert.deepEqual([update.reason, update.error], ["error", "engine gone"]);
  // A finish that is waiting resolves when the engine dies instead of hanging.
  start = h.sessions.start("window-owner-1");
  await tick();
  const finishing = h.sessions.finish(start.session, "", 0);
  h.sessions.engineStopped("engine gone again");
  assert.equal((await finishing).error, "engine gone again");
  h.sessions.dispose();
});

test("rejects malformed requests", async () => {
  const h = harness();
  for (const owner of [undefined, "", "short", "has spaces in it", 42, "x".repeat(65)]) assert.throws(() => h.sessions.start(owner), /owner/);
  const start = h.sessions.start("window-owner-1");
  await tick();
  assert.throws(() => h.sessions.push("nope", "", 0), /no longer exists/);
  assert.throws(() => h.sessions.push(undefined, "", 0), /no longer exists/);
  for (const bad of ["***", "AA==", "AAAA=A", 42, {}, "A".repeat(2_000_000)]) assert.throws(() => h.sessions.push(start.session, bad, 0), /Invalid audio/);
  assert.equal(h.of("audio").length, 0);
  h.sessions.dispose();
});

test("ends a session that falls hopelessly behind", async () => {
  const h = harness();
  const start = h.sessions.start("window-owner-1");
  await tick();
  const second = 16_000;
  let update = h.sessions.push(start.session, audio(second), 0);
  for (let pushed = 1; pushed * 1000 <= MAX_LAG_MS && update.state !== "ended"; pushed++) update = h.sessions.push(start.session, audio(second), 0);
  assert.deepEqual([update.state, update.reason], ["ended", "too-slow"]);
  assert.match(update.error ?? "", /cannot transcribe as fast/);
  assert.equal(h.of("cancel").length, 1);
  h.sessions.dispose();
});

test("abandoned sessions are released and long ones are finished", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = harness();
  let start = h.sessions.start("window-owner-1");
  await tick();
  h.advance(SESSION_IDLE_MS + 1);
  t.mock.timers.tick(2_000);
  assert.equal(h.sessions.active, false);
  assert.equal(h.sessions.push(start.session, "", 0).reason, "idle");

  start = h.sessions.start("window-owner-1");
  await tick();
  // Keep it alive with regular pushes until the cap.
  for (let elapsed = 0; elapsed <= MAX_SESSION_MS; elapsed += 5_000) {
    h.advance(5_000);
    h.sessions.push(start.session, "", 0);
    t.mock.timers.tick(2_000);
  }
  assert.equal(h.of("finish").at(-1)?.session, start.session);
  h.reply({ type: "done", session: start.session, text: "long talk", processed: 0 });
  const update = h.sessions.push(start.session, "", 0);
  assert.deepEqual([update.state, update.reason, update.text], ["ended", "limit", "long talk"]);
  h.sessions.dispose();
});
