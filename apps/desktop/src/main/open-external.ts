import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { OpenExternalTarget } from "@grok-deck/shared";

/**
 * Open project folder in Explorer / terminals / editors.
 *
 * Windows note: spawning cmd/powershell directly from Electron often fails to
 * show a console. Use a short hidden PowerShell that calls Start-Process with
 * WorkingDirectory — works with Korean/space paths.
 */
export async function openProjectExternal(
  cwd: string,
  target: OpenExternalTarget,
): Promise<{ ok: boolean; message?: string }> {
  if (!cwd || !existsSync(cwd)) {
    return { ok: false, message: `폴더가 없습니다: ${cwd}` };
  }

  const dir = cwd.replace(/[\\/]+$/, "") || cwd;

  try {
    switch (target) {
      case "explorer": {
        await runPs(
          `Start-Process -FilePath explorer.exe -ArgumentList @(${psQuote(dir)})`,
        );
        return { ok: true, message: `탐색기: ${dir}` };
      }
      case "powershell": {
        await runPs(
          `Start-Process -FilePath powershell.exe -WorkingDirectory ${psQuote(dir)} -ArgumentList '-NoExit','-NoProfile' -WindowStyle Normal`,
        );
        return { ok: true, message: `PowerShell: ${dir}` };
      }
      case "cmd": {
        const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
        await runPs(
          `Start-Process -FilePath ${psQuote(comspec)} -WorkingDirectory ${psQuote(dir)} -ArgumentList '/k','title Grok Deck' -WindowStyle Normal`,
        );
        return { ok: true, message: `CMD: ${dir}` };
      }
      case "vscode": {
        return openWithCode(dir);
      }
      case "cursor": {
        return openWithEditor("cursor", dir, "Cursor CLI를 PATH에서 찾지 못했습니다");
      }
      default:
        return { ok: false, message: `Unknown target: ${target}` };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function runPs(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      {
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: process.env,
      },
    );

    let stderr = "";
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (e) => done(e));
    child.on("exit", (code) => {
      if (code && code !== 0) {
        done(new Error(stderr.trim() || `PowerShell exit ${code}`));
      } else {
        done();
      }
    });
    setTimeout(() => done(), 3000);
  });
}

async function openWithCode(cwd: string): Promise<{ ok: boolean; message?: string }> {
  const candidates = [
    join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "Code.exe"),
    join(process.env["ProgramFiles"] || "", "Microsoft VS Code", "Code.exe"),
    join(process.env["ProgramFiles(x86)"] || "", "Microsoft VS Code", "Code.exe"),
  ].filter(Boolean);

  for (const exe of candidates) {
    if (!existsSync(exe)) continue;
    try {
      await runPs(
        `Start-Process -FilePath ${psQuote(exe)} -ArgumentList '-n',${psQuote(cwd)} -WindowStyle Normal`,
      );
      return { ok: true, message: `VS Code: ${cwd}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  return openWithEditor("code", cwd, "VS Code를 찾지 못했습니다. PATH에 code 가 있는지 확인하세요.");
}

function openWithEditor(
  cmd: string,
  cwd: string,
  notFoundMsg: string,
): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, ["-n", cwd], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: true,
      env: process.env,
    });
    child.on("error", (err) => {
      resolve({
        ok: false,
        message: err.message.includes("ENOENT") ? notFoundMsg : err.message,
      });
    });
    child.unref();
    setTimeout(() => resolve({ ok: true, message: `${cmd}: ${cwd}` }), 400);
  });
}
