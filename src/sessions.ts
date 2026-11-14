/** One live dictation at a time for the whole server: a microphone has one owner.
 *
 * The frontend pushes audio through the JSON bridge and each response carries any
 * newly recognised text, so transcript delivery is plain request/response and
 * does not depend on best-effort notifications. */
import { randomUUID } from "node:crypto";
import {
  MAX_LAG_MS, MAX_PUSH_BASE64, MAX_SESSION_MS, SAMPLE_RATE, SESSION_IDLE_MS,
  extendTranscript, type SessionUpdate,
} from "./contract.ts";
import type { EngineConfig } from "./engine-host.ts";
import type { EngineReply, EngineRequest } from "./engine-worker.ts";

type EndReason = NonNullable<SessionUpdate["reason"]>;
interface Session {
  id: string;
  owner: string;
  createdAt: number;
  seenAt: number;
  state: SessionUpdate["state"];
  reason?: EndReason;
  error?: string;
  text: string;
  /** Samples accepted from the frontend and samples the engine has transcribed. */
  received: number;
  processed: number;
  /** Audio that arrived while the model was still loading. */
  queue: Int16Array[];
  started: boolean;
  /** Set once a final flush has been requested; resolves when the session ends. */
  finishing?: { promise: Promise<void>; resolve(): void; reason: EndReason };
}
export interface SessionEngine {
  ensure(config: EngineConfig): Promise<void>;
  post(request: EngineRequest, transfer?: ArrayBuffer[]): void;
  keepAlive(): void;
}
export interface SessionsOptions {
  engine: SessionEngine;
  /** Current engine configuration and language; throws when nothing is installed.
   * `requested` is the language the caller asked for, if any. */
  configuration(requested: unknown): { config: EngineConfig; language: string };
  now?: () => number;
}
const ENDED_RETENTION_MS = 60_000;
const FINISH_TIMEOUT_MS = 30_000;

function decodeAudio(value: unknown): Int16Array | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > MAX_PUSH_BASE64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("Invalid audio chunk.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length % 2 !== 0) throw new Error("Invalid audio chunk.");
  // Copy into its own buffer: it is transferred to the engine thread.
  const pcm = new Int16Array(bytes.length / 2);
  for (let index = 0; index < pcm.length; index++) pcm[index] = bytes.readInt16LE(index * 2);
  return pcm;
}

export class Sessions {
  private current: Session | undefined;
  private readonly ended = new Map<string, Session>();
  private readonly watchdog: ReturnType<typeof setInterval>;
  private readonly now: () => number;

  constructor(private readonly options: SessionsOptions) {
    this.now = options.now ?? Date.now;
    this.watchdog = setInterval(() => this.watch(), 2_000);
    this.watchdog.unref?.();
  }

  get active(): boolean { return this.current !== undefined; }

  start(owner: unknown, requestedLanguage?: unknown): SessionUpdate {
    if (typeof owner !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(owner)) throw new Error("Invalid dictation owner.");
    if (this.current) {
      if (this.current.owner !== owner) throw new Error("Dictation is already running in another window.");
      this.cancelSession(this.current, "cancelled");
    }
    const { config, language } = this.options.configuration(requestedLanguage);
    const now = this.now();
    const session: Session = {
      id: randomUUID(), owner, createdAt: now, seenAt: now, state: "loading",
      text: "", received: 0, processed: 0, queue: [], started: false,
    };
    this.current = session;
    this.options.engine.ensure(config).then(() => {
      if (this.current !== session) return;
      this.options.engine.post({ type: "start", session: session.id, language });
      session.started = true;
      session.state = "listening";
      for (const pcm of session.queue.splice(0)) this.sendAudio(session, pcm);
      if (session.finishing) this.options.engine.post({ type: "finish", session: session.id });
    }, error => this.end(session, "error", error instanceof Error ? error.message : String(error)));
    return this.update(session, 0);
  }

  push(id: unknown, audio: unknown, have: unknown): SessionUpdate {
    const session = this.find(id);
    session.seenAt = this.now();
    if (session.state !== "ended" && !session.finishing) this.accept(session, decodeAudio(audio));
    return this.update(session, have);
  }

  /** Flush the remaining audio and resolve with the last words. */
  async finish(id: unknown, audio: unknown, have: unknown): Promise<SessionUpdate> {
    const session = this.find(id);
    session.seenAt = this.now();
    if (session.state !== "ended") {
      if (!session.finishing) this.accept(session, decodeAudio(audio));
      await this.flush(session, "finished");
    }
    return this.update(session, have);
  }

