import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { applyUnifiedPatch } from "./patch.js";
import { resolveInside } from "./pathUtils.js";
import { patchApproval, readApproval, shellApproval, writeApproval } from "./permissions.js";
import type { ApprovalContext, ToolDefinition, ToolResult } from "../core/types.js";

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

export function createTools(cwd: string, maxOutputChars: number): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: "list_files",
      description: "List workspace files. Uses rg --files when available.",
      inputSchema: { path: "Optional directory path inside the workspace." },
      risk: "read",
      describe(input) {
        return `List files under ${typeof input.path === "string" ? input.path : "."}`;
      },
      requiresApproval() {
        return readApproval();
      },
      async run(input) {
        const target = resolveInside(cwd, typeof input.path === "string" ? input.path : ".");
        const relativeTarget = path.relative(cwd, target) || ".";
        const hasRg = await commandExists("rg", cwd);
        const command = hasRg
          ? `rg --files ${JSON.stringify(relativeTarget)}`
          : process.platform === "win32"
            ? `dir /b /s ${JSON.stringify(target)}`
            : `find ${JSON.stringify(target)} -type f`;
        const { stdout, stderr } = await execAsync(command, { cwd, timeout: 20_000 });
        return { ok: true, output: clip(stdout || stderr || "[no files]", maxOutputChars) };
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
      async run(input) {
        const query = requireString(input, "query");
        const target = resolveInside(cwd, typeof input.path === "string" ? input.path : ".");
        const relativeTarget = path.relative(cwd, target) || ".";
        const command = `rg --line-number --hidden --glob !node_modules --glob !dist ${JSON.stringify(query)} ${JSON.stringify(relativeTarget)}`;
        try {
          const { stdout, stderr } = await execAsync(command, { cwd, timeout: 20_000 });
          return { ok: true, output: clip(stdout || stderr || "[no matches]", maxOutputChars) };
        } catch (error: unknown) {
          const maybe = error as { stdout?: string; stderr?: string };
          return { ok: true, output: clip(maybe.stdout || maybe.stderr || "[no matches]", maxOutputChars) };
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
      async run(input) {
        const filePath = resolveInside(cwd, requireString(input, "path"));
        const text = await fs.readFile(filePath, "utf8");
        const lines = text.split(/\r?\n/);
        const start = typeof input.startLine === "number" ? Math.max(1, input.startLine) : 1;
        const end = typeof input.endLine === "number" ? Math.min(lines.length, input.endLine) : lines.length;
        const selected = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n");
        return { ok: true, output: clip(selected, maxOutputChars) };
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
      async run(input) {
        const filePath = resolveInside(cwd, requireString(input, "path"));
        const oldText = requireString(input, "oldText");
        const newText = requireString(input, "newText");
        const text = await fs.readFile(filePath, "utf8");
        const first = text.indexOf(oldText);
        if (first === -1) return { ok: false, output: "oldText was not found." };
        if (text.indexOf(oldText, first + oldText.length) !== -1) {
          return { ok: false, output: "oldText appears more than once; make it more specific." };
        }
        await fs.writeFile(filePath, text.replace(oldText, newText), "utf8");
        return { ok: true, output: `Updated ${path.relative(cwd, filePath)}` };
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
      async run(input) {
        const filePath = resolveInside(cwd, requireString(input, "path"));
        const content = typeof input.content === "string" ? input.content : "";
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
        return { ok: true, output: `Created ${path.relative(cwd, filePath)}` };
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
      async run(input) {
        const output = await applyUnifiedPatch(cwd, requireString(input, "patch"));
        return { ok: true, output };
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
        return shellApproval(requireString(input, "command"), context);
      },
      async run(input) {
        const command = requireString(input, "command");
        const timeout = typeof input.timeoutMs === "number" ? input.timeoutMs : 30_000;
        const { stdout, stderr } = await execAsync(command, { cwd, timeout });
        return { ok: true, output: clip([stdout, stderr].filter(Boolean).join("\n") || "[command completed]", maxOutputChars) };
      }
    },
    {
      name: "git_diff",
      description: "Show git status and diff for current workspace.",
      inputSchema: {},
      risk: "read",
      describe() {
        return "Show git status and diff";
      },
      requiresApproval() {
        return readApproval();
      },
      async run() {
        const status = await execAsync("git status --short", { cwd, timeout: 10_000 });
        const diff = await execAsync("git diff", { cwd, timeout: 10_000 });
        return { ok: true, output: clip(`STATUS:\n${status.stdout || "[clean]"}\nDIFF:\n${diff.stdout || "[no diff]"}`, maxOutputChars) };
      }
    }
  ];

  return tools.map((tool) => ({
    ...tool,
    async run(input: Record<string, unknown>): Promise<ToolResult> {
      try {
        return await tool.run(input);
      } catch (error) {
        return { ok: false, output: stringifyError(error) };
      }
    }
  }));
}
