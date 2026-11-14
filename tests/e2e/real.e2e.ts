/** Full pipeline against the real published packages: download, verify, unpack,
 * load the model in the engine and transcribe speech pushed through the same
 * JSON bridge calls the frontend makes.
 *
 * Needs network access and ~1.3 GB of disk. Environment:
 *   ODD_E2E_DATA   data directory to (re)use; kept between runs to skip downloads
 *   ODD_E2E_WAV    16 kHz mono 16-bit WAV to transcribe
 *   ODD_E2E_EXPECT words that must appear in the transcript, separated by "|"
 *   ODD_E2E_MODE   engine mode to force (auto | in-process | external)
 *   ODD_E2E_SPEED  playback speed relative to real time (default 1)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionUpdate, Status } from "../../src/contract.ts";
import { activateBackend } from "./host.ts";

const dist = fileURLToPath(new URL("../../dist", import.meta.url));
const data = process.env.ODD_E2E_DATA;
const wav = process.env.ODD_E2E_WAV;

function readWav(file: string): Int16Array {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  let offset = 12;
  let rate = 0;
  while (offset < bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      assert.equal(bytes.readUInt16LE(offset + 10), 1, "mono");
      rate = bytes.readUInt32LE(offset + 12);
      assert.equal(bytes.readUInt16LE(offset + 22), 16, "16-bit");
    } else if (id === "data") {
      assert.equal(rate, 16000, "16 kHz");
      return new Int16Array(bytes.buffer.slice(bytes.byteOffset + offset + 8, bytes.byteOffset + offset + 8 + size));
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("No data chunk");
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("install from the published packages and transcribe on this machine", { skip: !data || !wav, timeout: 30 * 60_000 }, async () => {
  fs.mkdirSync(data!, { recursive: true });
  const host = activateBackend(dist, data!);
  try {
    let status = await host.call<Status>("status");
    assert.equal(status.platform.supported, true);
    if (process.env.ODD_E2E_MODE) status = await host.call<Status>("set-settings", { engineMode: process.env.ODD_E2E_MODE });
    if (process.env.ODD_E2E_LATENCY) status = await host.call<Status>("set-settings", { latency: process.env.ODD_E2E_LATENCY });
    if (process.env.ODD_E2E_LANGUAGE) status = await host.call<Status>("set-settings", { language: process.env.ODD_E2E_LANGUAGE });
    if (!status.engineInstalled || !status.modelInstalled) {
      console.log("installing:", status.pending.map(item => `${item.file} (${item.bytes})`).join(", "));
      const started = Date.now();
      status = await host.call<Status>("install");
      let phase = "";
      while (status.install.phase !== "done" && status.install.phase !== "error") {
        if (status.install.phase !== phase) { phase = status.install.phase; console.log(`  ${((Date.now() - started) / 1000).toFixed(0)}s ${phase}`); }
        await sleep(500);
        status = await host.call<Status>("status");
      }
      assert.equal(status.install.phase, "done", status.install.error);
      console.log(`installed in ${((Date.now() - started) / 1000).toFixed(0)} s`);
      assert.deepEqual(fs.readdirSync(status.downloadsDirectory), [], "fetched archives are removed after installation");
    }
    assert.equal(status.engineInstalled && status.modelInstalled, true);
    assert.deepEqual(status.pending, []);

    const pcm = readWav(wav!);
    const speed = Number(process.env.ODD_E2E_SPEED ?? 1);
    const begin = await host.call<SessionUpdate>("session-start", { owner: "e2e-owner-0001" });
    assert.equal(begin.state, "loading");
    let text = "";
    let firstTextAt: number | undefined;
    let maxLag = 0;
    const started = Date.now();
    const block = 1600; // 100 ms, as the frontend sends
    for (let offset = 0; offset < pcm.length; offset += block) {
      const chunk = pcm.subarray(offset, offset + block);
      const audio = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("base64");
      const update = await host.call<SessionUpdate>("session-push", { session: begin.session, audio, have: text.length });
      assert.notEqual(update.state, "ended", update.error);
      if (update.text && firstTextAt === undefined) firstTextAt = Date.now() - started;
      text += update.text;
      assert.equal(update.length, text.length);
      if (firstTextAt !== undefined) maxLag = Math.max(maxLag, update.lagMs);
      const due = started + ((offset + block) / 16) / speed;
      if (due > Date.now()) await sleep(due - Date.now());
    }
    const flushStarted = Date.now();
    const final = await host.call<SessionUpdate>("session-finish", { session: begin.session, audio: "", have: text.length });
    text += final.text;
    assert.equal(final.state, "ended");
    assert.equal(final.reason, "finished");
    assert.equal(final.length, text.length);
    status = await host.call<Status>("status");
    console.log(`engine: ${status.engine.mode}, model load ${status.engine.loadMs} ms, ${status.threads} threads`);
    console.log(`audio ${(pcm.length / 16000).toFixed(1)} s, first words after ${firstTextAt} ms, peak backlog once running ${maxLag} ms, final flush ${Date.now() - flushStarted} ms`);
    console.log(`transcript: ${text}`);
    for (const word of (process.env.ODD_E2E_EXPECT ?? "").split("|").filter(Boolean)) {
      assert.ok(text.toLowerCase().includes(word.toLowerCase()), `transcript should contain "${word}"`);
    }
    assert.equal(status.sessionActive, false);
  } finally {
    await host.dispose();
  }
});

test("stopping the engine mid-load or with a backlog never takes the process down", { skip: !data || !wav, timeout: 5 * 60_000 }, async () => {
  // 1. Disable the plugin while the native library is busy loading the model.
  //    (Force-stopping the thread at this point aborts the whole process.)
  let host = activateBackend(dist, data!);
  let status = await host.call<Status>("status");
  assert.equal(status.engineInstalled && status.modelInstalled, true, "run the installation test first");
  await host.call<SessionUpdate>("session-start", { owner: "e2e-owner-0002" });
  await sleep(400);
  assert.equal((await host.call<Status>("status")).engine.state, "loading");
  await host.dispose();
  await sleep(4_000); // the abandoned load finishes and the thread leaves by itself

  // 2. Cancel with half a minute of untranscribed audio queued: the engine must
  //    drop that backlog rather than grind through it before listening again.
  host = activateBackend(dist, data!);
  try {
    const pcm = readWav(wav!);
    const long = new Int16Array(16_000 * 30);
    for (let offset = 0; offset < long.length; offset += pcm.length) long.set(pcm.subarray(0, Math.min(pcm.length, long.length - offset)), offset);
    const first = await host.call<SessionUpdate>("session-start", { owner: "e2e-owner-0002" });
    while ((await host.call<Status>("status")).engine.state !== "ready") await sleep(100);
    for (let offset = 0; offset < long.length; offset += 160_000) {
      const chunk = long.subarray(offset, offset + 160_000);
      await host.call("session-push", { session: first.session, audio: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("base64"), have: 0 });
    }
    const cancelled = await host.call<SessionUpdate>("session-cancel", { session: first.session });
    assert.equal(cancelled.reason, "cancelled");
    const started = Date.now();
    const second = await host.call<SessionUpdate>("session-start", { owner: "e2e-owner-0002" });
    const head = pcm.subarray(0, 16_000 * 4);
    const final = await host.call<SessionUpdate>("session-finish", {
      session: second.session, audio: Buffer.from(head.buffer, head.byteOffset, head.byteLength).toString("base64"), have: 0,
    });
    const took = Date.now() - started;
    status = await host.call<Status>("status");
    console.log(`after cancelling a 30 s backlog, a fresh 4 s dictation finished in ${took} ms (${status.engine.mode}): ${final.text}`);
    assert.equal(final.reason, "finished");
    assert.ok(final.text.length > 5);
    // Transcribing the stale 30 s first would take well over 10 s on any machine
    // where this bound matters; skipping it leaves only the fresh 4 s.
    if (status.engine.mode === "in-process") assert.ok(took < 10_000, `engine was responsive again after ${took} ms`);
  } finally { await host.dispose(); }
});