  cancel(id: unknown): SessionUpdate {
    const session = this.find(id);
    if (session.state !== "ended") this.cancelSession(session, "cancelled");
    return this.update(session, session.text.length);
  }

  /** Route an engine reply to the session it belongs to. */
  reply(reply: EngineReply): void {
    const session = this.current;
    if (reply.type === "loaded" || reply.type === "load-error" || !session || reply.session !== session.id) return;
    if (reply.type === "session-error") { this.end(session, "error", reply.message); return; }
    session.text = extendTranscript(session.text, reply.text);
    session.processed = reply.processed;
    if (reply.type === "done") this.end(session, session.finishing?.reason ?? "finished");
  }

  engineStopped(message: string): void {
    if (this.current) this.end(this.current, "error", message);
  }

  dispose(): void {
    clearInterval(this.watchdog);
    if (this.current) this.cancelSession(this.current, "cancelled");
    this.ended.clear();
  }

  private find(id: unknown): Session {
    const session = typeof id === "string" ? (this.current?.id === id ? this.current : this.ended.get(id)) : undefined;
    if (!session) throw new Error("This dictation session no longer exists.");
    return session;
  }

  private accept(session: Session, pcm: Int16Array | undefined): void {
    if (!pcm?.length) return;
    session.received += pcm.length;
    if (session.started) this.sendAudio(session, pcm);
    else session.queue.push(pcm);
    if (this.lagMs(session) > MAX_LAG_MS) {
      this.cancelSession(session, "too-slow", session.started
        ? "This computer cannot transcribe as fast as you speak with the current settings. Try a larger responsiveness step or more CPU threads."
        : "The speech model took too long to load.");
    }
  }

  private sendAudio(session: Session, pcm: Int16Array): void {
    this.options.engine.post({ type: "audio", session: session.id, pcm }, [pcm.buffer as ArrayBuffer]);
    this.options.engine.keepAlive();
  }

  private flush(session: Session, reason: EndReason): Promise<void> {
    if (!session.finishing) {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      session.finishing = { promise, resolve, reason };
      if (session.started) this.options.engine.post({ type: "finish", session: session.id });
      // The backlog still has to be transcribed before the flush can complete.
      const timer = setTimeout(() => {
        if (session.state !== "ended") this.cancelSession(session, "error", "Finishing dictation timed out.");
      }, FINISH_TIMEOUT_MS + this.lagMs(session));
      timer.unref?.();
      void promise.then(() => clearTimeout(timer));
    }
    return session.finishing.promise;
  }

  private cancelSession(session: Session, reason: EndReason, error?: string): void {
    if (session.started) this.options.engine.post({ type: "cancel", session: session.id });
    this.end(session, reason, error);
  }

  private end(session: Session, reason: EndReason, error?: string): void {
    if (session.state === "ended") return;
    session.state = "ended";
    session.reason = reason;
    if (error !== undefined) session.error = error;
    session.queue = [];
    if (this.current === session) this.current = undefined;
    // Keep the result briefly so a request already in flight still gets its text.
    this.ended.set(session.id, session);
    const timer = setTimeout(() => this.ended.delete(session.id), ENDED_RETENTION_MS);
    timer.unref?.();
    session.finishing?.resolve();
    this.options.engine.keepAlive();
  }

  private watch(): void {
    const session = this.current;
    if (!session) return;
    const now = this.now();
    if (now - session.seenAt > SESSION_IDLE_MS) this.cancelSession(session, "idle");
    else if (now - session.createdAt > MAX_SESSION_MS && !session.finishing) void this.flush(session, "limit");
  }

  private lagMs(session: Session): number {
    return Math.max(0, session.received - session.processed) / (SAMPLE_RATE / 1000);
  }

  private update(session: Session, have: unknown): SessionUpdate {
    const offset = typeof have === "number" && Number.isInteger(have) && have >= 0 ? Math.min(have, session.text.length) : 0;
    const update: SessionUpdate = {
      session: session.id, state: session.state, text: session.text.slice(offset),
      length: session.text.length, lagMs: Math.round(this.lagMs(session)),
    };
    if (session.reason) update.reason = session.reason;
    if (session.error) update.error = session.error;
    return update;
  }
}
