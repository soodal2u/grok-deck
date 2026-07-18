import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import type { SkillInfo, SlashCommand } from "@grok-deck/shared";

type SkillSource = SkillInfo["source"];

function parseFrontmatter(raw: string): { name?: string; description?: string } {
  if (!raw.startsWith("---")) return {};
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return {};
  const yaml = raw.slice(3, end).trim();
  const out: { name?: string; description?: string } = {};
  // Minimal YAML: name / description (description may be multiline with >)
  let key: "name" | "description" | null = null;
  let buf = "";
  for (const line of yaml.split(/\r?\n/)) {
    const m = line.match(/^(name|description)\s*:\s*(.*)$/);
    if (m) {
      if (key && buf) out[key] = cleanYamlScalar(buf);
      key = m[1] as "name" | "description";
      buf = m[2] || "";
      if (buf === ">" || buf === "|") buf = "";
      continue;
    }
    if (key && (line.startsWith("  ") || line.startsWith("\t"))) {
      buf += (buf ? " " : "") + line.trim();
    }
  }
  if (key && buf) out[key] = cleanYamlScalar(buf);
  return out;
}

function cleanYamlScalar(s: string): string {
  return s
    .replace(/^['"]|['"]$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function readSkillMd(skillMd: string, source: SkillSource): Promise<SkillInfo | null> {
  try {
    const raw = await readFile(skillMd, "utf8");
    const fm = parseFrontmatter(raw);
    const dirName = basename(dirname(skillMd));
    const name = (fm.name || dirName).trim();
    if (!name) return null;
    const description =
      fm.description ||
      raw
        .replace(/^---[\s\S]*?---\s*/, "")
        .split(/\r?\n/)
        .find((l) => l.trim() && !l.startsWith("#"))
        ?.trim() ||
      `Skill: ${name}`;
    return { name, description: description.slice(0, 200), source, path: skillMd };
  } catch {
    return null;
  }
}

async function scanSkillsDir(dir: string, source: SkillSource, into: Map<string, SkillInfo>) {
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.startsWith(".")) continue;
    const full = join(dir, ent);
    try {
      const st = await stat(full);
      if (st.isDirectory()) {
        const skillMd = join(full, "SKILL.md");
        if (existsSync(skillMd)) {
          const skill = await readSkillMd(skillMd, source);
          if (skill && !into.has(skill.name.toLowerCase())) {
            into.set(skill.name.toLowerCase(), skill);
          }
        }
      } else if (ent.toLowerCase().endsWith(".md") && source === "commands") {
        // Flat command markdown: name = stem
        const name = basename(ent, ".md");
        if (!into.has(name.toLowerCase())) {
          const raw = await readFile(full, "utf8").catch(() => "");
          const fm = parseFrontmatter(raw);
          into.set(name.toLowerCase(), {
            name: fm.name || name,
            description: (fm.description || `Command: ${name}`).slice(0, 200),
            source: "commands",
            path: full,
          });
        }
      }
    } catch {
      /* skip */
    }
  }
}

/**
 * Discover skills/commands the same way Grok does (priority: project > user > bundled).
 */
export async function listSkills(projectRoot?: string | null): Promise<SkillInfo[]> {
  const map = new Map<string, SkillInfo>();

  // Lower priority first so higher can overwrite
  await scanSkillsDir(join(homedir(), ".grok", "bundled", "skills"), "bundled", map);
  await scanSkillsDir(join(homedir(), ".grok", "skills"), "user", map);
  await scanSkillsDir(join(homedir(), ".grok", "commands"), "commands", map);

  if (projectRoot) {
    await scanSkillsDir(join(projectRoot, ".grok", "skills"), "project", map);
    await scanSkillsDir(join(projectRoot, ".grok", "commands"), "commands", map);
    await scanSkillsDir(join(projectRoot, ".agents", "skills"), "project", map);
    await scanSkillsDir(join(projectRoot, ".claude", "skills"), "project", map);
    await scanSkillsDir(join(projectRoot, ".claude", "commands"), "commands", map);
    await scanSkillsDir(join(projectRoot, ".cursor", "skills"), "project", map);
  }

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function skillsAsSlashCommands(skills: SkillInfo[]): SlashCommand[] {
  return skills.map((s) => ({
    name: s.name,
    description: s.description,
    kind: "skill" as const,
    source: s.source,
  }));
}
