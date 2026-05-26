import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SubagentInfo, ToolDefinition } from "./types.js";

interface SubagentRoot {
  path: string;
  source: SubagentInfo["source"];
}

export async function discoverSubagents(cwd: string, includeGlobal = true, homeDir = os.homedir()): Promise<SubagentInfo[]> {
  const roots: SubagentRoot[] = [
    { path: path.join(cwd, ".mini-code", "agents"), source: "project" },
    { path: path.join(cwd, ".claude", "agents"), source: "project" }
  ];
  if (includeGlobal) {
    roots.push(
      { path: path.join(homeDir, ".mini-code", "agents"), source: "global" },
      { path: path.join(homeDir, ".claude", "agents"), source: "global" }
    );
  }

  const agents: SubagentInfo[] = [];
  for (const root of roots) {
    for (const filePath of await markdownFiles(root.path)) {
      const agent = await readSubagent(filePath, root);
      if (agent) agents.push(agent);
    }
  }
  return markShadowed(agents);
}

export interface SubagentCreateResult {
  name: string;
  path: string;
  description: string;
  tools: string[];
}

export interface SubagentCreateOptions {
  tools?: string[];
  instructions?: string;
}

export async function createProjectSubagent(cwd: string, rawName: string, rawDescription = "", options: SubagentCreateOptions = {}): Promise<SubagentCreateResult> {
  const name = normalizeName(rawName);
  if (!name || name === "agent" || name === "subagent") throw new Error("Subagent name is required. Usage: /agent create <name> [description]");
  const description = cleanDescription(rawDescription) || `Use for ${name.replaceAll("-", " ")} tasks.`;
  const tools = (options.tools ?? []).map((tool) => tool.trim()).filter(Boolean);
  const instructions = cleanInstructions(options.instructions ?? "") || [
    `You are the ${name} subagent.`,
    "",
    "- Inspect the relevant project context before answering.",
    "- Follow the active Mini Code permission policy.",
    "- Return concise findings and next actions."
  ].join("\n");
  const directory = path.join(cwd, ".mini-code", "agents");
  const filePath = path.join(directory, `${name}.md`);
  if (await exists(filePath)) throw new Error(`Subagent already exists: ${filePath}`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(filePath, renderSubagentTemplate(name, description, tools, instructions), "utf8");
  return { name, path: filePath, description, tools };
}

export function renderSubagentList(agents: SubagentInfo[]): string {
  if (agents.length === 0) return "No subagents discovered.";
  return [
    `subagents: total=${agents.length} defaults=${agents.filter((agent) => !agent.shadowedBy).length} shadowed=${agents.filter((agent) => agent.shadowedBy).length}`,
    "id\tname\tsource\tstatus\tdescription\ttools\tpath",
    ...agents.map((agent) => `${agent.id}\t${agent.name}\t${agent.source}\t${agent.shadowedBy ? "shadowed" : "default"}\t${agent.description}\t${agent.tools.join(",") || "[inherit]"}\t${agent.path}`)
  ].join("\n");
}

export function renderSubagentInspect(agent: SubagentInfo, candidates: SubagentInfo[] = [agent]): string {
  if (candidates.length > 1) {
    return [
      `matches for: ${agent.name}`,
      "id\tstatus\tsource\tdescription\tpath",
      ...candidates.map((item) => `${item.id}\t${item.shadowedBy ? "shadowed" : "default"}\t${item.source}\t${item.description}\t${item.path}`),
      "",
      `default: ${candidates.find((item) => !item.shadowedBy)?.id ?? candidates[0]?.id}`
    ].join("\n");
  }
  return [
    `id: ${agent.id}`,
    `name: ${agent.name}`,
    `source: ${agent.source}`,
    `status: ${agent.shadowedBy ? "shadowed" : "default"}`,
    `description: ${agent.description}`,
    `path: ${agent.path}`,
    `tools: ${agent.tools.join(", ") || "[inherit session tools]"}`
  ].join("\n");
}

export function resolveSubagent(agents: SubagentInfo[], nameOrId: string): { agent?: SubagentInfo; candidates: SubagentInfo[] } {
  const normalized = normalizeName(nameOrId);
  const exact = agents.find((agent) => agent.id === nameOrId || agent.id === normalized);
  if (exact) return { agent: exact, candidates: [exact] };
  const candidates = agents.filter((agent) => agent.name === normalized || agent.name.startsWith(normalized));
  const agent = candidates.find((item) => !item.shadowedBy) ?? candidates[0];
  return { agent, candidates };
}

export function subagentInjection(agent: SubagentInfo, task: string): string {
  return [
    `Run foreground subagent: ${agent.name}.`,
    agent.description ? `Description: ${agent.description}` : "",
    agent.tools.length ? `Declared tools: ${agent.tools.join(", ")}` : "Declared tools: inherit current session tools.",
    "Use the subagent instructions below for this task. Stay within the current Mini Code permission and tool policy.",
    task.trim() ? `Task:\n${task.trim()}` : "Task: use the user's latest request.",
    "Subagent instructions:",
    agent.content
  ].filter(Boolean).join("\n\n");
}

export function subagentToolNames(agent: SubagentInfo, tools: ToolDefinition[]): Set<string> | undefined {
  if (agent.tools.length === 0) return undefined;
  const allowed = new Set<string>();
  const aliases = new Map<string, string[]>([
    ["bash", ["run_command"]],
    ["read", ["read_file", "read_many_files", "show_file_outline"]],
    ["write", ["write_file", "create_file"]],
    ["edit", ["replace_text", "apply_patch", "git_apply_check"]],
    ["grep", ["search"]],
    ["ls", ["list_files", "read_tree"]],
    ["todowrite", ["todo_write"]],
    ["task", []]
  ]);
  const byName = new Map(tools.map((tool) => [tool.name.toLowerCase(), tool.name]));
  for (const declared of agent.tools) {
    const normalized = declared.trim().toLowerCase().replace(/[^a-z0-9_:-]+/g, "");
    const exact = byName.get(normalized);
    if (exact) {
      allowed.add(exact);
      continue;
    }
    for (const item of aliases.get(normalized) ?? []) allowed.add(item);
  }
  return allowed;
}

async function markdownFiles(root: string): Promise<string[]> {
  const stat = await fs.stat(root).catch(() => undefined);
  if (!stat?.isDirectory()) return [];
  const files: string[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(fullPath));
    else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(fullPath);
  }
  return files;
}

