/** Downloads and installs the speech engine and model into plugin-owned data.
 *
 * Nothing here runs until the learner explicitly asks for it. Downloads resume,
 * a package placed in the downloads folder by hand is used instead of fetching,
 * and nothing is installed unless its published digest matches.
 *
 * A model arrives either as one archive (unpacked by the extract worker) or as
 * separate files, which are fetched one by one into downloads/<model directory>/,
 * each verified, and then moved into place together. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  RUNTIME_VERSION, isArchiveModel, modelSize,
  type InstallProgress, type LooseModel, type ModelPackage, type PackageFile, type RuntimePackage,
} from "./contract.ts";
import type { ExtractJob, ExtractMessage, VerifyJob } from "./extract-worker.ts";

const MARKER = "installed.json";
/** Suffix of a separately published file this plugin fetched itself, as opposed
 * to one the learner put in the downloads folder under its plain name. */
const FETCHED = ".fetched";
/** A connection that delivers nothing for this long is treated as dead. */
const STALL_MS = 60_000;

export interface InstallerOptions {
  dataDirectory: string;
  /** Built extract worker script (dist/extract-worker.cjs). */
  extractScript: string;
  onProgress(progress: InstallProgress): void;
  fetch?: typeof fetch;
}

function exists(file: string): fs.Stats | undefined {
  return fs.lstatSync(file, { throwIfNoEntry: false });
}
/** Remove one of our own generated directories; never follow a link out of data. */
function removeTree(directory: string): void {
  const stat = exists(directory);
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new Error(`Refusing to remove a symbolic link: ${directory}`);
  fs.rmSync(directory, { recursive: true, force: true });
}

