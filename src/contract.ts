/** Shared, side-effect-free contracts for the frontend and backend bundles. */

export const PLUGIN_NAME = "On-device dictation";
export const MODEL_NAME = "nemotron-3.5-asr-streaming-0.6b";
export const SAMPLE_RATE = 16_000;
/** Same cap VS Code applies to one built-in dictation session. */
export const MAX_SESSION_MS = 20 * 60_000;
/** A window that stops sending audio (closed, crashed, reloaded) loses its session. */
export const SESSION_IDLE_MS = 15_000;
/** Unprocessed audio beyond this means the computer cannot keep up in real time. */
export const MAX_LAG_MS = 45_000;
/** One bridge call may carry at most this much audio (base64 of 16-bit PCM). */
export const MAX_PUSH_BASE64 = 1_400_000;

/* ----------------------------------------------------------------------------
 * Languages. The 40 locales NVIDIA lists on the model card, in its three tiers.
 * Every code below is a key of the exported model's own `prompt_dictionary`.
 * -------------------------------------------------------------------------- */

export interface LanguageOption { code: string; label: string; tier: 1 | 2 | 3 }

export const LANGUAGES: readonly LanguageOption[] = [
  { code: "en-US", label: "English (United States)", tier: 1 },
  { code: "en-GB", label: "English (United Kingdom)", tier: 1 },
  { code: "es-US", label: "Spanish (Latin America / US)", tier: 1 },
  { code: "es-ES", label: "Spanish (Spain)", tier: 1 },
  { code: "fr-FR", label: "French (France)", tier: 1 },
  { code: "fr-CA", label: "French (Canada)", tier: 1 },
  { code: "it-IT", label: "Italian", tier: 1 },
  { code: "pt-BR", label: "Portuguese (Brazil)", tier: 1 },
  { code: "pt-PT", label: "Portuguese (Portugal)", tier: 1 },
  { code: "nl-NL", label: "Dutch", tier: 1 },
  { code: "de-DE", label: "German", tier: 1 },
  { code: "tr-TR", label: "Turkish", tier: 1 },
  { code: "ru-RU", label: "Russian", tier: 1 },
  { code: "ar-AR", label: "Arabic", tier: 1 },
  { code: "hi-IN", label: "Hindi", tier: 1 },
  { code: "ja-JP", label: "Japanese", tier: 1 },
  { code: "ko-KR", label: "Korean", tier: 1 },
  { code: "vi-VN", label: "Vietnamese", tier: 1 },
  { code: "uk-UA", label: "Ukrainian", tier: 1 },
  { code: "pl-PL", label: "Polish", tier: 2 },
  { code: "sv-SE", label: "Swedish", tier: 2 },
  { code: "cs-CZ", label: "Czech", tier: 2 },
  { code: "nb-NO", label: "Norwegian Bokmål", tier: 2 },
  { code: "da-DK", label: "Danish", tier: 2 },
  { code: "bg-BG", label: "Bulgarian", tier: 2 },
  { code: "fi-FI", label: "Finnish", tier: 2 },
  { code: "hr-HR", label: "Croatian", tier: 2 },
  { code: "sk-SK", label: "Slovak", tier: 2 },
  { code: "zh-CN", label: "Chinese (Mandarin, Simplified)", tier: 2 },
  { code: "hu-HU", label: "Hungarian", tier: 2 },
  { code: "ro-RO", label: "Romanian", tier: 2 },
  { code: "et-EE", label: "Estonian", tier: 2 },
  { code: "el-GR", label: "Greek (limited accuracy)", tier: 3 },
  { code: "lt-LT", label: "Lithuanian (limited accuracy)", tier: 3 },
  { code: "lv-LV", label: "Latvian (limited accuracy)", tier: 3 },
  { code: "mt-MT", label: "Maltese (limited accuracy)", tier: 3 },
  { code: "sl-SI", label: "Slovenian (limited accuracy)", tier: 3 },
  { code: "he-IL", label: "Hebrew (limited accuracy)", tier: 3 },
  { code: "th-TH", label: "Thai (limited accuracy)", tier: 3 },
  { code: "nn-NO", label: "Norwegian Nynorsk (limited accuracy)", tier: 3 },
];
const LANGUAGE_CODES: ReadonlySet<string> = new Set(LANGUAGES.map(language => language.code));
export const AUTO_LANGUAGE = "auto";
/** Setting value: take the language from LearnHarness's own Dictation setting. */
export const HOST_LANGUAGE = "host";
/** A language the engine can be started with. */
export function isLanguage(value: unknown): value is string {
  return value === AUTO_LANGUAGE || (typeof value === "string" && LANGUAGE_CODES.has(value));
}

