/** Worker thread: verify and unpack one pinned package without blocking the host
 * server. Decompression is CPU-bound, so it must not run on the server's thread.
 *
 * Only whitelisted regular files are written, each under its own fixed name in a
 * fresh private directory, so archive contents cannot choose a destination. The
 * package digest and every file digest must match before success is reported. */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHash, type Hash } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import unbzip2 from "unbzip2-stream";
import { TarReader, type TarSink } from "./tar.ts";

export interface ExtractJob {
  archive: string;
  format: "tar.bz2" | "tgz";
  digest: { algorithm: "sha256" | "sha512"; encoding: "hex" | "base64"; expected: string };
  /** Directory inside the archive that holds the wanted files, e.g. "package/". */
  prefix: string;
  files: { name: string; bytes?: number; sha256?: string }[];
  /** Must not exist yet; created here and removed again on any failure. */
  destination: string;
}
export type ExtractMessage =
  | { type: "progress"; done: number; total: number }
  | { type: "done" }
  | { type: "error"; message: string };

function post(message: ExtractMessage): void { parentPort!.postMessage(message); }

async function extract(job: ExtractJob): Promise<void> {
  const wanted = new Map(job.files.map(file => [job.prefix + file.name, file] as const));
  const written = new Map<string, { bytes: number; sha256: string }>();
  fs.mkdirSync(job.destination, { recursive: false, mode: 0o700 });

  const tar = new TarReader((name, _size): TarSink | undefined => {
    const file = wanted.get(name);
    if (!file) return undefined;
    if (written.has(file.name)) throw new Error(`Package lists ${file.name} more than once.`);
    // "wx": never follow or overwrite anything that is already there.
    const descriptor = fs.openSync(path.join(job.destination, file.name), "wx", 0o644);
    const hash: Hash = createHash("sha256");
    let bytes = 0;
    return {
      write(chunk) { fs.writeSync(descriptor, chunk); hash.update(chunk); bytes += chunk.length; },
      end() { fs.closeSync(descriptor); written.set(file.name, { bytes, sha256: hash.digest("hex") }); },
    };
  });

  const total = fs.statSync(job.archive).size;
  const digest = createHash(job.digest.algorithm);
  let done = 0;
  let reported = 0;
  await new Promise<void>((resolve, reject) => {
    const source = fs.createReadStream(job.archive, { highWaterMark: 1 << 20 });
    const inflate: NodeJS.ReadWriteStream = job.format === "tgz" ? zlib.createGunzip() : unbzip2();
    let failed = false;
    const fail = (error: unknown) => {
      if (failed) return;
      failed = true;
      source.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    source.on("data", chunk => {
      const buffer = chunk as Buffer;
      digest.update(buffer);
      done += buffer.length;
      const now = Date.now();
      if (now - reported > 250) { reported = now; post({ type: "progress", done, total }); }
    });
    source.on("error", fail);
    inflate.on("error", fail);
    inflate.on("data", chunk => { try { tar.push(chunk as Buffer); } catch (error) { fail(error); } });
    inflate.on("end", () => { try { tar.end(); resolve(); } catch (error) { fail(error); } });
    source.pipe(inflate);
  });

  if (digest.digest(job.digest.encoding) !== job.digest.expected) {
    throw new Error("The downloaded package does not match its published checksum. It was not installed.");
  }
  for (const file of job.files) {
    const result = written.get(file.name);
    if (!result) throw new Error(`The package is missing ${file.name}.`);
    if (file.bytes !== undefined && result.bytes !== file.bytes) throw new Error(`${file.name} has an unexpected size.`);
    if (file.sha256 !== undefined && result.sha256 !== file.sha256) throw new Error(`${file.name} does not match its expected checksum.`);
  }
  post({ type: "progress", done: total, total });
}

if (parentPort) {
  const job = workerData as ExtractJob;
  extract(job).then(
    () => post({ type: "done" }),
    error => {
      try { fs.rmSync(job.destination, { recursive: true, force: true }); } catch { /* best effort */ }
      post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    },
  );
}
