import path from "node:path";
import type { ToolDefinition } from "../../core/types.js";
import { createProjectSkill } from "../../core/skills.js";
import { createProjectSubagent } from "../../core/subagents.js";
import { writeApproval } from "../permissions.js";
import { requireString, validateToolInput, workspacePath, type BuiltinToolContext } from "./common.js";

export function createSkillTools(context: BuiltinToolContext): ToolDefinition[] {
  const { cwd } = context;
  return [
    {
      name: "create_skill",
      description: "Create a project-local Mini Code skill under .mini-code/skills/<name>/SKILL.md and make it discoverable.",
      inputSchema: {
        name: "Required skill name. It will be normalized to lowercase hyphen-case.",
        description: "Optional concise trigger description for when the skill should be used.",
        instructions: "Optional markdown instructions to include in the skill body."
      },
      risk: "write",
      describe(input) {
        return `Create project skill ${String(input.name ?? "")}`;
      },
      requiresApproval(input, approvalContext) {
        const name = typeof input.name === "string" ? normalizeName(input.name) : "skill";
        return writeApproval("create_skill", `.mini-code/skills/${name}/SKILL.md`, approvalContext);
      },
      validate(input) {
        return validateToolInput("create_skill", input);
      },
      async run(input) {
        const name = requireString(input, "name");
        const description = typeof input.description === "string" ? input.description : "";
        const instructions = typeof input.instructions === "string" ? input.instructions : "";
        const created = await createProjectSkill(cwd, name, description, { instructions });
        const relativePath = workspacePath(cwd, created.path);
        return {
          ok: true,
          output: [
            `Created skill ${created.name}`,
            `path: ${relativePath}`,
            `description: ${created.description}`,
            "Skill index was refreshed for the current session."
          ].join("\n"),
          metadata: {
            path: relativePath,
            touchedPaths: [relativePath],
            skillName: created.name,
            description: created.description,
            skillRoot: path.posix.dirname(relativePath)
          }
        };
      }
    },
    {
      name: "create_subagent",
      description: "Create a project-local Mini Code subagent under .mini-code/agents/<name>.md and make it discoverable.",
      inputSchema: {
        name: "Required subagent name. It will be normalized to lowercase hyphen-case.",
        description: "Optional concise description for when the subagent should be used.",
        instructions: "Optional markdown instructions to include in the subagent body.",
        tools: "Optional array of Claude-style tool names to declare in frontmatter."
      },
      risk: "write",
      describe(input) {
        return `Create project subagent ${String(input.name ?? "")}`;
      },
      requiresApproval(input, approvalContext) {
        const name = typeof input.name === "string" ? normalizeName(input.name) : "agent";
        return writeApproval("create_subagent", `.mini-code/agents/${name}.md`, approvalContext);
      },
      validate(input) {
        return validateToolInput("create_subagent", input);
      },
      async run(input) {
        const name = requireString(input, "name");
        const description = typeof input.description === "string" ? input.description : "";
        const instructions = typeof input.instructions === "string" ? input.instructions : "";
        const tools = Array.isArray(input.tools) ? input.tools.filter((tool): tool is string => typeof tool === "string") : [];
        const created = await createProjectSubagent(cwd, name, description, { instructions, tools });
        const relativePath = workspacePath(cwd, created.path);
        return {
          ok: true,
          output: [
            `Created subagent ${created.name}`,
            `path: ${relativePath}`,
            `description: ${created.description}`,
            created.tools.length ? `tools: ${created.tools.join(", ")}` : "tools: [inherit]",
            "Subagent index was refreshed for the current session."
          ].join("\n"),
          metadata: {
            path: relativePath,
            touchedPaths: [relativePath],
            subagentName: created.name,
            description: created.description,
            subagentRoot: path.posix.dirname(relativePath)
          }
        };
      }
    }
  ];
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}
