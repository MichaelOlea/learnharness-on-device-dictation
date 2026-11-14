/** The optional live-typing button of the built plugin, end to end, in a real
 * Chromium (the built-in Dictate replacement is tested against the real app in
 * app.e2e.ts):
 *
 *   fake microphone (a WAV file) -> getUserMedia -> AudioWorklet -> JSON bridge
 *   -> built backend -> engine worker -> real Nemotron model -> text typed into
 *   a React-controlled composer.
 *
 * The page (page.tsx) stands in for a LearnHarness window; it is not the app.
 *
 * Environment:
 *   ODD_E2E_DATA    data directory with the engine and model already installed
 *   ODD_E2E_WAV     16 kHz mono WAV the fake microphone plays
 *   ODD_E2E_EXPECT  words that must appear, separated by "|"
 *   ODD_CHROME      Chromium/Chrome executable (default: common locations)
 *   ODD_E2E_FRESH   set to 1 to also run first-time setup with a real download
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Status } from "../../src/contract.ts";
import { activateBackend, type FakeHost } from "./host.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dist = path.join(root, "dist");
const data = process.env.ODD_E2E_DATA;
const wav = process.env.ODD_E2E_WAV;
const expected = (process.env.ODD_E2E_EXPECT ?? "").split("|").filter(Boolean);
const executable = process.env.ODD_CHROME ?? ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(file => fs.existsSync(file));
const skip = !data || !wav || !executable;

const TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Plugin test window</title>
<link rel="stylesheet" href="/plugin/styles.css">
<style>:root{--background:#fff;--foreground:#111;--border:#ccc;--muted:#eee;--muted-foreground:#666;--destructive:#c00;--popover:#fff;--popover-foreground:#111}
body{font-family:sans-serif;margin:2rem}.test-dialog{position:fixed;inset:10% 20%;background:#fff;border:1px solid #888;overflow:auto;z-index:10}</style></head>
<body><div id="app"></div><h3>Settings</h3><div id="settings"></div><script type="module" src="/harness.js"></script></body></html>`;

let harness = "";
let browser: Browser;

/** One fake LearnHarness: backend + HTTP bridge + page. */
async function open(dataDirectory: string): Promise<{ page: Page; host: FakeHost; loaded: string[]; close(): Promise<void> }> {
  const host = activateBackend(dist, dataDirectory);
  // These scenarios exercise the opt-in live-typing button.
  await host.call("set-settings", { liveButton: true, preload: false, language: "auto" });
  /** Paths the server was asked for (worklet fetches are invisible to page events). */
  const loaded: string[] = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    loaded.push(url.pathname);
    if (url.pathname === "/") { response.writeHead(200, { "content-type": "text/html" }).end(HTML); return; }
    if (url.pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
    if (url.pathname === "/harness.js") { response.writeHead(200, { "content-type": "text/javascript" }).end(harness); return; }
    if (url.pathname === "/events") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(host.events.slice(Number(url.searchParams.get("after") ?? 0))));
      return;
    }
    if (url.pathname.startsWith("/plugin/")) {
      // Like the host: only the frontend entry, styles and assets/ are public.
      const relative = url.pathname.slice("/plugin/".length);
      if (!["main.js", "styles.css"].includes(relative) && !relative.startsWith("assets/")) { response.writeHead(404).end(); return; }
      const file = path.join(dist, relative);
      if (!file.startsWith(dist) || !fs.existsSync(file)) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(fs.readFileSync(file));
      return;
    }
    if (url.pathname === "/call" && request.method === "POST") {
      const parts: Buffer[] = [];
      request.on("data", part => parts.push(part as Buffer));
      request.on("end", () => {
        const { operation, input } = JSON.parse(Buffer.concat(parts).toString("utf8")) as { operation: string; input?: unknown };
        host.call(operation, input).then(
          result => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result })),
          error => response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })),
        );
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const context = await browser.newContext({ permissions: ["microphone"] });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await context.newPage();
  page.on("console", message => { if (message.type() === "error") console.log(`  [page error] ${message.text()}`); });
  page.on("response", response => { if (response.status() >= 400) console.log(`  [HTTP ${response.status()}] ${new URL(response.url()).pathname}`); });
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  await page.waitForFunction("window.__activated === true");
  return {
    page, host, loaded,
    async close() {
      const errors = await page.evaluate("window.__errors") as string[];
      await page.evaluate("window.__deactivate()");
      await context.close();
      await host.dispose();
      await new Promise(resolve => server.close(resolve));
      assert.deepEqual(errors, [], "no uncaught errors in the page");
    },
  };
}

