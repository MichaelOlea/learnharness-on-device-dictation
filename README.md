# On-device dictation for LearnHarness

[![CI](https://github.com/MichaelOlea/learnharness-on-device-dictation/actions/workflows/ci.yml/badge.svg)](https://github.com/MichaelOlea/learnharness-on-device-dictation/actions/workflows/ci.yml)
![LearnHarness 0.6.1](https://img.shields.io/badge/LearnHarness-0.6.1-555)
![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)
![Made 100% with AI](https://img.shields.io/badge/made%20100%25%20with-AI-8A2BE2)

A [LearnHarness](https://github.com/amosblomqvist/learnharness) plugin that makes the
app's own **Dictate** button transcribe your speech **on your computer** instead of
sending it to Deepgram. Same button, same shortcut, same recording meter — but no
Deepgram key, no account, and no audio leaving your device.

The speech model is NVIDIA's
[`nemotron-3.5-asr-streaming-0.6b`](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b),
the model VS Code's built-in dictation runs on-device. After a one-time download it
works offline.

> [!IMPORTANT]
> **This project was made 100% with AI.** All code, tests and documentation were written
> by Anthropic's Claude; a human asked for it, steered it and tested it on Linux, but
> has not reviewed the code line by line. See [AI_DISCLOSURE.md](AI_DISCLOSURE.md).
>
> It is an independent community plugin, **not affiliated with or endorsed by**
> LearnHarness, NVIDIA, Deepgram or the sherpa-onnx project.

## Contents

- [Install](#install)
- [Using it](#using-it)
- [Settings](#settings)
- [Requirements](#requirements)
- [Privacy](#privacy)
- [Testing status](#testing-status)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)
- [Building from source](#building-from-source)
- [Licence](#licence)

## Install

1. Download **`on-device-dictation.zip`** from the
   [latest release](https://github.com/MichaelOlea/learnharness-on-device-dictation/releases/latest).
2. In LearnHarness open **Settings → Community plugins** and note the plugins directory.
3. Extract the zip into that directory so the result is

   ```
   <plugins directory>/on-device-dictation/dist/manifest.json
   ```

   "Extract All" on the downloaded file does this, because the folder is named after
   the zip. If you end up with a different folder name or an extra nesting level, fix
   it so the path above exists — otherwise LearnHarness reports
   *"Missing plugin build: expected dist/manifest.json"*.
4. Choose **Refresh** and enable **On-device dictation**.
5. Press **Dictate** as usual. The first time, a dialog explains the one-time download
   and starts it only when you choose **Download and install**:

   | What | Size | From |
   | --- | --- | --- |
   | Speech engine (sherpa-onnx + ONNX Runtime, for your platform) | 8–14 MB | registry.npmjs.org |
   | Nemotron 3.5 ASR model, int8 | 475 MB | github.com (k2-fsa/sherpa-onnx releases) |

   Both are checked against pinned checksums. Unpacking takes about a minute; installing
   needs ~1.2 GB of free disk (0.7 GB afterwards). Then press **Dictate** again.

**Updating:** replace only `dist/`, then restart LearnHarness. Downloads and settings
live in the sibling `data/` folder and are kept.

## Using it

Exactly as before: press **Dictate** (or LearnHarness's dictation shortcut), speak,
press **Stop**; **Esc** cancels. As with the built-in engine, the text appears when you
stop, in the composer or the question field LearnHarness would have used. Every place
LearnHarness offers dictation shares the same connection, so all of them are covered.

You can leave **Settings → Dictation → Deepgram** empty. The **Language** chosen there
is still honoured: it is mapped to the closest of the model's 40 locales, and languages
the model does not cover are detected automatically.

Differences from Deepgram you may notice:

- The very last sentence of a dictation usually ends without a full stop (the model
  writes a sentence's full stop together with the first word of the next one).
- Numbers are written as spoken ("forty two"); there is no smart formatting.
- If the model is not loaded yet and you dictate only a second or two, the words can
  finish after LearnHarness has stopped waiting. They are then added to the end of the
  field you were in a moment later (or offered with a Copy button if there is none).

## Settings

Open **Settings → On-device dictation**.

| Setting | Default | What it does |
| --- | --- | --- |
| Replace built-in dictation | on | Off returns the Dictate button to Deepgram. |
| Language | same as LearnHarness | Or detect automatically, or pin one of 40 locales. |
| Responsiveness | 0.56 s | Model variant: 0.16, 0.32, 0.56 or 1.1 s steps. Larger is more accurate and uses less CPU; each is its own 475 MB download. |
| Load the model when LearnHarness starts | on | Makes the first dictation instant. |
| Release the model after idle minutes | 30 | The loaded model uses about 1 GB of memory. 0 keeps it loaded. |
| CPU threads | automatic | Half your cores, at most four. |
| Where the speech engine runs | automatic | Inside LearnHarness, or a separate Node.js process (needed on macOS). |
| Node.js path | found automatically | For the separate-process engine. |
| Extra: live-typing button | off | A separate microphone button and shortcut (Ctrl/Cmd+Shift+M) that types words at the cursor *while* you speak. |

**Remove downloaded files** deletes the engine and models (not your settings).

## Requirements

- **LearnHarness 0.6.1.** The replacement relies on how this version talks to Deepgram
  (see [How it works](#how-it-works)). After a LearnHarness update, check for a plugin
  update if Dictate misbehaves — or switch the replacement off to get the original
  behaviour back.
- Windows x64/Arm64; Linux x64 (glibc 2.32+) or Arm64; macOS 14+ on Apple silicon or
  macOS 15+ on Intel.
- **macOS also needs [Node.js](https://nodejs.org) installed.** LearnHarness's signed
  macOS app is built without the exception that would let it load third-party native
  libraries, so there the plugin runs the engine in a separate Node.js process.
- ~1 GB of free memory while the model is loaded. On a slow 2-core test machine the
  default model needed about 0.6 s of one core per second of speech, so it keeps up;
  the 0.16 s variant did not.

## Privacy

Audio goes from the LearnHarness window to this plugin's backend inside the same app
(over LearnHarness's local plugin bridge), is transcribed by a library running on your
computer, and is discarded; it is never written to disk. With the replacement on,
LearnHarness's Deepgram token route is not called and no connection to Deepgram is
opened. The only network requests the plugin itself makes are the two downloads above,
and only when you ask for them.

## Testing status

| Where | Result |
| --- | --- |
| Linux x64, the owner's own computer | Works (reported by the owner) |
| Linux x64, LearnHarness 0.6.1 run from source, real Dictate button, real model, Chromium with a WAV file as microphone | Automated tests pass (`tests/e2e/app.e2e.ts`) |
| Linux x64, real model and installer | Automated tests pass (`tests/e2e/real.e2e.ts`, `tests/e2e/browser.e2e.ts`) |
| Unit and integration tests (72) | Pass in CI |
| Windows, macOS, packaged desktop app on those systems | **Not tested yet** — reports welcome |

## Troubleshooting

- **"Missing plugin build: expected dist/manifest.json"** — the folder is nested or
  misnamed; see [Install](#install) step 3.
- **Dictate shows "Dictation needs a Deepgram key"** — the plugin is not enabled, or
  *Replace built-in dictation* is off.
- **macOS: "only loads native libraries signed by its own publisher"** — install Node.js.
- **Windows: "The specified module could not be found"** — install the current Microsoft
  Visual C++ Redistributable.
- **Text is late or dictation stops as "too slow"** — choose a larger Responsiveness
  step or raise CPU threads.
- **The download fails behind a proxy or offline** — open the plugin's settings, expand
  **Install without a download**, fetch the listed files elsewhere, put them in the
  folder shown (`<plugins directory>/on-device-dictation/data/downloads/`) and choose
  **Download and install**. Files already there are verified and used.

## How it works

LearnHarness has no setting or plugin API for choosing a speech engine, so the plugin
takes Deepgram's place at the two points where the app's window talks to it
([`src/builtin.ts`](src/builtin.ts)):

1. the request for a Deepgram token (`/api/stt/token`) is answered locally with a
   placeholder, so no key is needed and the real route is never called;
2. the WebSocket LearnHarness opens to `wss://api.deepgram.com/v1/listen` is replaced by
   a local object that speaks the same small protocol (16-bit PCM in, final `Results`
   out, `CloseStream` to finish) but hands the audio to the on-device engine.

Every other request and socket in the app is passed through untouched, and the
replacement removes itself when the plugin is disabled. This is an intervention in the
app's internals rather than a supported extension point: it was built against and
tested with LearnHarness 0.6.1, and refuses to step in (with a message) if the audio
format it sees is not the one it knows.

```
LearnHarness Dictate → mic → 16 kHz PCM → [local stand-in for the Deepgram socket]
      → plugin backend → engine thread → sherpa-onnx → ONNX Runtime → Nemotron 3.5
      → final text → LearnHarness types it where it always does
```

More detail, including the source layout, is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Building from source

```sh
git clone https://github.com/MichaelOlea/learnharness-on-device-dictation.git
cd learnharness-on-device-dictation
npm ci
npm run build          # writes dist/
npm test               # unit and integration tests (needs tar and bzip2)
npm run package        # release/on-device-dictation.zip
```

To develop inside a LearnHarness installation, run
`npm run install:local -- "<plugins directory>"`. See [CONTRIBUTING.md](CONTRIBUTING.md)
for the end-to-end tests.

## Licence

[AGPL-3.0-only](LICENSE), the licence of LearnHarness and its plugin examples.
Third-party components, including the separately downloaded engine and model (NVIDIA
OpenMDW-1.1), are listed in [THIRD-PARTY.md](THIRD-PARTY.md).
