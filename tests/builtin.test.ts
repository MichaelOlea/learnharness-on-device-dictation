/** The stand-in for LearnHarness's Deepgram connection, driven the way
 * LearnHarness 0.6.1 drives the real one (components/dictation.tsx). */
import assert from "node:assert/strict";
import test from "node:test";
import { LocalDictationSocket, installBuiltinReplacement, type BuiltinHost } from "../src/builtin.ts";
import type { SessionUpdate } from "../src/contract.ts";

const LISTEN = "wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1&smart_format=true&punctuate=true&endpointing=300&language=";
const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const frame = (value = 1, samples = 2048) => new Int16Array(samples).fill(value);

interface Script {
  installed?: boolean;
  startError?: string;
  /** Called for every push; returns the full transcript so far. */
  transcript?: (pushes: number) => string;
  finishDelayMs?: number;
  finalTranscript?: string;
  ended?: Partial<SessionUpdate>;
}
function fakeHost(script: Script = {}) {
  const calls: { operation: string; input: Record<string, unknown> }[] = [];
  const notes: { text: string; tone?: string; copy?: string }[] = [];
  const late: string[] = [];
  let setUps = 0;
  let pushes = 0;
  let text = "";
  const update = (have: number, extra: Partial<SessionUpdate> = {}): SessionUpdate => ({
    session: "s1", state: "listening", text: text.slice(have), length: text.length, lagMs: 0, ...extra,
  });
  const host: BuiltinHost = {
    owner: "window-owner-1",
    enabled: () => true,
    decided: async () => true,
    installed: async () => script.installed ?? true,
    setUp: () => { setUps++; },
    note: (noteText, options) => { notes.push({ text: noteText, ...options }); },
    late: lateText => { late.push(lateText); },
    async call<T>(operation: string, input?: unknown): Promise<T> {
      const record = (input ?? {}) as Record<string, unknown>;
      calls.push({ operation, input: record });
      if (operation === "session-start") {
        if (script.startError) throw new Error(script.startError);
        return update(0, { state: "loading" }) as T;
      }
      if (operation === "session-push") {
        pushes++;
        text = script.transcript?.(pushes) ?? text;
        return update(Number(record.have), pushes >= 3 && script.ended ? script.ended : {}) as T;
      }
      if (operation === "session-finish") {
        if (script.finishDelayMs) await wait(script.finishDelayMs);
        text = script.finalTranscript ?? text;
        return update(Number(record.have), { state: "ended", reason: "finished" }) as T;
      }
      return update(text.length, { state: "ended", reason: "cancelled" }) as T;
    },
  };
  return { host, calls, notes, late, setUps: () => setUps, of: (operation: string) => calls.filter(call => call.operation === operation) };
}
/** Listen the way LearnHarness does and record what it would see. */
function observe(socket: LocalDictationSocket) {
  const seen = { opened: 0, finals: [] as string[], closes: [] as number[] };
  socket.addEventListener("open", () => { seen.opened++; });
  socket.addEventListener("message", event => {
    const message = JSON.parse((event as MessageEvent).data as string);
    if (message.type === "Results" && message.is_final && message.channel?.alternatives?.[0]?.transcript) seen.finals.push(message.channel.alternatives[0].transcript);
  });
  socket.addEventListener("close", event => { seen.closes.push((event as CloseEvent).code); });
  return seen;
}
const until = async (condition: () => boolean, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (!condition()) { if (Date.now() > deadline) throw new Error("timed out waiting"); await wait(5); }
};

