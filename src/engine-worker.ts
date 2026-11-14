/** The speech engine. Runs either as a worker thread of the host server or, as a
 * fallback, as a separate Node.js process; the message protocol is identical.
 *
 * It owns the native sherpa-onnx addon and the loaded Nemotron model. Recognition
 * calls are synchronous and CPU-heavy, which is why none of this runs on the
 * server's own thread. Audio never leaves this process. */
import { parentPort, workerData } from "node:worker_threads";
import { SAMPLE_RATE, normalizeTranscript } from "./contract.ts";

export interface EngineLoad {
  type: "load";
  addon: string;
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
  threads: number;
  /** Chunk size of the loaded export, used to size the end-of-speech padding. */
  latencyMs: number;
}
export type EngineRequest =
  | EngineLoad
  | { type: "start"; session: string; language: string }
  | { type: "audio"; session: string; pcm: Int16Array; epoch?: number }
  | { type: "finish"; session: string }
  | { type: "cancel"; session: string }
  | { type: "shutdown" };
/** Shared with the host when running as a worker thread, so the host can be
 * heard without waiting behind queued audio:
 *   [0] non-zero: stop as soon as the current native call returns
 *   [1] audio stamped with an older epoch belongs to a cancelled session */
export interface EngineWorkerData { control: SharedArrayBuffer }
export const CONTROL_STOP = 0;
export const CONTROL_EPOCH = 1;
export type EngineReply =
  | { type: "loaded"; loadMs: number; version: string }
  | { type: "load-error"; message: string }
  | { type: "text"; session: string; text: string; processed: number }
  | { type: "done"; session: string; text: string; processed: number }
  | { type: "session-error"; session: string; message: string };

/** The subset of the sherpa-onnx 2.0.1 addon this plugin calls. */
interface Addon {
  version?: string;
  createOnlineRecognizer(config: unknown): unknown;
  createOnlineStream(recognizer: unknown): unknown;
  onlineStreamSetOption(stream: unknown, key: string, value: string): void;
  acceptWaveformOnline(stream: unknown, wave: { samples: Float32Array; sampleRate: number }): void;
  inputFinished(stream: unknown): void;
  isOnlineStreamReady(recognizer: unknown, stream: unknown): boolean;
  decodeOnlineStream(recognizer: unknown, stream: unknown): void;
  getOnlineStreamResultAsJson(recognizer: unknown, stream: unknown): string;
}
const REQUIRED: (keyof Addon)[] = [
  "createOnlineRecognizer", "createOnlineStream", "onlineStreamSetOption", "acceptWaveformOnline",
  "inputFinished", "isOnlineStreamReady", "decodeOnlineStream", "getOnlineStreamResultAsJson",
];

const reply: (message: EngineReply) => void = parentPort
  ? message => parentPort!.postMessage(message)
  : message => { process.send?.(message); };

const control = parentPort && (workerData as EngineWorkerData | null)?.control
  ? new Int32Array((workerData as EngineWorkerData).control) : undefined;
let addon: Addon | undefined;
let recognizer: unknown;
let closed = false;
let latencyMs = 560;
let active: { session: string; stream: unknown; processed: number; text: string } | undefined;

function load(request: EngineLoad): void {
  const started = Date.now();
  // process.dlopen loads exactly this file; its sibling libraries resolve through
  // the addon's own $ORIGIN / @loader_path / same-directory search.
  const loaded: { exports: Record<string, unknown> } = { exports: {} };
  process.dlopen(loaded, request.addon);
  const candidate = loaded.exports as unknown as Addon;
  for (const name of REQUIRED) {
    if (typeof candidate[name] !== "function") throw new Error(`The speech engine is missing ${name}; it does not match this plugin.`);
  }
  recognizer = candidate.createOnlineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 128 },
    modelConfig: {
      transducer: { encoder: request.encoder, decoder: request.decoder, joiner: request.joiner },
      tokens: request.tokens, numThreads: request.threads, provider: "cpu", debug: 0,
    },
    // Greedy search only ever appends to its hypothesis, which is what lets words
    // be typed at the cursor as they are recognised without later corrections.
    decodingMethod: "greedy_search",
    // No endpointing: the model writes a sentence's final punctuation together
    // with the first word of the next one, so splitting at pauses would lose it.
    enableEndpoint: false,
  });
  addon = candidate;
  latencyMs = request.latencyMs;
  reply({ type: "loaded", loadMs: Date.now() - started, version: String(candidate.version ?? "") });
}

