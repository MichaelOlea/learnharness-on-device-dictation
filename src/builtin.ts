/** Drop-in engine for LearnHarness's own Dictate button.
 *
 * The built-in dictation (LearnHarness 0.6.1, components/dictation.tsx) works
 * like this: it fetches a short-lived Deepgram token from `/api/stt/token`,
 * opens `wss://api.deepgram.com/v1/listen?...encoding=linear16&sample_rate=16000`
 * from the window, streams 16-bit PCM frames, collects `Results` messages whose
 * `is_final` is true, and on stop sends `{"type":"CloseStream"}` and waits (at
 * most three seconds) for the socket to close normally before typing the text.
 *
 * LearnHarness has no setting or plugin API to choose another speech engine, so
 * this module answers those two requests locally instead: the token request gets
 * a placeholder, and the Deepgram socket is replaced by an object that speaks
 * the same small protocol but sends the audio to this plugin's on-device engine.
 * Nothing is sent to Deepgram, and no Deepgram key is needed. Every other fetch
 * and WebSocket in the window is passed through untouched.
 *
 * This depends on how one LearnHarness version talks to Deepgram. If a later
 * version changes that, the checks below decline to step in and say so. */
import { MAX_PUSH_BASE64, SAMPLE_RATE, mapHostLanguage, type SessionUpdate } from "./contract.ts";

export interface BuiltinHost {
  /** Whether the replacement is switched on, as far as is known right now. */
  enabled(): boolean;
  /** The same, but waiting (briefly) for the saved setting if it is not loaded yet. */
  decided(): Promise<boolean>;
  /** Whether the speech engine and model are installed. */
  installed(): Promise<boolean>;
  call<T>(operation: string, input?: unknown): Promise<T>;
  /** This window's session-owner token. */
  owner: string;
  /** Nothing is installed yet: explain and offer the download. */
  setUp(): void;
  /** Tell the learner something the built-in controls have no place for. */
  note(text: string, options?: { tone?: "error" | "info"; copy?: string }): void;
  /** Words recognised only after LearnHarness had already typed the rest. */
  late(text: string): void;
}

const TOKEN_PATH = "/api/stt/token";
const LOCAL_TOKEN = "on-device-dictation";
/** LearnHarness gives up waiting three seconds after it asks to stop. */
const STOP_GRACE_MS = 2_600;
/** Audio held while a request is in flight; beyond this the oldest is dropped. */
const MAX_HELD_SAMPLES = SAMPLE_RATE * 30;

/** A socket opened with the placeholder token can only be meant for us. */
function carriesLocalToken(protocols: unknown): boolean {
  return Array.isArray(protocols) ? protocols.includes(LOCAL_TOKEN) : protocols === LOCAL_TOKEN;
}
function isListenUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value));
    return url.protocol === "wss:" && url.hostname === "api.deepgram.com" && url.pathname === "/v1/listen";
  } catch { return false; }
}
function isTokenRequest(view: Window, input: RequestInfo | URL, init: RequestInit | undefined): boolean {
  const request = typeof Request === "function" && input instanceof Request ? input : undefined;
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  if (method !== "GET") return false;
  const url = new URL(request ? request.url : String(input), view.location.href);
  return url.origin === view.location.origin && url.pathname === TOKEN_PATH;
}
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function toBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
function concat(blocks: Int16Array[]): Int16Array {
  const merged = new Int16Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let offset = 0;
  for (const block of blocks) { merged.set(block, offset); offset += block.length; }
  return merged;
}
/** Copy a sent frame into our own 16-bit view (the caller may reuse its buffer). */
function toPcm(data: unknown): Int16Array | undefined {
  let bytes: Uint8Array;
  if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else return undefined;
  const pcm = new Int16Array(bytes.byteLength >> 1);
  new Uint8Array(pcm.buffer).set(bytes.subarray(0, pcm.byteLength));
  return pcm;
}
/** The one message shape LearnHarness reads: a final transcript. */
function resultsMessage(transcript: string): string {
  return JSON.stringify({
    type: "Results", channel_index: [0, 1], is_final: true, speech_final: true, from_finalize: false,
    channel: { alternatives: [{ transcript, confidence: 1, words: [] }] },
    metadata: { model_info: { name: "nemotron-3.5-asr-streaming-0.6b (on-device)" } },
  });
}

