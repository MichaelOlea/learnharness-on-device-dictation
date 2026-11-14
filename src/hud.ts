/** The floating recording indicator. A live microphone must always be visible,
 * and the plugin API has no non-blocking status surface, so this is a small
 * plugin-owned element with scoped class names appended to the page. It never
 * takes focus: the caret has to stay in the field being dictated into. */

export type HudState = "starting" | "loading" | "listening" | "finishing" | "message";
export interface HudActions {
  done(): void;
  cancel(): void;
  dismiss(): void;
  copy(text: string): void | Promise<void>;
}

const LABELS: Record<Exclude<HudState, "message">, string> = {
  starting: "Starting microphone…",
  loading: "Loading speech model — go ahead and speak",
  listening: "Listening — on this device",
  finishing: "Finishing…",
};

function element<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class Hud {
  readonly root: HTMLDivElement;
  private readonly label: HTMLSpanElement;
  private readonly detail: HTMLSpanElement;
  private readonly meter: HTMLElement;
  private readonly doneButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly copyButton: HTMLButtonElement;
  private copyText = "";
  private hideTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly doc: Document, private readonly actions: HudActions) {
    this.root = element(doc, "div", "odd-hud");
    this.root.hidden = true;
    this.root.setAttribute("role", "group");
    this.root.setAttribute("aria-label", "On-device dictation");
    const dot = element(doc, "span", "odd-hud-dot");
    dot.setAttribute("aria-hidden", "true");
    const meter = element(doc, "span", "odd-hud-meter");
    meter.setAttribute("aria-hidden", "true");
    this.meter = element(doc, "i", "");
    meter.append(this.meter);
    this.label = element(doc, "span", "odd-hud-label");
    // Announce state changes, not every word: the words appear in the field itself.
    this.label.setAttribute("role", "status");
    this.label.setAttribute("aria-live", "polite");
    this.detail = element(doc, "span", "odd-hud-detail");
    this.copyButton = this.button("Copy", "odd-hud-button", () => { void this.actions.copy(this.copyText); });
    this.doneButton = this.button("Done", "odd-hud-button odd-hud-primary", () => this.actions.done());
    this.cancelButton = this.button("✕", "odd-hud-button odd-hud-close", () => {
      if (this.root.dataset.state === "message") this.actions.dismiss(); else this.actions.cancel();
    });
    this.root.append(dot, meter, this.label, this.detail, this.copyButton, this.doneButton, this.cancelButton);
    // Clicking the indicator must not pull focus (and the caret) out of the field.
    this.root.addEventListener("mousedown", event => event.preventDefault());
    doc.body.append(this.root);
  }

  private button(text: string, className: string, onClick: () => void): HTMLButtonElement {
    const button = element(this.doc, "button", className, text);
    button.type = "button";
    button.tabIndex = -1;
    button.addEventListener("click", event => { event.preventDefault(); onClick(); });
    return button;
  }

  show(state: Exclude<HudState, "message">, detail = ""): void {
    clearTimeout(this.hideTimer);
    this.root.hidden = false;
    this.root.dataset.state = state;
    this.root.dataset.tone = "";
    if (this.label.textContent !== LABELS[state]) this.label.textContent = LABELS[state];
    this.detail.textContent = detail;
    this.copyButton.hidden = true;
    this.doneButton.hidden = state === "finishing";
    this.cancelButton.hidden = state === "finishing";
    this.cancelButton.setAttribute("aria-label", "Cancel dictation");
    this.cancelButton.title = "Cancel dictation";
    if (state !== "listening") this.level(0);
  }

  /** A note that stays until dismissed, optionally with text the learner can copy. */
  message(text: string, options: { tone?: "error" | "info"; copy?: string; autoHideMs?: number } = {}): void {
    clearTimeout(this.hideTimer);
    this.root.hidden = false;
    this.root.dataset.state = "message";
    this.root.dataset.tone = options.tone ?? "info";
    this.label.textContent = text;
    this.detail.textContent = options.copy ?? "";
    this.copyText = options.copy ?? "";
    this.copyButton.hidden = !options.copy;
    this.copyButton.textContent = "Copy";
    this.doneButton.hidden = true;
    this.cancelButton.hidden = false;
    this.cancelButton.setAttribute("aria-label", "Dismiss");
    this.cancelButton.title = "Dismiss";
    this.level(0);
    if (options.autoHideMs) this.hideTimer = setTimeout(() => this.hide(), options.autoHideMs);
  }

  copied(): void { this.copyButton.textContent = "Copied"; }

  /** Words that have nowhere to go yet, or a hint about what is happening. */
  setDetail(text: string): void { if (this.detail.textContent !== text) this.detail.textContent = text; }

  level(value: number): void { this.meter.style.transform = `scaleX(${Math.max(0.04, Math.min(1, value)).toFixed(2)})`; }

  hide(): void {
    clearTimeout(this.hideTimer);
    this.root.hidden = true;
    this.root.dataset.state = "";
    this.copyText = "";
    this.detail.textContent = "";
  }

  get visible(): boolean { return !this.root.hidden; }

  dispose(): void {
    clearTimeout(this.hideTimer);
    this.root.remove();
  }
}
