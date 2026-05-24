import { promises as fs } from "node:fs";
import path from "node:path";
import type { SkillInfo } from "./types.js";

export async function discoverSkills(cwd: string, configuredPaths: string[], enabled: boolean): Promise<SkillInfo[]> {
  if (!enabled) return [];
  const roots = [path.join(cwd, ".mini-code", "skills"), path.join(cwd, ".agents", "skills"), path.join(cwd, ".claude", "skills"), ...configuredPaths.map((item) => path.resolve(cwd, item))];
  const skills: SkillInfo[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const filePath of await skillFiles(root)) {
      const skill = await readSkill(filePath);
      if (!skill || seen.has(skill.name)) continue;
      seen.add(skill.name);
      skills.push(skill);
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function renderSkillsForPrompt(skills: SkillInfo[]): string {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";
  return [
    "Available skills. Use /skill:name when the user explicitly asks, or load the skill when it clearly matches the task:",
    ...visible.map((skill) => `- ${skill.name}: ${skill.description}`)
  ].join("\n");
}

export function renderSkillList(skills: SkillInfo[]): string {
  if (skills.length === 0) return "No skills discovered.";
  return skills.map((skill) => `${skill.name}\t${skill.description}\t${skill.path}`).join("\n");
}

export function skillInjection(skill: SkillInfo, args: string): string {
  return [`Use Mini Code skill: ${skill.name}`, skill.description ? `Description: ${skill.description}` : "", args ? `User arguments: ${args}` : "", "Skill content:", skill.content].filter(Boolean).join("\n\n");
}

async function skillFiles(root: string): Promise<string[]> {
  const stat = await fs.stat(root).catch(() => undefined);
  if (!stat) return [];
  if (stat.isFile() && root.endsWith(".md")) return [root];
  if (!stat.isDirectory()) return [];
  const files: string[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const skillPath = path.join(fullPath, "SKILL.md");
      if (await exists(skillPath)) files.push(skillPath);
      files.push(...(await skillFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return Array.from(new Set(files));
}

async function readSkill(filePath: string): Promise<SkillInfo | undefined> {
  const content = await fs.readFile(filePath, "utf8").catch(() => undefined);
  if (!content) return undefined;
  const { frontmatter, body } = parseFrontmatter(content);
  const inferred = path.basename(path.dirname(filePath)) === "." ? path.basename(filePath, ".md") : path.basename(path.dirname(filePath));
  const name = frontmatter.name || inferred;
  const description = frontmatter.description || firstParagraph(body) || "No description";
  return {
    name: normalizeName(name),
    description,
    path: filePath,
    content,
    allowedTools: splitWords(frontmatter["allowed-tools"]),
    disableModelInvocation: /^(true|1|yes)$/i.test(frontmatter["disable-model-invocation"] ?? "")
  };
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  if (!content.startsWith("---\n")) return { frontmatter: {}, body: content };
  const end = content.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: content };
  const raw = content.slice(4, end);
  const frontmatter: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    frontmatter[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return { frontmatter, body: content.slice(end + 4).trim() };
}

function firstParagraph(body: string): string {
  return body.split(/\n\s*\n/).map((part) => part.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

function splitWords(value: string | undefined): string[] {
  return value?.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean) ?? [];
}

async function exists(filePath: string): Promise<boolean> {
  return Boolean(await fs.stat(filePath).catch(() => undefined));
}
