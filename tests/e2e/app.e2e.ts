/** The plugin inside the REAL LearnHarness web app, driven through a real
 * Chromium with a WAV file as the microphone.
 *
 * Start a LearnHarness checkout first (for example `npx next dev -p 3005` with
 * LH_DATA_DIR set), with this plugin's dist/ installed under
 * <LH_DATA_DIR>/plugins/on-device-dictation/ and the engine and model already
 * in its data/ folder. Then:
 *
 *   ODD_APP_URL     http://localhost:3005
 *   ODD_E2E_WAV     16 kHz mono WAV the fake microphone plays
 *   ODD_E2E_EXPECT  words expected near the start of the recording, "|"-separated
 *   ODD_CHROME      Chromium/Chrome executable (default: common locations)
 *   ODD_E2E_FRESH   1 to also delete the files and reinstall through the app's dialog
 *   ODD_E2E_SHOTS   directory for screenshots
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { before } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Status } from "../../src/contract.ts";

const app = process.env.ODD_APP_URL;
const wav = process.env.ODD_E2E_WAV;
const expected = (process.env.ODD_E2E_EXPECT ?? "").split("|").filter(Boolean);
const executable = process.env.ODD_CHROME ?? ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(file => fs.existsSync(file));
const skip = !app || !wav || !executable;
const ID = "on-device-dictation";
const TOGGLE = '[data-testid="dictation-toggle"]';
const BAR = '[data-testid="dictation-bar"]';

async function call<T>(operation: string, input?: unknown): Promise<T> {
  const response = await fetch(`${app}/api/plugins/${ID}/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, input }) });
  const body = await response.json() as { result?: T; message?: string; error?: string };
  if (!response.ok) throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
  return body.result as T;
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function engineReady(): Promise<Status> {
  let status = await call<Status>("warm");
  const deadline = Date.now() + 120_000;
  while (status.engine.state !== "ready") {
    assert.notEqual(status.engine.state, "error", status.engine.error);
    assert.ok(Date.now() < deadline, "the model did not load in time");
    await sleep(250);
    status = await call<Status>("status");
  }
  return status;
}

interface Window_ { browser: Browser; page: Page; traffic: string[]; sockets: string[]; close(): Promise<void> }
/** A fresh browser per scenario, so the fake microphone starts its recording again. */
async function open(): Promise<Window_> {
  const browser = await chromium.launch({
    executablePath: executable!, headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}%noloop`],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["microphone"] });
  const page = await context.newPage();
  const traffic: string[] = [];
  const sockets: string[] = [];
  const errors: string[] = [];
  page.on("request", request => { const url = new URL(request.url()); traffic.push(`${request.method()} ${url.host}${url.pathname}`); });
  page.on("websocket", socket => sockets.push(socket.url()));
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${app}/`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.locator(TOGGLE).waitFor({ timeout: 120_000 });
  // The plugin's frontend is active once its (hidden) indicator exists.
  await page.waitForSelector(".odd-hud", { state: "attached", timeout: 120_000 });
  return {
    browser, page, traffic, sockets,
    async close() { await browser.close(); assert.deepEqual(errors, [], "no uncaught errors in the app window"); },
  };
}
const composer = (page: Page) => page.locator('[contenteditable="true"]').first();
const indicator = (page: Page) => page.evaluate(`(() => { const hud = document.querySelector(".odd-hud"); return hud.hidden ? "" : hud.innerText; })()`) as Promise<string>;
async function shot(page: Page, name: string): Promise<void> {
  if (process.env.ODD_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.ODD_E2E_SHOTS, `${name}.png`) });
}
function checkStart(text: string): void {
  for (const word of expected.slice(0, 2)) assert.ok(text.toLowerCase().includes(word.toLowerCase()), `transcript should contain "${word}": ${text}`);
}

before(async () => {
  if (skip) return;
  const list = await (await fetch(`${app}/api/plugins`)).json() as { plugins: { id: string; enabled: boolean; status: string; error?: string }[] };
  const plugin = list.plugins.find(entry => entry.id === ID);
  assert.ok(plugin, "install dist/ into <LH_DATA_DIR>/plugins/on-device-dictation/ and refresh");
  assert.deepEqual([plugin.enabled, plugin.status, plugin.error], [true, "active", undefined], "enable the plugin in the app first");
});

