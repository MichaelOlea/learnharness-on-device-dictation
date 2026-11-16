# Architecture

> Written by AI, like the rest of this project — see [AI_DISCLOSURE.md](../AI_DISCLOSURE.md).

## Big picture

```
LearnHarness window                         LearnHarness server (Node.js)
┌───────────────────────────────┐          ┌───────────────────────────────────────┐
│ built-in Dictate (unchanged)  │          │ plugin backend (src/backend.ts)       │
│   mic → AudioWorklet → PCM    │          │   settings, installer, sessions       │
│   fetch /api/stt/token ───────┼─╳ local  │                                       │
│   new WebSocket(deepgram) ────┼─╳ local  │   Sessions (src/sessions.ts)          │
│        │                      │          │     one live dictation per app        │
│  LocalDictationSocket ────────┼─ plugin ─┼──►  │                                  │
│  (src/builtin.ts)             │  bridge  │     ▼                                 │
│                               │  (JSON)  │   EngineHost (src/engine-host.ts)     │
│ optional live-typing button   │          │     worker thread, or Node process    │
│  (src/main.ts, capture.ts,    │          │     ▼                                 │
│   insert.ts, hud.ts)          │          │   engine-worker → sherpa-onnx addon   │
└───────────────────────────────┘          │     → ONNX Runtime → Nemotron 3.5     │
                                           └───────────────────────────────────────┘
```

## The Deepgram stand-in (`src/builtin.ts`)

LearnHarness 0.6.1's dictation (`components/dictation.tsx` in its source):

1. `GET /api/stt/token` → `{ token }` (a short-lived Deepgram token);
2. `new WebSocket("wss://api.deepgram.com/v1/listen?…encoding=linear16&sample_rate=16000…", ["bearer", token])`;
3. sends 16-bit mono PCM frames, queued until `open`;
4. reads messages with `type: "Results"` and `is_final: true`, collecting
   `channel.alternatives[0].transcript`;
5. to stop, sends `{"type":"CloseStream"}`; a close with code 1000 ends the run and the
   collected finals are joined with spaces and inserted. It gives up after 3 s.
6. any other close code triggers one reconnect with a fresh token, then an error.

The plugin wraps `window.fetch` and `window.WebSocket` while it is enabled:

- the token request returns `{ token: "on-device-dictation" }` without touching the
  network (it waits for the plugin's saved settings first, if they are not loaded);
- a socket to the Deepgram listen URL becomes a `LocalDictationSocket`, which opens
  asynchronously, forwards audio to the backend, emits `Results` finals and closes
  with 1000 within the 3 s window. Finals are cut only at spaces and the newest word
  is held back, because the model attaches punctuation to it later. Text that misses
  the window is appended to the field afterwards.
- everything else goes to the real implementations. A socket opened with the
  placeholder token is always handled locally (Deepgram would only reject it).

## Backend

- **Sessions** (`src/sessions.ts`): one live dictation for the whole app; audio pushes
  return newly recognised text, so delivery is plain request/response. Sessions that
  stop receiving audio, fall too far behind, or run over 20 minutes are ended.
- **EngineHost** (`src/engine-host.ts`): runs `engine-worker.cjs` in a worker thread,
  or — when the native library cannot load in-process (macOS hardened runtime) — as a
  separate Node.js process. The worker is **never force-terminated**: interrupting the
  native library mid-call aborts the whole process, so it is asked to leave and exits
  when its current call returns.
- **Installer** (`src/installer.ts`, `src/extract-worker.ts`, `src/tar.ts`): resumable
  download with stall detection, archive and per-file SHA checks, streaming unpack of
  only the expected files into a fresh directory, atomic rename. Files placed in
  `data/downloads/` by hand are used instead of fetched.
  A model can also be published as separate files instead of one archive (the
  full-precision export is). Those are fetched one by one into
  `data/downloads/<model directory>/` as `<name>.fetched`, each is hashed on the worker
  thread, and only when all match are they moved into a fresh directory that is then
  renamed into place. A file the learner put there under its plain name is used
  instead, and is never deleted if it fails its checksum.

## Pinned downloads

`src/contract.ts` lists, per platform, the `sherpa-onnx-<platform>@2.0.1` npm tarball
with its npm integrity hash, and per latency the sherpa-onnx export of the NVIDIA model
with the archive SHA-256 and the SHA-256 and size of each file used.

The model catalog is keyed by latency and by precision (`modelFor(latency, precision)`):

- `int8` — `MODELS`, the compact 8-bit archives from the sherpa-onnx GitHub release.
  One exists for every latency, and it is the default.
- `fp32` — `FULL_PRECISION_MODELS`, the unquantized export, listed file by file with a
  Hugging Face URL pinned to a commit. A latency without an entry is simply not offered
  in full precision, and the "Model size and precision" setting is hidden if the
  table is empty. The 2.45 GB weights file is byte-identical in all four packages,
  but each package still installs its own copy.

Both precisions install into their own directory, so switching back and forth does not
download anything twice.

## Source layout

| File | Role |
| --- | --- |
| `src/main.ts` | Frontend entry: wiring, settings page, optional live button |
| `src/builtin.ts` | Deepgram stand-in for the built-in Dictate button |
| `src/panel.ts` | Install card, set-up dialog, settings rows |
| `src/capture.ts`, `src/pcm-worklet.ts` | Microphone capture (live button) |
| `src/insert.ts`, `src/hud.ts`, `src/submission.ts` | Typing at the caret, indicator, send-time handling (live button) |
| `src/backend.ts` | Backend entry and JSON operations |
| `src/sessions.ts` | Dictation sessions |
| `src/engine-host.ts`, `src/engine-worker.ts` | Native speech engine lifecycle |
| `src/installer.ts`, `src/extract-worker.ts`, `src/tar.ts` | Downloads and unpacking |
| `src/contract.ts` | Shared types, settings, catalog, language mapping |
| `vendor/learnharness-plugin-api/` | LearnHarness's type-only plugin SDK (from its authoring kit) |
