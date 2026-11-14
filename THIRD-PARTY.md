# Third-party components

## Bundled into this plugin's `dist/`

| Component | Version | Licence | Used for |
| --- | --- | --- | --- |
| [unbzip2-stream](https://github.com/regular/unbzip2-stream) | 1.4.3 | MIT | Unpacking the model archive without native code |
| [through](https://github.com/dominictarr/through) | 2.3.8 | MIT or Apache-2.0 | Dependency of unbzip2-stream |

Their licence texts are copied into `dist/licenses/` by the build.

From the LearnHarness project (AGPL-3.0, as is this plugin), taken from its plugin
authoring kit for version 0.6.1:

- `scripts/install-plugin-local.mjs` — the portable local installer;
- `vendor/learnharness-plugin-api/` — the type-only plugin SDK used for type checking
  (not part of the built plugin).

## Downloaded on your request, not distributed with this plugin

These are fetched from their publishers when you choose **Download and install**, and
verified against the checksums pinned in `src/contract.ts`.

| Component | Version | Licence | Source |
| --- | --- | --- | --- |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) Node addon (`sherpa-onnx-<platform>`) | 2.0.1 | Apache-2.0 | registry.npmjs.org |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime), inside that package | 1.28.2 | MIT | registry.npmjs.org |
| [NVIDIA Nemotron 3.5 ASR Streaming 0.6B](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b), int8 ONNX export by the sherpa-onnx project (`sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-<N>ms-int8-2026-06-11`) | 2026-06-11 | [OpenMDW-1.1](https://openmdw.ai/license/1-1/) | github.com/k2-fsa/sherpa-onnx releases (`asr-models`) |

By downloading the model you accept NVIDIA's licence terms for it.

## Development only

esbuild, TypeScript, tsx, jsdom, playwright-core, React and the LearnHarness
`learnharness-plugin-api` type-only SDK are used to build and test and are not part of
the built plugin.
