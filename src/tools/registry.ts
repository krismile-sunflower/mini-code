import type { ToolDefinition } from "../core/types.js";
import { renderCapabilityList } from "../core/capabilities.js";
import { loadMcpConfig } from "../mcp/config.js";
import { McpManager } from "../mcp/manager.js";
import { createMcpResourceTools, createMcpToolDefinitions } from "../mcp/tools.js";
import { createBuiltinTools } from "./builtin/index.js";
import { readApproval } from "./permissions.js";
import { validateInput } from "./validation.js";
import { ToolRegistry } from "./toolRegistry.js";

function capabilityTools(registry: ToolRegistry): ToolDefinition[] {
  return [
    {
      name: "list_capabilities",
      description: "List available capabilities from built-in tools, MCP servers, and skills.",
      inputSchema: {},
      risk: "read",
      describe() {
        return "List capabilities";
      },
      requiresApproval: readApproval,
      validate() {
        return undefined;
      },
      async run() {
        const capabilities = registry.capabilities();
        return { ok: true, output: renderCapabilityList(capabilities), metadata: { count: capabilities.length, source: "builtin" } };
      }
    },
    {
      name: "describe_capability",
      description: "Describe one capability by id or name.",
      inputSchema: { id: "Optional capability id.", name: "Optional capability name." },
      risk: "read",
      describe(input) {
        return `Describe capability ${String(input.id ?? input.name ?? "")}`;
      },
      requiresApproval: readApproval,
      validate(input) {
        if (typeof input.id !== "string" && typeof input.name !== "string") {
          return { ok: false, output: "describe_capability requires id or name.", errorType: "validation" };
        }
        return validateInput("describe_capability", input, { id: { type: "string" }, name: { type: "string" } });
      },
      async run(input) {
        const id = typeof input.id === "string" ? input.id : undefined;
        const name = typeof input.name === "string" ? input.name : undefined;
        const capability = registry.capabilities().find((item) => item.id === id || item.name === name);
        if (!capability) return { ok: false, output: `Capability not found: ${id ?? name}`, errorType: "runtime" };
        return { ok: true, output: JSON.stringify(capability, null, 2), metadata: { source: "builtin", capabilityId: capability.id } };
      }
    }
  ];
}

export function createToolRegistry(cwd: string, maxOutputChars: number, allowDangerousCommands = false): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerMany(createBuiltinTools(cwd, maxOutputChars, allowDangerousCommands));
  registry.registerMany(capabilityTools(registry));
  return registry;
}

export async function createToolRegistryWithMcp(cwd: string, maxOutputChars: number, allowDangerousCommands = false, mcpConfigPath?: string): Promise<{ registry: ToolRegistry; mcpManager?: McpManager }> {
  const registry = createToolRegistry(cwd, maxOutputChars, allowDangerousCommands);
  const mcpConfig = loadMcpConfig(cwd, mcpConfigPath);
  if (Object.keys(mcpConfig.mcpServers).length === 0) return { registry };
  const mcpManager = new McpManager(mcpConfig, cwd);
  const mcpTools = await mcpManager.listTools();
  for (const tool of createMcpToolDefinitions(mcpManager, mcpTools)) {
    const [, server, name] = tool.name.split(":");
    registry.register(tool, { id: tool.name, kind: "mcp_tool", source: `mcp:${server}`, namespace: server, name, risk: tool.risk });
  }
  for (const tool of createMcpResourceTools(mcpManager)) {
    registry.register(tool, { id: tool.name, kind: "mcp_resource", source: "mcp", risk: tool.risk });
  }
  return { registry, mcpManager };
}

export function createTools(cwd: string, maxOutputChars: number, allowDangerousCommands = false): ToolDefinition[] {
  return createToolRegistry(cwd, maxOutputChars, allowDangerousCommands).list();
}

export { createBuiltinTools };