/** Stands in for the Deepgram WebSocket of one dictation run. */
export class LocalDictationSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  binaryType: BinaryType = "blob";
  readonly bufferedAmount = 0;
  readonly extensions = "";
  readonly protocol = "bearer";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  private session: string | undefined;
  private readonly started: Promise<void>;
  private blocks: Int16Array[] = [];
  private samples = 0;
  private pumping = false;
  /** Everything recognised so far, and how much of it LearnHarness has been given. */
  private transcript = "";
  private delivered = 0;
  private have = 0;
  private finishing = false;
  private done = false;

  constructor(readonly url: string, private readonly host: BuiltinHost) {
    super();
    // Give the caller the chance to attach its listeners first, like a real socket.
    this.started = new Promise<void>(resolve => setTimeout(resolve, 0)).then(() => this.begin());
  }

  send(data: unknown): void {
    if (this.readyState === 0) throw new DOMException("Still in CONNECTING state.", "InvalidStateError");
    if (this.readyState !== 1 || this.done || this.finishing) return;
    if (typeof data === "string") {
      let type: unknown;
      try { type = (JSON.parse(data) as { type?: unknown }).type; } catch { return; }
      // KeepAlive and Finalize need no answer here.
      if (type === "CloseStream") void this.finish();
      return;
    }
    const pcm = toPcm(data);
    if (!pcm?.length) return;
    this.blocks.push(pcm);
    this.samples += pcm.length;
    while (this.samples > MAX_HELD_SAMPLES && this.blocks.length > 1) this.samples -= this.blocks.shift()!.length;
    void this.pump();
  }

  /** The caller abandons the run (cancel, navigation): discard unfinished speech. */
  close(): void {
    if (this.done) return;
    this.release();
    this.finalize(1005, false);
  }

  private async begin(): Promise<void> {
    if (this.done) return;
    const parameters = new URL(this.url).searchParams;
    const known = parameters.get("encoding") === "linear16" && parameters.get("sample_rate") === String(SAMPLE_RATE) &&
      (parameters.get("channels") ?? "1") === "1";
    let installed = false;
    let failure: string | undefined;
    if (!known) failure = "This LearnHarness version sends dictation audio in a format On-device dictation does not know. Update the plugin, or turn off “Replace built-in dictation” in its settings.";
    else {
      try { installed = await this.host.installed(); }
      catch (error) { failure = `On-device dictation is unavailable: ${describe(error)}`; }
    }
    if (this.done) return;
    this.readyState = 1;
    this.dispatch(new Event("open"));
    if (this.done) return;
    if (failure !== undefined) { this.end(failure); return; }
    if (!installed) {
      // End the run quietly (no error on the button) and show what is needed.
      this.host.setUp();
      this.end();
      return;
    }
    try {
      const update = await this.host.call<SessionUpdate>("session-start", {
        owner: this.host.owner, language: mapHostLanguage(parameters.get("language")),
      });
      if (this.done) { void this.host.call("session-cancel", { session: update.session }).catch(() => undefined); return; }
      this.session = update.session;
      this.apply(update);
      void this.pump();
    } catch (error) { this.end(describe(error)); }
  }

  /** Send held audio in order, one request at a time; replies carry new text. */
  private async pump(): Promise<void> {
    if (this.pumping || !this.session) return;
    this.pumping = true;
    try {
      while (!this.done && !this.finishing && this.samples > 0) {
        const limit = Math.floor(MAX_PUSH_BASE64 / 4) * 3 / 2; // samples that fit one request
        const batch: Int16Array[] = [];
        let size = 0;
        while (this.blocks.length && (batch.length === 0 || size + this.blocks[0]!.length <= limit)) {
          const block = this.blocks.shift()!;
          batch.push(block);
          size += block.length;
        }
        this.samples -= size;
        this.apply(await this.host.call<SessionUpdate>("session-push", { session: this.session, audio: toBase64(concat(batch)), have: this.have }));
      }
    } catch (error) {
      if (!this.done) this.end(`Dictation stopped: ${describe(error)}`);
    } finally { this.pumping = false; }
  }

  private apply(update: SessionUpdate): void {
    if (update.text) {
      this.transcript += update.text;
      this.have = update.length;
      if (!this.done) this.deliver(false);
    }
    if (update.state === "ended" && !this.finishing && !this.done) {
      this.end(update.reason === "limit" ? "Dictation stopped after 20 minutes." : update.error ?? "Dictation stopped.", update.reason === "limit" ? "info" : "error");
    }
  }

  /** Hand finished text to LearnHarness as Deepgram-style finals. LearnHarness
   * joins finals with single spaces, so text is only ever cut at a space, and
   * the newest word is held back: the model attaches a sentence's punctuation
   * to it later, together with the next word. */
  private deliver(everything: boolean): void {
    const end = everything ? this.transcript.length : this.transcript.trimEnd().lastIndexOf(" ");
    if (end <= this.delivered) return;
    const chunk = this.transcript.slice(this.delivered, end).trim();
    this.delivered = everything ? end : end + 1;
    if (chunk) this.dispatch(new MessageEvent("message", { data: resultsMessage(chunk) }));
  }

  /** LearnHarness asked to stop and keep the text: flush, deliver, close normally. */
  private async finish(): Promise<void> {
    if (this.finishing || this.done) return;
    this.finishing = true;
    let failure: string | undefined;
    const flushed = (async () => {
      await this.started;
      while (this.pumping) await new Promise(resolve => setTimeout(resolve, 15));
      if (!this.session) return;
      const pcm = concat(this.blocks.splice(0));
      this.samples = 0;
      const update = await this.host.call<SessionUpdate>("session-finish", {
        session: this.session, audio: pcm.length ? toBase64(pcm) : "", have: this.have,
      });
      if (update.text) { this.transcript += update.text; this.have = update.length; }
      if (update.reason === "error" || update.reason === "too-slow") failure = update.error ?? "Dictation stopped.";
    })().catch(error => { failure = `Dictation stopped: ${describe(error)}`; });
    const inTime = await Promise.race([
      flushed.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), STOP_GRACE_MS)),
    ]);
    if (this.done) return; // cancelled while flushing
    this.deliver(true);
    const sent = this.delivered;
    this.finalize(1000, true);
    if (!inTime) {
      // LearnHarness would have stopped waiting; close in time and hand over
      // whatever arrives afterwards separately instead of losing it.
      await flushed;
      const late = this.transcript.slice(sent).trim();
      if (late) this.host.late(late);
    }
    if (failure !== undefined) this.host.note(failure, { tone: "error" });
  }

  /** End the run from this side, keeping the text recognised so far. */
  private end(note?: string, tone: "error" | "info" = "error"): void {
    if (this.done) return;
    this.deliver(true);
    this.release();
    this.finalize(1000, true);
    if (note !== undefined) this.host.note(note, { tone });
  }

  private release(): void {
    const session = this.session;
    this.session = undefined;
    this.blocks = [];
    this.samples = 0;
    if (session) void this.host.call("session-cancel", { session }).catch(() => undefined);
  }

  private finalize(code: number, wasClean: boolean): void {
    if (this.done) return;
    this.done = true;
    this.readyState = 3;
    const event = typeof CloseEvent === "function"
      ? new CloseEvent("close", { code, wasClean, reason: "" })
      : Object.assign(new Event("close"), { code, wasClean, reason: "" });
    setTimeout(() => this.dispatch(event), 0);
  }

  private dispatch(event: Event): void {
    const handler = (this as unknown as Record<string, unknown>)[`on${event.type}`];
    if (typeof handler === "function") { try { (handler as (event: Event) => void).call(this, event); } catch { /* a listener's own problem */ } }
    this.dispatchEvent(event);
  }
}

