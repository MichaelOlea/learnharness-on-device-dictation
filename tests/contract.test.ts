import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SETTINGS, FULL_PRECISION_MODELS, LANGUAGES, LATENCIES, MODELS, PRECISIONS, RUNTIMES, effectiveThreads, extendTranscript,
  fullPrecisionPackage, isArchiveModel, isLanguage, mapHostLanguage, modelFor, modelSize, normalizeTranscript, offeredPrecisions,
  parseSettings, parseSettingsPatch, sessionLanguage,
} from "../src/contract.ts";

test("catalog entries are complete and pinned", () => {
  assert.equal(LANGUAGES.length, 40);
  assert.equal(new Set(LANGUAGES.map(language => language.code)).size, 40);
  for (const latency of LATENCIES) {
    const model = MODELS[latency];
    assert.match(model.url, /^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\/asr-models\/.+\.tar\.bz2$/);
    assert.match(model.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(model.files.map(file => file.name).sort(), ["decoder.int8.onnx", "encoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]);
    for (const file of model.files) { assert.match(file.sha256, /^[0-9a-f]{64}$/); assert.ok(file.bytes > 0); }
  }
  assert.equal(new Set(LATENCIES.map(latency => MODELS[latency].sha256)).size, LATENCIES.length);
  for (const latency of LATENCIES) {
    assert.equal(modelFor(latency, "int8"), MODELS[latency], "the compact model exists for every latency");
    assert.equal(MODELS[latency].precision, "int8");
    assert.equal(modelFor(latency, "fp32"), FULL_PRECISION_MODELS[latency]);
  }
  // Whatever full-precision packages are listed must be pinned just as tightly.
  for (const [latency, model] of Object.entries(FULL_PRECISION_MODELS)) {
    assert.equal(model.latency, latency);
    assert.equal(model.precision, "fp32");
    assert.equal(isArchiveModel(model), false);
    assert.match(model.baseUrl, /^https:\/\/huggingface\.co\/csukuangfj2\/sherpa-onnx-nemotron-3\.5-asr-streaming-0\.6b-\d+ms-2026-06-11\/resolve\/[0-9a-f]{40}\/$/, "pinned to a commit");
    const names = model.files.map(file => file.name);
    assert.equal(new Set(names).size, names.length);
    for (const name of Object.values(model.entry)) assert.ok(names.includes(name), name);
    for (const file of model.files) { assert.match(file.name, /^[A-Za-z0-9._-]+$/); assert.match(file.sha256, /^[0-9a-f]{64}$/); assert.ok(file.bytes > 0); }
  }
  assert.deepEqual(offeredPrecisions(), Object.keys(FULL_PRECISION_MODELS).length ? ["int8", "fp32"] : ["int8"]);
  for (const [key, runtime] of Object.entries(RUNTIMES)) {
    assert.equal(runtime.key, key);
    assert.match(runtime.url, /^https:\/\/registry\.npmjs\.org\/sherpa-onnx-[a-z0-9-]+\/-\/sherpa-onnx-[a-z0-9-]+-2\.0\.1\.tgz$/);
    assert.match(runtime.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    assert.ok(runtime.files.includes(runtime.addon));
  }
  assert.deepEqual(Object.keys(RUNTIMES).sort(), ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]);
});

test("model packages describe both ways a model is published", () => {
  const compact = MODELS["560"];
  assert.deepEqual(modelSize(compact), { download: 475_271_763, installed: 657_601_403 + 14_978_075 + 9_504_438 + 131_440 });
  const full = fullPrecisionPackage("1120", "a".repeat(40), [
    { name: "encoder.onnx", bytes: 10, sha256: "1".repeat(64) }, { name: "encoder.data", bytes: 1000, sha256: "2".repeat(64) },
    { name: "decoder.onnx", bytes: 20, sha256: "3".repeat(64) }, { name: "joiner.onnx", bytes: 30, sha256: "4".repeat(64) },
    { name: "tokens.txt", bytes: 5, sha256: "5".repeat(64) },
  ]);
  assert.equal(full.baseUrl, `https://huggingface.co/csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-1120ms-2026-06-11/resolve/${"a".repeat(40)}/`);
  assert.notEqual(full.directory, MODELS["1120"].directory, "both precisions can be installed side by side");
  assert.deepEqual(modelSize(full), { download: 1065, installed: 1065 });
  assert.deepEqual(full.entry, { encoder: "encoder.onnx", decoder: "decoder.onnx", joiner: "joiner.onnx", tokens: "tokens.txt" });
  assert.deepEqual([...PRECISIONS], ["int8", "fp32"]);
});

test("settings changes are validated strictly", () => {
  assert.deepEqual(parseSettingsPatch({ language: "de-DE", latency: "1120", threads: 4 }), { language: "de-DE", latency: "1120", threads: 4 });
  assert.deepEqual(parseSettingsPatch({ nodePath: "  /usr/bin/node  " }), { nodePath: "/usr/bin/node" });
  assert.deepEqual(parseSettingsPatch({ language: "host", replaceBuiltIn: false, liveButton: true, preload: false }), { language: "host", replaceBuiltIn: false, liveButton: true, preload: false });
  assert.deepEqual(parseSettingsPatch({ precision: "fp32" }), { precision: "fp32" });
  assert.deepEqual(parseSettingsPatch({ precision: "int8" }), { precision: "int8" });
  for (const bad of [
    null, [], "x", { language: "xx-YY" }, { language: "en" }, { latency: "80" }, { latency: 560 }, { precision: "fp16" }, { precision: 32 }, { precision: "" }, { threads: -1 }, { threads: 1.5 },
    { threads: 17 }, { autoStopSeconds: 601 }, { unloadAfterMinutes: "5" }, { sidebarButton: true }, { replaceBuiltIn: "yes" }, { liveButton: 0 }, { preload: null }, { engineMode: "gpu" },
    { nodePath: "a\nb" }, { revision: 3 }, { unknown: true },
  ]) assert.throws(() => parseSettingsPatch(bad), Error, JSON.stringify(bad));
  assert.ok(isLanguage("auto"));
  assert.ok(!isLanguage("constructor"));
});

test("saved settings round-trip and refuse malformed records", () => {
  assert.deepEqual(parseSettings(JSON.parse(JSON.stringify(DEFAULT_SETTINGS))), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings({ revision: 7, language: "ja-JP" }), { ...DEFAULT_SETTINGS, revision: 7, language: "ja-JP" });
  assert.deepEqual(parseSettings({ revision: 2, sidebarButton: true }), { ...DEFAULT_SETTINGS, revision: 2 }, "a 0.1.0 file still loads");
  assert.equal(DEFAULT_SETTINGS.precision, "int8", "the compact model stays the default");
  assert.equal(parseSettings({ revision: 4, latency: "320" }).precision, "int8", "a 0.2.0 file, which has no precision, still loads");
  assert.equal(parseSettings({ revision: 5, precision: "fp32" }).precision, "fp32");
  assert.equal(DEFAULT_SETTINGS.replaceBuiltIn, true);
  assert.equal(DEFAULT_SETTINGS.liveButton, false);
  assert.throws(() => parseSettings({ language: "ja-JP" }));
  assert.throws(() => parseSettings({ revision: 1, futureOption: true }));
  assert.throws(() => parseSettings("{}"));
});

test("automatic thread count stays modest", () => {
  assert.equal(effectiveThreads({ threads: 0 }, 1), 1);
  assert.equal(effectiveThreads({ threads: 0 }, 2), 1);
  assert.equal(effectiveThreads({ threads: 0 }, 8), 4);
  assert.equal(effectiveThreads({ threads: 0 }, 32), 4);
  assert.equal(effectiveThreads({ threads: 6 }, 2), 6);
});

test("transcript text is cleaned without ever shrinking", () => {
  assert.equal(normalizeTranscript(" The cell.  I think"), "The cell. I think");
  assert.equal(normalizeTranscript("Guten Tag. <de-DE>"), "Guten Tag. ");
  assert.equal(normalizeTranscript("a < b and c > d"), "a < b and c > d");
  // A growing raw text must produce a growing clean text.
  const raw = " The mitochondria is the powerhouse of the cell.  I think <en-US> so";
  let previous = "";
  for (let length = 0; length <= raw.length; length++) {
    const next = normalizeTranscript(raw.slice(0, length));
    // The only non-append step is a whole language tag disappearing at once.
    if (!next.startsWith(previous)) assert.match(raw.slice(0, length), /<en-US>$/);
    previous = next;
  }
  assert.equal(extendTranscript("hello", "hello world"), "hello world");
  assert.equal(extendTranscript("hello wor", "hello world"), "hello world");
  assert.equal(extendTranscript("hello there", "hello world"), "hello thereworld");
  assert.equal(extendTranscript("", "x"), "x");
});

test("LearnHarness's dictation languages map onto the model's locales", () => {
  assert.equal(mapHostLanguage("en"), "en-US");
  assert.equal(mapHostLanguage("en-GB"), "en-GB");
  assert.equal(mapHostLanguage("en-AU"), "en-GB");
  assert.equal(mapHostLanguage("es-419"), "es-US");
  assert.equal(mapHostLanguage("pt"), "pt-BR");
  assert.equal(mapHostLanguage("zh-Hans"), "zh-CN");
  assert.equal(mapHostLanguage("ar-EG"), "ar-AR");
  assert.equal(mapHostLanguage("no"), "nb-NO");
  for (const unsupported of ["multi", "ta", "zh-HK", "zh-TW", "constructor", "", null, undefined]) assert.equal(mapHostLanguage(unsupported), "auto", String(unsupported));
  // Every code LearnHarness 0.6.1 can send resolves to something the engine accepts.
  const host = ["af","af-ZA","ar","ar-AE","ar-SA","ar-QA","ar-KW","ar-SY","ar-LB","ar-PS","ar-JO","ar-EG","ar-SD","ar-TD","ar-MA","ar-DZ","ar-TN","ar-IQ","ar-IR","hy","as","as-IN","be","bn","bs","bg","ca","zh-HK","zh","zh-CN","zh-Hans","zh-TW","zh-Hant","hr","cs","cs-CZ","da","da-DK","nl","en","en-US","en-AU","en-GB","en-IN","en-NZ","et","fi","nl-BE","fr","fr-CA","ka","ka-GE","de","de-CH","el","gu","gu-IN","he","hi","hu","id","it","ja","kn","kk","kk-KZ","ko","ko-KR","lv","lt","mk","ms","mr","mn","ne","no","ps","ps-AF","fa","pl","pt","pt-BR","pt-PT","pa","pa-IN","ro","ru","sr","sk","sl","es","es-419","sv","sv-SE","tl","ta","te","th","th-TH","tr","tr-TR","uk","ur","vi","multi"];
  for (const code of host) assert.ok(isLanguage(mapHostLanguage(code)), code);
});

test("an explicit plugin language wins over the one LearnHarness asks for", () => {
  assert.equal(sessionLanguage("host", "de-DE"), "de-DE");
  assert.equal(sessionLanguage("host", undefined), "auto");
  assert.equal(sessionLanguage("host", "not-a-language"), "auto");
  assert.equal(sessionLanguage("host", "host"), "auto");
  assert.equal(sessionLanguage("ja-JP", "de-DE"), "ja-JP");
  assert.equal(sessionLanguage("auto", "de-DE"), "auto");
});
