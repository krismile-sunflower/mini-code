import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "../../core/types.js";
import { readApproval } from "../permissions.js";
import { resolveInside } from "../pathUtils.js";
import {
  clip,
  collectFiles,
  commandExists,
  execAsync,
  formatReadFile,
  matchesSimpleGlob,
  requireNumber,
  requireString,
  requireStringArray,
  validateToolInput,
  workspacePath,
  type BuiltinToolContext
} from "./common.js";

export function createFileTools(context: BuiltinToolContext): ToolDefinition[] {
  const { cwd, maxOutputChars } = context;
  return [
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
      requiresApproval: readApproval,
      validate(input) {
        return validateToolInput("list_files", input);
      },
      async run(input) {
        const target = resolveInside(cwd, typeof input.path === "string" ? input.path : ".");
        const relativeTarget = path.relative(cwd, target) || ".";
        const hasRg = await commandExists("rg", cwd);
        const glob = typeof input.glob === "string" && input.glob.trim() ? input.glob : undefined;
        const command = hasRg
          ? `rg --files${glob ? ` -g ${JSON.stringify(glob)}` : ""} ${JSON.stringify(relativeTarget)}`
          : process.platform === "win32"
            ? `dir /b /s ${JSON.stringify(target)}`
            : `find ${JSON.stringify(target)} -type f`;
        const { stdout, stderr } = await execAsync(command, { cwd, timeout: 20_000 });
        let output = stdout || stderr || "";
        if (!output.trim()) output = (await collectFiles(target, cwd, glob)).join("\n");
        output = output || "[no files]";
        if (output !== "[no files]") {
          output = output
            .split(/\r?\n/)
            .filter(Boolean)
            .map((file) => {
              const normalized = file.replaceAll("\\", "/");
              return path.isAbsolute(file) ? workspacePath(cwd, file) : normalized.replace(/^\.\//, "");
            })
            .filter((file) => !glob || matchesSimpleGlob(file, glob))
            .join("\n") || "[no files]";
        }
        const maxDepth = typeof input.maxDepth === "number" ? input.maxDepth : undefined;
        if (maxDepth !== undefined && maxDepth >= 0 && output !== "[no files]") {
          const baseDepth = relativeTarget === "." ? 0 : relativeTarget.split(/[\\/]/).filter(Boolean).length;
          output = output
            .split(/\r?\n/)
            .filter(Boolean)
            .filter((file) => file.replace(/^\.\//, "").split(/[\\/]/).filter(Boolean).length - baseDepth <= maxDepth)
            .map((file) => file.replaceAll("\\", "/"))
            .join("\n") || "[no files]";
        }
        const clipped = clip(output, maxOutputChars);
        const files = output === "[no files]" ? [] : output.split(/\r?\n/).filter(Boolean);
        return { ok: true, output: clipped.output, metadata: { path: relativeTarget, glob, maxDepth, readPaths: files } };
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
      requiresApproval: readApproval,
      validate(input) {
        return validateToolInput("read_many_files", input);
      },
      async run(input) {
        const paths = requireStringArray(input, "paths");
        const outputs: string[] = [];
        const readPaths: string[] = [];
        for (const requestedPath of paths) {
          try {
            const filePath = resolveInside(cwd, requestedPath);
            const text = await fs.readFile(filePath, "utf8");
            readPaths.push(workspacePath(cwd, filePath));
            outputs.push(`--- ${requestedPath}\n${formatReadFile(filePath, text)}`);
          } catch (error) {
            outputs.push(`--- ${requestedPath}\n[error] ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return { ok: true, output: clip(outputs.join("\n\n"), maxOutputChars).output, metadata: { paths, readPaths } };
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
      requiresApproval: readApproval,
      validate(input) {
        return validateToolInput("read_tree", input);
      },
      async run(input) {
        const target = resolveInside(cwd, typeof input.path === "string" ? input.path : ".");
        const relativeRoot = path.relative(cwd, target) || ".";
        const maxDepth = Math.max(0, Math.min(6, requireNumber(input, "maxDepth", 2)));
        const lines = await walkTree(target, relativeRoot, maxDepth);
        return { ok: true, output: clip(lines.join("\n") || "[empty directory]", maxOutputChars).output, metadata: { path: relativeRoot, maxDepth, readPaths: [relativeRoot] } };
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
      requiresApproval: readApproval,
      validate(input) {
        return validateToolInput("search", input);
      },
      async run(input) {
        const query = requireString(input, "query");
        const target = resolveInside(cwd, typeof input.path === "string" ? input.path : ".");
        const relativeTarget = path.relative(cwd, target) || ".";
        const command = `rg --line-number --hidden --glob !node_modules --glob !dist ${JSON.stringify(query)} ${JSON.stringify(relativeTarget)}`;
        try {
          const { stdout, stderr } = await execAsync(command, { cwd, timeout: 20_000 });
          return { ok: true, output: clip(stdout || stderr || "[no matches]", maxOutputChars).output, metadata: { query, path: relativeTarget, readPaths: [relativeTarget] } };
        } catch (error: unknown) {
          const maybe = error as { stdout?: string; stderr?: string };
          return { ok: true, output: clip(maybe.stdout || maybe.stderr || "[no matches]", maxOutputChars).output, metadata: { query, path: relativeTarget, readPaths: [relativeTarget] } };
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
      requiresApproval: readApproval,
      validate(input) {
        return validateToolInput("read_file", input);
      },
      async run(input) {
        const filePath = resolveInside(cwd, requireString(input, "path"));
        const text = await fs.readFile(filePath, "utf8");
        const start = typeof input.startLine === "number" ? Math.max(1, input.startLine) : 1;
        const end = typeof input.endLine === "number" ? input.endLine : undefined;
        const relativePath = workspacePath(cwd, filePath);
        return { ok: true, output: clip(formatReadFile(filePath, text, start, end), maxOutputChars).output, metadata: { path: relativePath, readPaths: [relativePath], startLine: start, endLine: end } };
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
      requiresApproval: readApproval,
      validate(input) {
        return validateToolInput("show_file_outline", input);
      },
      async run(input) {
        const requestedPath = requireString(input, "path");
        const filePath = resolveInside(cwd, requestedPath);
        const text = await fs.readFile(filePath, "utf8");
        return { ok: true, output: clip(outlineText(requestedPath, text), maxOutputChars).output, metadata: { path: requestedPath, readPaths: [requestedPath] } };
      }
    }
  ];
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
    if (entry.isDirectory()) lines.push(...(await walkTree(path.join(root, entry.name), relative, maxDepth, currentDepth + 1)));
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