/** Start answering LearnHarness's Deepgram requests locally. Returns the undo. */
export function installBuiltinReplacement(view: Window & typeof globalThis, host: BuiltinHost): () => void {
  const nativeFetch = view.fetch;
  const NativeWebSocket = view.WebSocket;
  let active = true;

  const patchedFetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let token = false;
    try { token = active && isTokenRequest(view, input, init); } catch { token = false; }
    if (!token) return nativeFetch.call(view, input, init);
    // LearnHarness asks for a token as soon as a page mounts, possibly before
    // this plugin has read its settings, so wait for them rather than guess.
    return host.decided().catch(() => false).then(local => active && local
      ? new Response(JSON.stringify({ token: LOCAL_TOKEN }), { status: 200, headers: { "Content-Type": "application/json" } })
      : nativeFetch.call(view, input, init));
  } as typeof fetch;

  // A proxy keeps everything about the real class (constants, prototype,
  // instanceof) and only changes what `new` returns for the Deepgram address.
  const PatchedWebSocket: typeof WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args: unknown[], newTarget): object {
      if (active && isListenUrl(args[0]) && (host.enabled() || carriesLocalToken(args[1]))) return new LocalDictationSocket(String(args[0]), host);
      return Reflect.construct(target, args, newTarget === PatchedWebSocket ? target : newTarget) as object;
    },
  });

  view.fetch = patchedFetch;
  view.WebSocket = PatchedWebSocket;
  return () => {
    active = false; // inert even if something else wrapped these after us
    if (view.fetch === patchedFetch) view.fetch = nativeFetch;
    if (view.WebSocket === PatchedWebSocket) view.WebSocket = NativeWebSocket;
  };
}
