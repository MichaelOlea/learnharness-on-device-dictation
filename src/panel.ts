/** Installation status, used both as the first-run dialog and at the top of the
 * plugin's Settings page, plus the settings rows themselves. */
import type { PluginFrontendContext, PluginSettingsSchema, PluginWidgetHandle } from "learnharness-plugin-api";
import {
  AUTO_LANGUAGE, ENGINE_MODES, HOST_LANGUAGE, LANGUAGES, LATENCIES, LATENCY_LABELS, LIMITS, MODEL_NAME, formatBytes,
  type EngineMode, type Latency, type Settings, type SettingsPatch, type Status,
} from "./contract.ts";

export interface StatusStore {
  current(): Status | undefined;
  refresh(): Promise<Status>;
  subscribe(listener: (status: Status) => void): () => void;
  /** Apply a status the backend returned from a mutating call. */
  publish(status: Status): void;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const PHASES: Record<Status["install"]["phase"], string> = {
  idle: "", done: "",
  "downloading-engine": "Downloading the speech engine",
  "unpacking-engine": "Verifying and unpacking the speech engine",
  "downloading-model": "Downloading the speech model",
  "unpacking-model": "Verifying and unpacking the speech model (about a minute)",
  error: "",
};

function host(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** Mount the live installation card. Returns cleanup. */
export function mountInstallation(
  container: HTMLElement, ctx: PluginFrontendContext, store: StatusStore, signal: AbortSignal,
  options: { onReady?: () => void } = {},
): () => void {
  const card = node("div", "odd-card");
  container.append(card);
  const widgets: PluginWidgetHandle<unknown>[] = [];
  let rendered = "";
  let wasReady: boolean | undefined;

  const act = async (operation: string) => {
    try { store.publish(await ctx.call<Status>(operation)); }
    catch (error) { await store.refresh().catch(() => undefined); throw error; }
  };
  const button = (parent: HTMLElement, label: string, onClick: () => void | Promise<void>, variant: "default" | "outline" | "destructive" = "outline") => {
    const slot = node("span");
    parent.append(slot);
    widgets.push(ctx.ui.mountButton(slot, { label, onClick, variant, size: "sm" }, { signal }) as PluginWidgetHandle<unknown>);
  };

  function render(status: Status): void {
    const ready = status.engineInstalled && status.modelInstalled;
    const install = status.install;
    const busy = install.phase !== "idle" && install.phase !== "done" && install.phase !== "error";
    // Progress updates only move the bar; everything else re-renders on change.
    const shape = JSON.stringify([status.platform, ready, busy ? install.phase : install, status.pending, status.engine, status.settings.latency, status.settings.replaceBuiltIn, status.threads]);
    if (shape === rendered) {
      const bar = card.querySelector<HTMLElement>(".odd-progress > i");
      const figures = card.querySelector<HTMLElement>(".odd-figures");
      if (bar && install.total > 0) bar.style.width = `${Math.min(100, (install.done / install.total) * 100).toFixed(1)}%`;
      if (figures && install.total > 0) figures.textContent = `${formatBytes(install.done)} of ${formatBytes(install.total)}`;
      return;
    }
    rendered = shape;
    widgets.splice(0).forEach(widget => widget.dispose());
    card.replaceChildren();
    card.dataset.tone = "";

    if (!status.platform.supported) {
      card.dataset.tone = "error";
      card.append(
        node("div", "odd-state", "This computer is not supported"),
        node("p", "odd-muted", `No prebuilt speech engine exists for ${status.platform.key}. Supported: Windows (x64, Arm64), macOS 14+ on Apple silicon, macOS 15+ on Intel, Linux x64 (glibc 2.32 or later) and Linux Arm64.`),
      );
    } else if (busy) {
      card.append(node("div", "odd-state", `${PHASES[install.phase]}…`));
      const progress = node("div", "odd-progress");
      progress.append(node("i"));
      const figures = node("p", "odd-muted odd-figures");
      const actions = node("div", "odd-actions");
      card.append(progress, figures, actions);
      button(actions, "Cancel", () => act("install-cancel"));
      wasReady = false;
      render(status); // fill in the bar through the fast path
      return;
    } else if (!ready) {
      if (install.phase === "error") {
        card.dataset.tone = "error";
        card.append(node("div", "odd-state", "Installation did not finish"), node("p", "", install.error ?? "Unknown error."));
      } else {
        card.append(node("div", "odd-state", "Speech engine and model are not installed"));
      }
      const total = status.pending.reduce((sum, item) => sum + item.bytes, 0);
      card.append(node("p", "", `Dictation can run on this computer with NVIDIA's ${MODEL_NAME} model, the same model VS Code's on-device dictation uses, instead of Deepgram. It needs a one-time download of ${formatBytes(total)}; after that no audio or text is sent anywhere, no Deepgram key is needed, and dictation works offline.`));
      const list = node("ul", "odd-list");
      for (const item of status.pending) list.append(node("li", "", `${item.name} — ${formatBytes(item.bytes)} from ${host(item.url)}`));
      card.append(list, node("p", "odd-muted", "Needs about 1.2 GB of free disk space while installing (0.7 GB afterwards) and about 1 GB of memory while the model is loaded. Each file is checked against its published checksum before it is used. The model is licensed by NVIDIA under OpenMDW-1.1."));
      const actions = node("div", "odd-actions");
      card.append(actions);
      button(actions, install.phase === "error" ? "Try again" : "Download and install", () => act("install"), "default");
      const manual = node("details", "odd-details");
      manual.append(node("summary", "", "Install without a download (offline or behind a proxy)"));
      manual.append(node("p", "", "Download these files on any computer, put them in the folder below, then choose “Download and install” — files already in the folder are verified and used instead of being fetched."));
      const files = node("ul", "odd-list");
      for (const item of status.pending) {
        const entry = node("li");
        entry.append(node("span", "odd-code", item.url));
        files.append(entry);
      }
      manual.append(files, node("p", "odd-code", status.downloadsDirectory));
      card.append(manual);
    } else {
      const engine = status.engine;
      const where = engine.mode === "external" ? "in a separate process" : "inside LearnHarness";
      const line = engine.state === "ready" ? `Model loaded ${where}${engine.loadMs !== undefined ? ` (took ${(engine.loadMs / 1000).toFixed(1)} s)` : ""}.`
        : engine.state === "loading" ? "Loading the model…"
        : engine.state === "error" ? engine.error ?? "The speech engine failed."
        : "The model is not loaded right now; it loads when you start dictating.";
      if (engine.state === "error") card.dataset.tone = "error";
      card.append(
        node("div", "odd-state", engine.state === "error" ? "Speech engine problem" : "Ready — dictation is transcribed on this computer"),
        node("p", engine.state === "error" ? "" : "odd-muted", line),
        node("p", "odd-muted", `Model: ${MODEL_NAME}, ${status.settings.latency} ms steps, ${status.threads} CPU thread${status.threads === 1 ? "" : "s"}.`),
        node("p", "odd-muted", status.settings.replaceBuiltIn
          ? "LearnHarness's Dictate button uses it. No Deepgram key is needed; the Deepgram entry under Settings → Dictation can stay empty."
          : "LearnHarness's Dictate button is using Deepgram. Turn on “Replace built-in dictation” below to use this instead."),
      );
      const actions = node("div", "odd-actions");
      card.append(actions);
      button(actions, "Remove downloaded files", () => confirmRemoval(ctx, store, signal), "outline");
    }
    if (wasReady === false && ready) options.onReady?.();
    wasReady = ready;
  }

  const unsubscribe = store.subscribe(render);
  const now = store.current();
  if (now) render(now);
  void store.refresh().catch(error => {
    card.replaceChildren(node("div", "odd-state", "Could not read dictation status"), node("p", "", error instanceof Error ? error.message : String(error)));
  });
  return () => {
    unsubscribe();
    widgets.splice(0).forEach(widget => widget.dispose());
    card.remove();
  };
}

function confirmRemoval(ctx: PluginFrontendContext, store: StatusStore, signal: AbortSignal): void {
  const controller = new AbortController();
  const scope = AbortSignal.any([signal, controller.signal]);
  const dialog = ctx.ui.openDialog({
    title: "Remove downloaded speech files",
    content(container, mountSignal) {
      const panel = node("div", "odd-panel odd-dialog");
      panel.append(
        node("h2", "", "Remove the downloaded speech files?"),
        node("p", "", "This deletes the speech engine and every downloaded model from this plugin's data folder (about 0.7 GB per model). Your settings are kept. Dictation will ask to download them again."),
      );
      const actions = node("div", "odd-actions");
      panel.append(actions);
      const remove = node("span");
      const keep = node("span");
      actions.append(remove, keep);
      ctx.ui.mountButton(remove, {
        label: "Remove files", variant: "destructive", size: "sm",
        onClick: async () => { store.publish(await ctx.call<Status>("remove-files")); controller.abort(); },
      }, { signal: mountSignal });
      ctx.ui.mountButton(keep, { label: "Keep", variant: "outline", size: "sm", onClick: () => controller.abort() }, { signal: mountSignal });
      container.append(panel);
      return () => panel.remove();
    },
    onClose: () => controller.abort(),
  }, { signal: scope });
  scope.addEventListener("abort", () => dialog.dispose(), { once: true });
}

/** First-run dialog: explain, install, then offer the closing action. */
export function openSetupDialog(
  ctx: PluginFrontendContext, store: StatusStore, signal: AbortSignal,
  after: { label: string; hint?: string; run?: () => void },
): void {
  const controller = new AbortController();
  const scope = AbortSignal.any([signal, controller.signal]);
  const dialog = ctx.ui.openDialog({
    title: "Set up on-device dictation",
    content(container, mountSignal) {
      const panel = node("div", "odd-panel odd-dialog");
      panel.append(node("h2", "", "Set up on-device dictation"));
      container.append(panel);
      const slot = node("div");
      const actions = node("div", "odd-actions");
      panel.append(slot, actions);
      const offerNext = () => {
        if (actions.childElementCount) return;
        if (after.hint) actions.append(node("span", "odd-muted", after.hint));
        const next = node("span");
        actions.append(next);
        ctx.ui.mountButton(next, {
          label: after.label, variant: "default", size: "sm",
          onClick: () => { controller.abort(); after.run?.(); },
        }, { signal: mountSignal });
      };
      const cleanup = mountInstallation(slot, ctx, store, mountSignal, { onReady: offerNext });
      return () => { cleanup(); panel.remove(); };
    },
    onClose: () => controller.abort(),
  }, { signal: scope });
  scope.addEventListener("abort", () => dialog.dispose(), { once: true });
}

function settingsRows(status: Status, change: (patch: SettingsPatch) => Promise<void>): PluginSettingsSchema["rows"] {
  const settings: Settings = status.settings;
  const installed = new Set<Latency>(status.installedModels);
  return [
    {
      key: "replaceBuiltIn", type: "toggle", label: "Replace built-in dictation", value: settings.replaceBuiltIn,
      description: "LearnHarness's own Dictate button and shortcut transcribe on this computer instead of Deepgram. No Deepgram key is needed and no audio leaves your device. Turn off to go back to Deepgram.",
      onChange: replaceBuiltIn => change({ replaceBuiltIn }),
    },
    {
      key: "language", type: "dropdown", label: "Language", value: settings.language,
      description: "By default this follows Settings → Dictation → Language. Languages this model does not cover are detected automatically.",
      options: [
        { value: HOST_LANGUAGE, label: "Same as LearnHarness's Dictation language" },
        { value: AUTO_LANGUAGE, label: "Detect automatically" },
        ...LANGUAGES.map(language => ({ value: language.code, label: language.label })),
      ],
      onChange: language => change({ language }),
    },
    {
      key: "latency", type: "dropdown", label: "Responsiveness", value: settings.latency,
      description: "How often new words appear. Larger steps are more accurate and use less CPU. Each choice is its own 475 MB model download.",
      options: LATENCIES.map(latency => ({ value: latency, label: `${LATENCY_LABELS[latency]}${installed.has(latency) ? "" : " — not downloaded"}` })),
      onChange: latency => change({ latency: latency as Latency }),
    },
    {
      key: "liveButton", type: "toggle", label: "Extra: live-typing button", value: settings.liveButton,
      description: "Adds a separate microphone button (session top bars, sidebar; shortcut Ctrl/Cmd+Shift+M) that types words at the cursor while you speak, instead of when you stop.",
      onChange: liveButton => change({ liveButton }),
    },
    {
      key: "autoStopSeconds", type: "number", label: "Live typing: stop after silence (seconds)", value: settings.autoStopSeconds, ...LIMITS.autoStopSeconds, step: 1,
      description: "Only for the live-typing button. 0 keeps listening until you stop it.",
      onChange: autoStopSeconds => change({ autoStopSeconds }),
    },
    {
      key: "threads", type: "number", label: "CPU threads", value: settings.threads, ...LIMITS.threads, step: 1,
      description: `0 chooses automatically (currently ${status.threads} of ${status.cores} cores). Raise it if text falls behind your speech.`,
      onChange: threads => change({ threads }),
    },
    {
      key: "preload", type: "toggle", label: "Load the model when LearnHarness starts", value: settings.preload,
      description: "Makes the first dictation instant. Off: the model loads when you first press Dictate, which takes a few seconds; a very short first dictation may then get its words a moment late.",
      onChange: preload => change({ preload }),
    },
    {
      key: "unloadAfterMinutes", type: "number", label: "Release the model after idle minutes", value: settings.unloadAfterMinutes, ...LIMITS.unloadAfterMinutes, step: 1,
      description: "The loaded model uses about 1 GB of memory. It is released after this long without dictating and loads again on the next use. 0 keeps it loaded.",
      onChange: unloadAfterMinutes => change({ unloadAfterMinutes }),
    },
    {
      key: "engineMode", type: "dropdown", label: "Where the speech engine runs", value: settings.engineMode,
      description: "Automatic runs it inside LearnHarness and switches to a separate Node.js process only if the native library cannot be loaded there.",
      options: ENGINE_MODES.map(mode => ({ value: mode, label: mode === "auto" ? "Automatic" : mode === "in-process" ? "Inside LearnHarness" : "Separate Node.js process" })),
      onChange: engineMode => change({ engineMode: engineMode as EngineMode }),
    },
    {
      key: "nodePath", type: "text", label: "Node.js path for the separate process", value: settings.nodePath,
      description: "Only used by the separate-process engine. Leave blank to find Node.js automatically.",
      validate: value => (value.length > 1024 || /[\r\n]/.test(value) ? "Enter a single path." : undefined),
      onChange: nodePath => change({ nodePath }),
    },
  ];
}

/** The plugin's Settings page body. */
export function mountSettings(container: HTMLElement, ctx: PluginFrontendContext, store: StatusStore, signal: AbortSignal): () => void {
  const panel = node("div", "odd-panel");
  const top = node("div");
  const rowsSlot = node("div");
  panel.append(top, rowsSlot);
  container.append(panel);
  const cleanupInstallation = mountInstallation(top, ctx, store, signal);

  let rows: PluginWidgetHandle<PluginSettingsSchema> | undefined;
  const change = async (patch: SettingsPatch) => { store.publish(await ctx.call<Status>("set-settings", patch)); };
  // Publish accepted values back into the controlled rows after every save.
  const apply = (status: Status) => {
    const schema = { rows: settingsRows(status, change) };
    if (rows) rows.update(schema);
    else rows = ctx.ui.mountSettingsRows(rowsSlot, schema, { signal });
  };
  let last = "";
  const unsubscribe = store.subscribe(status => {
    const shape = JSON.stringify([status.settings, status.installedModels, status.threads]);
    if (shape === last) return;
    last = shape;
    apply(status);
  });
  const now = store.current();
  if (now) { last = JSON.stringify([now.settings, now.installedModels, now.threads]); apply(now); }
  return () => {
    unsubscribe();
    rows?.dispose();
    cleanupInstallation();
    panel.remove();
  };
}
