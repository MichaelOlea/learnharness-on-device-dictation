/** Frontend entry. One activation per LearnHarness window.
 *
 * Main job: make LearnHarness's own Dictate button transcribe on this computer
 * (src/builtin.ts). Optional extra: a separate button and shortcut that types
 * words live at the caret, with its own microphone capture and indicator. */
import type {
  PluginAction, PluginActionContext, PluginFrontendContext, PluginSubmission,
} from "learnharness-plugin-api";
import { installBuiltinReplacement } from "./builtin.ts";
import { startCapture, type Capture } from "./capture.ts";
import { MAX_PUSH_BASE64, type SessionUpdate, type Status } from "./contract.ts";
import { Hud } from "./hud.ts";
import { FocusMemory, Inserter, appendAtEnd } from "./insert.ts";
import { mountSettings, openSetupDialog, type StatusStore } from "./panel.ts";
import { appendDictation } from "./submission.ts";

const MICROPHONE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>';
/** Audio is sent in blocks of at least this long (in samples at 16 kHz). */
const MIN_BLOCK = 1_600;
/** How long a submission may wait for the last words before going out as it is. */
const SUBMIT_WAIT_MS = 2_500;
const DETAIL_TAIL = 72;

function toBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
function concat(blocks: Int16Array[]): Int16Array {
  const merged = new Int16Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let offset = 0;
  for (const block of blocks) { merged.set(block, offset); offset += block.length; }
  return merged;
}
function tail(text: string): string {
  return text.length > DETAIL_TAIL ? `…${text.slice(-DETAIL_TAIL)}` : text;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
/** A per-window owner token; randomUUID needs a secure context, so fall back. */
function ownerToken(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}

interface Live {
  owner: string;
  inserter: Inserter;
  capture?: Capture;
  /** Assigned once the backend has accepted the session. */
  session?: string;
  /** Audio captured but not yet sent. */
  blocks: Int16Array[];
  samples: number;
  /** Transcript characters already received from the backend. */
  have: number;
  pumping: boolean;
  phase: "starting" | "listening" | "finishing" | "over";
  lastTextAt: number;
  /** While a submission is being prepared, new words are collected here for the
   * outgoing message instead of being typed into the field. */
  diverted?: string;
  /** Resolves when the session is completely over. */
  over: Promise<void>;
  settle(): void;
}

export function activate(ctx: PluginFrontendContext): () => void {
  const signal = ctx.signal;
  let disposed = false;
  let live: Live | undefined;
  let settings: Status["settings"] | undefined;
  /** One owner per window: starting a dictation replaces this window's previous one. */
  const owner = ownerToken();

  /* ---- status shared by the action, the dialog and the settings page ---- */
  let status: Status | undefined;
  const listeners = new Set<(status: Status) => void>();
  const store: StatusStore = {
    current: () => status,
    publish(next) {
      if (disposed) return;
      status = next;
      settings = next.settings;
      offerLiveButton(next.settings.liveButton);
      warmUp(next);
      for (const listener of [...listeners]) listener(next);
    },
    async refresh() {
      const next = await ctx.call<Status>("status");
      store.publish(next);
      return next;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const reread = () => { void store.refresh().catch(() => undefined); };
  /** Load the model once per window (and once after installing), so the first
   * dictation does not have to wait for it. Idle unloading still applies later. */
  let warmed = false;
  function warmUp(current: Status): void {
    const installed = current.platform.supported && current.engineInstalled && current.modelInstalled;
    if (!installed) { warmed = false; return; }
    if (warmed || !current.settings.replaceBuiltIn || !current.settings.preload) return;
    warmed = true;
    if (current.engine.state === "unloaded") void ctx.call<Status>("warm").then(next => store.publish(next), () => undefined);
  }
  /** The first read of the saved settings; requests that depend on them wait for it. */
  const firstStatus: Promise<unknown> = Promise.resolve().then(() => store.refresh()).catch(() => undefined);

  /* ---- floating indicator and caret tracking ---- */
  const hud = new Hud(document, {
    done: () => { void finish(); },
    cancel: () => { void cancel(); },
    dismiss: () => hud.hide(),
    async copy(text) {
      try { await navigator.clipboard.writeText(text); hud.copied(); }
      catch { hud.message("Copying was blocked. Select the text in the field instead.", { tone: "error" }); }
    },
  });
  const focus = new FocusMemory(document, element => hud.root.contains(element));
  const onFocus = () => {
    if (!live || live.phase === "over") return;
    const found = focus.current();
    if (found?.focused) { live.inserter.adopt(found.element); live.inserter.flush(); showDetail(live); }
  };
  document.addEventListener("focusin", onFocus);

  function showDetail(session: Live): void {
    if (session.phase !== "listening") return;
    const waiting = session.inserter.unplaced;
    hud.setDetail(waiting ? tail(waiting) : session.inserter.element ? "" : "Click into a text field");
  }

  /* ---- session lifecycle ---- */
  function over(session: Live): void {
    if (session.phase === "over") return;
    session.phase = "over";
    session.capture?.stop();
    session.blocks = [];
    if (live === session) live = undefined;
    session.settle();
    ctx.refreshActions();
  }

  /** Close the session and say what happened to any words that found no field. */
  function conclude(session: Live, note?: { text: string; tone: "error" | "info" }): void {
    const leftover = session.inserter.takeUnplaced().trim();
    over(session);
    if (note) hud.message(leftover ? `${note.text} Not typed anywhere:` : note.text, leftover ? { tone: note.tone, copy: leftover } : { tone: note.tone });
    else if (leftover) hud.message("Dictated text that was not typed into a field:", { copy: leftover });
    else hud.hide();
  }

  function receive(session: Live, update: SessionUpdate): void {
    if (!update.text) return;
    session.have = update.length;
    session.lastTextAt = Date.now();
    if (session.diverted !== undefined) session.diverted += update.text;
    else session.inserter.add(update.text);
  }

  function apply(session: Live, update: SessionUpdate): void {
    if (session.phase === "over") return;
    receive(session, update);
    if (update.state === "ended") {
      if (session.phase === "finishing") return; // finish() reports the outcome itself
      const text = update.reason === "limit" ? "Dictation stopped after 20 minutes."
        : update.reason === "idle" ? "Dictation stopped because this window stopped sending audio."
        : update.error ?? "Dictation stopped.";
      conclude(session, { text, tone: update.reason === "limit" ? "info" : "error" });
      return;
    }
    if (session.phase !== "listening") return;
    if (update.state === "loading") hud.show("loading");
    else {
      hud.show("listening", update.lagMs > 4_000 ? "Catching up…" : "");
      if (update.lagMs <= 4_000) showDetail(session);
    }
  }

  /** Send captured audio in order, one request at a time; each reply carries text. */
  async function pump(session: Live): Promise<void> {
    if (session.pumping || !session.session) return;
    session.pumping = true;
    try {
      while (session.phase === "listening" && session.samples >= MIN_BLOCK) {
        const pcm = concat(session.blocks.splice(0));
        session.samples = 0;
        const update = await ctx.call<SessionUpdate>("session-push", { session: session.session, audio: toBase64(pcm), have: session.have });
        apply(session, update);
      }
    } catch (error) {
      if (session.phase !== "over") {
        // The server may still hold the session; release it and report.
        void ctx.call("session-cancel", { session: session.session }).catch(() => undefined);
        conclude(session, { text: `Dictation stopped: ${message(error)}`, tone: "error" });
      }
    } finally {
      session.pumping = false;
    }
    const idleFor = settings?.autoStopSeconds ?? 0;
    if (session.phase === "listening" && idleFor > 0 && Date.now() - session.lastTextAt > idleFor * 1000) void finish();
  }

  async function start(): Promise<void> {
    if (disposed || live) return;
    let current: Status;
    try { current = status ?? await store.refresh(); }
    catch (error) { hud.message(`Dictation is unavailable: ${message(error)}`, { tone: "error" }); return; }
    if (!current.platform.supported || !current.engineInstalled || !current.modelInstalled) {
      // Re-read once: the files may have been installed from another window.
      current = await store.refresh().catch(() => current);
      if (!current.platform.supported || !current.engineInstalled || !current.modelInstalled) {
        openSetupDialog(ctx, store, signal, { label: "Start dictating", run: () => { void start(); } });
        return;
      }
    }

    const found = focus.current();
    // A toolbar click moved focus to the button; give the caret back to the field.
    if (found && !found.focused) found.element.focus({ preventScroll: true });
    let settle!: () => void;
    const done = new Promise<void>(resolve => { settle = resolve; });
    const session: Live = {
      owner, inserter: new Inserter(found?.element), blocks: [], samples: 0, have: 0,
      pumping: false, phase: "starting", lastTextAt: Date.now(), over: done, settle,
    };
    live = session;
    ctx.refreshActions();
    hud.show("starting");

    // Open the microphone and the server session together so no speech is lost
    // while the other is still starting; captured audio simply queues up.
    const capturing = startCapture(new URL("./assets/pcm-worklet.js", import.meta.url), {
      samples(pcm, level) {
        if (session.phase === "over" || session.phase === "finishing") return;
        // Roughly one request's worth of headroom; beyond that the server is gone.
        if (session.samples * 2 * 1.4 > MAX_PUSH_BASE64) return;
        session.blocks.push(pcm);
        session.samples += pcm.length;
        hud.level(level);
        void pump(session);
      },
      lost(text) { if (session.phase !== "over") void finish(text); },
    });
    const opening = ctx.call<SessionUpdate>("session-start", { owner: session.owner });
    const [captured, opened] = await Promise.allSettled([capturing, opening]);
    if (captured.status === "fulfilled") session.capture = captured.value;
    if (opened.status === "fulfilled") session.session = opened.value.session;

    if (session.phase === "over" || disposed || captured.status === "rejected" || opened.status === "rejected") {
      // Something failed or the learner cancelled meanwhile: release both halves.
      session.capture?.stop();
      if (session.session) void ctx.call("session-cancel", { session: session.session }).catch(() => undefined);
      const reason = captured.status === "rejected" ? captured.reason : opened.status === "rejected" ? opened.reason : undefined;
      const wasOver = session.phase === "over";
      over(session);
      if (reason !== undefined && !wasOver && !disposed) hud.message(message(reason), { tone: "error" });
      else if (!wasOver) hud.hide();
      return;
    }
    session.phase = "listening";
    session.lastTextAt = Date.now();
    apply(session, opened.value);
    void pump(session);
  }

  /** Stop listening, wait for the last words and type them. */
  async function finish(note?: string): Promise<void> {
    const session = live;
    if (!session) return;
    if (session.phase === "starting") { await cancel(); return; }
    if (session.phase !== "listening") { await session.over; return; }
    session.phase = "finishing";
    session.capture?.stop();
    hud.show("finishing");
    ctx.refreshActions();
    let failure: string | undefined;
    try {
      // Let an in-flight push land first so audio stays in order.
      while (session.pumping) await new Promise(resolve => setTimeout(resolve, 15));
      if ((session.phase as Live["phase"]) === "over") return; // that push failed and already reported it
      const pcm = concat(session.blocks.splice(0));
      session.samples = 0;
      const update = await ctx.call<SessionUpdate>("session-finish", {
        session: session.session, audio: pcm.length ? toBase64(pcm) : "", have: session.have,
      });
      receive(session, update);
      if (update.reason === "error" || update.reason === "too-slow") failure = update.error ?? "Dictation stopped.";
    } catch (error) { failure = `Dictation stopped: ${message(error)}`; }
    // A submission in progress takes the last words and reports the outcome.
    if (session.diverted !== undefined) { over(session); return; }
    const text = failure ?? note;
    conclude(session, text ? { text, tone: "error" } : undefined);
  }

  /** Stop without waiting for unfinished words. Text already typed stays. */
  async function cancel(): Promise<void> {
    const session = live;
    if (!session || session.phase === "over") return;
    const id = session.session;
    over(session);
    hud.hide();
    if (id) await ctx.call("session-cancel", { session: id }).catch(() => undefined);
  }

  /* ---- finishing before a message is sent ---- */
  /** When the learner sends while still dictating, stop the microphone and include
   * the words that had not reached the field yet. Any failure passes the
   * submission through untouched: sending a message must never break. */
  async function onSubmit(input: PluginSubmission): Promise<PluginSubmission | undefined> {
    const session = live;
    if (!session || session.phase !== "listening") return undefined;
    try {
      session.diverted = "";
      const finished = finish();
      const completed = await Promise.race([
        finished.then(() => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), SUBMIT_WAIT_MS)),
      ]);
      const words = session.diverted ?? "";
      session.diverted = undefined;
      if (!completed) {
        // Too slow to hold the message back: send it as it is. The words gathered
        // so far, and any still to come, are typed into the field as usual.
        if (words) session.inserter.add(words);
        return undefined;
      }
      const extended = appendDictation(input, session.inserter.placed, words);
      const unsent = `${session.inserter.takeUnplaced()}${extended ? "" : words}`.trim();
      if (unsent) hud.message("These last words were not part of the message you sent:", { copy: unsent });
      else hud.hide();
      return extended;
    } catch { return undefined; }
  }

  /* ---- host registrations ---- */
  const makeAction = (defaultBinding?: string): PluginAction => ({
    id: "toggle",
    icon: MICROPHONE,
    // A getter keeps the label current; the host re-reads it on refreshActions().
    get name() { return live ? "Stop live dictation" : "Live dictation"; },
    shortcut: defaultBinding ? { scope: "app", defaultBinding } : { scope: "app" },
    disabled: () => live?.phase === "finishing",
    // Return promptly: the host shows the button as busy while this runs.
    run(_context: PluginActionContext) {
      if (!live) { void start(); return; }
      if (live.phase === "starting") { void cancel(); return; }
      void finish();
    },
  });
  const cleanups: (() => void)[] = [];

  /* The live-typing button is an opt-in extra; nothing of it exists while off. */
  let liveCleanups: (() => void)[] | undefined;
  function offerLiveButton(wanted: boolean): void {
    if (disposed || wanted === (liveCleanups !== undefined)) return;
    if (!wanted) {
      void cancel();
      liveCleanups?.splice(0).reverse().forEach(dispose => dispose());
      liveCleanups = undefined;
      return;
    }
    const registered: (() => void)[] = [];
    try { registered.push(ctx.registerAction(makeAction("mod+shift+m"))); }
    catch {
      // A refused default must not cost the learner the feature: register it
      // unbound and let them choose a shortcut in Settings → Keyboard.
      registered.push(ctx.registerAction(makeAction()));
    }
    registered.push(ctx.placeAction({ id: "session-top-bar", actionId: "toggle", location: "top-bar", sessions: ["teaching", "practice"] }));
    registered.push(ctx.placeAction({ id: "sidebar", actionId: "toggle", location: "sidebar" }));
    registered.push(ctx.registerSubmissionInterceptor({ id: "finish-dictation", intercept: input => onSubmit(input) }));
    liveCleanups = registered;
  }

  /* The built-in Dictate button: answer its Deepgram requests on this computer. */
  cleanups.push(installBuiltinReplacement(window, {
    owner,
    enabled: () => !disposed && settings?.replaceBuiltIn === true,
    async decided() {
      if (!settings) await Promise.race([firstStatus, new Promise(resolve => setTimeout(resolve, 5_000))]);
      return !disposed && settings?.replaceBuiltIn === true;
    },
    call: (operation, input) => ctx.call(operation, input),
    async installed() {
      let current = status ?? await store.refresh();
      // Re-read once: it may have been installed from another window.
      if (!current.engineInstalled || !current.modelInstalled) current = await store.refresh();
      return current.platform.supported && current.engineInstalled && current.modelInstalled;
    },
    setUp: () => openSetupDialog(ctx, store, signal, { label: "Done", hint: "Ready. Press Dictate again to start." }),
    note: (text, options) => hud.message(text, options),
    late(text) {
      // LearnHarness appends dictation to the end of its input; do the same for
      // words that missed its deadline, in the field the learner was last in.
      const found = focus.current();
      if (found && appendAtEnd(found.element, text)) hud.message("Added the last words, which finished transcribing a moment late.", { tone: "info", autoHideMs: 5_000 });
      else hud.message("These last words were recognised after LearnHarness stopped waiting:", { copy: text });
    },
  }));

  cleanups.push(ctx.registerSettings((container, mountSignal) => mountSettings(container, ctx, store, mountSignal)) as () => void);
  cleanups.push(ctx.onNotification(event => { if (event.topic === "status") reread(); }));
  cleanups.push(ctx.onResync(reread));

  return () => {
    if (disposed) return;
    disposed = true;
    const session = live;
    if (session) {
      const id = session.session;
      over(session);
      if (id) void ctx.call("session-cancel", { session: id }).catch(() => undefined);
    }
    document.removeEventListener("focusin", onFocus);
    focus.dispose();
    hud.dispose();
    liveCleanups?.splice(0).reverse().forEach(dispose => dispose());
    liveCleanups = undefined;
    cleanups.splice(0).reverse().forEach(dispose => dispose());
    listeners.clear();
  };
}
