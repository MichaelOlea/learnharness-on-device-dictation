/** Browser half of the end-to-end test: a small React page that stands in for a
 * LearnHarness window. It offers the plugin the public frontend API it uses and
 * a controlled composer like the app's, so the built plugin runs unmodified. */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PluginAction, PluginFrontendContext, PluginSettingsRow, PluginSettingsSchema, PluginSubmission, PluginSubmissionInterceptor } from "learnharness-plugin-api";

interface TestWindow extends Window {
  __state: { text: string; changes: number };
  __sent: string[];
  __dialogs: number;
  __activated: boolean;
  __deactivate(): Promise<void>;
  __errors: string[];
}
const win = window as unknown as TestWindow;
win.__state = { text: "", changes: 0 };
win.__sent = [];
win.__dialogs = 0;
win.__errors = [];
window.addEventListener("error", event => win.__errors.push(String(event.message)));
window.addEventListener("unhandledrejection", event => win.__errors.push(String(event.reason?.message ?? event.reason)));

const activation = new AbortController();
const actions = new Map<string, PluginAction>();
const interceptors: PluginSubmissionInterceptor[] = [];
const notificationListeners = new Set<(event: { pluginId: string; topic: string; data?: unknown }) => void>();
let renderChrome = () => {};

async function call<T>(operation: string, input?: unknown): Promise<T> {
  const response = await fetch("/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, input }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  return body.result as T;
}

function handle<P>(apply: (props: P) => void, initial: P, dispose: () => void, signal: AbortSignal) {
  let props = initial;
  let gone = false;
  const end = () => { if (!gone) { gone = true; dispose(); } };
  signal.addEventListener("abort", end, { once: true });
  apply(props);
  return { update(next: Partial<P>) { if (!gone) { props = { ...props, ...next }; apply(props); } }, dispose: end };
}

function renderRow(row: PluginSettingsRow): HTMLElement {
  const wrapper = document.createElement("label");
  wrapper.dataset.key = row.key;
  wrapper.style.display = "block";
  wrapper.append(`${row.label} `);
  const fail = (error: unknown) => { wrapper.dataset.error = error instanceof Error ? error.message : String(error); };
  if (row.type === "dropdown") {
    const select = document.createElement("select");
    for (const option of row.options) select.add(new Option(option.label, option.value));
    select.value = row.value;
    select.onchange = () => { void Promise.resolve(row.onChange(select.value)).catch(fail); };
    wrapper.append(select);
  } else if (row.type === "toggle") {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = row.value;
    box.onchange = () => { void Promise.resolve(row.onChange(box.checked)).catch(fail); };
    wrapper.append(box);
  } else {
    const input = document.createElement("input");
    input.type = row.type === "text" ? "text" : "number";
    input.value = String(row.value);
    input.onchange = () => {
      const value = row.type === "text" ? input.value : Number(input.value);
      const problem = (row.validate as ((value: unknown) => string | undefined) | undefined)?.(value);
      if (problem) { wrapper.dataset.error = problem; return; }
      void Promise.resolve((row.onChange as (value: unknown) => void | Promise<void>)(value)).catch(fail);
    };
    wrapper.append(input);
  }
  return wrapper;
}

const ctx = {
  signal: activation.signal,
  cleanup() { /* unused by this plugin */ },
  registerAction(action: PluginAction) {
    if (action.shortcut?.defaultBinding && !/^(mod|alt)(\+shift)?\+[a-z0-9]$|^f\d+$/.test(action.shortcut.defaultBinding)) throw new Error("Invalid binding");
    actions.set(action.id, action);
    renderChrome();
    return () => { actions.delete(action.id); renderChrome(); };
  },
  placeAction(placement: { id: string; actionId: string; location: string }) {
    document.body.dataset[`placed_${placement.location.replace("-", "_")}`] = placement.actionId;
    return () => { delete document.body.dataset[`placed_${placement.location.replace("-", "_")}`]; };
  },
  refreshActions() { renderChrome(); },
  registerSettings(mount: (container: HTMLElement, signal: AbortSignal) => void | (() => void)) {
    const container = document.getElementById("settings")!;
    const controller = new AbortController();
    const cleanup = mount(container, controller.signal);
    return () => { controller.abort(); if (typeof cleanup === "function") cleanup(); };
  },
  registerSubmissionInterceptor(definition: PluginSubmissionInterceptor) {
    interceptors.push(definition);
    return () => { interceptors.splice(interceptors.indexOf(definition), 1); };
  },
  refreshSubmissions() { /* unused */ },
  onNotification(listener: (event: { pluginId: string; topic: string; data?: unknown }) => void) { notificationListeners.add(listener); return () => notificationListeners.delete(listener); },
  onResync() { return () => undefined; },
  onAppEvent() { return () => undefined; },
  call,
  app: { pathname: () => location.pathname, openSession() {}, openHome() {}, openView() {}, openSettings() {} },
  ui: {
    mountButton(container: HTMLElement, props: { label: string; onClick: () => void | Promise<void>; disabled?: boolean }, options: { signal: AbortSignal }) {
      const button = document.createElement("button");
      button.type = "button";
      container.append(button);
      let current = props;
      button.onclick = () => { void Promise.resolve(current.onClick()).catch(error => { button.dataset.error = error instanceof Error ? error.message : String(error); }); };
      return handle<typeof props>(next => { current = next; button.textContent = next.label; button.disabled = Boolean(next.disabled); }, props, () => button.remove(), options.signal);
    },
    openDialog(props: { title: string; content: HTMLElement | ((container: HTMLElement, signal: AbortSignal) => void | (() => void)); onClose?: () => void }, options: { signal: AbortSignal }) {
      win.__dialogs++;
      const dialog = document.createElement("div");
      dialog.className = "test-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-label", props.title);
      const close = document.createElement("button");
      close.textContent = "×";
      close.className = "test-dialog-close";
      close.onclick = () => { props.onClose?.(); };
      const body = document.createElement("div");
      dialog.append(close, body);
      document.body.append(dialog);
      const controller = new AbortController();
      const cleanup = typeof props.content === "function" ? props.content(body, controller.signal) : void body.append(props.content);
      return handle<typeof props>(() => undefined, props, () => { controller.abort(); if (typeof cleanup === "function") cleanup(); dialog.remove(); }, options.signal);
    },
    mountSettingsRows(container: HTMLElement, schema: PluginSettingsSchema, options: { signal: AbortSignal }) {
      const list = document.createElement("div");
      list.className = "test-rows";
      container.append(list);
      return handle<PluginSettingsSchema>(next => list.replaceChildren(...next.rows.map(renderRow)), schema, () => list.remove(), options.signal);
    },
  },
} as unknown as PluginFrontendContext;

