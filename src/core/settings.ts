import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ApprovalRequirement } from "./types.js";

export interface SettingsPermissionRule {
  action: "allow" | "deny";
  matcher: string;
  source: string;
}

export interface ProjectSettings {
  permissions: SettingsPermissionRule[];
}

export function settingsFiles(cwd: string, includeGlobal = true, homeDir = os.homedir()): string[] {
  return [
    ...(includeGlobal ? [path.join(homeDir, ".mini-code", "settings.json"), path.join(homeDir, ".claude", "settings.json")] : []),
    path.join(cwd, ".mini-code", "settings.json"),
    path.join(cwd, ".mini-code", "settings.local.json"),
    path.join(cwd, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.local.json")
  ];
}

export function projectLocalSettingsPath(cwd: string): string {
  return path.join(cwd, ".mini-code", "settings.local.json");
}

export async function loadProjectSettings(cwd: string, includeGlobal = true, homeDir = os.homedir()): Promise<ProjectSettings> {
  const settings: ProjectSettings = { permissions: [] };
  for (const filePath of settingsFiles(cwd, includeGlobal, homeDir)) {
    if (!existsSync(filePath)) continue;
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    mergeSettings(settings, parsed, filePath);
  }
  return settings;
}

export function applySettingsPermissions(requirement: ApprovalRequirement, rules: SettingsPermissionRule[], tool: string, input: Record<string, unknown>): ApprovalRequirement {
  const denied = rules.find((rule) => rule.action === "deny" && matchesPermissionRule(rule.matcher, tool, input, requirement));
  if (denied) {
    return {
      ...requirement,
      required: true,
      denied: true,
      blocked: true,
      rememberable: false,
      reason: `Blocked by settings permission rule (${denied.matcher}) from ${denied.source}: ${requirement.reason}`,
      riskReason: "Blocked by settings permission rule.",
      details: [...(requirement.details ?? []), { label: "settingsRule", value: `${denied.action}:${denied.matcher}` }, { label: "settingsSource", value: denied.source }]
    };
  }

  const allowed = rules.find((rule) => rule.action === "allow" && matchesPermissionRule(rule.matcher, tool, input, requirement));
  if (!allowed || requirement.blocked || requirement.denied || requirement.risk === "dangerous") return requirement;
  return {
    ...requirement,
    required: false,
    denied: false,
    blocked: false,
    reason: `Allowed by settings permission rule (${allowed.matcher}) from ${allowed.source}.`,
    riskReason: "Allowed by settings permission rule.",
    details: [...(requirement.details ?? []), { label: "settingsRule", value: `${allowed.action}:${allowed.matcher}` }, { label: "settingsSource", value: allowed.source }]
  };
}

export async function addSettingsPermissionRule(cwd: string, action: SettingsPermissionRule["action"], matcher: string): Promise<{ path: string; action: SettingsPermissionRule["action"]; matcher: string; added: boolean }> {
  const normalized = normalizeMatcher(matcher);
  const filePath = projectLocalSettingsPath(cwd);
  const settings = await readSettingsObject(filePath);
  const permissions = ensurePermissionsObject(settings);
  const list = ensureStringArray(permissions, action);
  const added = !list.includes(normalized);
  if (added) list.push(normalized);
  await writeSettingsObject(filePath, settings);
  return { path: filePath, action, matcher: normalized, added };
}

export async function removeSettingsPermissionRule(cwd: string, action: SettingsPermissionRule["action"], matcher: string): Promise<{ path: string; action: SettingsPermissionRule["action"]; matcher: string; removed: boolean }> {
  const normalized = normalizeMatcher(matcher);
  const filePath = projectLocalSettingsPath(cwd);
  const settings = await readSettingsObject(filePath);
  const permissions = ensurePermissionsObject(settings);
  const list = ensureStringArray(permissions, action);
  const before = list.length;
  const next = list.filter((item) => item !== normalized);
  permissions[action] = next;
  await writeSettingsObject(filePath, settings);
  return { path: filePath, action, matcher: normalized, removed: before !== next.length };
}

function mergeSettings(settings: ProjectSettings, raw: unknown, source: string): void {
  if (!isRecord(raw) || !isRecord(raw.permissions)) return;
  for (const action of ["allow", "deny"] as const) {
    const value = raw.permissions[action];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const matcher = parsePermissionMatcher(item);
      if (matcher) settings.permissions.push({ action, matcher, source });
    }
  }
}

