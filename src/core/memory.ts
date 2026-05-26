import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const MAX_MEMORY_BYTES = 25_000;

export type MemoryScope = "user" | "project" | "local";

export interface MemorySource {
  scope: MemoryScope;
  label: string;
  filePath: string;
  exists: boolean;
  bytes: number;
  content?: string;
}

export function memoryPath(cwd: string, scope: MemoryScope): string {
  if (scope === "user") return path.join(homedir(), ".mini-code", "CLAUDE.md");
  if (scope === "local") return path.join(cwd, ".mini-code", "CLAUDE.md");
  return path.join(cwd, "CLAUDE.md");
}

export function memoryCandidates(cwd: string): Array<{ scope: MemoryScope; label: string; filePath: string }> {
  return [
    { scope: "user", filePath: memoryPath(cwd, "user"), label: "user memory" },
    { scope: "project", filePath: memoryPath(cwd, "project"), label: "project memory" },
    { scope: "local", filePath: memoryPath(cwd, "local"), label: "local override" }
  ];
}

export async function loadProjectMemorySources(cwd: string): Promise<MemorySource[]> {
  const sources: MemorySource[] = [];
  for (const candidate of memoryCandidates(cwd)) {
    try {
      const raw = await readFile(candidate.filePath, "utf8");
      sources.push({
        ...candidate,
        exists: true,
        bytes: Buffer.byteLength(raw, "utf8"),
        content: raw
      });
    } catch {
      sources.push({ ...candidate, exists: false, bytes: 0 });
    }
  }
  return sources;
}

export async function loadProjectMemory(cwd: string): Promise<string> {
  const sources = await loadProjectMemorySources(cwd);
  const parts: string[] = [];
  let totalBytes = 0;

  for (const { filePath, label, content: raw } of sources) {
    if (totalBytes >= MAX_MEMORY_BYTES) break;
    const trimmed = raw?.trim();
    if (!trimmed) continue;
    const remaining = MAX_MEMORY_BYTES - totalBytes;
    const content = trimmed.length > remaining ? `${trimmed.slice(0, remaining)}\n...[truncated]` : trimmed;
    parts.push(`<!-- ${label}: ${filePath} -->\n${content}`);
    totalBytes += Buffer.byteLength(content, "utf8");
  }

  return parts.join("\n\n");
}

export async function appendProjectMemory(cwd: string, scope: MemoryScope, note: string): Promise<string> {
  const trimmed = note.trim();
  if (!trimmed) throw new Error("Memory note cannot be empty.");
  const filePath = memoryPath(cwd, scope);
  await mkdir(path.dirname(filePath), { recursive: true });
  const existing = await readExisting(filePath);
  const prefix = existing.trim() ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
  await appendFile(filePath, `${prefix}${trimmed}\n`, "utf8");
  return filePath;
}

export function parseMemoryScope(value: string): MemoryScope {
  if (value === "user" || value === "project" || value === "local") return value;
  throw new Error("Usage: /memory add <project|local|user> <note>");
}

export function renderMemorySources(sources: MemorySource[]): string {
  const rows = sources.map((source) => [
    source.scope.padEnd(8),
    (source.exists ? "yes" : "no").padEnd(6),
    String(source.bytes).padStart(8),
    source.filePath
  ].join("  "));
  return ["scope     exists     bytes  path", ...rows].join("\n");
}

async function readExisting(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}
