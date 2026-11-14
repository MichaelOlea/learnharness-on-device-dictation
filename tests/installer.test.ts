/** Installer behaviour against a local HTTP server and small synthetic packages
 * built with the system tar/bzip2/gzip. Uses the built extract worker. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import type { InstallProgress, ModelPackage, RuntimePackage } from "../src/contract.ts";
import { Installer } from "../src/installer.ts";

const extractScript = fileURLToPath(new URL("../dist/extract-worker.cjs", import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "odd-install-"));
const served = new Map<string, Buffer>();
const requests: { url: string; range?: string }[] = [];
/** Per-path behaviour switches for the fake server. */
const behaviour = { ignoreRange: false, cutAfter: 0 };
let server: http.Server;
let origin = "";

const MODEL_DIR = "tiny-model";
// Incompressible, so the archive is large enough to interrupt and resume.
const MODEL_FILES = { "encoder.int8.onnx": randomBytes(300_000), "decoder.int8.onnx": Buffer.from("decoder"), "joiner.int8.onnx": Buffer.from("joiner"), "tokens.txt": Buffer.from("a 0\nb 1\n") };
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function buildModelArchive(extra?: (root: string) => void, omit: string[] = []): Buffer {
  const root = fs.mkdtempSync(path.join(scratch, "model-src-"));
  fs.mkdirSync(path.join(root, MODEL_DIR, "test_wavs"), { recursive: true });
  for (const [name, body] of Object.entries(MODEL_FILES)) if (!omit.includes(name)) fs.writeFileSync(path.join(root, MODEL_DIR, name), body);
  fs.writeFileSync(path.join(root, MODEL_DIR, "test_wavs/en.wav"), Buffer.alloc(5000, 1));
  fs.writeFileSync(path.join(root, MODEL_DIR, "README.md"), "readme");
  extra?.(root);
  return execFileSync("tar", ["-cjf", "-", "-C", root, MODEL_DIR], { maxBuffer: 1 << 28 });
}
function buildRuntimeArchive(): Buffer {
  const root = fs.mkdtempSync(path.join(scratch, "runtime-src-"));
  fs.mkdirSync(path.join(root, "package"));
  for (const name of ["sherpa-onnx.node", "libonnxruntime.so", "package.json", "index.js"]) fs.writeFileSync(path.join(root, "package", name), `content of ${name}`);
  return execFileSync("tar", ["-czf", "-", "-C", root, "package"], { maxBuffer: 1 << 28 });
}
function modelPackage(archive: Buffer, name = "tiny-model.tar.bz2"): ModelPackage {
  served.set(`/${name}`, archive);
  return {
    latency: "560", directory: MODEL_DIR, archive: name, url: `${origin}/${name}`, bytes: archive.length, sha256: sha256(archive),
    files: Object.entries(MODEL_FILES).map(([file, body]) => ({ name: file, bytes: body.length, sha256: sha256(body) })),
  };
}
function runtimePackage(archive: Buffer): RuntimePackage {
  served.set("/tiny-runtime.tgz", archive);
  return {
    key: "test", name: "tiny-runtime", url: `${origin}/tiny-runtime.tgz`, bytes: archive.length, addon: "sherpa-onnx.node",
    integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`, files: ["sherpa-onnx.node", "libonnxruntime.so"],
  };
}
function installer(data: string): { installer: Installer; phases: string[]; finished(): Promise<InstallProgress> } {
  const phases: string[] = [];
  let settle: ((progress: InstallProgress) => void) | undefined;
  const made = new Installer({
    dataDirectory: data, extractScript,
    onProgress(progress) {
      if (phases.at(-1) !== progress.phase) phases.push(progress.phase);
      if (progress.phase === "done" || progress.phase === "error" || (progress.phase === "idle" && phases.length > 1)) settle?.(progress);
    },
  });
  return { installer: made, phases, finished: () => new Promise(resolve => { settle = resolve; }) };
}
const fresh = () => fs.mkdtempSync(path.join(scratch, "data-"));

before(async () => {
  assert.ok(fs.existsSync(extractScript), "run `npm run build` first");
  server = http.createServer((request, response) => {
    const body = served.get(request.url ?? "");
    const range = request.headers.range;
    requests.push(range ? { url: request.url!, range } : { url: request.url! });
    if (!body) { response.writeHead(404).end(); return; }
    let start = 0;
    if (range && !behaviour.ignoreRange) start = Number(/bytes=(\d+)-/.exec(range)![1]);
    const slice = body.subarray(start);
    response.writeHead(start ? 206 : 200, { "content-length": slice.length, ...(start ? { "content-range": `bytes ${start}-${body.length - 1}/${body.length}` } : {}) });
    if (behaviour.cutAfter) {
      // Flush the first bytes, then drop the connection mid-body.
      response.write(slice.subarray(0, behaviour.cutAfter), () => setTimeout(() => response.destroy(), 100));
      return;
    }
    response.end(slice);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); fs.rmSync(scratch, { recursive: true, force: true }); });

test("downloads, verifies and installs only the whitelisted files", async () => {
  const data = fresh();
  const model = modelPackage(buildModelArchive());
  const runtime = runtimePackage(buildRuntimeArchive());
  const run = installer(data);
  assert.equal(run.installer.runtimeInstalled(runtime), false);
  assert.equal(run.installer.modelInstalled(model), false);
  const finished = run.finished();
  run.installer.start(runtime, model);
  assert.equal(run.installer.busy, true);
  assert.equal((await finished).phase, "done");
  assert.deepEqual(run.phases, ["downloading-engine", "unpacking-engine", "downloading-model", "unpacking-model", "done"]);
  assert.equal(run.installer.runtimeInstalled(runtime), true);
  assert.equal(run.installer.modelInstalled(model), true);
  assert.deepEqual(fs.readdirSync(run.installer.modelDirectory(model)).sort(), ["decoder.int8.onnx", "encoder.int8.onnx", "installed.json", "joiner.int8.onnx", "tokens.txt"]);
  assert.deepEqual(fs.readdirSync(run.installer.runtimeDirectory(runtime)).sort(), ["installed.json", "libonnxruntime.so", "sherpa-onnx.node"]);
  assert.ok(fs.readFileSync(path.join(run.installer.modelDirectory(model), "encoder.int8.onnx")).equals(MODEL_FILES["encoder.int8.onnx"]));
  assert.deepEqual(fs.readdirSync(run.installer.downloads), [], "fetched archives are deleted once installed");
  assert.deepEqual(fs.readdirSync(path.join(data, "models")), [MODEL_DIR], "no temporary directories remain");
  // A changed file size means "not installed" again.
  fs.appendFileSync(path.join(run.installer.modelDirectory(model), "tokens.txt"), "x");
  assert.equal(run.installer.modelInstalled(model), false);
});

test("resumes a partial download with a range request", async () => {
  const data = fresh();
  const archive = buildModelArchive();
  const model = modelPackage(archive);
  const runtime = runtimePackage(buildRuntimeArchive());
  const run = installer(data);
  fs.mkdirSync(run.installer.downloads, { recursive: true });
  fs.writeFileSync(run.installer.downloadPath(`${model.archive}.part`), archive.subarray(0, 1000));
  requests.length = 0;
  const finished = run.finished();
  run.installer.start(runtime, model);
  assert.equal((await finished).phase, "done");
  assert.equal(requests.find(request => request.url === `/${model.archive}`)?.range, "bytes=1000-");
  assert.equal(run.installer.modelInstalled(model), true);
});

test("restarts cleanly when the server ignores the range", async () => {
  const data = fresh();
  const archive = buildModelArchive();
  const model = modelPackage(archive);
  const runtime = runtimePackage(buildRuntimeArchive());
  const run = installer(data);
  fs.mkdirSync(run.installer.downloads, { recursive: true });
  fs.writeFileSync(run.installer.downloadPath(`${model.archive}.part`), Buffer.alloc(1000, 9)); // garbage prefix
  behaviour.ignoreRange = true;
  try {
    const finished = run.finished();
    run.installer.start(runtime, model);
    assert.equal((await finished).phase, "done");
  } finally { behaviour.ignoreRange = false; }
  assert.equal(run.installer.modelInstalled(model), true);
});

test("an interrupted download keeps its partial file and reports how to resume", async () => {
  const data = fresh();
  const model = modelPackage(buildModelArchive());
  const runtime = runtimePackage(buildRuntimeArchive());
  const run = installer(data);
  // Install the engine first so only the model download is cut.
  let finished = run.finished();
  run.installer.start(runtime, model);
  assert.equal((await finished).phase, "done");
  fs.rmSync(run.installer.modelDirectory(model), { recursive: true });
  behaviour.cutAfter = 2000;
  try {
    finished = run.finished();
    run.installer.start(runtime, model);
    const result = await finished;
    assert.equal(result.phase, "error");
  } finally { behaviour.cutAfter = 0; }
  assert.equal(run.installer.modelInstalled(model), false);
  assert.equal(fs.statSync(run.installer.downloadPath(`${model.archive}.part`)).size, 2000);
  finished = run.finished();
  run.installer.start(runtime, model);
  assert.equal((await finished).phase, "done");
  assert.equal(run.installer.modelInstalled(model), true);
});

test("refuses a package whose checksum does not match and deletes what it fetched", async () => {
  const data = fresh();
  const model = { ...modelPackage(buildModelArchive()), sha256: "0".repeat(64) };
  const runtime = runtimePackage(buildRuntimeArchive());
  const run = installer(data);
  const finished = run.finished();
  run.installer.start(runtime, model);
  const result = await finished;
  assert.equal(result.phase, "error");
  assert.match(result.error ?? "", /checksum/);
  assert.equal(run.installer.modelInstalled(model), false);
  assert.equal(fs.existsSync(run.installer.modelDirectory(model)), false);
  assert.deepEqual(fs.readdirSync(run.installer.downloads), []);
  assert.deepEqual(fs.readdirSync(path.join(data, "models")), []);
});

test("refuses a package whose inner file was altered", async () => {
  const data = fresh();
  const good = modelPackage(buildModelArchive());
  const altered = buildModelArchive(root => fs.writeFileSync(path.join(root, MODEL_DIR, "tokens.txt"), "a 0\nb 9\n"));
  const model = { ...good, ...{ archive: "altered.tar.bz2", url: `${origin}/altered.tar.bz2`, bytes: altered.length, sha256: sha256(altered) } };
  served.set("/altered.tar.bz2", altered);
  const run = installer(data);
  const finished = run.finished();
  run.installer.start(runtimePackage(buildRuntimeArchive()), model);
  const result = await finished;
  assert.equal(result.phase, "error");
  assert.match(result.error ?? "", /tokens\.txt/);
  assert.equal(fs.existsSync(run.installer.modelDirectory(model)), false);
});

test("never writes outside its directory and ignores links posing as model files", async () => {
  const data = fresh();
  const outside = path.join(scratch, "outside.txt");
  const hostile = buildModelArchive(root => {
    fs.rmSync(path.join(root, MODEL_DIR, "joiner.int8.onnx"));
    fs.symlinkSync(outside, path.join(root, MODEL_DIR, "joiner.int8.onnx"));
    fs.mkdirSync(path.join(root, MODEL_DIR, "sub"));
    fs.writeFileSync(path.join(root, MODEL_DIR, "sub/encoder.int8.onnx"), "decoy in a subdirectory");
  });
  const base = modelPackage(buildModelArchive());
  served.set("/hostile.tar.bz2", hostile);
  const model = { ...base, archive: "hostile.tar.bz2", url: `${origin}/hostile.tar.bz2`, bytes: hostile.length, sha256: sha256(hostile) };
  const run = installer(data);
  const finished = run.finished();
  run.installer.start(runtimePackage(buildRuntimeArchive()), model);
  const result = await finished;
  assert.equal(result.phase, "error");
  assert.match(result.error ?? "", /missing joiner\.int8\.onnx/);
  assert.equal(fs.existsSync(outside), false);
  assert.equal(fs.existsSync(run.installer.modelDirectory(model)), false);
});

test("uses a package the learner placed in the downloads folder and leaves it there", async () => {
  const data = fresh();
  const archive = buildModelArchive();
  const model = modelPackage(archive);
  const runtimeArchive = buildRuntimeArchive();
  const runtime = runtimePackage(runtimeArchive);
  const run = installer(data);
  fs.mkdirSync(run.installer.downloads, { recursive: true });
  fs.writeFileSync(run.installer.downloadPath(model.archive), archive);
  fs.writeFileSync(run.installer.downloadPath(run.installer.runtimeArchive(runtime)), runtimeArchive);
  requests.length = 0;
  const finished = run.finished();
  run.installer.start(runtime, model);
  assert.equal((await finished).phase, "done");
  assert.deepEqual(requests, [], "nothing was fetched");
  assert.deepEqual(fs.readdirSync(run.installer.downloads).sort(), [model.archive, run.installer.runtimeArchive(runtime)].sort());
  assert.equal(run.installer.modelInstalled(model) && run.installer.runtimeInstalled(runtime), true);
});

test("a supplied package that fails verification is reported and not deleted", async () => {
  const data = fresh();
  const archive = buildModelArchive();
  const model = modelPackage(archive);
  const run = installer(data);
  fs.mkdirSync(run.installer.downloads, { recursive: true });
  const wrong = Buffer.from(archive);
  wrong[wrong.length - 20] = wrong[wrong.length - 20]! ^ 0xff;
  fs.writeFileSync(run.installer.downloadPath(model.archive), wrong);
  const finished = run.finished();
  run.installer.start(runtimePackage(buildRuntimeArchive()), model);
  assert.equal((await finished).phase, "error");
  assert.equal(fs.existsSync(run.installer.downloadPath(model.archive)), true);
  assert.equal(run.installer.modelInstalled(model), false);
});

test("cancel stops the run, and removeAll deletes only generated directories", async () => {
  const data = fresh();
  const model = modelPackage(buildModelArchive());
  const runtime = runtimePackage(buildRuntimeArchive());
  const run = installer(data);
  let finished = run.finished();
  run.installer.start(runtime, model);
  run.installer.cancel();
  assert.equal((await finished).phase, "idle");
  assert.equal(run.installer.busy, false);
  finished = run.finished();
  run.installer.start(runtime, model);
  assert.equal((await finished).phase, "done");
  fs.writeFileSync(path.join(data, "settings.json"), "{}");
  run.installer.removeAll();
  assert.deepEqual(fs.readdirSync(data), ["settings.json"]);
  assert.equal(run.installer.modelInstalled(model), false);
});

test("reports HTTP failures and unexpected sizes without installing", async () => {
  const data = fresh();
  const model = modelPackage(buildModelArchive());
  const runtime = runtimePackage(buildRuntimeArchive());
  let run = installer(data);
  let finished = run.finished();
  run.installer.start(runtime, { ...model, url: `${origin}/missing.tar.bz2`, archive: "missing.tar.bz2" });
  let result = await finished;
  assert.equal(result.phase, "error");
  assert.match(result.error ?? "", /HTTP 404/);
  run = installer(fresh());
  finished = run.finished();
  run.installer.start(runtime, { ...model, bytes: model.bytes + 5 });
  result = await finished;
  assert.equal(result.phase, "error");
  assert.match(result.error ?? "", /unexpected size/);
});
