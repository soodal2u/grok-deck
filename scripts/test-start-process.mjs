import { spawn } from "node:child_process";
import path from "node:path";

function psQuote(s) {
  return `'${s.replace(/'/g, "''")}'`;
}

function runPs(command) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", done);
    child.on("exit", (c) => (c ? done(new Error(err || `exit ${c}`)) : done()));
    setTimeout(() => done(), 3000);
  });
}

const dir = path.join(process.env.USERPROFILE, "Documents");
await runPs(
  `Start-Process -FilePath cmd.exe -WorkingDirectory ${psQuote(dir)} -ArgumentList '/k','title GrokDeck-CMD-OK' -WindowStyle Normal`,
);
await runPs(
  `Start-Process -FilePath powershell.exe -WorkingDirectory ${psQuote(dir)} -ArgumentList '-NoExit','-NoProfile' -WindowStyle Normal`,
);
console.log("Start-Process OK", dir);
