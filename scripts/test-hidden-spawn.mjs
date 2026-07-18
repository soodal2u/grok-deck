/**
 * Verify Windows agent spawns do not open a visible console/WT window.
 * Runs python -c and cmd echo via TerminalManager logic equivalent.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tokenizeCmdLine(input) {
  const tokens = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function needsShell(cmdline) {
  return /&&|\|\||[|<>]|\b(cd|set|call|if|for|exit)\b/i.test(cmdline) || /[\r\n]/.test(cmdline);
}

function resolveWinCommand(command, args) {
  if (args.length > 0) return { file: command, args };
  const trimmed = command.trim();
  if (needsShell(trimmed)) {
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", trimmed],
      verbatim: true,
    };
  }
  const tokens = tokenizeCmdLine(trimmed);
  return { file: tokens[0], args: tokens.slice(1) };
}

function runHidden(command, args = []) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PYTHONUNBUFFERED: "1", TERM: "dumb" };
    delete env.WT_SESSION;
    delete env.WT_PROFILE_ID;
    delete env.WT_PROFILE;

    const resolved = resolveWinCommand(command, args);
    console.log("SPAWN", resolved.file, resolved.args);

    const child = spawn(resolved.file, resolved.args, {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsVerbatimArguments: resolved.verbatim === true,
    });

    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out: out.trim(), pid: child.pid }));
  });
}

const cases = [
  ["python", ["-c", "print('hidden-ok-direct')"]],
  ["python -c \"print('hidden-ok-string')\"", []],
  ["cmd", ["/c", "echo hidden-ok-cmd"]],
];

for (const [cmd, args] of cases) {
  const r = await runHidden(cmd, args);
  console.log("RESULT", { cmd, args, code: r.code, out: r.out.slice(0, 200) });
  if (r.code !== 0) {
    console.error("FAIL non-zero exit", r);
    process.exit(1);
  }
}

console.log("OK: all hidden spawns completed (check no translucent WT window flashed)");
process.exit(0);
