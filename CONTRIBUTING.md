# Contributing

Issues and pull requests are welcome. Note that this project was written entirely by AI
(see [AI_DISCLOSURE.md](AI_DISCLOSURE.md)); contributions from humans and AI tools are
both fine — please say which in your pull request.

## Reporting a problem

Open an [issue](../../issues/new/choose) and include your operating system and CPU,
your LearnHarness version, the plugin version, and the message shown (the plugin's
settings page shows engine errors).

## Setup

Node.js 20.3 or newer, plus `tar` and `bzip2` for the installer test fixtures.

```sh
npm ci
npm run build       # dist/ — what LearnHarness loads
npm run typecheck
npm test            # builds, then runs tests/*.test.ts (72 tests, no network)
npm run package     # release/on-device-dictation.zip
```

`npm run install:local -- "<plugins directory>"` builds and installs `dist/` into a
LearnHarness plugins directory, keeping its `data/`. Restart LearnHarness to load
changed code.

## End-to-end tests

These use the real downloads (~486 MB), a real Chrome/Chromium, and a 16 kHz mono WAV
file as the microphone. They are not run in CI.

```sh
export ODD_E2E_WAV=/path/to/speech-16k-mono.wav
export ODD_E2E_EXPECT="first|words|you|say"     # words the transcript must contain

# real installer + engine, and the live-typing button in a stand-in window
ODD_E2E_DATA=/tmp/odd-data npx tsx --test --test-concurrency=1 tests/e2e/real.e2e.ts tests/e2e/browser.e2e.ts

# inside a running LearnHarness checkout (npx next dev -p 3005, with LH_DATA_DIR set
# and this plugin installed and enabled in <LH_DATA_DIR>/plugins/)
ODD_APP_URL=http://localhost:3005 npx tsx --test --test-concurrency=1 tests/e2e/app.e2e.ts
```

`ODD_E2E_FRESH=1` also exercises a from-scratch download through the dialogs;
`ODD_CHROME` selects the browser; `ODD_E2E_SHOTS` saves screenshots.

## Guidelines

- Follow LearnHarness's plugin rules (`vendor/learnharness-plugin-api` and its
  authoring guide): no private host imports, clean up everything on disable, never
  write outside `ctx.dataDirectory`.
- The built-in replacement must stay invisible when switched off and must pass all
  non-Deepgram traffic through unchanged.
- Never `terminate()` the in-process engine worker (see docs/ARCHITECTURE.md).
- Changing a pinned download means updating its size and hashes in `src/contract.ts`.
- Add a test for each behaviour change.

By contributing you agree your contribution is licensed under AGPL-3.0-only.