function parsePermissionMatcher(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (isRecord(raw) && typeof raw.matcher === "string" && raw.matcher.trim()) return raw.matcher.trim();
  return undefined;
}

function normalizeMatcher(matcher: string): string {
  const normalized = matcher.trim();
  if (!normalized) throw new Error("Permission matcher cannot be empty.");
  return normalized;
}

async function readSettingsObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeSettingsObject(filePath: string, settings: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function ensurePermissionsObject(settings: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(settings.permissions)) settings.permissions = {};
  return settings.permissions as Record<string, unknown>;
}

function ensureStringArray(settings: Record<string, unknown>, key: "allow" | "deny"): string[] {
  if (!Array.isArray(settings[key])) settings[key] = [];
  const list = (settings[key] as unknown[]).filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  settings[key] = list;
  return list;
}

function matchesPermissionRule(matcher: string, tool: string, input: Record<string, unknown>, requirement: ApprovalRequirement): boolean {
  const targets = permissionTargets(tool, input, requirement);
  return targets.some((target) => matchesPattern(matcher, target));
}

function permissionTargets(tool: string, input: Record<string, unknown>, requirement: ApprovalRequirement): string[] {
  const targets = [tool, `${tool}(*)`, ...claudeToolAliases(tool).map((alias) => alias), ...claudeToolAliases(tool).map((alias) => `${alias}(*)`)];
  if (tool === "run_command" && typeof input.command === "string") {
    const command = input.command.trim().replace(/\s+/g, " ");
    targets.push(`run_command:${command}`, `Bash(${command})`, `Bash(*)`);
    const bashPrefixTarget = bashColonTarget(command);
    if (bashPrefixTarget) targets.push(bashPrefixTarget);
  }
  for (const filePath of inputPaths(input)) {
    targets.push(...pathTargets(tool, filePath));
    for (const alias of claudeToolAliases(tool, filePath)) targets.push(...pathTargets(alias, filePath));
    if (isReadLikeTool(tool)) targets.push(...pathTargets("Read", filePath));
  }
  if (tool === "search" && typeof input.query === "string") targets.push(`Grep(${input.query})`);
  if (requirement.approvalKey) targets.push(requirement.approvalKey);
  if (requirement.allowAlwaysKey) targets.push(requirement.allowAlwaysKey);
  if (requirement.scope) targets.push(`${tool}:${requirement.scope}`, `${tool}(${requirement.scope})`);
  return Array.from(new Set(targets));
}

function claudeToolAliases(tool: string, filePath?: string): string[] {
  if (tool === "run_command") return ["Bash"];
  if (tool === "read_file" || tool === "read_many_files" || tool === "show_file_outline") return ["Read"];
  if (tool === "search") return filePath ? ["Grep", "Read"] : ["Grep"];
  if (tool === "list_files" || tool === "read_tree") return ["LS", "Read"];
  if (tool === "write_file" || tool === "create_file") return ["Write"];
  if (tool === "replace_text") return ["Edit"];
  if (tool === "apply_patch") return ["Edit", "Write"];
  if (tool === "todo_write") return ["TodoWrite"];
  return [];
}

function inputPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (typeof input.path === "string") paths.push(input.path);
  if (Array.isArray(input.paths)) {
    for (const item of input.paths) {
      if (typeof item === "string") paths.push(item);
    }
  }
  return paths;
}

function pathTargets(tool: string, filePath: string): string[] {
  const normalized = normalizePermissionPath(filePath);
  const variants = new Set([filePath, normalized]);
  if (!normalized.startsWith("./") && !path.isAbsolute(normalized) && !normalized.startsWith("~")) variants.add(`./${normalized}`);
  return Array.from(variants).flatMap((variant) => [`${tool}:${variant}`, `${tool}(${variant})`, `${tool}(*)`]);
}

function normalizePermissionPath(filePath: string): string {
  return filePath.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function isReadLikeTool(tool: string): boolean {
  return ["read_file", "read_many_files", "show_file_outline", "search", "list_files", "read_tree", "git_diff", "git_status", "list_changed_files"].includes(tool);
}

function bashColonTarget(command: string): string | undefined {
  const [first, second, ...rest] = command.split(/\s+/);
  if (!first) return undefined;
  const prefix = second ? `${first} ${second}` : first;
  const suffix = rest.join(" ");
  return `Bash(${prefix}:${suffix})`;
}

function matchesPattern(pattern: string, target: string): boolean {
  if (pattern === "*" || pattern === target) return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(target);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
