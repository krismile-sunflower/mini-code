import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SkillHelper, SkillInfo, ToolRisk } from "./types.js";

export interface SkillDiscoveryOptions {
  includeGlobal?: boolean;
  homeDir?: string;
}

export interface SkillCreateResult {
  name: string;
  path: string;
  description: string;
}

export interface SkillCreateOptions {
  instructions?: string;
}

interface SkillRoot {
  path: string;
  source: NonNullable<SkillInfo["source"]>;
  configuredFile?: boolean;
  priority: number;
}

export function skillRoots(cwd: string, configuredPaths: string[], options: SkillDiscoveryOptions = {}): string[] {
  return skillRootEntries(cwd, configuredPaths, options).map((root) => root.path);
}

export async function discoverSkills(cwd: string, configuredPaths: string[], enabled: boolean, options: SkillDiscoveryOptions = {}): Promise<SkillInfo[]> {
  if (!enabled) return [];
  const skills: SkillInfo[] = [];
  for (const root of skillRootEntries(cwd, configuredPaths, options)) {
    for (const filePath of await skillFiles(root)) {
      const skill = await readSkill(filePath, root);
      if (skill) skills.push(skill);
    }
  }
  return markDefaultSkills(ensureUniqueIds(skills));
}

export function renderSkillsForPrompt(skills: SkillInfo[]): string {
  const visible = defaultSkills(skills).filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";
  return [
    "Available skills. Use /skill:name when the user explicitly asks, or load the skill when it clearly matches the task:",
    ...visible.map((skill) => `- ${skill.name}: ${skill.description}`)
  ].join("\n");
}

export function renderSkillList(skills: SkillInfo[]): string {
  if (skills.length === 0) return "No skills discovered.";
  const defaults = defaultSkills(skills).length;
  const shadowed = skills.filter((skill) => skill.shadowedBy).length;
  const roots = new Set(skills.map((skill) => skill.root).filter(Boolean)).size;
  return [
    `skills: total=${skills.length} defaults=${defaults} shadowed=${shadowed} roots=${roots}`,
    "id\tname\tsource\tstatus\tdescription\tpath",
    ...skills.map((skill) => `${skill.id}\t${skill.name}\t${skill.source ?? "project"}\t${skillStatus(skill)}\t${skill.description}\t${skill.path}`),
    shadowed > 0 ? "hint: /skill:<name> loads the default skill; /skill:<id> loads an exact skill." : ""
  ].filter(Boolean).join("\n");
}

export function renderSkillInspect(skill: SkillInfo, candidates: SkillInfo[] = [skill]): string {
  if (candidates.length > 1) {
    return [
      `matches for: ${skill.name}`,
      "id\tstatus\tsource\tdescription\tpath",
      ...candidates.map((item) => `${item.id}\t${skillStatus(item)}\t${item.source ?? "project"}\t${item.description}\t${item.path}`),
      "",
      `default: ${candidates.find((item) => !item.shadowedBy)?.id ?? candidates[0]?.id}`
    ].join("\n");
  }
  return [
    `id: ${skill.id}`,
    `name: ${skill.name}`,
    `displayName: ${skill.displayName}`,
    `source: ${skill.source ?? "project"}`,
    `status: ${skillStatus(skill)}`,
    `description: ${skill.description}`,
    `path: ${skill.path}`,
    `root: ${skill.root ?? "[unknown]"}`,
    `relativePath: ${skill.relativePath ?? "[unknown]"}`,
    `allowedTools: ${skill.allowedTools.join(", ") || "[none declared]"}`,
    `disableModelInvocation: ${skill.disableModelInvocation ? "true" : "false"}`,
    `activation.keywords: ${skill.activation?.keywords.join(", ") || "[none]"}`,
    `activation.fileGlobs: ${skill.activation?.fileGlobs.join(", ") || "[none]"}`,
    `references: ${skill.references?.join(", ") || "[none]"}`,
    `helpers: ${skill.helpers?.map((helper) => `${helper.name} (${helper.risk}) ${helper.command}`).join("; ") || "[none]"}`
  ].join("\n");
}

export function skillInjection(skill: SkillInfo, args: string): string {
  return [`Use Mini Code skill: ${skill.name}`, skill.description ? `Description: ${skill.description}` : "", args ? `User arguments: ${args}` : "", "Skill content:", skill.content].filter(Boolean).join("\n\n");
}

