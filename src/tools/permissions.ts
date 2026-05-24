import path from "node:path";
import type { ApprovalContext, ApprovalRequirement, ToolRisk } from "../core/types.js";
import { inspectPatch } from "./patch.js";
import { looksSensitivePath } from "./pathUtils.js";

export function isDangerousCommand(command: string): boolean {
  const patterns = [
    /\brm\s+-rf\b/i,
    /\bdel\s+\/[sfq]/i,
    /\bRemove-Item\b.*\b-Recurse\b/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+clean\s+-[^\s]*f/i,
    /\bgit\s+checkout\s+--\b/i,
    /\bformat\b/i,
    /\bshutdown\b/i,
    /\breboot\b/i
  ];
  return patterns.some((pattern) => pattern.test(command));
}

export function commandPrefix(command: string): string {
  return command.trim().split(/\s+/).slice(0, 2).join(" ");
}

export function approval(required: boolean, risk: ToolRisk, reason: string, allowAlwaysKey?: string): ApprovalRequirement {
  return { required, risk, reason, allowAlwaysKey };
}

export function readApproval(): ApprovalRequirement {
  return approval(false, "read", "Read-only tools are allowed.");
}

export function writeApproval(tool: string, filePath: string, context: ApprovalContext): ApprovalRequirement {
  if (context.allowedTools.has(tool)) return approval(false, "write", `${tool} is allowed for this session.`);
  const normalized = filePath.replaceAll("\\", "/");
  if (looksSensitivePath(normalized)) {
    return approval(true, "write", `Sensitive path requires approval: ${normalized}`, tool);
  }
  if (normalized.split("/").includes("..") || path.isAbsolute(normalized)) {
    return approval(true, "write", `Unusual path requires approval: ${normalized}`, tool);
  }
  return approval(false, "write", "Ordinary workspace write is allowed.");
}

export function patchApproval(tool: string, patch: string, context: ApprovalContext): ApprovalRequirement {
  if (context.allowedTools.has(tool)) return approval(false, "write", `${tool} is allowed for this session.`);
  try {
    const summary = inspectPatch(patch);
    if (summary.deletesFiles) return approval(true, "write", "Patch deletes one or more files.", tool);
    const sensitive = summary.touchedPaths.find(looksSensitivePath);
    if (sensitive) return approval(true, "write", `Patch touches sensitive path: ${sensitive}`, tool);
    const escaping = summary.touchedPaths.find((filePath) => filePath.split(/[\\/]/).includes("..") || path.isAbsolute(filePath));
    if (escaping) return approval(true, "write", `Patch uses unusual path: ${escaping}`, tool);
    return approval(false, "write", "Ordinary workspace patch is allowed.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return approval(true, "write", `Patch must be reviewed because it could not be inspected: ${message}`, tool);
  }
}

export function shellApproval(command: string, context: ApprovalContext): ApprovalRequirement {
  const prefix = commandPrefix(command);
  if (context.allowedCommandPrefixes.has(prefix)) {
    return approval(false, "shell", `Command prefix is allowed this session: ${prefix}`, prefix);
  }
  if (isDangerousCommand(command)) {
    return approval(true, "dangerous", `Dangerous command requires explicit approval: ${command}`, prefix);
  }
  return approval(true, "shell", `Shell command requires approval: ${command}`, prefix);
}
