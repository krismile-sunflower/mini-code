import path from "node:path";
import type { ToolDefinition } from "../../core/types.js";
import { createProjectSkill } from "../../core/skills.js";
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
    }
  ];
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}