/** LearnHarness's dictation language list is Deepgram's. Map each code it can send
 * to the closest locale this model supports; anything else is auto-detected. */
const HOST_LANGUAGE_MAP: Readonly<Record<string, string>> = {
  multi: AUTO_LANGUAGE,
  en: "en-US", "en-US": "en-US", "en-GB": "en-GB", "en-AU": "en-GB", "en-NZ": "en-GB", "en-IN": "en-GB",
  es: "es-ES", "es-419": "es-US",
  fr: "fr-FR", "fr-CA": "fr-CA",
  de: "de-DE", "de-CH": "de-DE",
  it: "it-IT",
  pt: "pt-BR", "pt-BR": "pt-BR", "pt-PT": "pt-PT",
  nl: "nl-NL", "nl-BE": "nl-NL",
  tr: "tr-TR", "tr-TR": "tr-TR",
  ru: "ru-RU",
  hi: "hi-IN",
  ja: "ja-JP",
  ko: "ko-KR", "ko-KR": "ko-KR",
  vi: "vi-VN",
  uk: "uk-UA",
  pl: "pl-PL",
  sv: "sv-SE", "sv-SE": "sv-SE",
  cs: "cs-CZ", "cs-CZ": "cs-CZ",
  no: "nb-NO",
  da: "da-DK", "da-DK": "da-DK",
  bg: "bg-BG",
  fi: "fi-FI",
  hr: "hr-HR",
  sk: "sk-SK",
  zh: "zh-CN", "zh-CN": "zh-CN", "zh-Hans": "zh-CN",
  hu: "hu-HU",
  ro: "ro-RO",
  et: "et-EE",
  el: "el-GR",
  lt: "lt-LT",
  lv: "lv-LV",
  sl: "sl-SI",
  he: "he-IL",
  th: "th-TH", "th-TH": "th-TH",
};
export function mapHostLanguage(code: string | null | undefined): string {
  if (!code) return AUTO_LANGUAGE;
  if (Object.hasOwn(HOST_LANGUAGE_MAP, code)) return HOST_LANGUAGE_MAP[code]!;
  // Every regional Arabic code LearnHarness offers maps to the model's one Arabic.
  if (code === "ar" || code.startsWith("ar-")) return "ar-AR";
  return AUTO_LANGUAGE;
}

/* ----------------------------------------------------------------------------
 * Model packages: sherpa-onnx exports of the NVIDIA model, one per streaming
 * chunk size and numeric precision. Every size and digest below was taken from
 * the published files and is verified on every installation.
 *
 *   int8  the official release archives on github.com (k2-fsa/sherpa-onnx)
 *   fp32  the unquantized export, published file by file on huggingface.co
 * -------------------------------------------------------------------------- */

export const LATENCIES = ["160", "320", "560", "1120"] as const;
export type Latency = (typeof LATENCIES)[number];
export function isLatency(value: unknown): value is Latency {
  return typeof value === "string" && (LATENCIES as readonly string[]).includes(value);
}
export const LATENCY_LABELS: Readonly<Record<Latency, string>> = {
  "160": "Fastest — text every 0.16 s, lowest accuracy, most CPU",
  "320": "Fast — text every 0.32 s",
  "560": "Balanced — text every 0.56 s (recommended)",
  "1120": "Most accurate — text every 1.1 s, least CPU",
};

/** How the model's weights are stored. "int8" is the 8-bit quantized export;
 * "fp32" is the model as NVIDIA trained it, about four times the size. */
