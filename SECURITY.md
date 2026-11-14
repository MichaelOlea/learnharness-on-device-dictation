# Security

## What this plugin can do

LearnHarness plugins are trusted local code without a sandbox. This plugin:

- runs code in the LearnHarness window and server, and loads a native library
  (sherpa-onnx with ONNX Runtime) into the server or a child Node.js process;
- downloads two files, only when you choose to, from fixed URLs on registry.npmjs.org
  and github.com, and refuses them unless their pinned hashes match;
- writes only inside its own data folder (`<plugins directory>/on-device-dictation/data/`);
- while "Replace built-in dictation" is on, intercepts exactly two things in the
  LearnHarness window: GET `/api/stt/token` and WebSockets to
  `wss://api.deepgram.com/v1/listen`. Everything else is passed through.

The code was written by AI and has not been audited by a human
([AI_DISCLOSURE.md](AI_DISCLOSURE.md)). Review it before installing if that matters to you.

## Reporting a vulnerability

Please use GitHub's private reporting:
[Security → Report a vulnerability](../../security/advisories/new). Do not open a
public issue for security problems.
