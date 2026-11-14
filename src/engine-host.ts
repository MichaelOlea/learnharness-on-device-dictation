/** Owns the speech-engine worker: starts it, loads the model, reloads it when the
 * configuration changes, releases it when idle and reports when it dies.
 *
 * Default placement is a worker thread of the host server. If the native library
 * cannot be loaded there (for example because the desktop app only admits
 * libraries signed by its own publisher), "auto" falls back to running the very
 * same script in a separate Node.js process when one is available. */
import fs from "node:fs";
import path from "node:path";
import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { Worker } from "node:worker_threads";
import type { EngineMode } from "./contract.ts";
import { CONTROL_EPOCH, CONTROL_STOP, type EngineLoad, type EngineReply, type EngineRequest, type EngineWorkerData } from "./engine-worker.ts";

export type EngineConfig = Omit<EngineLoad, "type">;
export interface EngineOptions { mode: EngineMode; nodePath: string; unloadAfterMinutes: number }
type Placement = "in-process" | "external";

interface Transport {
  placement: Placement;
  post(request: EngineRequest, transfer?: ArrayBuffer[]): void;
  stop(): void;
}
const LOAD_TIMEOUT_MS = 180_000;

/** Locate a real Node.js executable for the external engine. */
export function findNode(configured: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const executable = platform === "win32" ? "node.exe" : "node";
  const usable = (file: string) => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
  };
  if (configured) return usable(configured) ? configured : undefined;
  // When the server itself runs on plain Node.js, that binary is the obvious choice.
  if (!process.versions.electron && usable(process.execPath)) return process.execPath;
  const directories = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  // Desktop apps on macOS and Linux often start with a minimal PATH.
  if (platform === "win32") directories.push(path.join(env.ProgramFiles ?? "C:\\Program Files", "nodejs"));
  else directories.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin");
  for (const directory of directories) {
    const candidate = path.join(directory, executable);
    if (usable(candidate)) return candidate;
  }
  return undefined;
}

export class EngineHost {
  state: "unloaded" | "loading" | "ready" | "error" = "unloaded";
  mode: Placement | undefined;
  error: string | undefined;
  loadMs: number | undefined;

