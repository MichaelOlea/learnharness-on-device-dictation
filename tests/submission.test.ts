import assert from "node:assert/strict";
import test from "node:test";
import type { PluginSubmission } from "learnharness-plugin-api";
import { appendDictation } from "../src/submission.ts";

const content = (text: string) => ({ text, images: [] });
const text = (value: string): PluginSubmission => ({ type: "text", content: content(value) });

test("extends the message that was being dictated", () => {
  const typed = " I think the answer is forty two because each step";
  const result = appendDictation(text("Notes: I think the answer is forty two because each step"), typed, " doubles the previous value");
  assert.deepEqual(result, text("Notes: I think the answer is forty two because each step doubles the previous value"));
  // Punctuation and missing spaces are joined the same way as in the field.
  assert.equal((appendDictation(text("so it is forty two"), "so it is forty two", ". Next") as { content: { text: string } }).content.text, "so it is forty two. Next");
  assert.equal((appendDictation(text("so it is forty two"), "so it is forty two", "doubles") as { content: { text: string } }).content.text, "so it is forty two doubles");
  assert.equal((appendDictation({ type: "thinking", content: content("my reasoning so far") }, "my reasoning so far", " continues") as { content: { text: string } }).content.text, "my reasoning so far continues");
});

test("a whole short dictation still in flight fills an empty message only", () => {
  assert.deepEqual(appendDictation(text(""), "", "Explain entropy"), text("Explain entropy"));
  assert.equal(appendDictation(text("typed by hand"), "", "Explain entropy"), undefined);
});

test("leaves the submission alone when it cannot tell where the words belong", () => {
  assert.equal(appendDictation(text("something else entirely"), "I was dictating a different field", " more"), undefined);
  assert.equal(appendDictation(text("edited after dictating!"), "edited after dictating", " more"), undefined);
  assert.equal(appendDictation(text("abc"), "abc", " more"), undefined, "too little typed text to recognise");
  assert.equal(appendDictation(text("whatever"), "whatever was said", "   "), undefined, "nothing to add");
});

test("picks the one matching field of a question answer", () => {
  const answer = (answerText: string | undefined, thinking: string, reading: string): PluginSubmission => ({
    type: "answer", answer: { ...(answerText === undefined ? {} : { text: answerText }), images: [] },
    thinking: content(thinking), readingThinking: content(reading),
  });
  const typed = "because the slope doubles";
  assert.deepEqual(appendDictation(answer("It is B because the slope doubles", "", ""), typed, " each time"), answer("It is B because the slope doubles each time", "", ""));
  assert.deepEqual(appendDictation(answer("B", "because the slope doubles", ""), typed, " each time"), answer("B", "because the slope doubles each time", ""));
  assert.deepEqual(appendDictation(answer(undefined, "", "because the slope doubles"), typed, " each time"), answer(undefined, "", "because the slope doubles each time"));
  assert.equal(appendDictation(answer("because the slope doubles", "because the slope doubles", ""), typed, " x"), undefined, "ambiguous");
  assert.equal(appendDictation(answer("B", "", ""), typed, " x"), undefined);
  assert.equal(appendDictation(answer(undefined, "", ""), "", "whole phrase"), undefined, "empty fields are ambiguous for answers");
});

test("plugin questions and problems only ever get thinking text extended", () => {
  const question: PluginSubmission = {
    type: "plugin-question-answer", answer: { code: "print(1)" }, answerImages: [],
    thinking: content("my approach is recursion"), readingThinking: content(""),
  };
  const extended = appendDictation(question, "my approach is recursion", " with memoization") as typeof question;
  assert.equal(extended.thinking.text, "my approach is recursion with memoization");
  assert.deepEqual(extended.answer, { code: "print(1)" });
  const problem: PluginSubmission = { type: "plugin-problem-submission", submission: { code: "x" }, submissionImages: [], thinking: content("first I sort the list") };
  assert.equal((appendDictation(problem, "first I sort the list", " then scan") as typeof problem).thinking.text, "first I sort the list then scan");
  assert.equal(appendDictation(problem, "something unrelated to it", " then scan"), undefined);
});
