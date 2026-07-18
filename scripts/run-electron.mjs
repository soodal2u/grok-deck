import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(root, "apps", "desktop");

let electronPath;
try {
  electronPath = String(require("electron")).trim();
} catch {
  electronPath = path.join(root, "node_modules", "electron", "dist", "electron.exe");
}

if (typeof electronPath !== "string" || !fs.existsSync(electronPath)) {
  // Fallback if path.txt has trailing newlines from Windows editors
  const fallback = path.join(root, "node_modules", "electron", "dist", "electron.exe");
  if (fs.existsSync(fallback)) {
    electronPath = fallback;
  } else {
    console.error("Electron binary not found. Run: node scripts/fix-electron.mjs");
    process.exit(1);
  }
}

const child = spawn(electronPath, [appDir], {
  stdio: "inherit",
  env: process.env,
  cwd: root,
});

child.on("exit", (code) => process.exit(code ?? 0));
