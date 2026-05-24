import path from "node:path";
import type { ApprovalContext, ApprovalRequirement, ToolRisk } from "../core/types.js";
import { inspectPatch } from "./patch.js";
import { looksSensitivePath } from "./pathUtils.js";

export function isDangerousCommand(command: string): boolean {
  const patterns = [
    /\brm\s+-rf\b/i,
    /\brm\s+-r\b/i,
    /\bdel\s+\/[sfq]/i,
    /\bRemove-Item\b.*\b-Recurse\b/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+clean\s+-[^\s]*f/i,
    /\bgit\s+checkout\s+--\b/i,
    /\bsudo\b/i,
    /\bcurl\b.*\|\s*(?:sh|bash|zsh)\b/i,
    /\bwget\b.*\|\s*(?:sh|bash|zsh)\b/i,
    /\bchmod\s+777\b/i,
    /\bformat\b/i,
    /\bshutdown\b/i,
    /\breboot\b/i
  ];
  return patterns.some((pattern) => pattern.test(command));
}

export function commandPrefix(command: string): string {
  return command.trim().split(/\s+/).slice(0, 2).join(" ");
}

export function commandApprovalKey(command: string): string {
  return `shell:exact:${command.trim().replace(/\s+/g, " ")}`;
}

function pathApprovalKey(tool: string, filePath: string): string {
  return `write:${tool}:${filePath.replaceAll("\\", "/")}`;
}

function patchApprovalKey(paths: string[]): string {
  return `patch:${paths.map((filePath) => filePath.replaceAll("\\", "/")).sort().join("|")}`;
}

function lowRiskCommand(command: string): boolean {
  return /^(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|typecheck|lint|build))\b/.test(command.trim()) || /^npx\s+tsc\b/.test(command.trim());
}

export function approval(
  required: boolean,
  risk: ToolRisk,
  reason: string,
  allowAlwaysKey?: string,
  details?: ApprovalRequirement["details"],
  denied = false,
  extras: Partial<ApprovalRequirement> = {}
): ApprovalRequirement {
  const blocked = extras.blocked ?? denied;
  const approvalKey = extras.approvalKey ?? allowAlwaysKey;
  return { required, risk, reason, allowAlwaysKey, approvalKey, details, denied, blocked, rememberable: required && !blocked && Boolean(approvalKey), ...extras };
}

export function readApproval(): ApprovalRequirement {
  return approval(false, "read", "Read-only tools are allowed.");
}

export function writeApproval(tool: string, filePath: string, context: ApprovalContext): ApprovalRequirement {
  const normalized = filePath.replaceAll("\\", "/");
  const key = pathApprovalKey(tool, normalized);
  if (context.allowedApprovalKeys.has("mode:bypass_permissions")) return approval(false, "write", "Bypass permissions mode allows this write.", key, undefined, false, { scope: normalized, riskReason: "Bypass permissions mode." });
  if (context.allowedApprovalKeys.has("mode:accept_edits")) return approval(false, "write", "Accept edits mode allows this write.", key, undefined, false, { scope: normalized, riskReason: "Accept edits mode." });
  if (context.allowedApprovalKeys.has(key)) return approval(false, "write", `Write is allowed for this path: ${normalized}`, key, undefined, false, { scope: normalized, riskReason: "Previously approved path." });
  if (looksSensitivePath(normalized)) {
    return approval(true, "write", `Sensitive path requires approval: ${normalized}`, key, undefined, false, { scope: normalized, riskReason: "Sensitive path.", rememberable: false });
  }
  if (normalized.split("/").includes("..") || path.isAbsolute(normalized)) {
    return approval(true, "write", `Unusual path requires approval: ${normalized}`, key, undefined, false, { scope: normalized, riskReason: "Unusual path.", rememberable: false });
  }
  return approval(false, "write", "Ordinary workspace write is allowed.", key, undefined, false, { scope: normalized, riskReason: "Ordinary workspace write." });
}

