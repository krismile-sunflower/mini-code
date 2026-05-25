import path from "node:path";
import type { ToolDefinition } from "../../core/types.js";
import { readApproval } from "../permissions.js";
import { resolveInside } from "../pathUtils.js";
import { clip, execAsync, validateToolInput, workspacePath, type BuiltinToolContext } from "./common.js";

export function createGitTools(context: BuiltinToolContext): ToolDefinition[] {
  const { cwd, maxOutputChars } = context;
  return [
    {
      name: "git_status",
      description: "Show short git status for current workspace.",
      inputSchema: {},
      risk: "read",
      describe() {
        return "Show git status";
      },
      requiresApproval: readApproval,
      validate() {
        return undefined;
      },
      async run() {
        const status = await execAsync("git status --short", { cwd, timeout: 10_000 });
        return { ok: true, output: clip(status.stdout || "[clean]", maxOutputChars).output };
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
      requiresApproval: readApproval,
      validate() {
        return undefined;
      },
      async run() {
        const status = await execAsync("git status --short", { cwd, timeout: 10_000 });
        const files = status.stdout
          .split(/\r?\n/)
          .map((line) => line.slice(3).trim())
          .filter(Boolean)
          .map((line) => line.includes(" -> ") ? line.split(" -> ").at(-1) ?? line : line)
          .map((file) => file.replaceAll("\\", "/"));
        return { ok: true, output: clip(files.join("\n") || "[clean]", maxOutputChars).output, metadata: { files, readPaths: files } };
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
      requiresApproval: readApproval,
      validate(input) {
        return validateToolInput("git_diff", input);
      },
      async run(input) {
        const diffPath = typeof input.path === "string" ? workspacePath(cwd, resolveInside(cwd, input.path)) : undefined;
        const command = diffPath ? `git diff -- ${JSON.stringify(diffPath)}` : "git diff";
        const diff = await execAsync(command, { cwd, timeout: 10_000 });
        return { ok: true, output: clip(diff.stdout || "[no diff]", maxOutputChars).output, metadata: { path: diffPath, readPaths: diffPath ? [diffPath] : [path.relative(cwd, cwd) || "."] } };
      }
    }
  ];
}
