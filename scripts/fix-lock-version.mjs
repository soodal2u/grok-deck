import fs from "node:fs";

const path = new URL("../package-lock.json", import.meta.url);
let t = fs.readFileSync(path, "utf8");

// Accidental PowerShell corruption: literal \r\n text inside JSON strings/fields
t = t.replaceAll('"name": "grok-deck",\\r\\n      "version": "0.3.0"', '"name": "grok-deck",\n      "version": "0.3.0"');
t = t.replaceAll('"name": "grok-deck",\r\n      "version": "0.3.0"', '"name": "grok-deck",\n      "version": "0.3.0"');

// Ensure workspace package versions are 0.3.0 where expected
const data = JSON.parse(t);
data.version = "0.3.0";
const bumpKeys = new Set(["", "apps/desktop", "packages/acp-client", "packages/shared"]);
const bumpNames = new Set(["grok-deck", "@grok-deck/acp-client", "@grok-deck/shared"]);
for (const [k, v] of Object.entries(data.packages || {})) {
  if (!v || typeof v !== "object") continue;
  if (bumpKeys.has(k) || bumpNames.has(v.name)) {
    v.version = "0.3.0";
  }
}
fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
console.log("package-lock.json fixed →", data.version);