async function readSubagent(filePath: string, root: SubagentRoot): Promise<SubagentInfo | undefined> {
  const content = await fs.readFile(filePath, "utf8").catch(() => undefined);
  if (!content?.trim()) return undefined;
  const frontmatter = parseFrontmatter(content);
  const body = stripFrontmatter(content).trim();
  const fallbackName = path.relative(root.path, filePath).replaceAll("\\", "/").replace(/\.md$/i, "");
  const name = normalizeName(frontmatter.name || fallbackName);
  if (!name || !body) return undefined;
  return {
    id: `${root.source}:${name}`,
    name,
    description: frontmatter.description || firstMeaningfulLine(body),
    path: filePath,
    source: root.source,
    tools: splitWords(frontmatter.tools),
    content: body
  };
}

function markShadowed(agents: SubagentInfo[]): SubagentInfo[] {
  const sorted = agents.sort((a, b) => priority(a) - priority(b) || a.path.localeCompare(b.path));
  const defaults = new Map<string, SubagentInfo>();
  for (const agent of sorted) {
    const winner = defaults.get(agent.name);
    if (!winner) defaults.set(agent.name, agent);
    else agent.shadowedBy = winner.id;
  }
  return sorted.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function priority(agent: SubagentInfo): number {
  return agent.source === "project" ? 0 : 1;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content.trimStart());
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!field) continue;
    result[field[1].toLowerCase()] = field[2].trim().replace(/^["']|["']$/g, "");
  }
  return result;
}

function stripFrontmatter(content: string): string {
  return content.trimStart().replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\\/g, "/").replace(/[^a-z0-9/_-]+/g, "-").replace(/^\/+|\/+$/g, "").replace(/^-+|-+$/g, "");
}

function splitWords(value = ""): string[] {
  return value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
}

function firstMeaningfulLine(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line && !line.startsWith("---")) ?? "Subagent";
}

async function exists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(() => true, () => false);
}

function cleanDescription(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanInstructions(value: string): string {
  return value.trim().replace(/\r\n/g, "\n");
}

function renderSubagentTemplate(name: string, description: string, tools: string[], instructions: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    tools.length ? `tools: ${tools.join(", ")}` : undefined,
    "---",
    "",
    instructions.trim(),
    ""
  ].filter((line) => line !== undefined).join("\n");
}
