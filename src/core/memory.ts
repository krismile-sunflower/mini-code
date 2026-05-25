import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const MAX_MEMORY_BYTES = 25_000;

/**
 * Load project memory from CLAUDE.md files at multiple levels (mirrors Claude Code's behaviour):
 *   1. ~/.mini-code/CLAUDE.md  — user-level global memory
 *   2. {cwd}/CLAUDE.md         — project-level memory
 *   3. {cwd}/.mini-code/CLAUDE.md — local project override
 *
 * All files that exist are combined and returned as a single string.
 * Each file is capped at MAX_MEMORY_BYTES total.
 */
export async function loadProjectMemory(cwd: string): Promise<string> {
  const candidates = [
    { filePath: path.join(homedir(), ".mini-code", "CLAUDE.md"), label: "user memory" },
    { filePath: path.join(cwd, "CLAUDE.md"), label: "project memory" },
    { filePath: path.join(cwd, ".mini-code", "CLAUDE.md"), label: "local override" }
  ];

  const parts: string[] = [];
  let totalBytes = 0;

  for (const { filePath, label } of candidates) {
    if (totalBytes >= MAX_MEMORY_BYTES) break;
    try {
      const raw = await readFile(filePath, "utf8");
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const remaining = MAX_MEMORY_BYTES - totalBytes;
      const content = trimmed.length > remaining ? trimmed.slice(0, remaining) + "\n...[truncated]" : trimmed;
      parts.push(`<!-- ${label}: ${filePath} -->\n${content}`);
      totalBytes += content.length;
    } catch {
      // file not found or unreadable — skip silently
    }
  }

  return parts.join("\n\n");
}