test("LearnHarness's own Dictate button transcribes on this computer, with no Deepgram key", { skip, timeout: 300_000 }, async () => {
  await call("set-settings", { replaceBuiltIn: true, liveButton: false, language: "host", preload: true });
  const status = await engineReady();
  assert.equal((await fetch(`${app}/api/stt/token`)).status, 503, "this app instance really has no Deepgram key");
  const window = await open();
  try {
    const { page } = window;
    assert.equal(await page.locator(TOGGLE).innerText(), "Dictate");
    const before = window.traffic.length;
    const clicked = Date.now();
    await page.locator(TOGGLE).click();
    await page.locator(BAR).waitFor({ timeout: 20_000 });
    console.log(`  recording meter shown ${Date.now() - clicked} ms after the click (engine ${status.engine.mode})`);
    await page.waitForTimeout(12_000);
    await shot(page, "app-recording");
    assert.equal((await composer(page).innerText()).trim(), "", "like the built-in engine, text appears when you stop");
    const stopped = Date.now();
    await page.locator(TOGGLE).click();
    await page.locator(BAR).waitFor({ state: "detached", timeout: 20_000 });
    const took = Date.now() - stopped;
    await page.waitForTimeout(300);
    const text = (await composer(page).innerText()).trim();
    console.log(`  stop to text: ${took} ms\n  composer: ${text}`);
    await shot(page, "app-after-stop");
    checkStart(text);
    assert.ok(took < 2_900, "finished inside LearnHarness's own three-second stop window");
    assert.equal(await page.locator(TOGGLE).innerText(), "Dictate", "no error on the button");
    assert.equal(await indicator(page), "", "the plugin showed nothing of its own");
    const during = window.traffic.slice(before);
    assert.deepEqual(during.filter(entry => /deepgram/i.test(entry)), [], "no request to Deepgram");
    assert.deepEqual(during.filter(entry => entry.includes("/api/stt/token")), [], "the app's token route was not used");
    assert.deepEqual(window.sockets.filter(url => /deepgram/i.test(url)), [], "no Deepgram socket");
    assert.ok(during.some(entry => entry.endsWith(`/api/plugins/${ID}/call`)), "audio went to the plugin's local backend");

    // A second run appends to what is already there, as the built-in one does.
    await page.locator(TOGGLE).click();
    await page.locator(BAR).waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1_500);
    await page.keyboard.press("Escape"); // LearnHarness's cancel: discard this run
    await page.locator(BAR).waitFor({ state: "detached", timeout: 20_000 });
    await page.waitForTimeout(500);
    assert.equal((await composer(page).innerText()).trim(), text, "Esc discards the cancelled run and keeps earlier text");
    assert.equal((await call<Status>("status")).sessionActive, false);
  } finally { await window.close(); }
});

test("a very short dictation right after a cold start still gets its words", { skip, timeout: 300_000 }, async () => {
  // Changing the thread count unloads the model; with preloading off the next
  // dictation has to load it while LearnHarness is already waiting for text.
  await call("set-settings", { preload: false, threads: 2 });
  await call("set-settings", { threads: 0 });
  assert.equal((await call<Status>("status")).engine.state, "unloaded");
  const window = await open();
  try {
    const { page } = window;
    await composer(page).click(); // the field late words are appended to
    await page.locator(TOGGLE).click();
    await page.locator(BAR).waitFor({ timeout: 20_000 });
    await page.waitForTimeout(2_500);
    await page.locator(TOGGLE).click();
    await page.locator(BAR).waitFor({ state: "detached", timeout: 20_000 });
    const deadline = Date.now() + 90_000;
    let text = "";
    while (!(text = (await composer(page).innerText()).trim()) && Date.now() < deadline) await page.waitForTimeout(250);
    const note = await indicator(page);
    console.log(`  composer: ${text}${note ? `\n  indicator: ${note.replace(/\s+/g, " ")}` : ""}`);
    assert.ok(text.length > 3, "the words arrived");
    assert.equal(await page.locator(TOGGLE).innerText(), "Dictate");
  } finally {
    await window.close();
    await call("set-settings", { preload: true });
  }
});

test("switching the replacement off restores LearnHarness's Deepgram behaviour", { skip, timeout: 120_000 }, async () => {
  await call("set-settings", { replaceBuiltIn: false });
  const window = await open();
  try {
    const { page } = window;
    await page.waitForTimeout(1_000);
    await page.locator(TOGGLE).click();
    // Without a key the app itself reports that it needs one.
    await page.waitForFunction(`document.querySelector('[data-testid="dictation-toggle"]')?.textContent.includes("Deepgram key")`, undefined, { timeout: 30_000 });
    assert.ok(window.traffic.some(entry => entry.includes("/api/stt/token")), "the app's own token route was used again");
    assert.equal((await call<Status>("status")).sessionActive, false);
  } finally {
    await window.close();
    await call("set-settings", { replaceBuiltIn: true });
  }
});