  private transport: Transport | undefined;
  private key: string | undefined;
  private loading: Promise<void> | undefined;
  private pendingLoad: { resolve(): void; reject(error: Error): void } | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly script: string,
    private readonly options: () => EngineOptions,
    private readonly events: { reply(reply: EngineReply): void; stopped(message: string): void; changed(): void },
  ) {}

  /** Resolve once a model with exactly this configuration is loaded. */
  ensure(config: EngineConfig): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Dictation is disabled."));
    const options = this.options();
    const key = JSON.stringify([config, options.mode, options.nodePath]);
    this.keepAlive();
    if (this.key === key && this.state === "ready") return Promise.resolve();
    if (this.key === key && this.loading) return this.loading;
    this.unload();
    this.key = key;
    this.state = "loading";
    this.error = undefined;
    this.events.changed();
    const loading = this.loadWithFallback(config, options, () => this.key === key && !this.disposed).then(
      () => { if (this.key === key) { this.state = "ready"; this.loading = undefined; this.events.changed(); this.keepAlive(); } },
      error => {
        if (this.key === key) {
          this.stopTransport();
          this.state = "error";
          this.error = error instanceof Error ? error.message : String(error);
          this.loading = undefined;
          this.key = undefined;
          this.events.changed();
        }
        throw error;
      },
    );
    this.loading = loading;
    return loading;
  }

  post(request: EngineRequest, transfer?: ArrayBuffer[]): void {
    this.transport?.post(request, transfer);
  }

  /** True when a load is in flight or a model is loaded. */
  get busy(): boolean { return this.transport !== undefined; }

  /** Postpone the idle unload; call while a session is using the engine. */
  keepAlive(): void {
    clearTimeout(this.idle);
    const minutes = this.options().unloadAfterMinutes;
    if (minutes > 0 && !this.disposed) {
      this.idle = setTimeout(() => this.unload(), minutes * 60_000);
      this.idle.unref?.();
    }
  }

  unload(): void {
    clearTimeout(this.idle);
    const wasLoaded = this.state !== "unloaded";
    this.pendingLoad?.reject(new Error("The speech model was unloaded."));
    this.pendingLoad = undefined;
    this.stopTransport();
    this.key = undefined;
    this.loading = undefined;
    this.state = "unloaded";
    this.mode = undefined;
    this.loadMs = undefined;
    if (wasLoaded) this.events.changed();
  }

  dispose(): void {
    this.unload();
    this.disposed = true;
  }

  private stopTransport(): void {
    const transport = this.transport;
    this.transport = undefined;
    transport?.stop();
  }

  private async loadWithFallback(config: EngineConfig, options: EngineOptions, current: () => boolean): Promise<void> {
    if (options.mode === "external") return this.load(config, "external", options);
    try {
      await this.load(config, "in-process", options);
    } catch (inProcess) {
      // Unloaded or reconfigured meanwhile: this attempt no longer owns the engine.
      if (!current()) throw inProcess;
      const first = inProcess instanceof Error ? inProcess.message : String(inProcess);
      if (options.mode !== "auto" || !findNode(options.nodePath)) throw new Error(explain(first));
      try { await this.load(config, "external", options); }
      catch (external) {
        throw new Error(`${explain(first)} The separate-process engine also failed: ${external instanceof Error ? external.message : String(external)}`);
      }
    }
  }

  private load(config: EngineConfig, placement: Placement, options: EngineOptions): Promise<void> {
    this.stopTransport();
    const transport = placement === "in-process" ? this.startWorker() : this.startProcess(options);
    this.transport = transport;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.pendingLoad?.reject(new Error("Loading the speech model timed out.")), LOAD_TIMEOUT_MS);
      this.pendingLoad = {
        resolve: () => { clearTimeout(timer); this.pendingLoad = undefined; this.mode = placement; resolve(); },
        reject: error => { clearTimeout(timer); this.pendingLoad = undefined; if (this.transport === transport) this.stopTransport(); reject(error); },
      };
      transport.post({ type: "load", ...config });
    });
  }

  private receive(transport: Transport, reply: EngineReply): void {
    if (this.transport !== transport) return;
    if (reply.type === "loaded") { this.loadMs = reply.loadMs; this.pendingLoad?.resolve(); }
    else if (reply.type === "load-error") this.pendingLoad?.reject(new Error(reply.message));
    else this.events.reply(reply);
  }

  private stoppedUnexpectedly(transport: Transport, detail: string): void {
    if (this.transport !== transport) return;
    this.transport = undefined;
    const message = `The speech engine stopped unexpectedly (${detail}).`;
    if (this.pendingLoad) { this.pendingLoad.reject(new Error(message)); return; }
    this.key = undefined;
    this.loading = undefined;
    this.state = "error";
    this.error = message;
    this.events.stopped(message);
    this.events.changed();
  }

  private startWorker(): Transport {
    const control = new Int32Array(new SharedArrayBuffer(8));
    const data: EngineWorkerData = { control: control.buffer as SharedArrayBuffer };
    const worker = new Worker(this.script, { workerData: data });
    let epoch = 0;
    const transport: Transport = {
      placement: "in-process",
      post: (request, transfer) => {
        if (request.type === "audio") request.epoch = epoch;
        else if (request.type === "cancel") Atomics.store(control, CONTROL_EPOCH, ++epoch);
        worker.postMessage(request, transfer ?? []);
      },
      // Never worker.terminate(): interrupting the thread inside the native
      // library aborts the whole process. Ask it to leave; it does so as soon as
      // the native call it is in returns, and it must not hold the server open.
      stop: () => {
        worker.removeAllListeners();
        worker.on("error", () => undefined);
        Atomics.store(control, CONTROL_STOP, 1);
        worker.postMessage({ type: "shutdown" } satisfies EngineRequest);
        worker.unref();
      },
    };
    worker.on("message", (reply: EngineReply) => this.receive(transport, reply));
    worker.on("error", error => this.stoppedUnexpectedly(transport, error instanceof Error ? error.message : String(error)));
    worker.on("exit", code => this.stoppedUnexpectedly(transport, `exit code ${code}`));
    return transport;
  }

  private startProcess(engine: EngineOptions): Transport {
    const node = findNode(engine.nodePath);
    if (!node) {
      throw new Error(engine.nodePath
        ? `No runnable Node.js was found at ${engine.nodePath}.`
        : "No Node.js installation was found. Install Node.js, or set its path in this plugin's settings.");
    }
    // fork() forwards its options to spawn(), which honours windowsHide even
    // though fork's own typings do not list it.
    const options: ForkOptions & { windowsHide: boolean } = {
      execPath: node, serialization: "advanced", windowsHide: true,
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    };
    const child: ChildProcess = fork(this.script, [], options);
    const transport: Transport = {
      placement: "external",
      post: request => { if (child.connected) child.send(request); },
      stop: () => { child.removeAllListeners(); if (child.connected) child.disconnect(); child.kill(); },
    };
    child.on("message", reply => this.receive(transport, reply as EngineReply));
    child.on("error", error => this.stoppedUnexpectedly(transport, error.message));
    child.on("exit", (code, signal) => this.stoppedUnexpectedly(transport, signal ? `signal ${signal}` : `exit code ${code}`));
    return transport;
  }
}

/** Turn a raw loader failure into something a learner can act on. */
function explain(message: string): string {
  if (/library validation|code signature|Team ID|not valid for use in process/i.test(message)) {
    return `This desktop app only loads native libraries signed by its own publisher, so the speech engine cannot run inside it (${message}). Install Node.js and the plugin will run the engine in a separate process instead.`;
  }
  if (/GLIBC|GLIBCXX/.test(message)) return `This Linux system's C library is too old for the speech engine (${message}).`;
  if (process.platform === "win32" && /specified module could not be found/i.test(message)) {
    return `The speech engine could not be loaded: ${message} Installing the current Microsoft Visual C++ Redistributable usually fixes this.`;
  }
  return `The speech engine could not be loaded: ${message}`;
}
