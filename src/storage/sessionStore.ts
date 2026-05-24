import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentEvent, Message, SessionRecord } from "../core/types.js";

export interface SessionSummary {
  id: string;
  updatedAt: string;
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
    const filePath = this.filePath(id);
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
        model: record.model,
        cwd: record.cwd,
        summary: record.summary
      });
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
      summary: input.summary ?? ""
    };
  }

  private filePath(id: string): string {
    return path.join(this.sessionDir, `${id}.json`);
  }
}
