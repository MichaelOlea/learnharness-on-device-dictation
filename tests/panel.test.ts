/** The settings page and install card under jsdom, with the host's widgets
 * replaced by recorders: what is offered, and the sizes quoted for it. */
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { PluginFrontendContext, PluginSettingsSchema } from "learnharness-plugin-api";
import {
  DEFAULT_SETTINGS, FULL_PRECISION_MODELS, LATENCIES, MODELS, PRECISION_LABELS, formatBytes, modelSize, offeredPrecisions,
  type Latency, type Settings, type Status,
} from "../src/contract.ts";
import { mountSettings, type StatusStore } from "../src/panel.ts";

type Row = PluginSettingsSchema["rows"][number];
type Dropdown = Extract<Row, { type: "dropdown" }>;

function status(settings: Partial<Settings>, extra: Partial<Status> = {}): Status {
  return {
    settings: { ...DEFAULT_SETTINGS, ...settings },
    platform: { key: "linux-x64", supported: true },
    engineInstalled: true, modelInstalled: true, installedModels: [], installedPrecisions: [],
    install: { phase: "idle", done: 0, total: 0 },
    engine: { state: "unloaded" }, sessionActive: false, downloadsDirectory: "/data/downloads", pending: [], cores: 8, threads: 4,
    ...extra,
  };
}

function mount(initial: Status) {
  const dom = new JSDOM("<!doctype html><body><div id=root></div></body>");
  Object.assign(globalThis, { document: dom.window.document });
  const calls: { operation: string; input: unknown }[] = [];
  let schema: PluginSettingsSchema = { rows: [] };
  let current = initial;
  const listeners = new Set<(status: Status) => void>();
  const store: StatusStore = {
    current: () => current,
    refresh: async () => current,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    publish(next) { current = next; listeners.forEach(listener => listener(next)); },
  };
  const ctx = {
    call: async (operation: string, input: unknown) => { calls.push({ operation, input }); return current; },
    ui: {
      mountButton: (slot: HTMLElement, options: { label: string }) => { slot.textContent = `[${options.label}]`; return { update() {}, dispose() {} }; },
      mountSettingsRows: (_slot: HTMLElement, first: PluginSettingsSchema) => { schema = first; return { update(next: PluginSettingsSchema) { schema = next; }, dispose() {} }; },
      openDialog: () => ({ dispose() {} }),
    },
  } as unknown as PluginFrontendContext;
  const root = dom.window.document.querySelector<HTMLElement>("#root")!;
  const cleanup = mountSettings(root, ctx, store, new AbortController().signal);
  return {
    root, calls, store, cleanup,
    row: (key: string) => schema.rows.find(row => row.key === key),
    text: () => root.textContent ?? "",
  };
}

test("with the compact model the page reads as it always did", () => {
  const page = mount(status({}, { installedModels: ["560"], installedPrecisions: ["int8"] }));
  const latency = page.row("latency") as Dropdown;
  assert.match(latency.description ?? "", /its own 475 MB model download/);
  assert.deepEqual(latency.options.map(option => option.label.includes("not downloaded")), [true, true, false, true]);
  assert.match(page.row("unloadAfterMinutes")?.description ?? "", /uses about 1 GB of memory/);
  assert.match(page.text(), /560 ms steps, compact, 4 CPU threads\./);
  page.cleanup();
});

test("the precision choice appears only when there is something to choose", async () => {
  const page = mount(status({}, { installedPrecisions: ["int8"] }));
  const row = page.row("precision") as Dropdown | undefined;
  if (offeredPrecisions().length < 2) { assert.equal(row, undefined); page.cleanup(); return; }
  assert.ok(row);
  assert.equal(row.value, "int8");
  // Offered for this latency only if a full-precision package exists for it.
  const here = FULL_PRECISION_MODELS[DEFAULT_SETTINGS.latency];
  assert.deepEqual(row.options.map(option => option.value), here ? ["int8", "fp32"] : ["int8"]);
  assert.equal(row.options[0]!.label, PRECISION_LABELS.int8, "the installed, recommended choice comes first");
  assert.match(row.options[0]!.label, /recommended/);
  if (here) {
    assert.equal(row.options[1]!.label, `${PRECISION_LABELS.fp32} — not downloaded`);
    assert.ok(row.description?.includes(`a ${formatBytes(modelSize(here).download)} download instead of 475 MB`));
    await row.onChange("fp32");
    assert.deepEqual(page.calls, [{ operation: "set-settings", input: { precision: "fp32" } }]);
  } else {
    assert.match(row.description ?? "", /Only the compact model is published/);
  }
  page.cleanup();
});

test("with full precision chosen, sizes and unavailable steps are shown for it", () => {
  const latency = LATENCIES.find(candidate => FULL_PRECISION_MODELS[candidate]);
  if (!latency) return; // no full-precision package is published
  const full = FULL_PRECISION_MODELS[latency]!;
  const size = modelSize(full);
  const pending = full.files.map(file => ({ name: `NVIDIA Nemotron 3.5 ASR model (${latency} ms, full precision)`, url: full.baseUrl + file.name, bytes: file.bytes, file: `${full.directory}/${file.name}` }));
  const page = mount(status({ latency, precision: "fp32" }, { modelInstalled: false, pending }));
  const row = page.row("latency") as Dropdown;
  assert.ok(row.description?.includes(`its own ${formatBytes(size.download)} model download`));
  for (const option of row.options) {
    assert.equal(option.label.includes("compact model only"), !FULL_PRECISION_MODELS[option.value as Latency], option.value);
  }
  assert.match(page.row("unloadAfterMinutes")?.description ?? "", /uses at least 2\.5 GB of memory/);
  const text = page.text();
  // One line for the model however many files it is published as, then every file to fetch by hand.
  assert.equal(text.split(`full precision) — ${formatBytes(size.download)} from huggingface.co`).length, 2);
  assert.ok(text.includes(`needs about ${formatBytes(size.installed)} of free disk space while installing`));
  for (const item of pending) assert.ok(text.includes(`${item.url} → ${item.file}`), item.file);
  page.cleanup();
});

test("the install card quotes the compact model's real sizes", () => {
  const model = MODELS["560"];
  const page = mount(status({}, { modelInstalled: false, pending: [{ name: "NVIDIA Nemotron 3.5 ASR model (560 ms, compact)", url: model.url, bytes: model.bytes, file: model.archive }] }));
  const text = page.text();
  assert.ok(text.includes("NVIDIA Nemotron 3.5 ASR model (560 ms, compact) — 475 MB from github.com"));
  assert.ok(text.includes("The compact model needs about 1.16 GB of free disk space while installing (682 MB afterwards) and about 1 GB of memory while it is loaded."));
  assert.ok(text.includes(`${model.url} → ${model.archive}`));
  page.cleanup();
});