export const PRECISIONS = ["int8", "fp32"] as const;
export type Precision = (typeof PRECISIONS)[number];
export function isPrecision(value: unknown): value is Precision {
  return typeof value === "string" && (PRECISIONS as readonly string[]).includes(value);
}
export const PRECISION_NAMES: Readonly<Record<Precision, string>> = { int8: "compact", fp32: "full precision" };
/** Dropdown choices; kept short because the host sizes the control to its longest one. */
export const PRECISION_LABELS: Readonly<Record<Precision, string>> = {
  int8: "Compact (recommended)",
  fp32: "Full precision",
};
/** Memory the loaded model occupies. int8 was measured; the fp32 figure is the
 * size of its weights, which is the least it can take. */
export const PRECISION_MEMORY: Readonly<Record<Precision, string>> = { int8: "about 1 GB", fp32: "at least 2.5 GB" };

export interface PackageFile { name: string; bytes: number; sha256: string }
interface ModelBase {
  latency: Latency;
  precision: Precision;
  /** Installed directory name (and the top-level directory inside an archive). */
  directory: string;
  /** Every file installed, each with its pinned size and digest. */
  files: readonly PackageFile[];
  /** Which of `files` the recognizer is started with. */
  entry: { encoder: string; decoder: string; joiner: string; tokens: string };
}
/** Published as one .tar.bz2 whose own digest is pinned too. */
export interface ArchiveModel extends ModelBase { archive: string; url: string; bytes: number; sha256: string }
/** Published as separate files, each fetched from `baseUrl` + its name. */
export interface LooseModel extends ModelBase { baseUrl: string }
export type ModelPackage = ArchiveModel | LooseModel;
export function isArchiveModel(model: ModelPackage): model is ArchiveModel { return "archive" in model; }

const MODEL_RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/";
const SHARED_MODEL_FILES: readonly PackageFile[] = [
  { name: "decoder.int8.onnx", bytes: 14_978_075, sha256: "19f9c98fc6d0a2c33a65a43b36fdb2e914c26c0aa9764be3aebc502a1e982fb0" },
  { name: "joiner.int8.onnx", bytes: 9_504_438, sha256: "4101c7c679a0bc30483794b27a059e34e79232aa2068d78d51231a22c8b0d7ce" },
  { name: "tokens.txt", bytes: 131_440, sha256: "729cc103155bafa785f9cd45746cd41cabe97eab7182fc04d594129587958f8a" },
];
function modelPackage(latency: Latency, bytes: number, sha256: string, encoderBytes: number, encoderSha256: string): ArchiveModel {
  const directory = `sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-${latency}ms-int8-2026-06-11`;
  return {
    latency, precision: "int8", directory, archive: `${directory}.tar.bz2`, url: `${MODEL_RELEASE}${directory}.tar.bz2`, bytes, sha256,
    files: [{ name: "encoder.int8.onnx", bytes: encoderBytes, sha256: encoderSha256 }, ...SHARED_MODEL_FILES],
    entry: { encoder: "encoder.int8.onnx", decoder: "decoder.int8.onnx", joiner: "joiner.int8.onnx", tokens: "tokens.txt" },
  };
}
/** The compact (int8) packages; one exists for every latency. */
export const MODELS: Readonly<Record<Latency, ArchiveModel>> = {
  "160": modelPackage("160", 475_273_363, "a81909a1780d84cff16d73c15e13e67d9d81d8839faf14870d507d8499f7a61a", 657_601_518, "e1b39e5e16bef578a54ed2fba5f031438e000cc36c3ea2ca49d55699d5baebd4"),
  "320": modelPackage("320", 475_272_949, "5f311142337a5c161e92d49f7a3009d8607d3836f39d610bff5307c74d1d2c53", 657_601_518, "f79c3fcc149f268b54b7d5754bdc2ba5c47c16b1fc70d15728a56f6efbf60ca5"),
  "560": modelPackage("560", 475_271_763, "c6bf5e0df765f9d5b43bc9e0536d4b4b3e7d40bdf5ecf13e45f134c51c05ae3a", 657_601_403, "012e9321373af99021415e0b0eb3ec827b4be3153be6f30d9b448fe65e896e68"),
  "1120": modelPackage("1120", 475_276_334, "adbdd5e9fef87300c37cebfcfc4f1ebe56845c860c8a760af0a1dd65ce9beed3", 657_601_521, "2fff2166acaa535bd969fb223c1f0783d71029f143cb298bc54c2afe85abf772"),
};