function silence(seconds: number): Float32Array { return new Float32Array(Math.round(SAMPLE_RATE * seconds)); }

function decode(): string {
  const engine = addon!;
  const current = active!;
  while (engine.isOnlineStreamReady(recognizer, current.stream)) engine.decodeOnlineStream(recognizer, current.stream);
  const result = JSON.parse(engine.getOnlineStreamResultAsJson(recognizer, current.stream)) as { text?: unknown };
  return normalizeTranscript(typeof result.text === "string" ? result.text : "");
}

/** Leave by letting the thread (or process) run out of work. The host never
 * force-stops this thread: interrupting it inside the native library can take
 * the whole server process down, so the engine always exits on its own. */
function shutdown(): void {
  if (closed) return;
  closed = true;
  active = undefined;
  recognizer = undefined;
  if (parentPort) parentPort.close();
  else process.exit(0);
}

function handle(request: EngineRequest): void {
  if (closed) return;
  if (request.type === "shutdown" || (control && Atomics.load(control, CONTROL_STOP) !== 0)) { shutdown(); return; }
  if (request.type === "load") {
    try { load(request); }
    catch (error) { reply({ type: "load-error", message: error instanceof Error ? error.message : String(error) }); }
    return;
  }
  const engine = addon;
  if (!engine) { reply({ type: "session-error", session: request.session, message: "The speech engine is not loaded." }); return; }
  try {
    switch (request.type) {
      case "start": {
        const stream = engine.createOnlineStream(recognizer);
        // An unset option means automatic language detection.
        if (request.language !== "auto") engine.onlineStreamSetOption(stream, "language", request.language);
        // A short lead-in keeps the first syllable from landing on a cold start.
        engine.acceptWaveformOnline(stream, { samples: silence(0.3), sampleRate: SAMPLE_RATE });
        active = { session: request.session, stream, processed: 0, text: "" };
        break;
      }
      case "audio": {
        if (active?.session !== request.session) return; // late audio for a closed session
        // Skip a cancelled session's backlog instead of transcribing it first.
        if (control && request.epoch !== undefined && request.epoch < Atomics.load(control, CONTROL_EPOCH)) return;
        const pcm = request.pcm;
        const samples = new Float32Array(pcm.length);
        for (let index = 0; index < pcm.length; index++) samples[index] = pcm[index]! / 32768;
        // The sample rate must never change within a stream: the native library
        // treats that as fatal. Callers always deliver 16 kHz.
        engine.acceptWaveformOnline(active.stream, { samples, sampleRate: SAMPLE_RATE });
        active.text = decode();
        active.processed += pcm.length;
        reply({ type: "text", session: active.session, text: active.text, processed: active.processed });
        break;
      }
      case "finish": {
        if (active?.session !== request.session) return;
        // The streaming encoder needs its look-ahead filled before it will emit
        // the last words; trailing silence supplies it.
        engine.acceptWaveformOnline(active.stream, { samples: silence(latencyMs / 1000 + 0.5), sampleRate: SAMPLE_RATE });
        engine.inputFinished(active.stream);
        const text = decode();
        const processed = active.processed;
        active = undefined;
        reply({ type: "done", session: request.session, text, processed });
        break;
      }
      case "cancel":
        if (active?.session === request.session) active = undefined;
        break;
    }
  } catch (error) {
    if (active?.session === request.session) active = undefined;
    reply({ type: "session-error", session: request.session, message: error instanceof Error ? error.message : String(error) });
  }
}

if (parentPort) {
  parentPort.on("message", handle);
} else if (typeof process.send === "function") {
  process.on("message", message => handle(message as EngineRequest));
  // The engine has no reason to outlive the server that started it.
  process.on("disconnect", () => process.exit(0));
}
