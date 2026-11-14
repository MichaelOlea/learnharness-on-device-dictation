/** Build straight into ./dist, the fixed runtime root LearnHarness loads.
 * Only generated dist/ is ever removed; sibling data/ is never touched. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");
try {
  if (fs.lstatSync(output).isSymbolicLink()) throw new Error("Refusing to build into a symlinked dist directory.");
  try { fs.lstatSync(path.join(output, "data")); throw new Error("Refusing to build over dist/data; move plugin data outside dist first."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
} catch (error) { if (error.code !== "ENOENT") throw error; }
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, "assets"), { recursive: true });

const common = { absWorkingDir: root, bundle: true, target: "es2022", minify: true, legalComments: "eof", metafile: true };
const node = { ...common, format: "cjs", platform: "node" };
const results = [
  await build({ ...common, entryPoints: ["src/main.ts"], outfile: path.join(output, "main.js"), format: "esm", platform: "browser" }),
  // Loaded by URL into the audio thread; it must stay a self-contained script.
  await build({ ...common, entryPoints: ["src/pcm-worklet.ts"], outfile: path.join(output, "assets/pcm-worklet.js"), format: "iife", platform: "browser" }),
  await build({ ...node, entryPoints: ["src/backend.ts"], outfile: path.join(output, "backend.cjs") }),
  // Separate files because each one is started as its own thread (or process).
  await build({ ...node, entryPoints: ["src/engine-worker.ts"], outfile: path.join(output, "engine-worker.cjs") }),
  await build({ ...node, entryPoints: ["src/extract-worker.ts"], outfile: path.join(output, "extract-worker.cjs") }),
];
const bundled = new Set();
for (const result of results) for (const input of Object.keys(result.metafile.inputs)) {
  if (input.startsWith("node_modules/")) bundled.add(input.split("/").slice(1, input.startsWith("node_modules/@") ? 3 : 2).join("/"));
  else if (!input.startsWith("src/")) throw new Error(`Unexpected runtime input: ${input}`);
}
for (const file of ["manifest.json", "README.md", "LICENSE", "THIRD-PARTY.md", "AI_DISCLOSURE.md"]) fs.copyFileSync(path.join(root, file), path.join(output, file));
fs.copyFileSync(path.join(root, "src/styles.css"), path.join(output, "styles.css"));
fs.mkdirSync(path.join(output, "licenses"));
for (const name of [...bundled].sort()) {
  const directory = path.join(root, "node_modules", name);
  const licenses = fs.readdirSync(directory).filter(file => /^licen[sc]e/i.test(file));
  if (!licenses.length) throw new Error(`Missing license file for bundled dependency ${name}.`);
  for (const file of licenses) fs.copyFileSync(path.join(directory, file), path.join(output, "licenses", `${name.replaceAll("/", "-")}-${file}`));
}
const size = file => `${(fs.statSync(path.join(output, file)).size / 1024).toFixed(1)} kB`;
console.log(`Built On-device dictation into ${output}`);
console.log(`main.js ${size("main.js")}, backend.cjs ${size("backend.cjs")}, engine-worker.cjs ${size("engine-worker.cjs")}, extract-worker.cjs ${size("extract-worker.cjs")}`);
console.log(`Bundled dependencies: ${[...bundled].sort().join(", ") || "none"}`);
