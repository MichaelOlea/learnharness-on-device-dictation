/** The built backend, activated the way LearnHarness would, without any download. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { FULL_PRECISION_MODELS, LATENCIES, MODELS, modelSize, type Latency, type Status } from "../src/contract.ts";
import { activateBackend } from "./e2e/host.ts";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "odd-backend-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const fresh = () => fs.mkdtempSync(path.join(scratch, "data-"));
const withFull = LATENCIES.filter(latency => FULL_PRECISION_MODELS[latency]);
const withoutFull = LATENCIES.filter(latency => !FULL_PRECISION_MODELS[latency]);
const modelDownloads = (status: Status) => status.pending.filter(item => item.name.includes("Nemotron"));

test("a fresh installation selects the compact model", async () => {
  const host = activateBackend(dist, fresh());
  try {
    const status = await host.call<Status>("status");
    assert.equal(status.settings.precision, "int8");
    assert.equal(status.modelInstalled, false);
    assert.deepEqual(status.installedModels, []);
    assert.deepEqual(status.installedPrecisions, []);
    const model = MODELS[status.settings.latency];
    assert.deepEqual(modelDownloads(status), [{ name: `NVIDIA Nemotron 3.5 ASR model (${status.settings.latency} ms, compact)`, url: model.url, bytes: model.bytes, file: model.archive }]);
    await assert.rejects(host.call("set-settings", { precision: "fp16" }), /Unsupported model precision/);
  } finally { await host.dispose(); }
});

test("full precision can only be chosen where it is published", async () => {
  const host = activateBackend(dist, fresh());
  try {
    for (const latency of withoutFull) {
      await host.call("set-settings", { latency });
      await assert.rejects(host.call("set-settings", { precision: "fp32" }), /full precision model is not published/);
      assert.equal((await host.call<Status>("status")).settings.precision, "int8", "a refused change is not saved");
    }
    for (const latency of withFull) {
      const status = await host.call<Status>("set-settings", { latency, precision: "fp32" });
      const full = FULL_PRECISION_MODELS[latency]!;
      assert.equal(status.settings.precision, "fp32");
      assert.equal(status.modelInstalled, false);
      assert.deepEqual(modelDownloads(status).map(item => item.url), full.files.map(file => full.baseUrl + file.name));
      assert.equal(modelDownloads(status).reduce((sum, item) => sum + item.bytes, 0), modelSize(full).download);
      assert.ok(modelDownloads(status).every(item => item.name === `NVIDIA Nemotron 3.5 ASR model (${latency} ms, full precision)`));
      await host.call("set-settings", { precision: "int8" });
    }
    // Moving to a latency without a full-precision package is refused while it is selected.
    if (withFull.length && withoutFull.length) {
      await host.call("set-settings", { latency: withFull[0], precision: "fp32" });
      await assert.rejects(host.call("set-settings", { latency: withoutFull[0] }), /not published/);
      await host.call<Status>("set-settings", { latency: withoutFull[0], precision: "int8" });
    }
  } finally { await host.dispose(); }
});

test("a saved precision that is not published falls back to compact without rewriting the file", async () => {
  const latency: Latency | undefined = withoutFull[0];
  if (!latency) return; // every latency has a full-precision package
  const data = fresh();
  const saved = JSON.stringify({ revision: 3, latency, precision: "fp32" });
  fs.writeFileSync(path.join(data, "settings.json"), saved);
  const host = activateBackend(dist, data);
  try {
    const status = await host.call<Status>("status");
    assert.equal(status.settings.precision, "int8");
    assert.equal(status.settings.latency, latency);
    assert.equal(modelDownloads(status)[0]?.url, MODELS[latency].url);
    assert.equal(fs.readFileSync(path.join(data, "settings.json"), "utf8"), saved);
  } finally { await host.dispose(); }
});
