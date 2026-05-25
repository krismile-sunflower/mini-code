import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { McpConfig, McpServerConfig } from "./types.js";

export function defaultMcpConfigPath(cwd: string): string {
  return path.join(cwd, ".mini-code", "mcp.json");
}

export function loadMcpConfig(cwd: string, configuredPath?: string): McpConfig {
  const filePath = configuredPath ? path.resolve(cwd, configuredPath) : defaultMcpConfigPath(cwd);
  if (!existsSync(filePath)) return { mcpServers: {} };
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (!isObject(parsed)) throw new Error(`Invalid MCP config: ${filePath}`);
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (!isObject(servers)) return { mcpServers: {} };
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(servers)) {
    if (!isObject(raw)) continue;
    const command = raw.command;
    if (typeof command !== "string" || !command.trim()) continue;
    mcpServers[name] = {
      command,
      args: Array.isArray(raw.args) ? raw.args.filter((item): item is string => typeof item === "string") : [],
      env: isStringMap(raw.env) ? raw.env : {},
      risk: raw.risk === "read" || raw.risk === "write" || raw.risk === "shell" || raw.risk === "dangerous" ? raw.risk : "shell"
    };
  }
  return { mcpServers };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((item) => typeof item === "string");
}