/** A full-precision package: the sherpa-onnx maintainer's Hugging Face repository
 * for one latency, pinned to a commit so the files behind the URLs cannot change. */
export function fullPrecisionPackage(latency: Latency, revision: string, files: readonly PackageFile[]): LooseModel {
  const directory = `sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-${latency}ms-2026-06-11`;
  return {
    latency, precision: "fp32", directory, files,
    baseUrl: `https://huggingface.co/csukuangfj2/${directory}/resolve/${revision}/`,
    entry: { encoder: "encoder.onnx", decoder: "decoder.onnx", joiner: "joiner.onnx", tokens: "tokens.txt" },
  };
}
/** The full-precision (fp32) packages. A latency without an entry is not offered
 * in full precision; while the table is empty the setting is not shown at all. */
// The weights, prediction network, joint network and vocabulary are the same
// files in all four repositories; only the small encoder graph differs.
const FULL_SHARED_FILES: readonly PackageFile[] = [
  { name: "encoder.data", bytes: 2_454_405_120, sha256: "7584f85df76bc9ae6fbdfa53aa8d97b07a842525d1c501d536d77fd9e4f57ac7" },
  { name: "decoder.onnx", bytes: 59_764_944, sha256: "f9c59ee6fa130bc2ba349dbcbba7c74a4a960a98d4196295ba4e8e5d6bde6b68" },
  { name: "joiner.onnx", bytes: 37_824_291, sha256: "a6bd74c0a31cbde0da0368c1e29d171752108c7ad1231630e079a7d97ceee6f0" },
  { name: "tokens.txt", bytes: 131_440, sha256: "729cc103155bafa785f9cd45746cd41cabe97eab7182fc04d594129587958f8a" },
];
function fullPrecision(latency: Latency, revision: string, encoderBytes: number, encoderSha256: string): LooseModel {
  return fullPrecisionPackage(latency, revision, [{ name: "encoder.onnx", bytes: encoderBytes, sha256: encoderSha256 }, ...FULL_SHARED_FILES]);
}
export const FULL_PRECISION_MODELS: Readonly<Partial<Record<Latency, LooseModel>>> = {
  "160": fullPrecision("160", "44d1e59cb0f8d6f91dc32cb2af4a76b6130393f6", 42_247_580, "e714a7cdd4a804dba85aea4cb0cffa5c0daef46752050d2738d1b502d4b4ab58"),
  "320": fullPrecision("320", "9fafa57a2ba5f3bab0823274b7543fb353e53ffd", 42_247_580, "93efa4bdad4a3ca47d171f22e31c5828fc86cad30b08b4af999f25122fd65925"),
  "560": fullPrecision("560", "2072aba9fb2d6ee6202b69e441761599ab7520b8", 42_247_484, "f1e540e03cb2cc57f5c0f6416b893768cfda23e756bfc0a2c4d502a1350325af"),
  "1120": fullPrecision("1120", "1ecc0a04c7658b6be62b97051fd21f67421392e8", 42_247_583, "7f6b9d121818aff3746153719afdaaa0c1063dc2bf8e49b1039efdeb76df3b1b"),
};

const CATALOG: Readonly<Record<Precision, Readonly<Partial<Record<Latency, ModelPackage>>>>> = { int8: MODELS, fp32: FULL_PRECISION_MODELS };
export function modelFor(latency: Latency, precision: Precision): ModelPackage | undefined {
  return CATALOG[precision][latency];
}
/** Precisions that at least one latency can be installed in. */
export function offeredPrecisions(): Precision[] {
  return PRECISIONS.filter(precision => LATENCIES.some(latency => modelFor(latency, precision)));
}
/** Bytes to fetch, and bytes the installed files occupy. */
export function modelSize(model: ModelPackage): { download: number; installed: number } {
  const installed = model.files.reduce((sum, file) => sum + file.bytes, 0);
  return { download: isArchiveModel(model) ? model.bytes : installed, installed };
}

