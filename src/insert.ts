/** Put dictated words where the caret is, the way typing would.
 *
 * LearnHarness has no public API for writing into its own composers, so this
 * uses only standard editing behaviour of whichever field the learner focused:
 * no host selectors, class names or component internals are involved. The field
 * receives ordinary `input` events, exactly as if the text had been typed. */

export type EditableField = HTMLTextAreaElement | HTMLInputElement;
export type Editable = EditableField | HTMLElement;

/** Input types whose value is free text with a readable selection. */
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", ""]);

export function isField(element: Element): element is EditableField {
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  if (element instanceof view.HTMLTextAreaElement) return true;
  return element instanceof view.HTMLInputElement && TEXT_INPUT_TYPES.has((element.getAttribute("type") ?? "").toLowerCase());
}

/** The element itself when dictation may type into it right now. */
export function editableFrom(node: EventTarget | null | undefined): Editable | undefined {
  const view = (node as Node | null)?.ownerDocument?.defaultView;
  if (!node || !view || !(node instanceof view.HTMLElement) || !node.isConnected) return undefined;
  if (isField(node)) return node.disabled || node.readOnly ? undefined : node;
  return node.isContentEditable ? node : undefined;
}

/** Follow focus through open shadow roots to the element that really has it. */
export function deepActiveElement(root: Document | ShadowRoot = document): Element | null {
  let active = root.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

function isVisible(element: HTMLElement): boolean {
  return element.getClientRects().length > 0;
}

/** Remembers the last text field the learner was in, because clicking a toolbar
 * button moves focus away from it before the button's action runs. */
export class FocusMemory {
  private last: WeakRef<Editable> | undefined;
  private readonly listener = (event: FocusEvent) => {
    const editable = editableFrom(event.composedPath()[0] ?? event.target);
    if (editable && !this.ignore(editable)) this.last = new WeakRef(editable);
  };

  constructor(private readonly doc: Document, private readonly ignore: (element: Element) => boolean) {
    doc.addEventListener("focusin", this.listener, true);
    const current = editableFrom(deepActiveElement(doc));
    if (current && !ignore(current)) this.last = new WeakRef(current);
  }

  /** The focused field, else the most recent one that is still usable. */
  current(): { element: Editable; focused: boolean } | undefined {
    const active = editableFrom(deepActiveElement(this.doc));
    if (active && !this.ignore(active)) return { element: active, focused: true };
    const remembered = this.last?.deref();
    const usable = remembered && editableFrom(remembered);
    return usable && isVisible(usable) ? { element: usable, focused: false } : undefined;
  }

  dispose(): void { this.doc.removeEventListener("focusin", this.listener, true); }
}

/** Scripts written without spaces between words must not get one prepended. */
const UNSPACED = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
const NO_SPACE_BEFORE = /^[\s.,;:!?)\]}%…。、，！？]/u;
const NO_SPACE_AFTER = /[\s([{“"'‘/\-—]$/u;

/** Separate new speech from text that is already in front of the caret. */
export function joinSpacing(before: string, text: string): string {
  if (!before || !text) return text;
  if (NO_SPACE_AFTER.test(before) || NO_SPACE_BEFORE.test(text) || UNSPACED.test(text)) return text;
  return ` ${text}`;
}

function textBeforeCaret(element: Editable): string {
  if (isField(element)) {
    const start = element.selectionStart ?? element.value.length;
    return element.value.slice(Math.max(0, start - 1), start);
  }
  const selection = element.ownerDocument.getSelection();
  const node = selection?.anchorNode;
  if (!selection || !node || !element.contains(node)) return "";
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").slice(Math.max(0, selection.anchorOffset - 1), selection.anchorOffset);
  // At an element boundary: treat existing content as needing separation only
  // when there is something before the caret at all.
  return selection.anchorOffset > 0 ? "x" : "";
}

function insertIntoField(element: EditableField, text: string): boolean {
  const doc = element.ownerDocument;
  if (deepActiveElement(doc) === element) {
    const before = element.value;
    // The editing command keeps the field's own undo history and fires the same
    // events as typing. It is deprecated but remains the only API that does so.
    try { doc.execCommand("insertText", false, text); } catch { /* fall through */ }
    if (element.value !== before) return true;
  }
  const start = element.selectionStart ?? element.value.length;
  const end = element.selectionEnd ?? start;
  element.setRangeText(text, start, end, "end");
  element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
  return true;
}

function insertIntoContent(element: HTMLElement, text: string): boolean {
  const doc = element.ownerDocument;
  const selection = doc.getSelection();
  const active = deepActiveElement(doc);
  const focused = active === element || (active !== null && element.contains(active));
  if (!selection?.rangeCount || !focused || !element.contains(selection.anchorNode)) return false;
  try { if (doc.execCommand("insertText", false, text)) return true; } catch { /* fall through */ }
  const proposal = new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, inputType: "insertText", data: text });
  if (!element.dispatchEvent(proposal)) return true; // a rich editor applied it itself
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = doc.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
  return true;
}

/** Add text after everything already in a field, the way LearnHarness itself
 * appends dictation. Returns false when the field cannot take it. */
export function appendAtEnd(element: Editable, text: string): boolean {
  const target = editableFrom(element);
  if (!target) return false;
  try {
    target.focus({ preventScroll: true });
    if (isField(target)) target.setSelectionRange(target.value.length, target.value.length);
    else {
      const selection = target.ownerDocument.getSelection();
      if (!selection) return false;
      selection.selectAllChildren(target);
      selection.collapseToEnd();
    }
  } catch { return false; }
  const inserter = new Inserter(target);
  inserter.add(text);
  return inserter.unplaced === "";
}

/** Types one dictation's words into a field as they arrive. Words that cannot be
 * placed yet are held, never dropped. */
export class Inserter {
  private target: Editable | undefined;
  private first = true;
  /** Recognised but not yet typed anywhere. */
  private held = "";
  /** Everything typed so far, for recognising our own text later. */
  private typed = "";

  constructor(target: Editable | undefined) { this.target = target; }

  get element(): Editable | undefined { return this.target; }
  get unplaced(): string { return this.held; }
  get placed(): string { return this.typed; }

  /** Use a newly focused field when the original one is gone or was never set. */
  adopt(element: Editable): void {
    if (this.target && editableFrom(this.target)) return;
    this.target = element;
    this.first = true;
    this.flush();
  }

  add(text: string): void {
    this.held += text;
    this.flush();
  }

  /** Try to type whatever is held. Returns true when nothing is left waiting. */
  flush(): boolean {
    if (!this.held) return true;
    const target = this.target && editableFrom(this.target);
    if (!target) return false;
    let text = this.held;
    if (this.first) text = joinSpacing(textBeforeCaret(target), text.replace(/^\s+/, ""));
    if (!text) { this.held = ""; return true; }
    let done = false;
    try { done = isField(target) ? insertIntoField(target, text) : insertIntoContent(target, text); }
    catch { done = false; }
    if (!done) return false;
    this.first = false;
    this.typed += text;
    this.held = "";
    return true;
  }

  /** Hand back and forget the words that never found a field. */
  takeUnplaced(): string {
    const text = this.held;
    this.held = "";
    return text;
  }
}