/** What the host does on Send: capture the draft, run interceptors, deliver. */
async function submit(captured: string, clear: () => void): Promise<void> {
  let submission: PluginSubmission = { type: "text", content: { text: captured, images: [] } };
  for (const interceptor of interceptors) {
    const result = await interceptor.intercept(submission, {} as never);
    if (result === null) return;
    if (result) submission = result;
  }
  if (submission.type === "text") win.__sent.push(submission.content.text);
  clear();
}

function runAction(placement: "top-bar" | "keyboard"): void {
  const action = actions.get("toggle");
  if (!action) return;
  const context = { placement, surface: "session", sessionId: "s1", kind: "teaching" } as never;
  if (typeof action.disabled === "function" ? action.disabled(context) : action.disabled) return;
  void action.run(context);
}

function App() {
  const [text, setText] = useState("");
  const [, setTick] = useState(0);
  useEffect(() => { renderChrome = () => setTick(tick => tick + 1); return () => { renderChrome = () => {}; }; }, []);
  win.__state.text = text;
  const action = actions.get("toggle");
  return (
    <>
      <header>
        {/* A real button: clicking it takes focus away from the composer. */}
        <button id="dictate" disabled={!action} onClick={() => runAction("top-bar")}>{action?.name ?? "…"}</button>
      </header>
      <textarea id="composer" rows={6} cols={80} value={text} placeholder="Message"
        onChange={event => { win.__state.changes++; setText(event.target.value); }} />
      <button id="send" onClick={() => { void submit(text, () => setText("")); }}>Send</button>
      <p><input id="plain" placeholder="uncontrolled input" /></p>
      <div id="rich" contentEditable suppressContentEditableWarning style={{ border: "1px solid #ccc", minHeight: "2em" }} />
    </>
  );
}

// The host's own shortcut dispatcher: the caret stays where it is.
window.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "m") { event.preventDefault(); runAction("keyboard"); }
});

createRoot(document.getElementById("app")!).render(<App />);

// Deliver backend notifications the way the host's live channel would.
let seen = 0;
const poll = setInterval(async () => {
  try {
    const events = await (await fetch(`/events?after=${seen}`)).json() as { topic: string; data?: unknown }[];
    seen += events.length;
    for (const event of events) for (const listener of notificationListeners) listener({ pluginId: "on-device-dictation", ...event });
  } catch { /* server gone at the end of a test */ }
}, 250);

const plugin = await import(/* @vite-ignore */ `${location.origin}/plugin/main.js`) as { activate(ctx: PluginFrontendContext): () => void };
const deactivate = plugin.activate(ctx);
win.__deactivate = async () => { clearInterval(poll); activation.abort(); deactivate(); };
win.__activated = true;
