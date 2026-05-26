import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition, ToolMetadata, ToolResult } from "../../core/types.js";
import { validateInput, type ToolRules } from "../validation.js";

export const execAsync = promisify(exec);

export interface BuiltinToolContext {
  cwd: string;
  maxOutputChars: number;
  allowDangerousCommands: boolean;
}

export function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required string input: ${key}`);
  }
  return value;
}

export function requireStringArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`Missing required string array input: ${key}`);
  }
  return value;
}

export function requireNumber(input: Record<string, unknown>, key: string, fallback: number): number {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function clip(value: string, maxChars: number): { output: string; clipped: boolean } {
  if (value.length <= maxChars) return { output: value, clipped: false };
  return { output: `${value.slice(0, maxChars)}\n\n[output clipped at ${maxChars} chars]`, clipped: true };
}

export function clipText(value: string, maxChars: number): string {
  return clip(value, maxChars).output;
}

export function workspacePath(cwd: string, filePath: string): string {
  return path.relative(cwd, filePath).replaceAll("\\", "/");
}

export function formatReadFile(_filePath: string, text: string, startLine = 1, endLine?: number): string {
  const lines = text.split(/\r?\n/);
  const start = Math.max(1, startLine);
  const end = endLine === undefined ? lines.length : Math.min(lines.length, endLine);
  return lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n");
}

export function splitLines(value: string): string[] {
  return value.length === 0 ? [] : value.replace(/\n$/, "").split("\n");
}

export function firstChangedLine(oldText: string, newText: string): number {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let index = 0;
  while (index < oldLines.length && index < newLines.length && oldLines[index] === newLines[index]) index += 1;
  return index + 1;
}

export function displayDiff(filePath: string, oldText: string, newText: string): string {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const context = 3;
  const start = Math.max(0, prefix - context);
  const oldChangeEnd = oldLines.length - suffix;
  const newChangeEnd = newLines.length - suffix;
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + context);
  const newEnd = Math.min(newLines.length, newLines.length - suffix + context);
  const lines = [`--- a/${filePath}`, `+++ b/${filePath}`, `@@ -${start + 1},${oldEnd - start} +${start + 1},${newEnd - start} @@`];

  for (const line of oldLines.slice(start, prefix)) lines.push(` ${line}`);
  for (const line of oldLines.slice(prefix, oldChangeEnd)) lines.push(`-${line}`);
  for (const line of newLines.slice(prefix, newChangeEnd)) lines.push(`+${line}`);
  for (const line of oldLines.slice(oldChangeEnd, oldEnd)) lines.push(` ${line}`);

  return lines.join("\n");
}

export async function commandExists(command: string, cwd: string): Promise<boolean> {
  const probe = process.platform === "win32" ? `where ${command}` : `command -v ${command}`;
  try {
    await execAsync(probe, { cwd, timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function collectFiles(root: string, cwd: string, glob?: string): Promise<string[]> {
  const results: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if ([".git", "node_modules", "dist", "build", ".mini-code", ".mini-agent"].includes(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        const relative = workspacePath(cwd, fullPath);
        if (!glob || matchesSimpleGlob(relative, glob)) results.push(relative);
      }
    }
  }
  await visit(root);
  return results.sort((a, b) => a.localeCompare(b));
}

export function matchesSimpleGlob(filePath: string, glob: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  const target = glob.includes("/") ? normalized : path.posix.basename(normalized);
  const escaped = glob
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(target);
}

export function rulesFor(tool: string): ToolRules {
  const rules: Record<string, ToolRules> = {
    list_files: { path: { type: "string" }, maxDepth: { type: "number" }, glob: { type: "string" } },
    read_many_files: { paths: { type: "string[]", required: true } },
    read_tree: { path: { type: "string" }, maxDepth: { type: "number" } },
    search: { query: { type: "string", required: true }, path: { type: "string" } },
    read_file: { path: { type: "string", required: true }, startLine: { type: "number" }, endLine: { type: "number" } },
    show_file_outline: { path: { type: "string", required: true } },
    replace_text: { path: { type: "string", required: true }, oldText: { type: "string", required: true }, newText: { type: "string", required: true } },
    write_file: { path: { type: "string", required: true }, content: { type: "string" } },
    create_file: { path: { type: "string", required: true }, content: { type: "string" } },
    apply_patch: { patch: { type: "string", required: true } },
    git_apply_check: { patch: { type: "string", required: true } },
    create_skill: { name: { type: "string", required: true }, description: { type: "string" }, instructions: { type: "string" } },
    create_subagent: { name: { type: "string", required: true }, description: { type: "string" }, instructions: { type: "string" }, tools: { type: "string[]" } },
    run_command: { command: { type: "string", required: true }, timeoutMs: { type: "number" } },
    git_diff: { path: { type: "string" } },
    describe_capability: { id: { type: "string" }, name: { type: "string" } },
    todo_write: { todos: { type: "string[]", required: true } }
  };
  return rules[tool] ?? {};
}

export function validateToolInput(tool: string, input: Record<string, unknown>): ToolResult | undefined {
  return validateInput(tool, input, rulesFor(tool));
}

export function withMetadata(result: ToolResult, metadata: ToolMetadata): ToolResult {
  return { ...result, metadata: { ...metadata, ...result.metadata } };
}

export function finalizeBuiltinTools(tools: ToolDefinition[], source = "builtin"): ToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    validate(input: Record<string, unknown>): ToolResult | undefined {
      return tool.validate(input);
    },
    async run(input: Record<string, unknown>): Promise<ToolResult> {
      const started = Date.now();
      try {
        const result = await tool.run(input);
        return withMetadata(result, {
          source,
          durationMs: Date.now() - started,
          clipped: result.output.includes("[output clipped at ")
        });
      } catch (error) {
        return withMetadata({ ok: false, output: stringifyError(error), errorType: "runtime" }, {
          tool: tool.name,
          source,
          durationMs: Date.now() - started
        });
      }
    }
  }));
}
