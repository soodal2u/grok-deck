/**
 * extract-zip occasionally leaves a broken Electron dist on Windows.
 * This postinstall re-extracts from the local electron-get cache when electron.exe is missing.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findElectronDir(start) {
  const candidates = [
    path.join(start, "node_modules", "electron"),
    path.join(start, "apps", "desktop", "node_modules", "electron"),
  ];
  return candidates.find((p) => fs.existsSync(path.join(p, "package.json")));
}

const electronDir = findElectronDir(root);
if (!electronDir) {
  console.warn("[fix-electron] electron package not found; skip");
  process.exit(0);
}

const distDir = path.join(electronDir, "dist");
const exe = path.join(distDir, process.platform === "win32" ? "electron.exe" : "electron");
if (fs.existsSync(exe)) {
  process.exit(0);
}

console.log("[fix-electron] electron binary missing — re-downloading…");

const { downloadArtifact } = require(path.join(electronDir, "node_modules", "@electron/get")) ||
  require("@electron/get");
const { version } = require(path.join(electronDir, "package.json"));

const zipPath = await downloadArtifact({
  version,
  artifactName: "electron",
  force: true,
  platform: process.platform,
  arch: process.arch,
});

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

// Prefer Node's unzip via PowerShell on Windows for reliability
if (process.platform === "win32") {
  const { spawnSync } = await import("node:child_process");
  const ps = `
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}', '${distDir.replace(/'/g, "''")}')
  `;
  const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    process.exit(1);
  }
} else {
  const extract = require("extract-zip");
  await extract(zipPath, { dir: distDir });
}

const platformPath = process.platform === "win32" ? "electron.exe" : "electron";
// Avoid Windows CRLF — electron's index.js does not trim path.txt
fs.writeFileSync(path.join(electronDir, "path.txt"), platformPath, { encoding: "utf8" });
if (!fs.existsSync(path.join(distDir, platformPath))) {
  console.error("[fix-electron] still missing binary after extract");
  process.exit(1);
}
console.log("[fix-electron] OK →", path.join(distDir, platformPath));