const composer = (page: Page) => page.evaluate("window.__state.text") as Promise<string>;
const hudState = (page: Page) => page.evaluate(`(() => { const hud = document.querySelector(".odd-hud"); return hud.hidden ? "hidden" : hud.dataset.state; })()`) as Promise<string>;
const hudLabel = (page: Page) => page.locator(".odd-hud-label").innerText();
const focused = (page: Page) => page.evaluate("document.activeElement?.id ?? ''") as Promise<string>;
async function waitForText(page: Page, read: () => Promise<string>, needle: string, timeout = 90_000): Promise<string[]> {
  const seen: string[] = [];
  const deadline = Date.now() + timeout;
  for (;;) {
    const text = await read();
    if (seen.at(-1) !== text) seen.push(text);
    if (text.toLowerCase().includes(needle.toLowerCase())) return seen;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for "${needle}"; last text: ${JSON.stringify(text)}; indicator: ${await hudState(page)} / ${await hudLabel(page).catch(() => "")}`);
    await page.waitForTimeout(100);
  }
}
function checkWords(text: string): void {
  for (const word of expected) assert.ok(text.toLowerCase().includes(word.toLowerCase()), `transcript should contain "${word}": ${text}`);
}
const last = expected.at(-1) ?? "";

before(async () => {
  if (skip) return;
  assert.ok(fs.existsSync(path.join(dist, "main.js")), "run `npm run build` first");
  const bundle = await build({
    absWorkingDir: root, entryPoints: ["tests/e2e/page.tsx"], bundle: true, write: false, format: "esm", platform: "browser",
    target: "es2022", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
  });
  harness = bundle.outputFiles[0]!.text;
  browser = await chromium.launch({
    executablePath: executable!, headless: true,
    args: [
      "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
      // Play the recording once as the microphone, then silence.
      `--use-file-for-fake-audio-capture=${wav}%noloop`,
    ],
  });
});
after(async () => { await browser?.close(); });

test("shortcut: words are typed live at the caret of a React-controlled composer", { skip, timeout: 180_000 }, async () => {
  const window = await open(data!);
  try {
    const { page } = window;
    await page.waitForFunction("document.body.dataset.placed_sidebar === 'toggle' && document.body.dataset.placed_top_bar === 'toggle'");
    assert.equal(await page.locator("#dictate").innerText(), "Live dictation");
    await page.locator("#composer").click();
    await page.keyboard.type("Notes:");
    await page.keyboard.press("Control+Shift+M");
    await page.waitForFunction(`!document.querySelector(".odd-hud").hidden`);
    assert.equal(await page.locator("#dictate").innerText(), "Stop live dictation");
    const started = Date.now();
    await waitForText(page, () => composer(page), "Notes: ");
    const firstWords = Date.now() - started;
    const seen = await waitForText(page, () => composer(page), last);
    console.log(`  first words after ${(firstWords / 1000).toFixed(1)} s (includes loading the model); last word after ${((Date.now() - started) / 1000).toFixed(1)} s, in ${seen.length} visible steps`);
    assert.ok(window.loaded.includes("/plugin/assets/pcm-worklet.js"), "audio was captured through the worklet, not the fallback");
    assert.equal(await hudState(page), "listening");
    assert.equal(await hudLabel(page), "Listening — on this device");
    if (process.env.ODD_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.ODD_E2E_SHOTS, "listening.png") });
    assert.equal(await focused(page), "composer", "the caret never left the composer");
    await page.keyboard.press("Control+Shift+M");
    await page.waitForFunction(`document.querySelector(".odd-hud").hidden`, undefined, { timeout: 30_000 });
    const text = await composer(page);
    console.log(`  composer: ${text}`);
    assert.ok(text.startsWith("Notes: "), "existing text is kept and separated by a space");
    checkWords(text);
    assert.equal(await page.locator("#composer").inputValue(), text, "React state and the field agree");
    assert.ok(seen.length >= 6, `text grew step by step (${seen.length} steps)`);
    for (let index = 1; index < seen.length; index++) assert.ok(seen[index]!.startsWith(seen[index - 1]!), "text only ever grows");
    assert.ok(await page.evaluate("window.__state.changes") as number >= 6, "the composer's own change handler saw the typing");
    assert.equal(await page.locator("#dictate").innerText(), "Live dictation");
    // The words went in through the editing command, so the field's undo works.
    await page.keyboard.press("Control+Z");
    assert.notEqual(await composer(page), text);
    assert.equal((await window.host.call<Status>("status")).sessionActive, false);
  } finally { await window.close(); }
});

test("the audio worklet registers and delivers 16 kHz blocks", { skip, timeout: 60_000 }, async () => {
  const window = await open(data!);
  try {
    const result = await window.page.evaluate(`(async () => {
      const context = new AudioContext({ sampleRate: 16000 });
      await context.audioWorklet.addModule("/plugin/assets/pcm-worklet.js");
      const node = new AudioWorkletNode(context, "on-device-dictation-pcm", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: "explicit" });
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 440;
      oscillator.connect(node);
      oscillator.start();
      await context.resume();
      const blocks = await new Promise(resolve => { const got = []; node.port.onmessage = event => { got.push(event.data); if (got.length === 5) resolve(got); }; });
      await context.close();
      return { rate: context.sampleRate, sizes: blocks.map(block => block.length), peak: Math.max(...blocks[2]), isFloat: blocks[0] instanceof Float32Array };
    })()`) as { rate: number; sizes: number[]; peak: number; isFloat: boolean };
    assert.deepEqual(result.sizes, [1024, 1024, 1024, 1024, 1024]);
    assert.equal(result.rate, 16000, "Chromium opens the context at the model's sample rate");
    assert.equal(result.isFloat, true);
    assert.ok(result.peak > 0.9, "samples carry the signal");
  } finally { await window.close(); }
});

test("toolbar button: focus returns to the field, Done on the indicator finishes", { skip, timeout: 180_000 }, async () => {
  const window = await open(data!);
  try {
    const { page } = window;
    await page.locator("#composer").click();
    await page.keyboard.type("Before  after");
    for (let step = 0; step < 6; step++) await page.keyboard.press("ArrowLeft"); // caret between the two spaces
    await page.locator("#dictate").click(); // moves focus to the button, as a real toolbar does
    await page.waitForFunction(`document.querySelector(".odd-hud").dataset.state === "listening"`, undefined, { timeout: 60_000 });
    assert.equal(await focused(page), "composer", "the plugin handed the caret back");
    await waitForText(page, () => composer(page), expected[0] ?? last);
    await page.locator(".odd-hud-primary").click();
    await page.waitForFunction(`document.querySelector(".odd-hud").hidden`, undefined, { timeout: 30_000 });
    const text = await composer(page);
    console.log(`  composer: ${text}`);
    assert.match(text, /^Before \S.* after$/s, "inserted in the middle, at the caret");
    assert.equal(await focused(page), "composer", "clicking the indicator did not steal focus");
  } finally { await window.close(); }
});

test("sending while dictating stops the microphone and nothing lands in the next draft", { skip, timeout: 180_000 }, async () => {
  const window = await open(data!);
  try {
    const { page } = window;
    await page.locator("#composer").click();
    await page.keyboard.press("Control+Shift+M");
    await waitForText(page, () => composer(page), expected[0] ?? last);
    const atSend = await composer(page);
    await page.locator("#send").click();
    await page.waitForFunction("window.__sent.length === 1", undefined, { timeout: 15_000 });
    const sent = (await page.evaluate("window.__sent") as string[])[0]!;
    console.log(`  in the field at Send: ${atSend}\n  message sent:         ${sent}`);
    assert.ok(sent.startsWith(atSend), "the sent message is what was typed, possibly extended by words still in flight");
    assert.equal((await window.host.call<Status>("status")).sessionActive, false, "the session ended with the submission");
    await page.waitForTimeout(3_000);
    assert.equal(await composer(page), "", "no late words were typed into the cleared composer");
    const indicator = await hudState(page);
    if (indicator !== "hidden") {
      // Words that could not be attributed to the message are offered, not lost.
      assert.equal(indicator, "message");
      assert.match(await hudLabel(page), /not part of the message/);
    }
    assert.equal(await page.locator("#dictate").innerText(), "Live dictation");
  } finally { await window.close(); }
});

test("no field selected: words wait in the indicator, then go to the field that gets focus", { skip, timeout: 180_000 }, async () => {
  const window = await open(data!);
  try {
    const { page } = window;
    await page.keyboard.press("Control+Shift+M");
    await page.waitForFunction(`document.querySelector(".odd-hud").dataset.state === "listening"`, undefined, { timeout: 60_000 });
    assert.equal(await page.locator(".odd-hud-detail").innerText(), "Click into a text field");
    await waitForText(page, () => page.locator(".odd-hud-detail").innerText(), expected[0] ?? last);
    assert.equal(await composer(page), "");
    await page.locator("#plain").click();
    const value = () => page.locator("#plain").inputValue();
    await waitForText(page, value, expected[0] ?? last, 5_000);
    assert.equal(await page.locator(".odd-hud-detail").innerText(), "");
    // Cancel keeps what was typed and releases everything.
    await page.locator(".odd-hud-close").click();
    await page.waitForFunction(`document.querySelector(".odd-hud").hidden`);
    assert.ok((await value()).length > 0);
    assert.equal((await window.host.call<Status>("status")).sessionActive, false);
  } finally { await window.close(); }
});

test("rich-text field: words are typed into a contenteditable editor", { skip, timeout: 180_000 }, async () => {
  const window = await open(data!);
  try {
    const { page } = window;
    await page.locator("#rich").click();
    await page.keyboard.type("Draft:");
    await page.keyboard.press("Control+Shift+M");
    const rich = () => page.locator("#rich").innerText();
    await waitForText(page, rich, expected[1] ?? last);
    await page.keyboard.press("Control+Shift+M");
    await page.waitForFunction(`document.querySelector(".odd-hud").hidden`, undefined, { timeout: 30_000 });
    const text = await rich();
    console.log(`  editor: ${text}`);
    assert.ok(text.startsWith("Draft: "));
  } finally { await window.close(); }
});

test("settings page shows the installation and saves changes", { skip, timeout: 60_000 }, async () => {
  const window = await open(data!);
  try {
    const { page } = window;
    await page.waitForFunction(`document.querySelector("#settings .odd-state")?.textContent.startsWith("Ready")`);
    assert.match(await page.locator("#settings .odd-card").innerText(), /nemotron-3\.5-asr-streaming-0\.6b, 560 ms steps/);
    if (process.env.ODD_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.ODD_E2E_SHOTS, "settings.png"), fullPage: true });
    const language = page.locator('#settings [data-key="language"] select');
    assert.equal(await language.locator("option").count(), 42);
    await language.selectOption("en-US");
    await page.waitForFunction(`document.querySelector('#settings [data-key="language"] select').value === "en-US"`);
    assert.equal((await window.host.call<Status>("status")).settings.language, "en-US");
    assert.equal(JSON.parse(fs.readFileSync(path.join(data!, "settings.json"), "utf8")).language, "en-US");
    // Turning the live-typing extra off removes its button everywhere, and back on restores it.
    await page.locator('#settings [data-key="liveButton"] input').uncheck();
    await page.waitForFunction("document.body.dataset.placed_sidebar === undefined && document.body.dataset.placed_top_bar === undefined");
    assert.equal(await page.locator("#dictate").isDisabled(), true, "no action is registered while it is off");
    await page.locator('#settings [data-key="liveButton"] input').check();
    await page.waitForFunction("document.body.dataset.placed_sidebar === 'toggle' && document.body.dataset.placed_top_bar === 'toggle'");
    assert.equal(await page.locator('#settings [data-key="replaceBuiltIn"] input').isChecked(), true);
    // Choosing a model that is not downloaded turns the card into an offer to fetch it.
    await page.locator('#settings [data-key="latency"] select').selectOption("1120");
    await page.waitForFunction(`document.querySelector("#settings .odd-state")?.textContent.includes("not installed")`);
    assert.match(await page.locator("#settings .odd-card").innerText(), /1120 ms\) — 475 MB from github\.com/);
    await page.locator('#settings [data-key="latency"] select').selectOption("560");
    await page.waitForFunction(`document.querySelector("#settings .odd-state")?.textContent.startsWith("Ready")`);
    await language.selectOption("host");
    await page.waitForFunction(`document.querySelector('#settings [data-key="language"] select').value === "host"`);
  } finally { await window.close(); }
});

test("a refused microphone is explained and leaves nothing running", { skip, timeout: 60_000 }, async () => {
  const window = await open(data!);
  try {
    const { page } = window;
    await page.evaluate(`navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError"))`);
    await page.locator("#composer").click();
    await page.keyboard.press("Control+Shift+M");
    await page.waitForFunction(`document.querySelector(".odd-hud").dataset.state === "message"`);
    assert.match(await hudLabel(page), /Microphone access was denied/);
    assert.equal(await page.evaluate(`document.querySelector(".odd-hud").dataset.tone`), "error");
    assert.equal(await page.locator("#dictate").innerText(), "Live dictation");
    await page.waitForFunction("true"); // let the cancel request land
    await page.waitForTimeout(300);
    assert.equal((await window.host.call<Status>("status")).sessionActive, false, "the server session was released");
    await page.locator(".odd-hud-close").click();
    assert.equal(await hudState(page), "hidden");
    assert.equal(await composer(page), "");
  } finally { await window.close(); }
});