test("a normal run: open, stream, stop — finals rejoin into the exact transcript", async () => {
  const full = "The mitochondria is the powerhouse of the cell. I think the answer is forty two";
  const words = full.split(" ");
  // The recogniser reveals two more words per push, sometimes with a trailing space.
  const h = fakeHost({ transcript: pushes => words.slice(0, pushes * 2).join(" ") + (pushes % 2 ? " " : ""), finalTranscript: full });
  const socket = new LocalDictationSocket(`${LISTEN}en`, h.host);
  const seen = observe(socket);
  assert.equal(socket.readyState, 0);
  assert.throws(() => socket.send(frame()), /CONNECTING/);
  await until(() => seen.opened === 1);
  assert.equal(socket.readyState, 1);
  await until(() => h.of("session-start").length === 1);
  assert.deepEqual(h.of("session-start")[0]!.input, { owner: "window-owner-1", language: "en-US" });
  for (let index = 0; index < 5; index++) { socket.send(frame(index + 1)); await wait(10); }
  await until(() => h.of("session-push").length >= 4);
  // Mid-run, only whole words are handed over and the newest one is held back.
  const midway = seen.finals.join(" ");
  assert.ok(midway.length > 0 && full.startsWith(midway), midway);
  assert.ok(!midway.endsWith("."), "a word that may still get punctuation is not delivered yet");
  socket.send(JSON.stringify({ type: "CloseStream" }));
  await until(() => seen.closes.length === 1);
  assert.deepEqual(seen.closes, [1000], "LearnHarness treats 1000 as its own stop landing");
  assert.equal(seen.finals.join(" "), full, "joined with single spaces, exactly as LearnHarness does");
  assert.equal(socket.readyState, 3);
  assert.equal(h.of("session-finish").length, 1);
  assert.equal(h.of("session-cancel").length, 0);
  // The audio arrived intact and in order.
  const first = Buffer.from(h.of("session-push")[0]!.input.audio as string, "base64");
  assert.equal(first.readInt16LE(0), 1);
  assert.deepEqual([h.notes, h.late], [[], []]);
});

test("text without spaces is delivered whole, never split", async () => {
  const full = "国があなたのために何ができるかを問うのではなく";
  const h = fakeHost({ transcript: pushes => full.slice(0, pushes * 5), finalTranscript: full });
  const socket = new LocalDictationSocket(`${LISTEN}ja`, h.host);
  const seen = observe(socket);
  await until(() => h.of("session-start").length === 1);
  assert.equal(h.of("session-start")[0]!.input.language, "ja-JP");
  for (let index = 0; index < 3; index++) { socket.send(frame()); await wait(10); }
  assert.deepEqual(seen.finals, []);
  socket.send(JSON.stringify({ type: "CloseStream" }));
  await until(() => seen.closes.length === 1);
  assert.deepEqual(seen.finals, [full]);
});

test("audio sent before the session exists is kept and sent first", async () => {
  const h = fakeHost({ transcript: () => "hello there", finalTranscript: "hello there friend" });
  const socket = new LocalDictationSocket(`${LISTEN}multi`, h.host);
  const seen = observe(socket);
  // LearnHarness flushes its queued frames synchronously inside its open handler.
  socket.addEventListener("open", () => { socket.send(frame(7)); socket.send(frame(8)); });
  await until(() => h.of("session-push").length >= 1);
  assert.equal(h.of("session-start")[0]!.input.language, "auto");
  const audio = Buffer.from(h.of("session-push")[0]!.input.audio as string, "base64");
  assert.equal(audio.length, 2 * 2048 * 2);
  assert.deepEqual([audio.readInt16LE(0), audio.readInt16LE(2048 * 2)], [7, 8]);
  socket.send(JSON.stringify({ type: "CloseStream" }));
  await until(() => seen.closes.length === 1);
  assert.equal(seen.finals.join(" "), "hello there friend");
});

test("stopping immediately still returns what was said", async () => {
  const h = fakeHost({ finalTranscript: "quick note" });
  const socket = new LocalDictationSocket(`${LISTEN}en`, h.host);
  const seen = observe(socket);
  socket.addEventListener("open", () => { socket.send(frame()); socket.send(JSON.stringify({ type: "CloseStream" })); });
  await until(() => seen.closes.length === 1);
  assert.deepEqual([seen.finals, seen.closes], [["quick note"], [1000]]);
  // The frame sent before the stop travels with the finish request.
  assert.ok((h.of("session-finish")[0]!.input.audio as string).length > 0 || h.of("session-push").length === 1);
});

