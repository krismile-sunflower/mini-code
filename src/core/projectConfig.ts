import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type ProjectConfigValue = string | number | boolean | string[];
export type ProjectConfig = Record<string, ProjectConfigValue>;

const schema: Record<string, "string" | "number" | "boolean" | "string[]"> = {
  provider: "string",
  model: "string",
  planModel: "string",
  baseUrl: "string",
  permissionMode: "string",
  toolsPolicy: "string",
  toolProtocol: "string",
  agentDir: "string",
  sessionDir: "string",
  mcpConfigPath: "string",
  maxTurns: "number",
  maxContextMessages: "number",
  maxToolOutputChars: "number",
  outputStyle: "string",
  enableSkills: "boolean",
  enableSkillHelpers: "boolean",
  enableMcp: "boolean",
  skills: "string[]",
  featureFlags: "string[]"
};

export function projectConfigPath(cwd: string): string {
  return path.join(cwd, ".mini-code", "config.json");
}

export function configurableKeys(): string[] {
  return Object.keys(schema).sort();
}

export function readProjectConfig(cwd: string): ProjectConfig {
  const filePath = projectConfigPath(cwd);
  if (!existsSync(filePath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!isRecord(parsed)) return {};
    const config: ProjectConfig = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!schema[key]) continue;
      const normalized = normalizeValue(key, value);
      if (normalized !== undefined) config[key] = normalized;
    }
    return config;
  } catch {
    return {};
  }
}

export async function writeProjectConfig(cwd: string, config: ProjectConfig): Promise<string> {
  const filePath = projectConfigPath(cwd);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(sortConfig(config), null, 2)}\n`, "utf8");
  return filePath;
}

export async function setProjectConfigValue(cwd: string, key: string, rawValue: string): Promise<{ path: string; key: string; value: ProjectConfigValue }> {
  if (!schema[key]) throw new Error(`Unsupported config key: ${key}. Supported keys: ${configurableKeys().join(", ")}`);
  const value = parseConfigValue(key, rawValue);
  const config = readProjectConfig(cwd);
  config[key] = value;
  const filePath = await writeProjectConfig(cwd, config);
  return { path: filePath, key, value };
}

export async function unsetProjectConfigValue(cwd: string, key: string): Promise<{ path: string; key: string; existed: boolean }> {
  if (!schema[key]) throw new Error(`Unsupported config key: ${key}. Supported keys: ${configurableKeys().join(", ")}`);
  const config = readProjectConfig(cwd);
  const existed = Object.prototype.hasOwnProperty.call(config, key);
  delete config[key];
  const filePath = await writeProjectConfig(cwd, config);
  return { path: filePath, key, existed };
}

export function renderProjectConfig(cwd: string): string {
  const config = readProjectConfig(cwd);
  const rows = Object.entries(config).map(([key, value]) => `${key}=${formatConfigValue(value)}`);
  return rows.length ? rows.join("\n") : "Project config is empty.";
}

export function getProjectConfigValue(cwd: string, key: string): ProjectConfigValue | undefined {
  if (!schema[key]) throw new Error(`Unsupported config key: ${key}. Supported keys: ${configurableKeys().join(", ")}`);
  return readProjectConfig(cwd)[key];
}

export function formatConfigValue(value: ProjectConfigValue): string {
  return Array.isArray(value) ? value.join(",") : String(value);
}

function parseConfigValue(key: string, rawValue: string): ProjectConfigValue {
  const kind = schema[key];
  const value = rawValue.trim();
  if (kind === "boolean") {
    if (/^(true|1|yes|on)$/i.test(value)) return true;
    if (/^(false|0|no|off)$/i.test(value)) return false;
    throw new Error(`Config key ${key} expects a boolean value.`);
  }
  if (kind === "number") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`Config key ${key} expects a number.`);
    return parsed;
  }
  if (kind === "string[]") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  validateStringChoice(key, value);
  return value;
}

function normalizeValue(key: string, value: unknown): ProjectConfigValue | undefined {
  const kind = schema[key];
  if (kind === "boolean") return typeof value === "boolean" ? value : undefined;
  if (kind === "number") return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  if (kind === "string[]") return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function validateStringChoice(key: string, value: string): void {
  const choices: Record<string, string[]> = {
    provider: ["openai", "anthropic"],
    permissionMode: ["default", "accept_edits", "bypass_permissions", "risk-based"],
    toolsPolicy: ["default", "read_only"],
    toolProtocol: ["json", "native"]
  };
  const allowed = choices[key];
  if (allowed && !allowed.includes(value)) throw new Error(`Config key ${key} expects one of: ${allowed.join(", ")}`);
}

function sortConfig(config: ProjectConfig): ProjectConfig {
  return Object.fromEntries(Object.entries(config).sort(([a], [b]) => a.localeCompare(b)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
