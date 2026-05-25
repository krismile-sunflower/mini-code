import type { CapabilityDescriptor, ToolDefinition, ToolsPolicy } from "../core/types.js";
import { renderCapabilityList } from "../core/capabilities.js";

export interface RegisteredTool {
  tool: ToolDefinition;
  capability: CapabilityDescriptor;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: ToolDefinition, capability?: Partial<CapabilityDescriptor>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, {
      tool,
      capability: {
        id: capability?.id ?? `builtin:${tool.name}`,
        kind: capability?.kind ?? "builtin_tool",
        name: capability?.name ?? tool.name,
        namespace: capability?.namespace,
        description: capability?.description ?? tool.description,
        inputSchema: capability?.inputSchema ?? tool.inputSchema,
        risk: capability?.risk ?? tool.risk,
        source: capability?.source ?? "builtin",
        tags: capability?.tags
      }
    });
  }

  registerMany(tools: ToolDefinition[], source = "builtin"): void {
    for (const tool of tools) {
      this.register(tool, { source });
    }
  }

  list(policy: ToolsPolicy = "default"): ToolDefinition[] {
    const tools = Array.from(this.tools.values()).map((entry) => entry.tool);
    if (policy === "read_only") return tools.filter((tool) => tool.risk === "read");
    return tools;
  }

  capabilities(policy: ToolsPolicy = "default"): CapabilityDescriptor[] {
    const allowed = new Set(this.list(policy).map((tool) => tool.name));
    return Array.from(this.tools.values())
      .filter((entry) => allowed.has(entry.tool.name))
      .map((entry) => entry.capability);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.tool;
  }

  capabilityForTool(name: string): CapabilityDescriptor | undefined {
    return this.tools.get(name)?.capability;
  }

  describeTools(policy: ToolsPolicy = "default"): string {
    return renderCapabilityList(this.capabilities(policy), "tools");
  }
}
