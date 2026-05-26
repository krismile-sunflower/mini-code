import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CustomCommandInfo } from "./types.js";

interface CommandRoot {
  path: string;
  source: CustomCommandInfo["source"];
}

export async function discoverCustomCommands(cwd: string, includeGlobal = true, homeDir = os.homedir()): Promise<CustomCommandInfo[]> {
  const roots: CommandRoot[] = [
    { path: path.join(cwd, ".mini-code", "commands"), source: "project" },
    { path: path.join(cwd, ".claude", "commands"), source: "project" }
  ];
  if (includeGlobal) {
    roots.push(
      { path: path.join(homeDir, ".mini-code", "commands"), source: "global" },
      { path: path.join(homeDir, ".claude", "commands"), source: "global" }
    );
  }

  const commands: CustomCommandInfo[] = [];
  for (const root of roots) {
    for (const filePath of await markdownFiles(root.path)) {
      const command = await readCommand(filePath, root);
      if (command) commands.push(command);
    }
  }
  return markDefaultCommands(commands);
}

export function renderCustomCommandList(commands: CustomCommandInfo[]): string {
  if (commands.length === 0) return "No custom commands discovered.";
  return [
    `custom commands: total=${commands.length}`,
    "name\tsource\tdescription\tpath",
    ...commands.map((command) => `${command.name}\t${command.source}\t${command.description}\t${command.path}`)
  ].join("\n");
}

export function resolveCustomCommand(commands: CustomCommandInfo[], name: string): CustomCommandInfo | undefined {
  const normalized = normalizeCommandName(name);
  return commands.find((command) => command.name === normalized || command.name.startsWith(normalized));
}

export function renderCustomCommandPrompt(command: CustomCommandInfo, args: string): string {
  const rendered = renderCustomCommandContent(command.content, args);
  return [
    `Run custom command /${command.name}.`,
    command.description ? `Description: ${command.description}` : "",
    args && !rendered.usedArgumentsPlaceholder ? `User arguments: ${args}` : "",
    "Command instructions:",
    rendered.content
  ].filter(Boolean).join("\n\n");
}

export function renderCustomCommandContent(content: string, args: string): { content: string; usedArgumentsPlaceholder: boolean } {
  const cleaned = stripFrontmatter(content).trim();
  const argv = splitCommandArguments(args);
  let usedArgumentsPlaceholder = false;
  let rendered = cleaned.replace(/\$ARGUMENTS\[(\d+)\]/g, (_match, rawIndex: string) => {
    usedArgumentsPlaceholder = true;
    return argv[Number(rawIndex)] ?? "";
  });
  rendered = rendered.replace(/\$ARGUMENTS\b/g, () => {
    usedArgumentsPlaceholder = true;
    return args.trim();
  });
  rendered = rendered.replace(/\$([1-9])\b/g, (_match, rawIndex: string) => {
    usedArgumentsPlaceholder = true;
    return argv[Number(rawIndex) - 1] ?? "";
  });
  return { content: rendered.trim(), usedArgumentsPlaceholder };
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

async function readCommand(filePath: string, root: CommandRoot): Promise<CustomCommandInfo | undefined> {
  const content = await fs.readFile(filePath, "utf8").catch(() => undefined);
  if (!content?.trim()) return undefined;
  const frontmatter = parseFrontmatter(content);
  const body = stripFrontmatter(content).trim();
  const relative = path.relative(root.path, filePath).replaceAll("\\", "/").replace(/\.md$/i, "");
  const name = normalizeCommandName(relative);
  if (!name) return undefined;
  return {
    id: `${root.source}:${name}`,
    name,
    description: frontmatter.description || firstMeaningfulLine(body),
    path: filePath,
    source: root.source,
    content: body
  };
}

function markDefaultCommands(commands: CustomCommandInfo[]): CustomCommandInfo[] {
  const byName = new Map<string, CustomCommandInfo>();
  for (const command of commands.sort((a, b) => priority(a) - priority(b) || a.path.localeCompare(b.path))) {
    if (!byName.has(command.name)) byName.set(command.name, command);
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function priority(command: CustomCommandInfo): number {
  return command.source === "project" ? 0 : 1;
}

function normalizeCommandName(value: string): string {
  return value.trim().toLowerCase().replace(/\\/g, "/").replace(/[^a-z0-9/_-]+/g, "-").replace(/^\/+|\/+$/g, "").replace(/^-+|-+$/g, "");
}

function firstMeaningfulLine(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line && !line.startsWith("---")) ?? "Custom command";
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

function splitCommandArguments(args: string): string[] {
  const values: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  for (const match of args.matchAll(pattern)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    values.push(raw.replace(/\\(["'\\])/g, "$1"));
  }
  return values;
}
