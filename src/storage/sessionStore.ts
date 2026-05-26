import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentEvent, Message, SessionRecord } from "../core/types.js";

export interface SessionSummary {
  id: string;
  updatedAt: string;
  title: string;
  lastUserMessage: string;
  model: string;
  cwd: string;
  summary: string;
}

export function createSessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${random}`;
}

export class SessionStore {
  constructor(private readonly sessionDir: string) {}

  async ensure(): Promise<void> {
    await fs.mkdir(this.sessionDir, { recursive: true });
  }

  async load(id: string): Promise<SessionRecord | undefined> {
    const filePath = this.resolveInputPath(id);
    try {
      const text = await fs.readFile(filePath, "utf8");
      return JSON.parse(text) as SessionRecord;
    } catch (error) {
      const nodeError = error as { code?: string };
      if (nodeError.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(record: SessionRecord): Promise<void> {
    await this.ensure();
    const next: SessionRecord = { ...record, updatedAt: new Date().toISOString() };
    await fs.writeFile(this.filePath(record.id), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  async list(): Promise<SessionSummary[]> {
    await this.ensure();
    const entries = await fs.readdir(this.sessionDir, { withFileTypes: true });
    const summaries: SessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -5);
      const record = await this.load(id);
      if (!record) continue;
      summaries.push({
        id: record.id,
        updatedAt: record.updatedAt,
        title: record.title ?? "Untitled session",
        lastUserMessage: record.lastUserMessage ?? "",
        model: record.model,
        cwd: record.cwd,
        summary: record.summary
      });
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async latest(): Promise<SessionSummary | undefined> {
    return (await this.list())[0];
  }

  async rename(id: string, title: string): Promise<SessionRecord> {
    const record = await this.load(id);
    if (!record) throw new Error(`Session not found: ${id}`);
    const trimmed = title.replace(/\s+/g, " ").trim();
    if (!trimmed) throw new Error("Session title cannot be empty.");
    const next = { ...record, title: trimmed };
    await this.save(next);
    return next;
  }

  async export(id: string, outputPath: string): Promise<string> {
    const record = await this.load(id);
    if (!record) throw new Error(`Session not found: ${id}`);
    const resolved = path.resolve(outputPath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return resolved;
  }

  async import(inputPath: string): Promise<SessionRecord> {
    const resolved = path.resolve(inputPath);
    const parsed = JSON.parse(await fs.readFile(resolved, "utf8")) as unknown;
    const record = validateSessionRecord(parsed, resolved);
    const existing = await this.load(record.id);
    if (existing) throw new Error(`Session already exists: ${record.id}`);
    await this.ensure();
    await fs.writeFile(this.filePath(record.id), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    const imported = await this.load(record.id);
    return imported ?? record;
  }

  async delete(id: string): Promise<boolean> {
    if (!id.trim() || id.endsWith(".json") || path.isAbsolute(id) || /[\\/]/.test(id)) {
      throw new Error("Session delete expects a session id, not a path.");
    }
    try {
      await fs.unlink(this.filePath(id));
      return true;
    } catch (error) {
      const nodeError = error as { code?: string };
      if (nodeError.code === "ENOENT") return false;
      throw error;
    }
  }

  async fork(id: string): Promise<SessionRecord> {
    const record = await this.load(id);
    if (!record) throw new Error(`Session not found: ${id}`);
    const now = new Date().toISOString();
    const next: SessionRecord = {
      ...record,
      id: createSessionId(),
      createdAt: now,
      updatedAt: now,
      title: `Fork of ${record.title ?? record.id}`,
      events: [...record.events],
      messages: [...record.messages],
      tasks: [...(record.tasks ?? [])],
      plans: [...(record.plans ?? [])],
      capabilities: record.capabilities ? [...record.capabilities] : undefined
    };
    await this.save(next);
    return next;
  }

  createRecord(input: { id?: string; cwd: string; provider: SessionRecord["provider"]; model: string; baseUrl: string; messages: Message[]; events?: AgentEvent[]; summary?: string }): SessionRecord {
    const now = new Date().toISOString();
    return {
      id: input.id ?? createSessionId(),
      createdAt: now,
      updatedAt: now,
      cwd: input.cwd,
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl,
      messages: input.messages,
      events: input.events ?? [],
      tasks: [],
      plans: [],
      summary: input.summary ?? ""
    };
  }

  private filePath(id: string): string {
    return path.join(this.sessionDir, `${id}.json`);
  }

  private resolveInputPath(idOrPath: string): string {
    if (idOrPath.endsWith(".json") || path.isAbsolute(idOrPath) || /[\\/]/.test(idOrPath)) return path.resolve(idOrPath);
    return this.filePath(idOrPath);
  }
}

function validateSessionRecord(value: unknown, source: string): SessionRecord {
  if (!isRecord(value)) throw new Error(`Invalid session file: ${source}`);
  const required = ["id", "createdAt", "updatedAt", "cwd", "provider", "model", "baseUrl", "messages", "events", "summary"];
  for (const key of required) {
    if (!(key in value)) throw new Error(`Invalid session file: missing ${key}`);
  }
  if (typeof value.id !== "string" || !value.id.trim()) throw new Error("Invalid session file: id must be a string.");
  if (value.id.endsWith(".json") || path.isAbsolute(value.id) || /[\\/]/.test(value.id)) throw new Error("Invalid session file: id must be a session id, not a path.");
  if (typeof value.provider !== "string" || !["openai", "anthropic"].includes(value.provider)) throw new Error("Invalid session file: unsupported provider.");
  if (!Array.isArray(value.messages) || !Array.isArray(value.events)) throw new Error("Invalid session file: messages and events must be arrays.");
  return value as unknown as SessionRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
