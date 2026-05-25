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

export function commandPrefixApprovalKey(prefix: string): string {
  return `shell:prefix:${prefix.trim().replace(/\s+/g, " ")}`;
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

function baseDetails(context: ApprovalContext, action: string, target: string, scopeType: string, riskReason: string, rememberPolicy: string): NonNullable<ApprovalRequirement["details"]> {
  return [
    { label: "mode", value: context.mode },
    { label: "action", value: action },
    { label: "target", value: target },
    { label: "scopeType", value: scopeType },
    { label: "cwd", value: context.cwd },
    { label: "riskReason", value: riskReason },
    { label: "rememberPolicy", value: rememberPolicy }
  ];
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
  const details = (riskReason: string, rememberPolicy: string) => baseDetails(context, "write", normalized, "file path", riskReason, rememberPolicy);
  if (looksSensitivePath(normalized)) {
    return approval(true, "write", `Sensitive path requires approval: ${normalized}`, key, details("Sensitive path.", "never"), false, { scope: normalized, riskReason: "Sensitive path.", rememberable: false });
  }
  if (normalized.split("/").includes("..") || path.isAbsolute(normalized)) {
    return approval(true, "write", `Unusual path requires approval: ${normalized}`, key, details("Unusual path.", "never"), false, { scope: normalized, riskReason: "Unusual path.", rememberable: false });
  }
  if (context.mode === "bypass_permissions") return approval(false, "write", "Bypass permissions mode allows this write.", key, details("Bypass permissions mode.", "not needed"), false, { scope: normalized, riskReason: "Bypass permissions mode." });
  if (context.mode === "accept_edits") return approval(false, "write", "Accept edits mode allows this write.", key, details("Accept edits mode.", "not needed"), false, { scope: normalized, riskReason: "Accept edits mode." });
  if (context.allowedApprovalKeys.has(key)) return approval(false, "write", `Write is allowed for this path: ${normalized}`, key, details("Previously approved path.", "file path"), false, { scope: normalized, riskReason: "Previously approved path." });
  return approval(true, "write", `Workspace write requires approval: ${normalized}`, key, details("Ordinary workspace write.", "file path"), false, { scope: normalized, riskReason: "Ordinary workspace write." });
}

export function patchApproval(tool: string, patch: string, context: ApprovalContext): ApprovalRequirement {
  try {
    const summary = inspectPatch(patch);
    const key = patchApprovalKey(summary.touchedPaths);
    const sensitive = summary.touchedPaths.find(looksSensitivePath);
    const escaping = summary.touchedPaths.find((filePath) => filePath.split(/[\\/]/).includes("..") || path.isAbsolute(filePath));
    const files = summary.touchedPaths.join(", ");
    const details = [
      ...baseDetails(context, "patch", files || "[none]", "patch file set", "Ordinary workspace patch.", "patch file set"),
      { label: "files", value: summary.touchedPaths.join(", ") || "[none]" },
      { label: "deletes", value: summary.deletesFiles ? "yes" : "no" },
      { label: "sensitive", value: sensitive ?? "no" }
    ];
    if (summary.deletesFiles) return approval(true, "write", "Patch deletes one or more files.", key, detailsWith(details, "riskReason", "Deletes files.", "rememberPolicy", "never"), false, { scope: files, riskReason: "Deletes files.", rememberable: false });
    if (sensitive) return approval(true, "write", `Patch touches sensitive path: ${sensitive}`, key, detailsWith(details, "riskReason", "Touches sensitive path.", "rememberPolicy", "never"), false, { scope: files, riskReason: "Touches sensitive path.", rememberable: false });
    if (escaping) return approval(true, "write", `Patch uses unusual path: ${escaping}`, key, detailsWith(details, "riskReason", "Uses unusual path.", "rememberPolicy", "never"), false, { scope: files, riskReason: "Uses unusual path.", rememberable: false });
    if (context.mode === "bypass_permissions") return approval(false, "write", "Bypass permissions mode allows this patch.", key, detailsWith(details, "riskReason", "Bypass permissions mode.", "rememberPolicy", "not needed"), false, { scope: files, riskReason: "Bypass permissions mode." });
    if (context.mode === "accept_edits") return approval(false, "write", "Accept edits mode allows this patch.", key, detailsWith(details, "riskReason", "Accept edits mode.", "rememberPolicy", "not needed"), false, { scope: files, riskReason: "Accept edits mode." });
    if (context.allowedApprovalKeys.has(key)) return approval(false, "write", "Patch is allowed for these files.", key, detailsWith(details, "riskReason", "Previously approved patch file set.", "rememberPolicy", "patch file set"), false, { scope: files, riskReason: "Previously approved patch file set." });
    return approval(true, "write", "Workspace patch requires approval.", key, details, false, { scope: files, riskReason: "Ordinary workspace patch." });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return approval(true, "write", `Patch must be reviewed because it could not be inspected: ${message}`, "patch:uninspectable", baseDetails(context, "patch", "[uninspectable]", "patch file set", "Patch could not be inspected.", "never"), false, { riskReason: "Patch could not be inspected.", rememberable: false });
  }
}

export function shellApproval(command: string, context: ApprovalContext, allowDangerousCommands = false): ApprovalRequirement {
  const prefix = commandPrefix(command);
  const key = commandApprovalKey(command);
  const prefixKey = commandPrefixApprovalKey(prefix);
  const isLowRisk = lowRiskCommand(command);
  const allowAlwaysKey = isLowRisk ? prefixKey : key;
  const details = [
    ...baseDetails(context, "shell", command, isLowRisk ? "command prefix" : "exact command", isLowRisk ? "Low-risk verification command." : "Shell command can modify the workspace or environment.", isLowRisk ? "command prefix" : "exact command"),
    { label: "cwd", value: context.cwd },
    { label: "command", value: command },
    { label: "prefix", value: prefix },
    { label: "prefixKey", value: prefixKey },
    { label: "approvalKey", value: key }
  ];
  if (isDangerousCommand(command)) {
    return approval(
      true,
      "dangerous",
      allowDangerousCommands ? `Dangerous command requires explicit approval: ${command}` : `Dangerous command blocked unless --allow-dangerous is set: ${command}`,
      undefined,
      detailsWith(details, "riskReason", "Command matches a dangerous pattern.", "rememberPolicy", "never"),
      !allowDangerousCommands,
      { scope: command, riskReason: "Command matches a dangerous pattern.", blocked: !allowDangerousCommands, rememberable: false }
    );
  }
  if (context.allowedApprovalKeys.has(key)) {
    return approval(false, "shell", `Command is allowed this session: ${command}`, key, detailsWith(details, "riskReason", "Previously approved exact command.", "rememberPolicy", "exact command"), false, { scope: command, riskReason: "Previously approved exact command." });
  }
  if (context.allowedCommandPrefixes.has(prefix) || context.allowedApprovalKeys.has(prefixKey)) {
    return approval(false, "shell", `Command prefix is allowed this session: ${prefix}`, prefixKey, detailsWith(details, "riskReason", "Previously approved command prefix.", "rememberPolicy", "command prefix"), false, { scope: prefix, riskReason: "Previously approved command prefix.", approvalKey: key });
  }
  if (context.mode === "bypass_permissions") {
    return approval(false, "shell", "Bypass permissions mode allows this shell command.", key, detailsWith(details, "riskReason", "Bypass permissions mode.", "rememberPolicy", "not needed"), false, { scope: command, riskReason: "Bypass permissions mode." });
  }
  const riskReason = isLowRisk ? "Low-risk verification command." : "Shell command can modify the workspace or environment.";
  return approval(true, "shell", `Shell command requires approval: ${command}`, allowAlwaysKey, details, false, { scope: isLowRisk ? prefix : command, riskReason, approvalKey: key });
}

function detailsWith(details: ApprovalRequirement["details"], labelA: string, valueA: string, labelB: string, valueB: string): ApprovalRequirement["details"] {
  return details?.map((detail) => {
    if (detail.label === labelA) return { ...detail, value: valueA };
    if (detail.label === labelB) return { ...detail, value: valueB };
    return detail;
  });
}
