import type { ToolRisk } from "../core/types.js";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  risk?: ToolRisk;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  risk: ToolRisk;
}

export interface McpResourceInfo {
  server: string;
  uri: string;
  name?: string;
  description?: string;
}

export interface McpPromptInfo {
  server: string;
  name: string;
  description?: string;
}