test("a slow flush closes in time and hands late words over separately", async () => {
  const h = fakeHost({ transcript: () => "the first part is", finishDelayMs: 3_000, finalTranscript: "the first part is here and the rest came late" });
  const socket = new LocalDictationSocket(`${LISTEN}en`, h.host);
  const seen = observe(socket);
  await until(() => h.of("session-start").length === 1);
  socket.send(frame());
  await until(() => h.of("session-push").length === 1);
  const stopped = Date.now();
  socket.send(JSON.stringify({ type: "CloseStream" }));
  await until(() => seen.closes.length === 1, 5_000);
  const took = Date.now() - stopped;
  assert.ok(took < 2_950, `closed before LearnHarness's three-second cut-off (${took} ms)`);
  assert.equal(seen.finals.join(" "), "the first part is");
  await until(() => h.late.length === 1, 3_000);
  assert.deepEqual(h.late, ["here and the rest came late"]);
});

test("nothing installed: the run ends quietly and set-up is offered", async () => {
  const h = fakeHost({ installed: false });
  const socket = new LocalDictationSocket(`${LISTEN}en`, h.host);
  const seen = observe(socket);
  await until(() => seen.closes.length === 1);
  assert.deepEqual([seen.opened, seen.closes, seen.finals], [1, [1000], []]);
  assert.equal(h.setUps(), 1);
  assert.deepEqual([h.calls, h.notes], [[], []], "no session, no error message");
});

test("failures keep the text so far, close normally and say why", async () => {
  let h = fakeHost({ startError: "The speech engine could not be loaded: boom" });
  let socket = new LocalDictationSocket(`${LISTEN}en`, h.host);
  let seen = observe(socket);
  await until(() => seen.closes.length === 1);
  assert.deepEqual(seen.closes, [1000], "no reconnect attempt is provoked");
  assert.deepEqual(h.notes, [{ text: "The speech engine could not be loaded: boom", tone: "error" }]);

  h = fakeHost({ transcript: pushes => "words so far ".repeat(pushes).trim(), ended: { state: "ended", reason: "too-slow", error: "cannot keep up" } });
  socket = new LocalDictationSocket(`${LISTEN}en`, h.host);
  seen = observe(socket);
  await until(() => h.of("session-start").length === 1);
  for (let index = 0; index < 4; index++) { socket.send(frame()); await wait(15); }
  await until(() => seen.closes.length === 1);
  assert.equal(seen.finals.join(" "), "words so far words so far words so far");
  assert.deepEqual(h.notes, [{ text: "cannot keep up", tone: "error" }]);

  h = fakeHost({ ended: { state: "ended", reason: "limit" } });
  socket = new LocalDictationSocket(`${LISTEN}en`, h.host);
  seen = observe(socket);
  await until(() => h.of("session-start").length === 1);
  for (let index = 0; index < 4; index++) { socket.send(frame()); await wait(15); }
  await until(() => seen.closes.length === 1);
  assert.deepEqual(h.notes, [{ text: "Dictation stopped after 20 minutes.", tone: "info" }]);
});

test("cancel (Esc, navigation) discards the run on the server too", async () => {
  const h = fakeHost({ transcript: () => "should be discarded soon" });
  const socket = new LocalDictationSocket(`${LISTEN}en`, h.host);
  const seen = observe(socket);
  await until(() => h.of("session-start").length === 1);
  socket.send(frame());
  await until(() => h.of("session-push").length === 1);
  socket.close();
  assert.equal(socket.readyState, 3);
  await until(() => h.of("session-cancel").length === 1);
  socket.send(frame());
  socket.send(JSON.stringify({ type: "CloseStream" }));
  await wait(30);
  assert.equal(h.of("session-finish").length, 0);
  assert.equal(h.of("session-push").length, 1);

  // Closing before the session even started cancels it as soon as it exists.
  const early = fakeHost();
  const second = new LocalDictationSocket(`${LISTEN}en`, early.host);
  await until(() => second.readyState === 1);
  second.close();
  await until(() => early.of("session-cancel").length === 1);
});

