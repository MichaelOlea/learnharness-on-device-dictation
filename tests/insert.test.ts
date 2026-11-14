/** Caret insertion under jsdom, which has no editing commands: this exercises
 * the standards-only fallback path. The real-browser path (editing command on a
 * React-controlled field) is covered by tests/e2e/browser.e2e.ts. */
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { FocusMemory, Inserter, deepActiveElement, editableFrom, joinSpacing } from "../src/insert.ts";

function page(html: string) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { pretendToBeVisual: true });
  const { document } = dom.window;
  // The module under test reads these globals the way it would in a browser.
  Object.assign(globalThis, { document, Node: dom.window.Node, InputEvent: dom.window.InputEvent });
  // jsdom lays nothing out; report every connected element as visible.
  dom.window.HTMLElement.prototype.getClientRects = function () { return (this.isConnected ? [{}] : []) as unknown as DOMRectList; };
  return { dom, document, $: <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T };
}

test("spacing joins speech to existing text naturally", () => {
  assert.equal(joinSpacing("", "Hello"), "Hello");
  assert.equal(joinSpacing("d", "Hello"), " Hello");
  assert.equal(joinSpacing(" ", "Hello"), "Hello");
  assert.equal(joinSpacing("\n", "Hello"), "Hello");
  assert.equal(joinSpacing("(", "Hello"), "Hello");
  assert.equal(joinSpacing("d", ", and"), ", and");
  assert.equal(joinSpacing("d", ". Next"), ". Next");
  assert.equal(joinSpacing("。", "不要问"), "不要问");
  assert.equal(joinSpacing("a", "国があなた"), "国があなた");
  assert.equal(joinSpacing("다", "안녕하세요"), " 안녕하세요");
});

test("recognises which elements can be dictated into", () => {
  const { $ } = page(`
    <textarea id="ta"></textarea><input id="text"><input id="search" type="search"><input id="pw" type="password">
    <input id="num" type="number"><input id="ro" readonly><textarea id="dis" disabled></textarea>
    <div id="ce" contenteditable="true"><b id="inner">x</b></div><div id="plain">x</div><button id="b">b</button>`);
  for (const id of ["ta", "text", "search"]) assert.equal(editableFrom($(`#${id}`)), $(`#${id}`), id);
  for (const id of ["pw", "num", "ro", "dis", "plain", "b"]) assert.equal(editableFrom($(`#${id}`)), undefined, id);
  assert.equal(editableFrom(null), undefined);
  const detached = $("#ta").cloneNode() as HTMLElement;
  assert.equal(editableFrom(detached), undefined, "a removed field is not a target");
});

test("types into a field at the caret, firing input events like typing", () => {
  const { $ } = page(`<textarea id="ta">Notes: ok</textarea>`);
  const field = $<HTMLTextAreaElement>("#ta");
  const events: string[] = [];
  field.addEventListener("input", event => events.push(`${(event as InputEvent).inputType}:${(event as InputEvent).data}`));
  field.focus();
  field.setSelectionRange(6, 6); // after "Notes:"
  const inserter = new Inserter(field);
  inserter.add("The mito");
  assert.equal(field.value, "Notes: The mito ok");
  inserter.add("chondria is");
  inserter.add(" the powerhouse.");
  assert.equal(field.value, "Notes: The mitochondria is the powerhouse. ok");
  assert.equal(field.selectionStart, "Notes: The mitochondria is the powerhouse.".length, "caret follows the words");
  assert.deepEqual(events, ["insertText: The mito", "insertText:chondria is", "insertText: the powerhouse."]);
  assert.equal(inserter.placed, " The mitochondria is the powerhouse.");
  assert.equal(inserter.unplaced, "");
});

test("replaces a selection, and keeps typing after the learner moves the caret", () => {
  const { $ } = page(`<input id="in" value="alpha beta gamma">`);
  const field = $<HTMLInputElement>("#in");
  field.focus();
  field.setSelectionRange(6, 10); // "beta"
  const inserter = new Inserter(field);
  inserter.add("delta");
  assert.equal(field.value, "alpha delta gamma");
  field.setSelectionRange(field.value.length, field.value.length);
  inserter.add(" epsilon");
  assert.equal(field.value, "alpha delta gamma epsilon");
});

test("still types into a field that lost focus to a toolbar button", () => {
  const { $, document } = page(`<textarea id="ta">Answer</textarea><button id="b">Dictate</button>`);
  const field = $<HTMLTextAreaElement>("#ta");
  field.focus();
  field.setSelectionRange(6, 6);
  $("#b").focus();
  assert.equal(deepActiveElement(document), $("#b"));
  const inserter = new Inserter(field);
  inserter.add("forty two");
  assert.equal(field.value, "Answer forty two");
});