/* ----------------------------------------------------------------------------
 * Native speech engine: the prebuilt sherpa-onnx Node addon (N-API) with ONNX
 * Runtime, one npm package per platform. Integrity values are npm's own
 * `dist.integrity` for these exact tarballs.
 * -------------------------------------------------------------------------- */

export const RUNTIME_VERSION = "2.0.1";
export interface RuntimePackage {
  key: string;
  name: string;
  url: string;
  bytes: number;
  /** npm subresource-integrity string: sha512-<base64>. */
  integrity: string;
  addon: "sherpa-onnx.node";
  /** Every native file the addon needs beside it; nothing else is unpacked. */
  files: readonly string[];
}
function runtimePackage(key: string, npmPlatform: string, bytes: number, integrity: string, libraries: readonly string[]): RuntimePackage {
  const name = `sherpa-onnx-${npmPlatform}`;
  return {
    key, name, bytes, integrity, addon: "sherpa-onnx.node",
    url: `https://registry.npmjs.org/${name}/-/${name}-${RUNTIME_VERSION}.tgz`,
    files: ["sherpa-onnx.node", ...libraries],
  };
}
const MAC_LIBRARIES = ["libonnxruntime.dylib", "libsherpa-onnx-c-api.dylib", "libsherpa-onnx-cxx-api.dylib"] as const;
const LINUX_LIBRARIES = ["libonnxruntime.so", "libsherpa-onnx-c-api.so", "libsherpa-onnx-cxx-api.so"] as const;
const WINDOWS_LIBRARIES = ["onnxruntime.dll", "onnxruntime_providers_shared.dll", "sherpa-onnx-c-api.dll", "sherpa-onnx-cxx-api.dll"] as const;
/** Keyed by Node's `${process.platform}-${process.arch}`. */
export const RUNTIMES: Readonly<Record<string, RuntimePackage>> = {
  "darwin-arm64": runtimePackage("darwin-arm64", "darwin-arm64", 10_013_200, "sha512-agXmbbwiVPUSMViMhWhYAt59iG21ui7x6HxQFU35XzHOfQe9x6Pg9V160Pzak/66x0ePMjixsLUtMaaUrLfCwQ==", MAC_LIBRARIES),
  "darwin-x64": runtimePackage("darwin-x64", "darwin-x64", 11_167_483, "sha512-SBnHa3LDOSI/5/rpBHGxKQDFq+yIdxowYY0InLzfojTUx+yGgqu7cYBrRxjzvHOiOKi0O4rmlFVZboyhIqpDgA==", MAC_LIBRARIES),
  "linux-x64": runtimePackage("linux-x64", "linux-x64", 11_005_484, "sha512-w5mRRrIvPvcNWac7rQ8AN/t/cwElPGoRpH+ceCRBV7XfjCIQ9Rcr3Ig/kXcJLNOxgK4bGmef+Y47lIWiesDODw==", LINUX_LIBRARIES),
  "linux-arm64": runtimePackage("linux-arm64", "linux-arm64", 13_822_449, "sha512-5CJvLjFYIg23oELCsT7l07fMLT3PdquZ3tqh7KZK3Pzi+c2YiPKRe1DDUxoNdtCaw3ZiS4aQSQPBblB9JStuDA==", LINUX_LIBRARIES),
  "win32-x64": runtimePackage("win32-x64", "win-x64", 8_779_375, "sha512-7vwdAw9PGEb0JLSpK7UFxAdp1vabBHK9Nhw2jFRBWSFgtslUPHIB0T6syJfRgiUGyCeNW9fJvcFAk2F2u7hBEw==", WINDOWS_LIBRARIES),
  "win32-arm64": runtimePackage("win32-arm64", "win-arm64", 8_486_399, "sha512-Mb9iqy2Zp7GC5a99dk5E8EQJsEBnapf+IcwHLVCgtIf5mxYHO9Q8YptnAoOHZOD0Zi+R+MblFyG9qv0Q6tin4Q==", WINDOWS_LIBRARIES),
};

