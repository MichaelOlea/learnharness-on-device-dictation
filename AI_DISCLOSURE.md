# AI disclosure

**This project was made 100% with AI.** Every line of code, every test, every build
script and every document in this repository was written by an AI model — Anthropic's
Claude (Claude Fable 5.2 and Claude Opus 5.5), working in an agentic coding session.
No part was written by hand.

## What the human did

The repository owner, [@MichaelOlea](https://github.com/MichaelOlea):

- asked for the plugin and described what it should do: make LearnHarness dictation
  run on-device, the way VS Code's dictation does with NVIDIA Nemotron 3.5 ASR, as a
  drop-in replacement for the Deepgram-based Dictate button;
- supplied the LearnHarness plugin authoring kit (the official, downloadable
  "authoring skill") that the AI worked from;
- reported problems (a packaging mistake in the first version, and that the first
  version added a separate button instead of replacing the existing one);
- installed and tried the result on their own Linux computer and confirmed it works;
- asked for this repository to be published.

## What the AI did

- read the LearnHarness plugin documentation, its type definitions and the LearnHarness
  0.6.1 source code to learn how the built-in dictation talks to Deepgram;
- researched the Nemotron 3.5 ASR model and the sherpa-onnx runtime that runs it;
- downloaded the real model and runtime, measured speed and accuracy, and pinned
  their checksums;
- designed and wrote all of the plugin's source code, tests and build scripts;
- ran the tests: unit tests, end-to-end tests with the real model in a real Chromium
  using a WAV file as the microphone, and tests that click the Dictate button of a
  locally running LearnHarness 0.6.1;
- wrote this documentation and prepared the repository and its release.

## What that means for you

- The code has been tested as described in the [README](README.md#testing-status), but
  it has **not been reviewed line by line by a human**. Read it before you trust it,
  as you would any third-party plugin — LearnHarness plugins are trusted local code
  with full access to your computer.
- Real-world testing so far: Linux (by the AI in its environment and by the owner on
  their computer). Windows and macOS have not been tried.
- Mistakes are possible. Please [open an issue](../../issues) if you find one.

The third-party components this plugin downloads or bundles (sherpa-onnx, ONNX
Runtime, the NVIDIA model, unbzip2-stream) were of course written by their own authors;
see [THIRD-PARTY.md](THIRD-PARTY.md). The vendored type definitions in
`vendor/learnharness-plugin-api/` come from the LearnHarness project.
