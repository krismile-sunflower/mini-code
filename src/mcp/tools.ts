import type { ToolDefinition } from "../core/types.js";
import { readApproval } from "../tools/permissions.js";
import type { McpManager } from "./manager.js";
import type { McpToolInfo } from "./types.js";

export function mcpToolName(server: string, tool: string): string {
  return `mcp:${server}:${tool}`;
}

export function createMcpToolDefinitions(manager: McpManager, tools: McpToolInfo[]): ToolDefinition[] {
  return tools.map((tool): ToolDefinition => ({
    name: mcpToolName(tool.server, tool.name),
    description: tool.description || `MCP tool ${tool.server}/${tool.name}`,
    inputSchema: schemaToDisplay(tool.inputSchema),
    risk: tool.risk,
    describe() {
      return `Call MCP tool ${tool.server}/${tool.name}`;
    },
    requiresApproval() {
      if (tool.risk === "read") return readApproval();
      return { required: true, risk: tool.risk, reason: `MCP tool requires approval: ${tool.server}/${tool.name}`, scope: `${tool.server}/${tool.name}`, riskReason: "MCP tool risk is configured as non-read.", rememberable: false };
    },
    validate() {
      return undefined;
    },
    async run(input) {
      const result = await manager.callTool(tool.server, tool.name, input);
      return { ok: true, output: renderMcpResult(result), metadata: { source: `mcp:${tool.server}`, mcpServer: tool.server, mcpTool: tool.name } };
    }
  }));
}

export function createMcpResourceTools(manager: McpManager): ToolDefinition[] {
  return [
    {
      name: "mcp_list_resources",
      description: "List resources exposed by configured MCP servers.",
      inputSchema: {},
      risk: "read",
      describe() {
        return "List MCP resources";
      },
      requiresApproval: readApproval,
      validate() {
        return undefined;
      },
      async run() {
        const resources = await manager.listResources();
        return { ok: true, output: resources.map((item) => `${item.server}\t${item.uri}\t${item.name ?? ""}\t${item.description ?? ""}`).join("\n") || "[no MCP resources]", metadata: { source: "mcp", count: resources.length } };
      }
    },
    {
      name: "mcp_read_resource",
      description: "Read one MCP resource by server and URI.",
      inputSchema: { server: "Required MCP server name.", uri: "Required resource URI." },
      risk: "read",
      describe(input) {
        return `Read MCP resource ${String(input.server)}/${String(input.uri)}`;
      },
      requiresApproval: readApproval,
      validate(input) {
        if (typeof input.server !== "string" || typeof input.uri !== "string") return { ok: false, output: "mcp_read_resource requires server and uri.", errorType: "validation" };
        return undefined;
      },
      async run(input) {
        const result = await manager.readResource(String(input.server), String(input.uri));
        return { ok: true, output: renderMcpResult(result), metadata: { source: `mcp:${String(input.server)}` } };
      }
    },
    {
      name: "mcp_list_prompts",
      description: "List prompts exposed by configured MCP servers.",
      inputSchema: {},
      risk: "read",
      describe() {
        return "List MCP prompts";
      },
      requiresApproval: readApproval,
      validate() {
        return undefined;
      },
      async run() {
        const prompts = await manager.listPrompts();
        return { ok: true, output: prompts.map((item) => `${item.server}\t${item.name}\t${item.description ?? ""}`).join("\n") || "[no MCP prompts]", metadata: { source: "mcp", count: prompts.length } };
      }
    },
    {
      name: "mcp_get_prompt",
      description: "Get one MCP prompt by server and name.",
      inputSchema: { server: "Required MCP server name.", name: "Required prompt name.", arguments: "Optional prompt arguments object." },
      risk: "read",
      describe(input) {
        return `Get MCP prompt ${String(input.server)}/${String(input.name)}`;
      },
      requiresApproval: readApproval,
      validate(input) {
        if (typeof input.server !== "string" || typeof input.name !== "string") return { ok: false, output: "mcp_get_prompt requires server and name.", errorType: "validation" };
        return undefined;
      },
      async run(input) {
        const args = typeof input.arguments === "object" && input.arguments !== null && !Array.isArray(input.arguments) ? input.arguments as Record<string, unknown> : {};
        const result = await manager.getPrompt(String(input.server), String(input.name), args);
        return { ok: true, output: renderMcpResult(result), metadata: { source: `mcp:${String(input.server)}` } };
      }
    }
  ];
}

function schemaToDisplay(schema: Record<string, unknown> | undefined): Record<string, string> {
  const properties = schema?.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return {};
  return Object.fromEntries(Object.keys(properties).map((key) => [key, "MCP tool input."]));
}

function renderMcpResult(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}