/* ----------------------------------------------------------------------------
 * Settings
 * -------------------------------------------------------------------------- */

export const ENGINE_MODES = ["auto", "in-process", "external"] as const;
export type EngineMode = (typeof ENGINE_MODES)[number];

export interface Settings {
  revision: number;
  /** Make LearnHarness's own Dictate button transcribe on this computer. */
  replaceBuiltIn: boolean;
  /** Also offer a separate button and shortcut that types words live at the caret. */
  liveButton: boolean;
  /** "host" (follow LearnHarness's Dictation language), "auto" or a LANGUAGES[].code. */
  language: string;
  latency: Latency;
  /** Which export of the model to run; see PRECISIONS. */
  precision: Precision;
  /** 0 chooses from the number of CPU cores. */
  threads: number;
  /** Finish automatically after this many seconds without new words. 0 keeps listening. */
  autoStopSeconds: number;
  /** Load the model when LearnHarness starts, so the first dictation is instant. */
  preload: boolean;
  /** Release the ~1 GB model after this many idle minutes. 0 keeps it loaded. */
  unloadAfterMinutes: number;
  engineMode: EngineMode;
  /** Used only by the "external" engine: a Node.js executable. Blank searches PATH. */
  nodePath: string;
}
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  revision: 0, replaceBuiltIn: true, liveButton: false, language: HOST_LANGUAGE, latency: "560", precision: "int8", threads: 0,
  autoStopSeconds: 0, preload: true, unloadAfterMinutes: 30, engineMode: "auto", nodePath: "",
});
export const LIMITS = { threads: { min: 0, max: 16 }, autoStopSeconds: { min: 0, max: 600 }, unloadAfterMinutes: { min: 0, max: 720 } } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integerIn(value: unknown, range: { min: number; max: number }, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < range.min || value > range.max) {
    throw new Error(`${name} must be a whole number from ${range.min} to ${range.max}.`);
  }
  return value;
}
export type SettingsPatch = Partial<Omit<Settings, "revision">>;

/** Strictly validate a partial change; unknown keys are refused, not ignored. */
export function parseSettingsPatch(value: unknown): SettingsPatch {
  if (!isRecord(value)) throw new Error("Settings change must be an object.");
  const patch: SettingsPatch = {};
  for (const [key, entry] of Object.entries(value)) {
    switch (key) {
      case "language": if (entry !== HOST_LANGUAGE && !isLanguage(entry)) throw new Error("Unsupported language."); patch.language = entry as string; break;
      case "replaceBuiltIn": if (typeof entry !== "boolean") throw new Error("Replace built-in dictation must be on or off."); patch.replaceBuiltIn = entry; break;
      case "preload": if (typeof entry !== "boolean") throw new Error("Load at start must be on or off."); patch.preload = entry; break;
      case "liveButton": if (typeof entry !== "boolean") throw new Error("Live-typing button must be on or off."); patch.liveButton = entry; break;
      case "latency": if (!isLatency(entry)) throw new Error("Unsupported responsiveness setting."); patch.latency = entry; break;
      case "precision": if (!isPrecision(entry)) throw new Error("Unsupported model precision."); patch.precision = entry; break;
      case "threads": patch.threads = integerIn(entry, LIMITS.threads, "CPU threads"); break;
      case "autoStopSeconds": patch.autoStopSeconds = integerIn(entry, LIMITS.autoStopSeconds, "Auto-stop"); break;
      case "unloadAfterMinutes": patch.unloadAfterMinutes = integerIn(entry, LIMITS.unloadAfterMinutes, "Unload delay"); break;
      case "engineMode": if (!(ENGINE_MODES as readonly unknown[]).includes(entry)) throw new Error("Unsupported engine mode."); patch.engineMode = entry as EngineMode; break;
      case "nodePath":
        if (typeof entry !== "string" || entry.length > 1024 || /[\0\r\n]/.test(entry)) throw new Error("Node.js path must be a single line of at most 1024 characters.");
        patch.nodePath = entry.trim(); break;
      default: throw new Error(`Unknown setting: ${key}`);
    }
  }
  return patch;
}
/** Read a saved record. A newer or malformed file is refused rather than rewritten. */
export function parseSettings(value: unknown): Settings {
  if (!isRecord(value)) throw new Error("Saved dictation settings are not an object.");
  // `sidebarButton` existed only in 0.1.0 and has no successor.
  const { revision, sidebarButton: _retired, ...rest } = value;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) throw new Error("Saved dictation settings have an invalid revision.");
  return { ...DEFAULT_SETTINGS, ...parseSettingsPatch(rest), revision };
}
/** The engine language for a session: an explicit choice in this plugin wins;
 * otherwise whatever LearnHarness asked for, otherwise auto-detection. */
