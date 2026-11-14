/** Zip the built plugin for a GitHub release.
 *
 * The archive holds dist/ (plus README and licences) at its root and is named
 * after the plugin ID, so "Extract All" into the plugins directory produces
 * exactly <plugins>/on-device-dictation/dist/manifest.json. Uses the system
 * `zip` (Linux/macOS) or PowerShell's Compress-Archive (Windows). */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "dist/manifest.json"), "utf8"));
const out = path.join(root, "release");
const stage = path.join(out, "stage");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(path.join(root, "dist"), path.join(stage, "dist"), { recursive: true });
for (const file of ["README.md", "LICENSE", "THIRD-PARTY.md", "AI_DISCLOSURE.md"]) fs.copyFileSync(path.join(root, file), path.join(stage, file));
const archive = path.join(out, `${manifest.id}.zip`);
if (process.platform === "win32") {
  execFileSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${stage}\\*' -DestinationPath '${archive}'`], { stdio: "inherit" });
} else {
  execFileSync("zip", ["-qr9X", archive, "."], { cwd: stage, stdio: "inherit" });
}
fs.rmSync(stage, { recursive: true, force: true });
console.log(`${archive} (${(fs.statSync(archive).size / 1024).toFixed(0)} kB) — plugin ${manifest.id} ${manifest.version}`);
