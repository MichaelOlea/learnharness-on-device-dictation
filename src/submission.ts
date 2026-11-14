/** Words still in flight when the learner presses Send.
 *
 * The host captures a submission before interceptors run, so words recognised
 * after that moment can only reach the message through the interceptor's return
 * value. They are appended to a text channel only when that channel is
 * demonstrably the text being dictated; otherwise the submission is left alone. */
import type { PluginSubmission } from "learnharness-plugin-api";
import { joinSpacing } from "./insert.ts";

/** Enough trailing characters to recognise our own typing without false matches. */
const MARKER_LENGTH = 24;
const MIN_MARKER = 6;

function extend(text: string, words: string): string {
  return text + joinSpacing(text.slice(-1), words.replace(/^\s+/, ""));
}

/** Return the submission with `words` appended to the dictated channel, or
 * undefined when no channel can be identified with confidence. `typed` is the
 * text this dictation already put into the field. */
export function appendDictation(input: PluginSubmission, typed: string, words: string): PluginSubmission | undefined {
  if (!words.trim()) return undefined;
  const marker = typed.trimEnd().slice(-MARKER_LENGTH);
  const matches = (text: string) =>
    marker.length >= MIN_MARKER ? text.trimEnd().endsWith(marker)
    // Nothing (or almost nothing) was typed yet: only an empty message is unambiguous.
    : typed.trim() === "" && text.trim() === "";

  switch (input.type) {
    case "text":
    case "thinking":
      return matches(input.content.text) ? { ...input, content: { ...input.content, text: extend(input.content.text, words) } } : undefined;
    case "answer": {
      // A free-text answer and the two thinking fields can each hold dictation.
      // An empty set of fields is ambiguous here, so require a real match.
      if (marker.length < MIN_MARKER) return undefined;
      const hits: ("answer" | "thinking" | "readingThinking")[] = [];
      if (typeof input.answer.text === "string" && matches(input.answer.text)) hits.push("answer");
      if (matches(input.thinking.text)) hits.push("thinking");
      if (matches(input.readingThinking.text)) hits.push("readingThinking");
      if (hits.length !== 1) return undefined;
      if (hits[0] === "answer") return { ...input, answer: { ...input.answer, text: extend(input.answer.text ?? "", words) } };
      const channel = hits[0]!;
      return { ...input, [channel]: { ...input[channel], text: extend(input[channel].text, words) } };
    }
    case "plugin-question-answer": {
      if (marker.length < MIN_MARKER) return undefined;
      const thinking = matches(input.thinking.text);
      const reading = matches(input.readingThinking.text);
      if (thinking === reading) return undefined;
      const channel = thinking ? "thinking" : "readingThinking";
      return { ...input, [channel]: { ...input[channel], text: extend(input[channel].text, words) } };
    }
    case "plugin-problem-submission":
      if (marker.length < MIN_MARKER || !matches(input.thinking.text)) return undefined;
      return { ...input, thinking: { ...input.thinking, text: extend(input.thinking.text, words) } };
  }
}
