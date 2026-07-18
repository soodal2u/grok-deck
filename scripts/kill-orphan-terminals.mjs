import { execSync } from "node:child_process";

const out = execSync(
  `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"`,
  { encoding: "utf8", maxBuffer: 30 * 1024 * 1024 },
);

const list = JSON.parse(out || "[]");
const arr = Array.isArray(list) ? list : [list];

const kill = [];
for (const p of arr) {
  const cl = p.CommandLine || "";
  const name = p.Name || "";
  if (!/cmd\.exe|powershell\.exe/i.test(name)) continue;

  // Keep tooling shells
  if (/NonInteractive|chrome-extension|run-electron|ConvertTo-Json|kill-orphan/i.test(cl)) {
    continue;
  }

  const isGrokStart =
    /Grok Deck/.test(cl) && (/\/D/.test(cl) || /start/.test(cl));
  const isBarePs =
    cl === "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" ||
    cl === '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"';
  const isNoExitPs =
    /powershell\.exe".*-NoExit/i.test(cl) || /-NoExit.*-NoProfile/i.test(cl);

  if (isGrokStart || isBarePs || isNoExitPs) {
    kill.push({ id: p.ProcessId, name, cl: cl.slice(0, 140) });
  }
}

console.log("Candidates:", kill.length);
for (const k of kill) {
  try {
    process.kill(k.id);
    console.log("killed", k.id, k.name, k.cl);
  } catch (e) {
    console.log("fail", k.id, e.message);
  }
}
console.log("done");