test("an unknown audio format is declined with an explanation", async () => {
  const h = fakeHost();
  const socket = new LocalDictationSocket("wss://api.deepgram.com/v1/listen?model=nova-4&encoding=opus&sample_rate=48000", h.host);
  const seen = observe(socket);
  await until(() => seen.closes.length === 1);
  assert.equal(h.calls.length, 0);
  assert.match(h.notes[0]!.text, /format On-device dictation does not know/);
});

test("only the token request and the Deepgram socket are touched", async () => {
  const fetched: string[] = [];
  const constructed: unknown[][] = [];
  class NativeSocket { static readonly OPEN = 1; static readonly CONNECTING = 0; constructor(...args: unknown[]) { constructed.push(args); } }
  const view = {
    location: { href: "http://localhost:3000/chat/1", origin: "http://localhost:3000" },
    fetch: async (input: RequestInfo | URL) => { fetched.push(String(input instanceof Request ? input.url : input)); return new Response("native", { status: 503 }); },
    WebSocket: NativeSocket,
  } as unknown as Window & typeof globalThis;
  const nativeFetch = view.fetch;
  let enabled = true;
  let decide: (value: boolean) => void = () => undefined;
  const h = fakeHost();
  h.host.enabled = () => enabled;
  h.host.decided = async () => enabled;
  const undo = installBuiltinReplacement(view, h.host);

  let response = await view.fetch("/api/stt/token");
  assert.deepEqual([response.status, await response.json()], [200, { token: "on-device-dictation" }]);
  assert.deepEqual(fetched, [], "the real token route (and so Deepgram) is never contacted");
  for (const other of ["/api/stt/token/extra", "/api/settings", "https://example.com/api/stt/token"]) assert.equal((await view.fetch(other)).status, 503, other);
  assert.equal((await view.fetch("/api/stt/token", { method: "POST" })).status, 503);
  assert.equal(fetched.length, 4);

  assert.ok(new view.WebSocket(`${LISTEN}en`, ["bearer", "x"]) instanceof LocalDictationSocket);
  assert.equal(constructed.length, 0);
  const other = new view.WebSocket("wss://example.com/socket", ["a"]);
  assert.ok(other instanceof NativeSocket, "other sockets are the real thing");
  assert.deepEqual(constructed, [["wss://example.com/socket", ["a"]]]);
  assert.equal(view.WebSocket.OPEN, 1, "constants LearnHarness compares against are intact");
  assert.ok(new view.WebSocket("wss://api.deepgram.com/v1/speak") instanceof NativeSocket);

  // Switched off: everything passes through…
  enabled = false;
  assert.equal((await view.fetch("/api/stt/token")).status, 503);
  assert.ok(new view.WebSocket(`${LISTEN}en`, ["bearer", "real-token"]) instanceof NativeSocket);
  // …except a socket opened with our own placeholder token, which Deepgram would only reject.
  assert.ok(new view.WebSocket(`${LISTEN}en`, ["bearer", "on-device-dictation"]) instanceof LocalDictationSocket);

  // Settings not loaded yet: the token request waits for them instead of guessing.
  enabled = true;
  h.host.decided = () => new Promise<boolean>(resolve => { decide = resolve; });
  const pending = view.fetch("/api/stt/token");
  let settled = false;
  void pending.then(() => { settled = true; });
  await wait(20);
  assert.equal(settled, false);
  decide(true);
  assert.equal((await pending).status, 200);

  undo();
  assert.equal(view.fetch, nativeFetch);
  assert.equal(view.WebSocket, NativeSocket);
});
