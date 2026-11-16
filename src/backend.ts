/** Backend entry: settings, installation, the speech engine and live sessions.
 * Runs in the LearnHarness server. Microphone audio arrives from this plugin's
 * own frontend over the local JSON bridge and is transcribed on this computer. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginBackendContext } from "learnharness-plugin-api";
import {
  DEFAULT_SETTINGS, LATENCIES, LATENCY_LABELS, MODELS, PRECISIONS, PRECISION_NAMES, RUNTIMES, effectiveThreads, modelFor, parseSettings,
  parseSettingsPatch, sessionLanguage,
  type InstallProgress, type ModelPackage, type Settings, type Status,
} from "./contract.ts";
import { EngineHost, type EngineConfig } from "./engine-host.ts";
import { Installer } from "./installer.ts";
import { Sessions } from "./sessions.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function activate(ctx: PluginBackendContext): () => void {
  const settingsFile = path.join(ctx.dataDirectory, "settings.json");
  let settings: Settings;
  try { settings = parseSettings(JSON.parse(fs.readFileSync(settingsFile, "utf8"))); }
  catch (error) {
    // A missing file means first run. Anything else (unreadable, newer format) is
    // reported rather than silently replaced with defaults.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    settings = { ...DEFAULT_SETTINGS };
  }
  // A precision this version does not publish for the saved latency (a file from
  // another version, or one edited by hand) falls back to the compact model,
  // which exists for every latency. Only the copy in memory changes.
  if (!modelFor(settings.latency, settings.precision)) settings = { ...settings, precision: "int8" };
  const currentModel = (): ModelPackage => modelFor(settings.latency, settings.precision) ?? MODELS[settings.latency];

  const platformKey = `${process.platform}-${process.arch}`;
  const runtime = RUNTIMES[platformKey];
  const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  let disposed = false;
  const assertActive = () => { if (disposed || ctx.signal.aborted) throw new Error("On-device dictation is disabled."); };

  // Progress and engine changes are frequent; the frontend only needs a nudge to
  // re-read status, and re-reads on resync, so a coalesced hint is enough.
  let hint: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    if (disposed || hint) return;
    hint = setTimeout(() => { hint = undefined; if (!disposed) ctx.events.emit("status"); }, 200);
  };

  const installer = new Installer({
    dataDirectory: ctx.dataDirectory,
    extractScript: path.join(ctx.directory, "extract-worker.cjs"),
    onProgress: (_progress: InstallProgress) => changed(),
  });
  try { installer.sweep(); } catch { /* a leftover temporary directory is harmless */ }

  let sessions: Sessions;
  const engine = new EngineHost(
    path.join(ctx.directory, "engine-worker.cjs"),
    () => ({ mode: settings.engineMode, nodePath: settings.nodePath, unloadAfterMinutes: settings.unloadAfterMinutes }),
    { reply: reply => sessions.reply(reply), stopped: message => sessions.engineStopped(message), changed },
  );

  function engineConfig(): EngineConfig {
    if (!runtime) throw new Error(`On-device dictation does not support this computer (${platformKey}).`);
    const model = currentModel();
    if (!installer.runtimeInstalled(runtime) || !installer.modelInstalled(model)) {
      throw new Error("The speech engine and model are not installed yet. Open this plugin's settings to download them.");
    }
    const directory = installer.modelDirectory(model);
    return {
      addon: path.join(installer.runtimeDirectory(runtime), runtime.addon),
      encoder: path.join(directory, model.entry.encoder),
      decoder: path.join(directory, model.entry.decoder),
      joiner: path.join(directory, model.entry.joiner),
      tokens: path.join(directory, model.entry.tokens),
      threads: effectiveThreads(settings, cores),
      latencyMs: Number(settings.latency),
    };
  }
  sessions = new Sessions({
    engine,
    configuration: requested => ({ config: engineConfig(), language: sessionLanguage(settings.language, requested) }),
  });

  function status(): Status {
    const model = currentModel();
    const engineInstalled = runtime ? installer.runtimeInstalled(runtime) : false;
    const modelInstalled = installer.modelInstalled(model);
    const pending: Status["pending"] = [];
    if (runtime && !engineInstalled) pending.push({ name: "Speech engine (sherpa-onnx with ONNX Runtime)", url: runtime.url, bytes: runtime.bytes, file: installer.runtimeArchive(runtime) });
    // A model published as separate files gives one entry per file, all under one name.
    const modelName = `NVIDIA Nemotron 3.5 ASR model (${settings.latency} ms, ${PRECISION_NAMES[model.precision]})`;
    for (const item of installer.modelDownloads(model)) pending.push({ name: modelName, ...item });
    const state: Status["engine"] = { state: engine.state };
    if (engine.mode) state.mode = engine.mode;
    if (engine.error) state.error = engine.error;
    if (engine.loadMs !== undefined) state.loadMs = engine.loadMs;
    return {
      settings: { ...settings },
      platform: { key: platformKey, supported: runtime !== undefined },
      engineInstalled, modelInstalled,
      installedModels: LATENCIES.filter(latency => {
        const candidate = modelFor(latency, settings.precision);
        return candidate !== undefined && installer.modelInstalled(candidate);
      }),
      installedPrecisions: PRECISIONS.filter(precision => {
        const candidate = modelFor(settings.latency, precision);
        return candidate !== undefined && installer.modelInstalled(candidate);
      }),
      install: installer.state,
      engine: state,
      sessionActive: sessions.active,
      downloadsDirectory: installer.downloads,
      pending, cores, threads: effectiveThreads(settings, cores),
    };
  }

  function save(next: Settings): void {
    fs.mkdirSync(ctx.dataDirectory, { recursive: true });
    const temporary = path.join(ctx.dataDirectory, `.settings-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, settingsFile);
    } finally { fs.rmSync(temporary, { force: true }); }
    settings = next;
  }

  const unregister = [
    ctx.handle("status", () => { assertActive(); return status(); }),
    ctx.handle("set-settings", input => {
      assertActive();
      const patch = parseSettingsPatch(input);
      const next: Settings = { ...settings, ...patch };
      const keys = Object.keys(patch) as (keyof typeof patch)[];
      if (!keys.some(key => next[key] !== settings[key])) return status();
      if (settings.revision === Number.MAX_SAFE_INTEGER) throw new Error("Settings revision limit reached.");
      next.revision = settings.revision + 1;
      if (!modelFor(next.latency, next.precision)) {
        throw new Error(`The ${PRECISION_NAMES[next.precision]} model is not published for “${LATENCY_LABELS[next.latency]}”. Choose another responsiveness step, or the compact model.`);
      }
      const reload = (["latency", "precision", "threads", "engineMode", "nodePath"] as const).some(key => next[key] !== settings[key]);
      if (reload && sessions.active) throw new Error("Stop dictating before changing this setting.");
      save(next);
      // The loaded model no longer matches; the next dictation loads the new one.
      if (reload) engine.unload();
      else engine.keepAlive();
      changed();
      return status();
    }),
    ctx.handle("install", () => {
      assertActive();
      if (!runtime) throw new Error(`On-device dictation does not support this computer (${platformKey}).`);
      installer.start(runtime, currentModel());
      return status();
    }),
    ctx.handle("install-cancel", () => { assertActive(); installer.cancel(); return status(); }),
    // Load the model ahead of the first dictation. Failures show up in status.
    ctx.handle("warm", () => {
      assertActive();
      if (runtime && installer.runtimeInstalled(runtime) && installer.modelInstalled(currentModel())) {
        engine.ensure(engineConfig()).catch(() => undefined);
      }
      return status();
    }),
    ctx.handle("remove-files", () => {
      assertActive();
      if (sessions.active) throw new Error("Stop dictating before removing the downloaded files.");
      engine.unload();
      installer.removeAll();
      return status();
    }),
    ctx.handle("session-start", input => {
      assertActive();
      return isRecord(input) ? sessions.start(input.owner, input.language) : sessions.start(undefined);
    }),
    ctx.handle("session-push", input => {
      assertActive();
      if (!isRecord(input)) throw new Error("Invalid request.");
      return sessions.push(input.session, input.audio, input.have);
    }),
    ctx.handle("session-finish", input => {
      assertActive();
      if (!isRecord(input)) throw new Error("Invalid request.");
      return sessions.finish(input.session, input.audio, input.have);
    }),
    ctx.handle("session-cancel", input => {
      assertActive();
      if (!isRecord(input)) throw new Error("Invalid request.");
      return sessions.cancel(input.session);
    }),
  ];

  return () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(hint);
    unregister.splice(0).forEach(dispose => dispose());
    installer.cancel();
    sessions.dispose();
    engine.dispose();
  };
}