test("a second window cannot take the microphone; the first keeps dictating", { skip, timeout: 120_000 }, async () => {
  const window = await open(data!);
  try {
    const { page } = window;
    await page.locator("#composer").click();
    await page.keyboard.press("Control+Shift+M");
    await page.waitForFunction(`document.querySelector(".odd-hud").dataset.state === "listening"`, undefined, { timeout: 60_000 });
    await assert.rejects(window.host.call("session-start", { owner: "another-window-0001" }), /already running in another window/);
    await waitForText(page, () => composer(page), expected[0] ?? last);
    await page.keyboard.press("Control+Shift+M");
    await page.waitForFunction(`document.querySelector(".odd-hud").hidden`, undefined, { timeout: 30_000 });
  } finally { await window.close(); }
});

test("first use: explains the download and fetches nothing until asked", { skip, timeout: 20 * 60_000 }, async () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "odd-fresh-"));
  const window = await open(fresh);
  try {
    const { page } = window;
    await page.locator("#composer").click();
    await page.keyboard.press("Control+Shift+M");
    await page.waitForSelector(".test-dialog");
    const dialog = page.locator(".test-dialog");
    assert.match(await dialog.innerText(), /one-time download of 486 MB/);
    assert.match(await dialog.innerText(), /from registry\.npmjs\.org/);
    assert.match(await dialog.innerText(), /from github\.com/);
    assert.equal(await hudState(page), "hidden", "the microphone was not opened");
    await page.waitForTimeout(1_500);
    assert.deepEqual(fs.readdirSync(fresh), ["settings.json"], "nothing was fetched or unpacked before consent");
    assert.equal(await page.locator("#settings .odd-state").innerText(), "Speech engine and model are not installed");
    if (process.env.ODD_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.ODD_E2E_SHOTS, "setup.png"), fullPage: true });
    if (process.env.ODD_E2E_FRESH !== "1") return;

    // The real thing: download both packages, verify, unpack, then dictate.
    await dialog.getByRole("button", { name: "Download and install" }).click();
    await page.waitForFunction(`document.querySelector(".test-dialog .odd-progress") !== null`);
    const started = Date.now();
    await dialog.getByRole("button", { name: "Start dictating" }).waitFor({ timeout: 15 * 60_000 });
    console.log(`  installed through the dialog in ${((Date.now() - started) / 1000).toFixed(0)} s`);
    assert.match(await dialog.innerText(), /Ready — dictation is transcribed on this computer/);
    await dialog.getByRole("button", { name: "Start dictating" }).click();
    await page.waitForFunction(`document.querySelector(".test-dialog") === null`);
    await waitForText(page, () => composer(page), expected[0] ?? last);
    await page.keyboard.press("Control+Shift+M");
    await page.waitForFunction(`document.querySelector(".odd-hud").hidden`, undefined, { timeout: 30_000 });
    console.log(`  composer: ${await composer(page)}`);
  } finally {
    await window.close();
    fs.rmSync(fresh, { recursive: true, force: true });
  }
});
