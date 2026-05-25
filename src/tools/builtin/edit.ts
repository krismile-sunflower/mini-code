import { promises as fs } from "node:fs";
import path from "node:path";
import type { ApprovalContext, ToolDefinition } from "../../core/types.js";
import { applyUnifiedPatch, checkUnifiedPatch } from "../patch.js";
import { patchApproval, writeApproval } from "../permissions.js";
import { resolveInside } from "../pathUtils.js";
import { clip, displayDiff, firstChangedLine, requireString, validateToolInput, workspacePath, type BuiltinToolContext } from "./common.js";

export function createEditTools(context: BuiltinToolContext): ToolDefinition[] {
  const { cwd, maxOutputChars } = context;
  return [
    {
      name: "replace_text",
      description: "Replace exact text in a file. Fails unless the old text occurs exactly once.",
      inputSchema: { path: "Required file path inside the workspace.", oldText: "Exact text to replace.", newText: "Replacement text." },
      risk: "write",
      describe(input) {
        return `Replace exact text in ${String(input.path)}`;
      },
      requiresApproval(input, approvalContext: ApprovalContext) {
        return writeApproval("replace_text", requireString(input, "path"), approvalContext);
      },
      validate(input) {
        return validateToolInput("replace_text", input);
      },
      async run(input) {
        const filePath = resolveInside(cwd, requireString(input, "path"));
        const relativePath = workspacePath(cwd, filePath);
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
      requiresApproval(input, approvalContext) {
        return writeApproval("write_file", requireString(input, "path"), approvalContext);
      },
      validate(input) {
        return validateToolInput("write_file", input);
      },
      async run(input) {
        const filePath = resolveInside(cwd, requireString(input, "path"));
        const relativePath = workspacePath(cwd, filePath);
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
      requiresApproval(input, approvalContext) {
        return writeApproval("create_file", requireString(input, "path"), approvalContext);
      },
      validate(input) {
        return validateToolInput("create_file", input);
      },
      async run(input) {
        const filePath = resolveInside(cwd, requireString(input, "path"));
        const relativePath = workspacePath(cwd, filePath);
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
      requiresApproval(input, approvalContext) {
        return patchApproval("apply_patch", requireString(input, "patch"), approvalContext);
      },
      validate(input) {
        return validateToolInput("apply_patch", input);
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
        return { required: false, risk: "read", reason: "Read-only tools are allowed." };
      },
      validate(input) {
        return validateToolInput("git_apply_check", input);
      },
      async run(input) {
        const patch = requireString(input, "patch");
        const output = await checkUnifiedPatch(cwd, patch);
        return { ok: true, output: clip(output, maxOutputChars).output, metadata: { touchedPaths: output.split(/\r?\n/).slice(1).map((line) => line.replace(/^(?:Updated|Created|Deleted)\s+/, "")).filter(Boolean), patch, checked: true } };
      }
    }
  ];
}