export function sessionLanguage(setting: string, requested: unknown): string {
  if (setting !== HOST_LANGUAGE) return isLanguage(setting) ? setting : AUTO_LANGUAGE;
  return isLanguage(requested) ? requested : AUTO_LANGUAGE;
}
export function effectiveThreads(settings: Pick<Settings, "threads">, cores: number): number {
  if (settings.threads > 0) return settings.threads;
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
}

/* ----------------------------------------------------------------------------
 * Frontend <-> backend bridge payloads (all JSON)
 * -------------------------------------------------------------------------- */

export type InstallPhase = "idle" | "downloading-engine" | "unpacking-engine" | "downloading-model" | "unpacking-model" | "done" | "error";
export interface InstallProgress {
  phase: InstallPhase;
  /** Bytes finished and expected for the current phase. */
  done: number;
  total: number;
  error?: string;
}
export interface Status {
  settings: Settings;
  platform: { key: string; supported: boolean };
  engineInstalled: boolean;
  modelInstalled: boolean;
  /** Latencies whose model package, in the chosen precision, is already on disk. */
  installedModels: Latency[];
  /** Precisions already on disk for the chosen latency. */
  installedPrecisions: Precision[];
  install: InstallProgress;
  engine: { state: "unloaded" | "loading" | "ready" | "error"; mode?: "in-process" | "external"; error?: string; loadMs?: number };
  sessionActive: boolean;
  downloadsDirectory: string;
  /** What a full installation for the current settings still has to fetch. `file`
   * is where it is kept, relative to the downloads directory. */
  pending: { name: string; url: string; bytes: number; file: string }[];
  cores: number;
  threads: number;
}
export type SessionState = "loading" | "listening" | "ended";
export interface SessionUpdate {
  session: string;
  state: SessionState;
  /** Transcript characters after the caller's `have` offset. */
  text: string;
  /** Total transcript length after this update. */
  length: number;
  /** Audio received but not yet transcribed. */
  lagMs: number;
  /** Present when state is "ended". */
  reason?: "finished" | "cancelled" | "limit" | "idle" | "too-slow" | "error";
  error?: string;
}

/* ----------------------------------------------------------------------------
 * Transcript text
 * -------------------------------------------------------------------------- */

/** The model can append a detected-language tag such as <en-US> in auto mode. */
const LANGUAGE_TAG = /<[a-z]{2,3}(?:-[A-Za-z]{2,4})?>/g;

/** Pure function of the raw recognizer text, so a growing input yields a growing output. */
export function normalizeTranscript(raw: string): string {
  return raw.replace(LANGUAGE_TAG, "").replace(/\s+/g, " ").replace(/^ /, "");
}

/** Never retract text already handed out: extend it with whatever is new. */
export function extendTranscript(previous: string, next: string): string {
  if (next.startsWith(previous)) return next;
  let common = 0;
  const limit = Math.min(previous.length, next.length);
  while (common < limit && previous.charCodeAt(common) === next.charCodeAt(common)) common++;
  return previous + next.slice(common);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}