/** Virus scanners on Windows briefly hold freshly written files open, which
 * makes an immediate rename fail; a short wait is all it takes. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(from, to); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 9 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
}

export class Installer {
  readonly downloads: string;
  private readonly models: string;
  private readonly runtime: string;
  private progress: InstallProgress = { phase: "idle", done: 0, total: 0 };
  private running: AbortController | undefined;

  constructor(private readonly options: InstallerOptions) {
    this.downloads = path.join(options.dataDirectory, "downloads");
    this.models = path.join(options.dataDirectory, "models");
    this.runtime = path.join(options.dataDirectory, "runtime");
  }

  get state(): InstallProgress { return { ...this.progress }; }
  get busy(): boolean { return this.running !== undefined; }

  runtimeDirectory(pkg: RuntimePackage): string { return path.join(this.runtime, `${pkg.name}-${RUNTIME_VERSION}`); }
  modelDirectory(model: ModelPackage): string { return path.join(this.models, model.directory); }
  downloadPath(file: string): string { return path.join(this.downloads, file); }
  runtimeArchive(pkg: RuntimePackage): string { return `${pkg.name}-${RUNTIME_VERSION}.tgz`; }
  /** Where a separately published model file is kept until it is installed,
   * relative to the downloads folder. */
  stagedFile(model: LooseModel, file: PackageFile): string { return path.join(model.directory, file.name); }

  /** A complete copy of a separately published file that is ready to verify:
   * one the learner supplied, else one fetched earlier. */
  private staged(model: LooseModel, file: PackageFile): { path: string; supplied: boolean } | undefined {
    const supplied = this.downloadPath(this.stagedFile(model, file));
    for (const candidate of [{ path: supplied, supplied: true }, { path: supplied + FETCHED, supplied: false }]) {
      const stat = exists(candidate.path);
      if (stat?.isFile() && stat.size === file.bytes) return candidate;
    }
    return undefined;
  }
  /** What installing this model would still fetch. */
  modelDownloads(model: ModelPackage): { url: string; bytes: number; file: string }[] {
    if (this.modelInstalled(model)) return [];
    if (isArchiveModel(model)) return [{ url: model.url, bytes: model.bytes, file: model.archive }];
    return model.files.filter(file => !this.staged(model, file))
      .map(file => ({ url: model.baseUrl + file.name, bytes: file.bytes, file: this.stagedFile(model, file) }));
  }

  runtimeInstalled(pkg: RuntimePackage): boolean {
    const directory = this.runtimeDirectory(pkg);
    return [MARKER, ...pkg.files].every(name => exists(path.join(directory, name))?.isFile());
  }
  modelInstalled(model: ModelPackage): boolean {
    const directory = this.modelDirectory(model);
    if (!exists(path.join(directory, MARKER))?.isFile()) return false;
    // Sizes are checked on every use; full digests were verified at installation.
    return model.files.every(file => {
      const stat = exists(path.join(directory, file.name));
      return stat?.isFile() && stat.size === file.bytes;
    });
  }

  /** Start installing whatever is missing. Returns immediately; observe `state`. */
  start(pkg: RuntimePackage, model: ModelPackage): void {
    if (this.running) return;
    const controller = new AbortController();
    this.running = controller;
    // Release the run before reporting its outcome, so an observer reacting to
    // "done" or "error" can start the next installation straight away.
    const release = () => { if (this.running === controller) this.running = undefined; };
    this.run(pkg, model, controller.signal).then(
      () => { release(); this.report({ phase: "done", done: 1, total: 1 }); },
      error => {
        release();
        this.report(controller.signal.aborted
          ? { phase: "idle", done: 0, total: 0 }
          : { phase: "error", done: 0, total: 0, error: error instanceof Error ? error.message : String(error) });
      },
    );
  }

  cancel(): void { this.running?.abort(new Error("Installation cancelled.")); }

  /** Delete everything this plugin downloaded or unpacked. Settings are kept. */
  removeAll(): void {
    if (this.running) throw new Error("Wait for the installation to finish or cancel it first.");
    for (const directory of [this.models, this.runtime, this.downloads]) removeTree(directory);
    this.report({ phase: "idle", done: 0, total: 0 });
  }

  /** Drop half-finished unpack directories left by an interrupted run. */
  sweep(): void {
    for (const parent of [this.models, this.runtime]) {
      if (!exists(parent)?.isDirectory()) continue;
      for (const name of fs.readdirSync(parent)) if (name.includes(".tmp-")) removeTree(path.join(parent, name));
    }
  }

  private report(progress: InstallProgress): void {
    this.progress = progress;
    this.options.onProgress({ ...progress });
  }

  private async run(pkg: RuntimePackage, model: ModelPackage, signal: AbortSignal): Promise<void> {
    for (const directory of [this.downloads, this.models, this.runtime]) fs.mkdirSync(directory, { recursive: true });
    this.sweep();
    await this.ensureSpace(pkg, model);
    if (!this.runtimeInstalled(pkg)) {
      await this.install({
        url: pkg.url, archive: this.runtimeArchive(pkg), bytes: pkg.bytes, destination: this.runtimeDirectory(pkg),
        phases: ["downloading-engine", "unpacking-engine"],
        job: {
          format: "tgz", prefix: "package/", files: pkg.files.map(name => ({ name })),
          digest: { algorithm: "sha512", encoding: "base64", expected: pkg.integrity.replace(/^sha512-/, "") },
        },
        marker: { name: pkg.name, version: RUNTIME_VERSION, integrity: pkg.integrity },
      }, signal);
    }
    if (this.modelInstalled(model)) return;
    if (isArchiveModel(model)) {
      await this.install({
        url: model.url, archive: model.archive, bytes: model.bytes, destination: this.modelDirectory(model),
        phases: ["downloading-model", "unpacking-model"],
        job: {
          format: "tar.bz2", prefix: `${model.directory}/`, files: model.files.map(file => ({ ...file })),
          digest: { algorithm: "sha256", encoding: "hex", expected: model.sha256 },
        },
        marker: { name: model.directory, sha256: model.sha256 },
      }, signal);
    } else {
      await this.installLoose(model, signal);
    }
  }

  /** Install a model published as separate files. */
  private async installLoose(model: LooseModel, signal: AbortSignal): Promise<void> {
    const staging = this.downloadPath(model.directory);
    if (exists(staging)?.isSymbolicLink()) throw new Error(`Refusing to download into a symbolic link: ${staging}`);
    fs.mkdirSync(staging, { recursive: true });
    const total = modelSize(model).installed;

    // Fetch whatever is not already there, as one progress bar over all files.
    let before = 0;
    for (const file of model.files) {
      if (!this.staged(model, file)) {
        const target = this.downloadPath(this.stagedFile(model, file)) + FETCHED;
        await this.download(model.baseUrl + file.name, target, file.bytes, "downloading-model", signal, { before, total });
      }
      before += file.bytes;
      signal.throwIfAborted();
    }

    // Verify every file before any of them is moved.
    const sources: { file: PackageFile; path: string }[] = [];
    before = 0;
    this.report({ phase: "unpacking-model", done: 0, total });
    for (const file of model.files) {
      const source = this.staged(model, file);
      if (!source) throw new Error(`${file.name} disappeared from the downloads folder. Start the installation again.`);
      try {
        await this.work({ verify: source.path, name: file.name, bytes: file.bytes, sha256: file.sha256 }, "unpacking-model", signal, { before, total });
      } catch (error) {
        // As with archives: what we fetched is useless and is fetched afresh next
        // time; what the learner supplied is theirs to replace.
        if (!source.supplied && !signal.aborted) fs.rmSync(source.path, { force: true });
        throw error;
      }
      sources.push({ file, path: source.path });
      before += file.bytes;
    }

    const destination = this.modelDirectory(model);
    const temporary = `${destination}.tmp-${randomUUID()}`;
    fs.mkdirSync(temporary, { recursive: false, mode: 0o700 });
    const moved: { from: string; to: string }[] = [];
    try {
      for (const source of sources) {
        const to = path.join(temporary, source.file.name);
        await renameWithRetry(source.path, to);
        moved.push({ from: source.path, to });
      }
      fs.writeFileSync(path.join(temporary, MARKER), JSON.stringify({
        name: model.directory, files: model.files.map(file => ({ name: file.name, sha256: file.sha256 })), installedAt: new Date().toISOString(),
      }) + "\n", { flag: "wx" });
      removeTree(destination);
      await renameWithRetry(temporary, destination);
    } catch (error) {
      // Put the verified files back so the next attempt need not fetch them again.
      for (const move of moved) { try { fs.renameSync(move.to, move.from); } catch { /* removed with the directory below */ } }
      removeTree(temporary);
      throw error;
    }
    try { fs.rmdirSync(staging); } catch { /* something of the learner's is still in it */ }
  }

  private async ensureSpace(pkg: RuntimePackage, model: ModelPackage): Promise<void> {
    let needed = 0;
    if (!this.runtimeInstalled(pkg)) needed += pkg.bytes * 5;
    if (!this.modelInstalled(model) && isArchiveModel(model)) {
      needed += modelSize(model).installed;
      const archive = exists(this.downloadPath(model.archive));
      if (!archive) needed += model.bytes - (exists(this.downloadPath(`${model.archive}.part`))?.size ?? 0);
    } else if (!this.modelInstalled(model)) {
      // Separate files are moved into place, so only what is not yet fetched counts.
      for (const item of this.modelDownloads(model)) {
        needed += item.bytes - Math.min(item.bytes, exists(this.downloadPath(item.file) + FETCHED + ".part")?.size ?? 0);
      }
    }
    if (needed === 0 || typeof fs.promises.statfs !== "function") return;
    let free: number;
    try {
      const stats = await fs.promises.statfs(this.options.dataDirectory);
      free = stats.bavail * stats.bsize;
    } catch { return; } // unknown filesystem: let the write itself report a full disk
    const margin = 200e6;
    if (free < needed + margin) {
      throw new Error(`Not enough free disk space: ${((needed + margin) / 1e9).toFixed(1)} GB is needed, ${(free / 1e9).toFixed(1)} GB is available.`);
    }
  }

  private async install(step: {
    url: string; archive: string; bytes: number; destination: string;
    phases: [InstallProgress["phase"], InstallProgress["phase"]];
    job: Pick<ExtractJob, "format" | "prefix" | "files" | "digest">;
    marker: Record<string, unknown>;
  }, signal: AbortSignal): Promise<void> {
    const archive = this.downloadPath(step.archive);
    // A complete file that was already there was put there by the learner.
    const supplied = exists(archive)?.size === step.bytes;
    if (!supplied) await this.download(step.url, archive, step.bytes, step.phases[0], signal);
    signal.throwIfAborted();

    const temporary = `${step.destination}.tmp-${randomUUID()}`;
    this.report({ phase: step.phases[1], done: 0, total: step.bytes });
    try {
      await this.work({ ...step.job, archive, destination: temporary }, step.phases[1], signal);
    } catch (error) {
      removeTree(temporary);
      // A file we fetched that fails verification is useless; fetch it afresh next
      // time. A file the learner supplied is theirs to replace.
      if (!supplied && !signal.aborted) fs.rmSync(archive, { force: true });
      throw error;
    }
    fs.writeFileSync(path.join(temporary, MARKER), JSON.stringify({ ...step.marker, installedAt: new Date().toISOString() }) + "\n", { flag: "wx" });
    removeTree(step.destination);
    try { await renameWithRetry(temporary, step.destination); }
    catch (error) { removeTree(temporary); throw error; }
    if (!supplied) fs.rmSync(archive, { force: true });
  }

  /** Fetch one file, resuming a partial one. `span` places its progress inside
   * a larger total when it is one of several files reported together. */
  private async download(
    url: string, destination: string, bytes: number, phase: InstallProgress["phase"], signal: AbortSignal,
    span: { before: number; total: number } = { before: 0, total: bytes },
  ): Promise<void> {
    const partial = `${destination}.part`;
    let offset = exists(partial)?.size ?? 0;
    if (offset >= bytes) { fs.rmSync(partial, { force: true }); offset = 0; }
    const progress = (done: number) => this.report({ phase, done: span.before + done, total: span.total });
    progress(offset);

    const stall = new AbortController();
    const combined = AbortSignal.any([signal, stall.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(new Error("The download stalled. Start it again to resume where it stopped.")), STALL_MS);
    };
    watchdog();
    let handle: fs.promises.FileHandle | undefined;
    try {
      const response = await (this.options.fetch ?? fetch)(url, {
        redirect: "follow", signal: combined,
        headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
      });
      if (offset > 0 && response.status === 200) offset = 0; // server ignored the range: start over
      else if (offset > 0 && response.status !== 206) throw new Error(`Download failed (HTTP ${response.status}).`);
      else if (offset === 0 && response.status !== 200) throw new Error(`Download failed (HTTP ${response.status}).`);
      if (!response.body) throw new Error("Download failed (empty response).");
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > 0 && offset + length !== bytes) {
        throw new Error("The server offered a file of an unexpected size. Nothing was installed.");
      }
      handle = await fs.promises.open(partial, offset > 0 ? "a" : "w", 0o600);
      let done = offset;
      let reported = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        watchdog();
        done += chunk.length;
        if (done > bytes) throw new Error("The download is larger than the published package. Nothing was installed.");
        await handle.write(chunk);
        const now = Date.now();
        if (now - reported > 250) { reported = now; progress(done); }
      }
      await handle.close();
      handle = undefined;
      if (done !== bytes) throw new Error("The download ended early. Start it again to resume where it stopped.");
      fs.renameSync(partial, destination);
      progress(bytes);
    } catch (error) {
      // Prefer the real cause over the generic abort error the transport throws.
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Installation cancelled.");
      if (stall.signal.aborted) throw stall.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      await handle?.close().catch(() => undefined);
    }
  }

  /** Run one unpack or verify job on the worker thread. */
  private work(job: ExtractJob | VerifyJob, phase: InstallProgress["phase"], signal: AbortSignal, span?: { before: number; total: number }): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.options.extractScript, { workerData: job });
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve();
      };
      const abort = () => {
        void worker.terminate();
        settle(signal.reason instanceof Error ? signal.reason : new Error("Installation cancelled."));
      };
      signal.addEventListener("abort", abort, { once: true });
      worker.on("message", (message: ExtractMessage) => {
        if (message.type === "progress") {
          if (!settled) this.report(span ? { phase, done: span.before + message.done, total: span.total } : { phase, done: message.done, total: message.total });
        }
        else if (message.type === "done") settle();
        else settle(new Error(message.message));
      });
      worker.on("error", error => settle(error instanceof Error ? error : new Error(String(error))));
      worker.on("exit", code => settle(new Error(`Verifying or unpacking stopped unexpectedly (code ${code}).`)));
      if (signal.aborted) abort();
    });
  }
}