export async function createProjectSkill(cwd: string, rawName: string, rawDescription = "", options: SkillCreateOptions = {}): Promise<SkillCreateResult> {
  const name = normalizeName(rawName);
  if (!name || name === "skill") throw new Error("Skill name is required. Usage: /skill create <name> [description]");
  const description = cleanDescription(rawDescription) || `Use when working on ${name.replaceAll("-", " ")} tasks.`;
  const instructions = cleanInstructions(options.instructions ?? "");
  const directory = path.join(cwd, ".mini-code", "skills", name);
  const filePath = path.join(directory, "SKILL.md");
  if (await exists(filePath)) throw new Error(`Skill already exists: ${filePath}`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(filePath, renderSkillTemplate(name, description, instructions), "utf8");
  return { name, description, path: filePath };
}

export function defaultSkills(skills: SkillInfo[]): SkillInfo[] {
  return skills.filter((skill) => !skill.shadowedBy);
}

export function resolveSkill(skills: SkillInfo[], nameOrId: string): { skill?: SkillInfo; candidates: SkillInfo[] } {
  const normalized = normalizeName(nameOrId);
  const exact = skills.find((skill) => skill.id === nameOrId || skill.id === normalized);
  if (exact) return { skill: exact, candidates: [exact] };
  const candidates = skills.filter((skill) => skill.name === normalized || skill.name.startsWith(normalized));
  const defaults = candidates.filter((skill) => !skill.shadowedBy);
  return { skill: defaults[0] ?? candidates[0], candidates };
}

function skillRootEntries(cwd: string, configuredPaths: string[], options: SkillDiscoveryOptions = {}): SkillRoot[] {
  const homeDir = options.homeDir ?? os.homedir();
  const roots: SkillRoot[] = [
    { path: path.join(cwd, ".mini-code", "skills"), source: "project", priority: 0 },
    { path: path.join(cwd, ".agents", "skills"), source: "project", priority: 0 },
    { path: path.join(cwd, ".claude", "skills"), source: "project", priority: 0 }
  ];
  if (options.includeGlobal !== false) {
    roots.push(
      { path: path.join(homeDir, ".mini-code", "skills"), source: "global", priority: 2 },
      { path: path.join(homeDir, ".agents", "skills"), source: "global", priority: 2 },
      { path: path.join(homeDir, ".claude", "skills"), source: "global", priority: 2 },
      { path: path.join(homeDir, ".codex", "skills"), source: "global", priority: 2 },
      { path: path.join(homeDir, ".codex", "plugins", "cache"), source: "plugin", priority: 3 },
      { path: path.join(homeDir, ".cc-switch", "skills"), source: "global", priority: 2 }
    );
  }
  roots.push(...configuredPaths.map((item) => {
    const resolved = path.resolve(cwd, item);
    return { path: resolved, source: "config" as const, configuredFile: resolved.endsWith(".md"), priority: 1 };
  }));
  const seen = new Set<string>();
  return roots
    .map((root) => ({ ...root, path: path.resolve(root.path) }))
    .filter((root) => {
      if (seen.has(root.path)) return false;
      seen.add(root.path);
      return true;
    });
}

async function skillFiles(root: SkillRoot): Promise<string[]> {
  const stat = await fs.stat(root.path).catch(() => undefined);
  if (!stat) return [];
  if (stat.isFile() && root.configuredFile && root.path.endsWith(".md")) return [root.path];
  if (!stat.isDirectory()) return [];
  const files: string[] = [];
  const entries = await fs.readdir(root.path, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(root.path, entry.name);
    const skillPath = path.join(fullPath, "SKILL.md");
    if (await exists(skillPath)) files.push(skillPath);
    files.push(...(await skillFiles({ ...root, path: fullPath })));
  }
  return Array.from(new Set(files));
}

async function readSkill(filePath: string, root: SkillRoot): Promise<SkillInfo | undefined> {
  const content = await fs.readFile(filePath, "utf8").catch(() => undefined);
  if (!content) return undefined;
  const { frontmatter, body } = parseFrontmatter(content);
  const inferred = path.basename(path.dirname(filePath)) === "." ? path.basename(filePath, ".md") : path.basename(path.dirname(filePath));
  const displayName = frontmatter.name || inferred;
  const name = normalizeName(displayName);
  const relativePath = path.relative(root.path, filePath).replaceAll("\\", "/");
  return {
    id: skillId(root.source, name, relativePath),
    name,
    displayName,
    description: frontmatter.description || firstParagraph(body) || "No description",
    path: filePath,
    root: root.path,
    relativePath,
    priority: root.priority,
    content,
    allowedTools: splitWords(frontmatter["allowed-tools"]),
    disableModelInvocation: /^(true|1|yes)$/i.test(frontmatter["disable-model-invocation"] ?? ""),
    source: root.source,
    activation: {
      keywords: splitWords(frontmatter["activation.keywords"]),
      fileGlobs: splitWords(frontmatter["activation.file_globs"] ?? frontmatter["activation.fileGlobs"])
    },
    helpers: parseHelpers(frontmatter),
    references: splitWords(frontmatter.references)
  };
}

function markDefaultSkills(skills: SkillInfo[]): SkillInfo[] {
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name) || (a.priority ?? 99) - (b.priority ?? 99) || a.path.localeCompare(b.path));
  const grouped = new Map<string, SkillInfo[]>();
  for (const skill of sorted) grouped.set(skill.name, [...(grouped.get(skill.name) ?? []), skill]);
  const result: SkillInfo[] = [];
  for (const group of grouped.values()) {
    const [selected, ...rest] = group;
    if (selected) result.push({ ...selected, shadowedBy: undefined });
    for (const skill of rest) result.push({ ...skill, shadowedBy: selected?.id });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name) || skillStatus(a).localeCompare(skillStatus(b)) || a.id.localeCompare(b.id));
}

