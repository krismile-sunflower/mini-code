import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { applyUnifiedPatch, checkUnifiedPatch } from "./patch.js";
import { resolveInside } from "./pathUtils.js";
import { patchApproval, readApproval, shellApproval, writeApproval } from "./permissions.js";
import { validateInput, type ToolRules } from "./validation.js";
import type { ApprovalContext, ToolDefinition, ToolMetadata, ToolResult } from "../core/types.js";

const execAsync = promisify(exec);

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required string input: ${key}`);
  }
  return value;
}

function requireStringArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`Missing required string array input: ${key}`);
  }
  return value;
}

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[output clipped at ${maxChars} chars]`;
}

async function commandExists(command: string, cwd: string): Promise<boolean> {
  const probe = process.platform === "win32" ? `where ${command}` : `command -v ${command}`;
  try {
    await execAsync(probe, { cwd, timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function formatReadFile(filePath: string, text: string, startLine = 1, endLine?: number): string {
  const lines = text.split(/\r?\n/);
  const start = Math.max(1, startLine);
  const end = endLine === undefined ? lines.length : Math.min(lines.length, endLine);
  return lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n");
}

function formatExecError(error: unknown): string {
  const maybe = error as { stdout?: string; stderr?: string; code?: number | string; signal?: string; killed?: boolean; message?: string };
  const parts = [
    maybe.killed ? "timed out" : undefined,
    maybe.code !== undefined ? `exit code: ${String(maybe.code)}` : undefined,
    maybe.signal ? `signal: ${maybe.signal}` : undefined,
    maybe.stdout ? `stdout:\n${maybe.stdout}` : undefined,
    maybe.stderr ? `stderr:\n${maybe.stderr}` : undefined,
    maybe.message ? `error: ${maybe.message}` : undefined
  ].filter(Boolean);
  return parts.join("\n") || stringifyError(error);
}

function requireNumber(input: Record<string, unknown>, key: string, fallback: number): number {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function rulesFor(tool: string): ToolRules {
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
    run_command: { command: { type: "string", required: true }, timeoutMs: { type: "number" } },
    git_diff: { path: { type: "string" } },
    todo_write: { todos: { type: "string[]", required: true } }
  };
  return rules[tool] ?? {};
}

function withMetadata(result: ToolResult, metadata: ToolMetadata): ToolResult {
  return { ...result, metadata: { ...metadata, ...result.metadata } };
}

function splitLines(value: string): string[] {
  return value.length === 0 ? [] : value.replace(/\n$/, "").split("\n");
}

function firstChangedLine(oldText: string, newText: string): number {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let index = 0;
  while (index < oldLines.length && index < newLines.length && oldLines[index] === newLines[index]) index += 1;
  return index + 1;
}

function displayDiff(filePath: string, oldText: string, newText: string): string {
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

async function walkTree(root: string, relativeRoot: string, maxDepth: number, currentDepth = 0): Promise<string[]> {
  if (currentDepth > maxDepth) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const visible = entries
    .filter((entry) => ![".git", "node_modules", "dist", "build", ".mini-code", ".mini-agent"].includes(entry.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const lines: string[] = [];
  for (const entry of visible) {
    const relative = relativeRoot === "." ? entry.name : `${relativeRoot}/${entry.name}`;
    lines.push(`${"  ".repeat(currentDepth)}${entry.isDirectory() ? "[d]" : "[f]"} ${relative}`);
    if (entry.isDirectory()) {
      lines.push(...(await walkTree(path.join(root, entry.name), relative, maxDepth, currentDepth + 1)));
    }
  }
  return lines;
}

function outlineText(filePath: string, text: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const lines = text.split(/\r?\n/);
  const patterns = extension === ".py"
    ? [/^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/, /^\s*class\s+([A-Za-z_][\w]*)\b/]
    : [
        /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
        /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
        /^\s*export\s+class\s+([A-Za-z_$][\w$]*)\b/,
        /^\s*class\s+([A-Za-z_$][\w$]*)\b/,
        /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/,
        /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/
      ];
  const matches: string[] = [];
  lines.forEach((line, index) => {
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (match?.[1]) {
        matches.push(`${index + 1}: ${match[1]} - ${line.trim()}`);
        break;
      }
    }
  });
  return matches.join("\n") || "[no outline symbols found]";
}

export function createTools(cwd: string, maxOutputChars: number, allowDangerousCommands = false): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: "list_files",
      description: "List workspace files. Uses rg --files when available.",
      inputSchema: {
        path: "Optional directory path inside the workspace.",
        maxDepth: "Optional maximum directory depth relative to path.",
        glob: "Optional ripgrep glob pattern."
      },
      risk: "read",
      describe(input) {
        return `List files under ${typeof input.path === "string" ? input.path : "."}`;
      },
      requiresApproval() {
        return readApproval();
      },
      validate(input) {
        return validateInput("list_files", input, rulesFor("list_files"));
      },
      async run(input) {
        const target = resolveInside(cwd, typeof input.path === "string" ? input.path : ".");
        const relativeTarget = path.relative(cwd, target) || ".";
        const hasRg = await commandExists("rg", cwd);
        const glob = typeof input.glob === "string" && input.glob.trim() ? input.glob : undefined;
        const command = hasRg
          ? `rg --files ${JSON.stringify(relativeTarget)}${glob ? ` -g ${JSON.stringify(glob)}` : ""}`
          : process.platform === "win32"
            ? `dir /b /s ${JSON.stringify(target)}`
            : `find ${JSON.stringify(target)} -type f`;
        const { stdout, stderr } = await execAsync(command, { cwd, timeout: 20_000 });
        let output = stdout || stderr || "[no files]";
        const maxDepth = typeof input.maxDepth === "number" ? input.maxDepth : undefined;
        if (maxDepth !== undefined && maxDepth >= 0 && output !== "[no files]") {
          const baseDepth = relativeTarget === "." ? 0 : relativeTarget.split(/[\\/]/).filter(Boolean).length;
          output = output
            .split(/\r?\n/)
            .filter(Boolean)
            .filter((file) => file.replace(/^\.\//, "").split(/[\\/]/).filter(Boolean).length - baseDepth <= maxDepth)
            .join("\n") || "[no files]";
        }
        return { ok: true, output: clip(output, maxOutputChars), metadata: { path: relativeTarget, glob, maxDepth } };
      }
    },
    {
      name: "read_many_files",
      description: "Read multiple UTF-8 text files from the workspace.",
      inputSchema: { paths: "Required array of file paths inside the workspace." },
      risk: "read",
      describe(input) {
        const paths = Array.isArray(input.paths) ? input.paths.join(", ") : String(input.paths);
        return `Read files: ${paths}`;
      },
      requiresApproval() {
        return readApproval();
      },
      validate(input) {
        return validateInput("read_many_files", input, rulesFor("read_many_files"));
      },
      async run(input) {
        const paths = requireStringArray(input, "paths");
        const outputs: string[] = [];
        for (const requestedPath of paths) {
          try {
            const filePath = resolveInside(cwd, requestedPath);
            const text = await fs.readFile(filePath, "utf8");
            outputs.push(`--- ${requestedPath}\n${formatReadFile(filePath, text)}`);
          } catch (error) {
            outputs.push(`--- ${requestedPath}\n[error] ${stringifyError(error)}`);
          }
        }
        return { ok: true, output: clip(outputs.join("\n\n"), maxOutputChars), metadata: { paths } };
      }
    },
    {
      name: "read_tree",
      description: "Show a compact directory tree for workspace navigation.",
      inputSchema: { path: "Optional directory path inside the workspace.", maxDepth: "Optional maximum depth, default 2." },
      risk: "read",
      describe(input) {
        return `Read directory tree under ${typeof input.path === "string" ? input.path : "."}`;
      },
      requiresApproval() {
        return readApproval();
      },
      validate(input) {
        return validateInput("read_tree", input, rulesFor("read_tree"));
      },
      async run(input) {
        const target = resolveInside(cwd, typeof input.path === "string" ? input.path : ".");
        const relativeRoot = path.relative(cwd, target) || ".";
        const maxDepth = Math.max(0, Math.min(6, requireNumber(input, "maxDepth", 2)));
        const lines = await walkTree(target, relativeRoot, maxDepth);
        return { ok: true, output: clip(lines.join("\n") || "[empty directory]", maxOutputChars), metadata: { path: relativeRoot, maxDepth } };
      }
    },
    {
      name: "search",
      description: "Search text in the workspace with ripgrep.",
      inputSchema: { query: "Required search string or regex.", path: "Optional directory path inside the workspace." },
      risk: "read",
      describe(input) {
        return `Search for ${JSON.stringify(input.query)} under ${typeof input.path === "string" ? input.path : "."}`;
      },
      requiresApproval() {
        return readApproval();
      },
      validate(input) {
        return validateInput("search", input, rulesFor("search"));
      },
      async run(input) {
        const query = requireString(input, "query");
        const target = resolveInside(cwd, typeof input.path === "string" ? input.path : ".");
        const relativeTarget = path.relative(cwd, target) || ".";
        const command = `rg --line-number --hidden --glob !node_modules --glob !dist ${JSON.stringify(query)} ${JSON.stringify(relativeTarget)}`;
        try {
          const { stdout, stderr } = await execAsync(command, { cwd, timeout: 20_000 });
          return { ok: true, output: clip(stdout || stderr || "[no matches]", maxOutputChars), metadata: { query, path: relativeTarget } };
        } catch (error: unknown) {
          const maybe = error as { stdout?: string; stderr?: string };
          return { ok: true, output: clip(maybe.stdout || maybe.stderr || "[no matches]", maxOutputChars), metadata: { query, path: relativeTarget } };
        }
      }
    },
    {
      name: "read_file",
      description: "Read a UTF-8 text file from the workspace.",
      inputSchema: {
        path: "Required file path inside the workspace.",
        startLine: "Optional 1-based start line.",
        endLine: "Optional 1-based end line."
      },
      risk: "read",
      describe(input) {
        return `Read ${String(input.path)}`;
      },
      requiresApproval() {
        return readApproval();
      },
      validate(input) {
        return validateInput("read_file", input, rulesFor("read_file"));
      },
      async run(input) {
        const filePath = resolveInside(cwd, requireString(input, "path"));
        const text = await fs.readFile(filePath, "utf8");
        const start = typeof input.startLine === "number" ? Math.max(1, input.startLine) : 1;
        const end = typeof input.endLine === "number" ? input.endLine : undefined;
        return { ok: true, output: clip(formatReadFile(filePath, text, start, end), maxOutputChars), metadata: { path: path.relative(cwd, filePath), startLine: start, endLine: end } };
      }
    },
    {
      name: "show_file_outline",
      description: "Show top-level functions, classes, and exports from a source file.",
      inputSchema: { path: "Required source file path inside the workspace." },
      risk: "read",
      describe(input) {
        return `Show outline for ${String(input.path)}`;
      },
      requiresApproval() {
        return readApproval();
      },
      validate(input) {
        return validateInput("show_file_outline", input, rulesFor("show_file_outline"));
      },
      async run(input) {
        const requestedPath = requireString(input, "path");
        const filePath = resolveInside(cwd, requestedPath);
        const text = await fs.readFile(filePath, "utf8");
        return { ok: true, output: clip(outlineText(requestedPath, text), maxOutputChars), metadata: { path: requestedPath } };
      }
    },
    {
      name: "replace_text",
      description: "Replace exact text in a file. Fails unless the old text occurs exactly once.",
      inputSchema: { path: "Required file path inside the workspace.", oldText: "Exact text to replace.", newText: "Replacement text." },
      risk: "write",
      describe(input) {
        return `Replace exact text in ${String(input.path)}`;
      },
      requiresApproval(input, context: ApprovalContext) {
        return writeApproval("replace_text", requireString(input, "path"), context);
      },
      validate(input) {
        return validateInput("replace_text", input, rulesFor("replace_text"));
      },
      async run(input) {
        const filePath = resolveInside(cwd, requireString(input, "path"));
        const relativePath = path.relative(cwd, filePath);
        const oldText = requireString(input, "oldText");
        const newText = requireString(input, "newText");
        const text = await fs.readFile(filePath, "utf8");
        const first = text.indexOf(oldText);
        if (first === -1) return { ok: false, output: "oldText was not found." };
        if (text.indexOf(oldText, first + oldText.length) !== -1) {
          return { ok: false, output: "oldText appears more than once; make it more specific." };
        }
        const nextText = text.replace(oldText, newText);
        await fs.writeFile(filePath, nextText, "utf8");
        return {
          ok: true,
          output: `Updated ${relativePath}`,
          metadata: {
            path: relativePath,
            touchedPaths: [relativePath],
            diff: displayDiff(relativePath, text, nextText),
            firstChangedLine: firstChangedLine(text, nextText)
          }
        };
      }
    },
    {
      name: "write_file",
      description: "Write a UTF-8 file, replacing existing content and creating parent directories as needed.",
      inputSchema: { path: "Required file path inside the workspace.", content: "File content." },
      risk: "write",
      describe(input) {
        return `Write ${String(input.path)}`;
      },
      requiresApproval(input, context) {
        return writeApproval("write_file", requireString(input, "path"), context);
      },
      validate(input) {
        return validateInput("write_file", input, rulesFor("write_file"));
      },
      async run(input) {
        const filePath = resolveInside(cwd, requireString(input, "path"));
        const relativePath = path.relative(cwd, filePath);
        const content = typeof input.content === "string" ? input.content : "";
        const oldContent = await fs.readFile(filePath, "utf8").catch(() => "");
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, "utf8");
        return {
          ok: true,
          output: `Wrote ${relativePath}`,
          metadata: {
            path: relativePath,
            touchedPaths: [relativePath],
            diff: displayDiff(relativePath, oldContent, content),
            firstChangedLine: firstChangedLine(oldContent, content)
          }
        };
      }
    },
    {
      name: "create_file",
      description: "Create a new UTF-8 file. Fails if the file already exists.",
      inputSchema: { path: "Required new file path inside the workspace.", content: "File content." },
      risk: "write",
      describe(input) {
        return `Create ${String(input.path)}`;
      },
      requiresApproval(input, context) {
        return writeApproval("create_file", requireString(input, "path"), context);
      },
      validate(input) {
        return validateInput("create_file", input, rulesFor("create_file"));
      },
      async run(input) {
        const filePath = resolveInside(cwd, requireString(input, "path"));
        const relativePath = path.relative(cwd, filePath);
        const content = typeof input.content === "string" ? input.content : "";
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
        return {
          ok: true,
          output: `Created ${relativePath}`,
          metadata: {
            path: relativePath,
            touchedPaths: [relativePath],
            diff: displayDiff(relativePath, "", content),
            firstChangedLine: 1
          }
        };
      }
    },
    {
      name: "apply_patch",
      description: "Apply a standard unified diff patch. Supports adding, modifying, and deleting files.",
      inputSchema: { patch: "Required unified diff string." },
      risk: "write",
      describe() {
        return "Apply unified diff patch";
      },
      requiresApproval(input, context) {
        return patchApproval("apply_patch", requireString(input, "patch"), context);
      },
      validate(input) {
        return validateInput("apply_patch", input, rulesFor("apply_patch"));
      },
      async run(input) {
        const patch = requireString(input, "patch");
        const output = await applyUnifiedPatch(cwd, patch);
        return { ok: true, output, metadata: { touchedPaths: output.split(/\r?\n/).map((line) => line.replace(/^(?:Updated|Created|Deleted)\s+/, "")).filter(Boolean), patch } };
      }
    },
    {
      name: "git_apply_check",
      description: "Validate a standard unified diff patch without modifying files.",
      inputSchema: { patch: "Required unified diff string." },
      risk: "read",
      describe() {
        return "Check unified diff patch";
      },
      requiresApproval() {
        return readApproval();
      },
      validate(input) {
        return validateInput("git_apply_check", input, rulesFor("git_apply_check"));
      },
      async run(input) {
        const patch = requireString(input, "patch");
        const output = await checkUnifiedPatch(cwd, patch);
        return { ok: true, output: clip(output, maxOutputChars), metadata: { touchedPaths: output.split(/\r?\n/).slice(1).map((line) => line.replace(/^(?:Updated|Created|Deleted)\s+/, "")).filter(Boolean), patch, checked: true } };
      }
    },
    {
      name: "run_command",
      description: "Run a shell command in the workspace. Always asks for approval in risk-based mode.",
      inputSchema: { command: "Required shell command.", timeoutMs: "Optional timeout in milliseconds." },
      risk: "shell",
      describe(input) {
        return `Run command: ${String(input.command)}`;
      },
      requiresApproval(input, context) {
        return shellApproval(requireString(input, "command"), context, allowDangerousCommands);
      },
      validate(input) {
        return validateInput("run_command", input, rulesFor("run_command"));
      },
      async run(input) {
        const command = requireString(input, "command");
        const timeout = typeof input.timeoutMs === "number" ? input.timeoutMs : 30_000;
        try {
          const { stdout, stderr } = await execAsync(command, { cwd, timeout });
          return { ok: true, output: clip([stdout, stderr].filter(Boolean).join("\n") || "[command completed]", maxOutputChars), metadata: { command, exitCode: 0 } };
        } catch (error) {
          const maybe = error as { code?: number | string };
          return { ok: false, output: clip(formatExecError(error), maxOutputChars), errorType: "runtime", metadata: { command, exitCode: typeof maybe.code === "number" ? maybe.code : String(maybe.code ?? "unknown") } };
        }
      }
    },
    {
      name: "git_status",
      description: "Show short git status for current workspace.",
      inputSchema: {},
      risk: "read",
      describe() {
        return "Show git status";
      },
      requiresApproval() {
        return readApproval();
      },
      validate() {
        return undefined;
      },
      async run() {
        const status = await execAsync("git status --short", { cwd, timeout: 10_000 });
        return { ok: true, output: clip(status.stdout || "[clean]", maxOutputChars) };
      }
    },
    {
      name: "list_changed_files",
      description: "List files changed in git status, including untracked files.",
      inputSchema: {},
      risk: "read",
      describe() {
        return "List changed files";
      },
      requiresApproval() {
        return readApproval();
      },
      validate() {
        return undefined;
      },
      async run() {
        const status = await execAsync("git status --short", { cwd, timeout: 10_000 });
        const files = status.stdout
          .split(/\r?\n/)
          .map((line) => line.slice(3).trim())
          .filter(Boolean)
          .map((line) => line.includes(" -> ") ? line.split(" -> ").at(-1) ?? line : line);
        return { ok: true, output: clip(files.join("\n") || "[clean]", maxOutputChars), metadata: { files } };
      }
    },
    {
      name: "git_diff",
      description: "Show git diff for current workspace, optionally limited to one path.",
      inputSchema: { path: "Optional file or directory path inside the workspace." },
      risk: "read",
      describe(input) {
        return typeof input.path === "string" ? `Show git diff for ${input.path}` : "Show git diff";
      },
      requiresApproval() {
        return readApproval();
      },
      validate(input) {
        return validateInput("git_diff", input, rulesFor("git_diff"));
      },
      async run(input) {
        const diffPath = typeof input.path === "string" ? path.relative(cwd, resolveInside(cwd, input.path)) : undefined;
        const command = diffPath ? `git diff -- ${JSON.stringify(diffPath)}` : "git diff";
        const diff = await execAsync(command, { cwd, timeout: 10_000 });
        return { ok: true, output: clip(diff.stdout || "[no diff]", maxOutputChars), metadata: { path: diffPath } };
      }
    },
    {
      name: "todo_write",
      description: "Update the task todo list. Call this to track progress on multi-step tasks. Replaces the current todo list with the provided items.",
      inputSchema: {
        todos: "Required array of todo objects with id (string), content (string), and status ('pending'|'in_progress'|'completed')."
      },
      risk: "read",
      describe(input) {
        const count = Array.isArray(input.todos) ? (input.todos as unknown[]).length : 0;
        return `Update todo list (${count} item${count === 1 ? "" : "s"})`;
      },
      requiresApproval() {
        return readApproval();
      },
      validate(input) {
        if (!Array.isArray(input.todos)) {
          return { ok: false, output: "todo_write requires a 'todos' array.", errorType: "validation" };
        }
        for (const item of input.todos as unknown[]) {
          if (typeof item !== "object" || item === null) {
            return { ok: false, output: "Each todo must be an object.", errorType: "validation" };
          }
          const todo = item as Record<string, unknown>;
          if (typeof todo.id !== "string" || typeof todo.content !== "string") {
            return { ok: false, output: "Each todo must have a string 'id' and 'content'.", errorType: "validation" };
          }
          if (!["pending", "in_progress", "completed"].includes(todo.status as string)) {
            return { ok: false, output: `Invalid todo status: ${String(todo.status)}. Must be pending, in_progress, or completed.`, errorType: "validation" };
          }
        }
        return undefined;
      },
      async run(input) {
        const todos = input.todos as Array<{ id: string; content: string; status: string }>;
        const summary = todos.map((t) => `[${t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " "}] ${t.content}`).join("\n");
        return { ok: true, output: `Todo list updated:\n${summary}`, metadata: { count: todos.length } };
      }
    }
  ];

  return tools.map((tool) => ({
    ...tool,
    validate(input: Record<string, unknown>): ToolResult | undefined {
      return tool.validate(input);
    },
    async run(input: Record<string, unknown>): Promise<ToolResult> {
      try {
        return await tool.run(input);
      } catch (error) {
        return withMetadata({ ok: false, output: stringifyError(error), errorType: "runtime" }, { tool: tool.name });
      }
    }
  }));
}
