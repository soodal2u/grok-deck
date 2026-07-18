import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TokenUsage } from "@grok-deck/shared";
import { ghostWorkspaceKey } from "./ghost-git";

function usagePath(workspaceRoot: string): string {
  const hash = createHash("sha256").update(ghostWorkspaceKey(workspaceRoot)).digest("hex").slice(0, 16);
  return join(homedir(), ".grokdeck", "usage", `${hash}.json`);
}

/** Last known context usage for a project (survives agent restarts). */
export async function loadUsage(workspaceRoot: string): Promise<TokenUsage | null> {
  try {
    const raw = await readFile(usagePath(workspaceRoot), "utf8");
    const parsed = JSON.parse(raw) as TokenUsage;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* missing */
  }
  return null;
}

export async function saveUsage(workspaceRoot: string, usage: TokenUsage): Promise<void> {
  try {
    const path = usagePath(workspaceRoot);
    await mkdir(join(homedir(), ".grokdeck", "usage"), { recursive: true });
    await writeFile(path, JSON.stringify(usage, null, 2), "utf8");
  } catch {
    /* ignore disk errors */
  }
}