function ensureUniqueIds(skills: SkillInfo[]): SkillInfo[] {
  const sorted = [...skills].sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
  const counts = new Map<string, number>();
  const ids = new Map<string, string>();
  for (const skill of sorted) {
    const count = counts.get(skill.id) ?? 0;
    counts.set(skill.id, count + 1);
    ids.set(skill.path, count === 0 ? skill.id : `${skill.id}:${count + 1}`);
  }
  return skills.map((skill) => ({ ...skill, id: ids.get(skill.path) ?? skill.id }));
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  if (!content.startsWith("---\n")) return { frontmatter: {}, body: content };
  const end = content.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: content };
  const raw = content.slice(4, end);
  const frontmatter: Record<string, string> = {};
  let section = "";
  let helperIndex = -1;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^[A-Za-z0-9_-]+:\s*$/.test(line)) {
      section = line.slice(0, -1);
      continue;
    }
    if (line.startsWith("- ") && section === "helpers") {
      helperIndex += 1;
      const rest = line.slice(2);
      const index = rest.indexOf(":");
      if (index !== -1) frontmatter[`helpers.${helperIndex}.${rest.slice(0, index).trim()}`] = cleanValue(rest.slice(index + 1));
      continue;
    }
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = cleanValue(line.slice(index + 1));
    if (section === "activation") frontmatter[`activation.${key}`] = value;
    else if (section === "helpers" && helperIndex >= 0) frontmatter[`helpers.${helperIndex}.${key}`] = value;
    else frontmatter[key] = value;
  }
  return { frontmatter, body: content.slice(end + 4).trim() };
}

function cleanValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map((item) => cleanValue(item)).join(" ");
  }
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function firstParagraph(body: string): string {
  return body.split(/\n\s*\n/).map((part) => part.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

function cleanDescription(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "").replace(/\s+/g, " ");
}

function cleanInstructions(value: string): string {
  return value.trim().replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

function renderSkillTemplate(name: string, description: string, instructions = ""): string {
  const title = name.split("-").map((part) => part ? `${part[0]?.toUpperCase()}${part.slice(1)}` : part).join(" ");
  const customInstructions = instructions ? ["## Skill Instructions", "", instructions, ""] : [];
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    "",
    `# ${title}`,
    "",
    "Use this skill when the request matches the description above.",
    "",
    ...customInstructions,
    "## Workflow",
    "",
    "1. Inspect the relevant project files before changing behavior.",
    "2. Identify the smallest reusable procedure or resource that helps with this task.",
    "3. Make focused changes that follow the existing project conventions.",
    "4. Run the most relevant validation command and report any remaining risk.",
    "",
    "## Notes",
    "",
    "- Keep instructions concise and specific to this skill.",
    "- Add `references/`, `scripts/`, or `assets/` only when they remove repeated work or preserve important domain knowledge.",
    ""
  ].join("\n");
}

function splitWords(value: string | undefined): string[] {
  return value?.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean) ?? [];
}

function parseHelpers(frontmatter: Record<string, string>): SkillHelper[] {
  const helpers: SkillHelper[] = [];
  const indexes = new Set<number>();
  for (const key of Object.keys(frontmatter)) {
    const match = /^helpers\.(\d+)\./.exec(key);
    if (match) indexes.add(Number(match[1]));
  }
  for (const index of Array.from(indexes).sort((a, b) => a - b)) {
    const type = frontmatter[`helpers.${index}.type`];
    const name = frontmatter[`helpers.${index}.name`];
    const command = frontmatter[`helpers.${index}.command`];
    const risk = parseRisk(frontmatter[`helpers.${index}.risk`]);
    if (type === "command" && name && command) helpers.push({ type, name: normalizeName(name), command, risk });
  }
  return helpers;
}

function parseRisk(value: string | undefined): ToolRisk {
  if (value === "read" || value === "write" || value === "shell" || value === "dangerous") return value;
  return "shell";
}

function skillStatus(skill: SkillInfo): "disabled" | "shadowed" | "default" {
  if (skill.disableModelInvocation) return "disabled";
  if (skill.shadowedBy) return "shadowed";
  return "default";
}

function skillId(source: NonNullable<SkillInfo["source"]>, name: string, relativePath: string): string {
  const hint = relativePath
    .replace(/\/SKILL\.md$/i, "")
    .replace(/\.md$/i, "")
    .split("/")
    .filter(Boolean)
    .slice(-4)
    .map(normalizeName)
    .filter(Boolean)
    .join("-");
  const suffix = hint && hint !== name ? `:${hint}` : "";
  return `${source}:${name}${suffix}`;
}

async function exists(filePath: string): Promise<boolean> {
  return Boolean(await fs.stat(filePath).catch(() => undefined));
}
