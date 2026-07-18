import { existsSync, renameSync, cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** User data root: ~/.grokdeck (settings, themes, ghost history) */
export function deckHome(): string {
  return join(homedir(), ".grokdeck");
}

/**
 * One-time migrate from legacy ~/.grok-deck → ~/.grokdeck if needed.
 */
export function ensureDeckHome(): string {
  const next = deckHome();
  const legacy = join(homedir(), ".grok-deck");
  try {
    if (!existsSync(next) && existsSync(legacy)) {
      renameSync(legacy, next);
    } else if (existsSync(next) && existsSync(legacy)) {
      // Both exist — leave legacy; prefer new dir
    } else if (!existsSync(next)) {
      mkdirSync(next, { recursive: true });
    }
  } catch {
    try {
      mkdirSync(next, { recursive: true });
      if (existsSync(legacy) && !existsSync(join(next, "settings.json"))) {
        cpSync(legacy, next, { recursive: true, force: false });
      }
    } catch {
      /* ignore */
    }
  }
  return next;
}