test("holds words when there is no field and types them once one is adopted", () => {
  const { $ } = page(`<textarea id="ta"></textarea>`);
  const inserter = new Inserter(undefined);
  inserter.add("Hello");
  inserter.add(" world");
  assert.equal(inserter.unplaced, "Hello world");
  assert.equal(inserter.flush(), false);
  const field = $<HTMLTextAreaElement>("#ta");
  inserter.adopt(field);
  assert.equal(field.value, "Hello world");
  assert.equal(inserter.unplaced, "");
  // A live target is not replaced by a later focus elsewhere.
  const other = field.ownerDocument.createElement("textarea");
  field.ownerDocument.body.append(other);
  inserter.adopt(other);
  inserter.add(" again");
  assert.equal(field.value, "Hello world again");
  assert.equal(other.value, "");
});

test("moves on when its field disappears, and never drops the words", () => {
  const { $, document } = page(`<textarea id="ta"></textarea>`);
  const field = $<HTMLTextAreaElement>("#ta");
  const inserter = new Inserter(field);
  inserter.add("one");
  field.remove();
  inserter.add(" two");
  assert.equal(inserter.unplaced, " two");
  const next = document.createElement("textarea");
  next.value = "Draft";
  document.body.append(next);
  next.setSelectionRange(5, 5);
  inserter.adopt(next);
  assert.equal(next.value, "Draft two");
  inserter.add(" three");
  next.readOnly = true;
  inserter.add(" four");
  assert.equal(inserter.takeUnplaced(), " four");
  assert.equal(inserter.unplaced, "");
});

test("types into rich-text editors when they hold the caret", () => {
  const { $, document } = page(`<div id="ce" contenteditable="true">Hello</div><button id="b">b</button>`);
  const editor = $("#ce");
  // jsdom does not compute isContentEditable.
  Object.defineProperty(editor, "isContentEditable", { value: true });
  const events: string[] = [];
  editor.addEventListener("beforeinput", event => events.push(`before:${(event as InputEvent).data}`));
  editor.addEventListener("input", event => events.push(`input:${(event as InputEvent).data}`));
  editor.focus();
  const selection = document.getSelection()!;
  selection.collapse(editor.firstChild, 5);
  const inserter = new Inserter(editor);
  inserter.add("world");
  assert.equal(editor.textContent, "Hello world");
  assert.deepEqual(events, ["before: world", "input: world"]);
  inserter.add(" again");
  assert.equal(editor.textContent, "Hello world again");
  // Without the caret inside it, words wait instead of landing somewhere arbitrary.
  $("#b").focus();
  selection.removeAllRanges();
  inserter.add(" later");
  assert.equal(editor.textContent, "Hello world again");
  assert.equal(inserter.unplaced, " later");
});

test("an editor that handles beforeinput itself is not edited twice", () => {
  const { $, document } = page(`<div id="ce" contenteditable="true"></div>`);
  const editor = $("#ce");
  Object.defineProperty(editor, "isContentEditable", { value: true });
  const own: string[] = [];
  editor.addEventListener("beforeinput", event => { event.preventDefault(); own.push((event as InputEvent).data ?? ""); });
  editor.focus();
  document.getSelection()!.collapse(editor, 0);
  const inserter = new Inserter(editor);
  inserter.add("mine");
  assert.deepEqual(own, ["mine"]);
  assert.equal(editor.textContent, "");
  assert.equal(inserter.unplaced, "");
});

test("remembers the last field across a focus change and ignores its own controls", () => {
  const { $, document } = page(`<textarea id="a"></textarea><input id="b"><div id="hud"><input id="mine"></div><button id="btn">x</button>`);
  const memory = new FocusMemory(document, element => $("#hud").contains(element));
  assert.equal(memory.current(), undefined);
  $("#a").focus();
  assert.deepEqual(memory.current(), { element: $("#a"), focused: true });
  $("#btn").focus();
  assert.deepEqual(memory.current(), { element: $("#a"), focused: false });
  $("#mine").focus();
  assert.deepEqual(memory.current(), { element: $("#a"), focused: false }, "the indicator's own inputs are never a target");
  $("#b").focus();
  assert.deepEqual(memory.current(), { element: $("#b"), focused: true });
  $("#btn").focus();
  $("#b").remove();
  assert.equal(memory.current(), undefined, "a removed field is forgotten");
  memory.dispose();
  $("#a").focus();
  $("#btn").focus();
  assert.equal(memory.current(), undefined, "no tracking after disposal");
});