export function patchApproval(tool: string, patch: string, context: ApprovalContext): ApprovalRequirement {
  try {
    const summary = inspectPatch(patch);
    const key = patchApprovalKey(summary.touchedPaths);
    const sensitive = summary.touchedPaths.find(looksSensitivePath);
    const escaping = summary.touchedPaths.find((filePath) => filePath.split(/[\\/]/).includes("..") || path.isAbsolute(filePath));
    const details = [
      { label: "files", value: summary.touchedPaths.join(", ") || "[none]" },
      { label: "deletes", value: summary.deletesFiles ? "yes" : "no" },
      { label: "sensitive", value: sensitive ?? "no" }
    ];
    if (context.allowedApprovalKeys.has("mode:bypass_permissions")) return approval(false, "write", "Bypass permissions mode allows this patch.", key, details, false, { scope: summary.touchedPaths.join(", "), riskReason: "Bypass permissions mode." });
    if (context.allowedApprovalKeys.has("mode:accept_edits")) return approval(false, "write", "Accept edits mode allows this patch.", key, details, false, { scope: summary.touchedPaths.join(", "), riskReason: "Accept edits mode." });
    if (summary.deletesFiles) return approval(true, "write", "Patch deletes one or more files.", key, details, false, { scope: summary.touchedPaths.join(", "), riskReason: "Deletes files.", rememberable: false });
    if (sensitive) return approval(true, "write", `Patch touches sensitive path: ${sensitive}`, key, details, false, { scope: summary.touchedPaths.join(", "), riskReason: "Touches sensitive path.", rememberable: false });
    if (escaping) return approval(true, "write", `Patch uses unusual path: ${escaping}`, key, details, false, { scope: summary.touchedPaths.join(", "), riskReason: "Uses unusual path.", rememberable: false });
    if (context.allowedApprovalKeys.has(key)) return approval(false, "write", "Patch is allowed for these files.", key, details, false, { scope: summary.touchedPaths.join(", "), riskReason: "Previously approved patch file set." });
    return approval(false, "write", "Ordinary workspace patch is allowed.", key, details, false, { scope: summary.touchedPaths.join(", "), riskReason: "Ordinary workspace patch." });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return approval(true, "write", `Patch must be reviewed because it could not be inspected: ${message}`, "patch:uninspectable", undefined, false, { riskReason: "Patch could not be inspected.", rememberable: false });
  }
}

export function shellApproval(command: string, context: ApprovalContext, allowDangerousCommands = false): ApprovalRequirement {
  const prefix = commandPrefix(command);
  const key = commandApprovalKey(command);
  const details = [
    { label: "cwd", value: context.cwd },
    { label: "command", value: command },
    { label: "prefix", value: prefix },
    { label: "approvalKey", value: key }
  ];
  if (context.allowedApprovalKeys.has(key)) {
    return approval(false, "shell", `Command is allowed this session: ${command}`, key, details, false, { scope: command, riskReason: "Previously approved exact command." });
  }
  if (isDangerousCommand(command)) {
    return approval(
      true,
      "dangerous",
      allowDangerousCommands ? `Dangerous command requires explicit approval: ${command}` : `Dangerous command blocked unless --allow-dangerous is set: ${command}`,
      key,
      details,
      !allowDangerousCommands,
      { scope: command, riskReason: "Command matches a dangerous pattern.", blocked: !allowDangerousCommands, rememberable: false }
    );
  }
  if (context.allowedApprovalKeys.has("mode:bypass_permissions")) {
    return approval(false, "shell", "Bypass permissions mode allows this shell command.", key, details, false, { scope: command, riskReason: "Bypass permissions mode." });
  }
  const riskReason = lowRiskCommand(command) ? "Low-risk verification command." : "Shell command can modify the workspace or environment.";
  return approval(true, "shell", `Shell command requires approval: ${command}`, key, details, false, { scope: command, riskReason });
}
