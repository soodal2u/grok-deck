import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import type { AuthStatus } from "@grok-deck/shared";

const AUTH_PATH = join(homedir(), ".grok", "auth.json");

type AuthEntry = {
  key?: string;
  auth_mode?: string;
  email?: string;
  user_id?: string;
  expires_at?: string;
  refresh_token?: string;
  oidc_issuer?: string;
  oidc_client_id?: string;
};

/**
 * Read the same credential store as the official Grok CLI.
 * OAuth / SuperGrok session → no separate console.x.ai API key billing.
 */
export async function getAuthStatus(): Promise<AuthStatus> {
  try {
    if (!existsSync(AUTH_PATH)) {
      return { state: "unauthenticated" };
    }
    const raw = await readFile(AUTH_PATH, "utf8");
    const data = JSON.parse(raw) as Record<string, AuthEntry>;
    const entry = Object.values(data)[0];
    if (!entry?.key && !entry?.refresh_token) {
      return { state: "unauthenticated" };
    }

    // Expired access token is OK if refresh_token exists — CLI/agent refreshes it.
    return {
      state: "authenticated",
      email: entry.email,
      userId: entry.user_id,
      expiresAt: entry.expires_at,
    };
  } catch (err) {
    return {
      state: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Launch `grok login --oauth` so the user signs in via browser (same as CLI).
 * Blocks until the process exits.
 */
export function loginWithGrokCli(grokPath = "grok"): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolve) => {
    const child = spawn(grokPath, ["login", "--oauth"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
      shell: false,
    });

    let stderr = "";
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.stdout?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });

    child.on("error", (err) => {
      resolve({
        ok: false,
        message:
          err.message.includes("ENOENT")
            ? "grok CLI not found. Install from https://x.ai/cli and ensure it is on PATH."
            : err.message,
      });
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({
          ok: false,
          message: stderr.trim() || `grok login exited with code ${code}`,
        });
      }
    });
  });
}

export async function logoutLocal(): Promise<void> {
  // Prefer official logout if available; fall back to clearing auth.json entry file.
  await new Promise<void>((resolve) => {
    const child = spawn("grok", ["logout"], {
      env: process.env,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve();
    }, 5000);
  });

  // If logout left credentials, wipe auth file (same effect as CLI logout).
  if (existsSync(AUTH_PATH)) {
    try {
      await writeFile(AUTH_PATH, "{}\n", "utf8");
    } catch {
      await unlink(AUTH_PATH).catch(() => undefined);
    }
  }
}

export async function ensureAppDataDir(name: string): Promise<string> {
  const dir = join(homedir(), ".grokdeck");
  await mkdir(dir, { recursive: true });
  return join(dir, name);
}