test("the plugin's page inside the app's Settings works", { skip, timeout: 120_000 }, async () => {
  await engineReady();
  const window = await open();
  try {
    const { page } = window;
    await page.getByText("Settings", { exact: false }).last().click();
    await page.getByText("On-device dictation", { exact: true }).click();
    await page.waitForFunction(`document.querySelector(".odd-state")?.textContent.startsWith("Ready")`, undefined, { timeout: 30_000 });
    const panel = page.locator(".odd-panel");
    assert.match(await panel.innerText(), /LearnHarness's Dictate button uses it/);
    for (const label of ["Replace built-in dictation", "Language", "Responsiveness", "Load the model when LearnHarness starts", "Extra: live-typing button"]) {
      assert.ok(await page.getByText(label, { exact: true }).count() > 0, `row "${label}" is shown`);
    }
    await shot(page, "app-settings");
  } finally { await window.close(); }
});

test("optional live-typing button types into the app's real composer", { skip, timeout: 300_000 }, async () => {
  await call("set-settings", { liveButton: true });
  await engineReady();
  const window = await open();
  try {
    const { page } = window;
    await composer(page).click();
    await page.keyboard.type("Notes:");
    await page.keyboard.press("Control+Shift+M");
    await page.waitForFunction(`document.querySelector(".odd-hud").dataset.state === "listening"`, undefined, { timeout: 60_000 });
    const deadline = Date.now() + 60_000;
    const seen: string[] = [];
    for (;;) {
      const text = (await composer(page).innerText()).trim();
      if (seen.at(-1) !== text) seen.push(text);
      if (expected[1] && text.toLowerCase().includes(expected[1].toLowerCase())) break;
      assert.ok(Date.now() < deadline, `words did not appear live: ${JSON.stringify(text)} / ${await indicator(page)}`);
      await page.waitForTimeout(150);
    }
    await shot(page, "app-live");
    await page.keyboard.press("Control+Shift+M");
    await page.waitForFunction(`document.querySelector(".odd-hud").hidden`, undefined, { timeout: 30_000 });
    const text = (await composer(page).innerText()).trim();
    console.log(`  composer after live typing (${seen.length} visible steps): ${text}`);
    assert.ok(text.startsWith("Notes: "));
    assert.ok(seen.length >= 3, "text arrived step by step");
  } finally {
    await window.close();
    await call("set-settings", { liveButton: false });
  }
});

test("first use inside the app: Dictate offers the download, then works", { skip: skip || process.env.ODD_E2E_FRESH !== "1", timeout: 20 * 60_000 }, async () => {
  await call("set-settings", { replaceBuiltIn: true, liveButton: false, preload: true });
  let status = await call<Status>("remove-files");
  assert.equal(status.engineInstalled || status.modelInstalled, false);
  const window = await open();
  try {
    const { page } = window;
    await page.locator(TOGGLE).click();
    const dialog = page.locator(".odd-dialog");
    await dialog.waitFor({ timeout: 30_000 });
    await page.locator(BAR).waitFor({ state: "detached", timeout: 20_000 });
    assert.equal(await page.locator(TOGGLE).innerText(), "Dictate", "the run ended quietly, without an error on the button");
    assert.match(await dialog.innerText(), /one-time download of 486 MB/);
    await shot(page, "app-setup");
    await page.getByRole("button", { name: "Download and install" }).click();
    const started = Date.now();
    await page.getByRole("button", { name: "Done", exact: true }).waitFor({ timeout: 15 * 60_000 });
    console.log(`  installed through the app's dialog in ${((Date.now() - started) / 1000).toFixed(0)} s`);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    // The model is loaded right after installing, so the next press just works.
    status = await engineReady();
    await page.locator(TOGGLE).click();
    await page.locator(BAR).waitFor({ timeout: 20_000 });
    await page.waitForTimeout(6_000);
    await page.locator(TOGGLE).click();
    await page.locator(BAR).waitFor({ state: "detached", timeout: 20_000 });
    await page.waitForTimeout(300);
    const text = (await composer(page).innerText()).trim();
    console.log(`  composer: ${text}`);
    assert.ok(text.length > 3);
  } finally { await window.close(); }
});
