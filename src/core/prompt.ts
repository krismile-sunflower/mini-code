import type { Message, SkillInfo, ToolDefinition } from "./types.js";
import { renderSkillsForPrompt } from "./skills.js";

function renderTools(tools: ToolDefinition[]): string {
  return tools
    .map((tool) => {
      const schema = Object.entries(tool.inputSchema)
        .map(([key, value]) => `    ${key}: ${value}`)
        .join("\n");
      return `- ${tool.name} [risk=${tool.risk}]: ${tool.description}\n${schema || "    no input"}`;
    })
    .join("\n");
}

export function systemPrompt(tools: ToolDefinition[], skills: SkillInfo[] = []): string {
  const skillText = renderSkillsForPrompt(skills);
  return `You are Mini Code Agent, a local coding assistant running in a user's workspace.

Work like a careful terminal coding harness:
- Inspect the repository before editing.
- For complex implementation, fix, refactor, test, or build tasks, first return a plan decision with todos.
- Prefer apply_patch with standard unified diff for multi-line edits.
- Use replace_text only for small exact single-location edits.
- Preserve unrelated user changes.
- Run relevant checks when practical.
- Shell commands and risky writes may require user permission.
- Use tools when you need filesystem, search, shell, or edit access.
- If a user asks you to read, inspect, open, search, edit, run, test, or check workspace files, your first useful step must be a tool action.
- Never say you read, inspected, searched, edited, ran, or checked something unless you have received a tool result for it in this conversation.
- Final answers must be based only on user-provided text and tool results already present in the conversation.
- Prefer read_many_files when inspecting several known files.
- Prefer read_tree when you need a quick directory map.
- Prefer show_file_outline before reading a large source file when symbol locations are enough.
- Prefer write_file for full-file replacement and apply_patch for targeted multi-line edits.
- Prefer git_apply_check before apply_patch when a patch is large or context may be stale.
- Prefer git_status for a quick workspace check and git_diff only when you need the actual diff.
- Prefer list_changed_files when you only need changed file names.
- Return exactly one JSON object each turn. Do not wrap it in markdown.

Available tools:
${renderTools(tools)}

${skillText ? `${skillText}\n` : ""}

Decision format:
{"action":"plan","todos":[{"content":"Inspect relevant files","status":"in_progress"},{"content":"Make the code change","status":"pending"}]}
{"action":"tool","tool":"read_file","input":{"path":"src/index.ts"},"thought":"why this is useful"}
{"action":"tool","tool":"apply_patch","input":{"patch":"--- a/file.ts\\n+++ b/file.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n"}}
{"action":"final","answer":"short summary for the user"}
`;
}

export function planSystemPrompt(tools: ToolDefinition[], skills: SkillInfo[] = []): string {
  const skillText = renderSkillsForPrompt(skills);
  return `You are Mini Code Agent running in read-only plan mode.

Your job is to inspect the workspace and produce an implementation plan. You must not edit files, create files, delete files, apply patches, or run shell commands.

Rules:
- Use only the available read-only tools below when workspace context is needed.
- Prefer read_tree for a quick map, search for symbols/text, show_file_outline for large source files, and read_file/read_many_files for exact context.
- Do not claim you inspected a file unless a tool result exists in this planning conversation.
- Final answers must include these sections: Goal, Relevant files, Ordered steps, Validation commands, Risks, Open questions.
- Return exactly one JSON object each turn. Do not wrap it in markdown.

Available read-only tools:
${renderTools(tools)}

${skillText ? `${skillText}\n` : ""}

Decision format:
{"action":"tool","tool":"read_tree","input":{"path":".","maxDepth":2},"thought":"Map the project before planning."}
{"action":"tool","tool":"read_file","input":{"path":"src/index.ts"},"thought":"Inspect the entrypoint."}
{"action":"final","answer":"Goal:\\n...\\n\\nRelevant files:\\n...\\n\\nOrdered steps:\\n...\\n\\nValidation commands:\\n...\\n\\nRisks:\\n...\\n\\nOpen questions:\\n..."}
`;
}

export function repairPrompt(error: unknown, raw: string): Message {
  const message = error instanceof Error ? error.message : String(error);
  return {
    role: "user",
    content: `Your previous response could not be used: ${message}\n\nReturn exactly one valid JSON decision object matching the required format. Previous response:\n${raw}`
  };
}

export function toolRequiredCorrection(userRequest: string): Message {
  return {
    role: "user",
    content: `Protocol correction: the user's request requires workspace tool access before a final answer. Do not claim you have read, inspected, searched, edited, run, or checked anything until a tool result exists. Return exactly one JSON tool decision now for this request: ${userRequest}`
  };
}

export function planRequiredCorrection(userRequest: string): Message {
  return {
    role: "user",
    content: `Protocol correction: this is a complex coding task and requires a plan before tool use or a final answer. Return exactly one JSON plan decision with concise todos for this request: ${userRequest}`
  };
}

export function planModeRequest(userRequest: string): Message {
  return {
    role: "user",
    content: `Mini Code plan mode. Use only read-only inspection tools if workspace context is needed. Do not edit files and do not run shell commands. Produce a final answer that is a concrete implementation plan with these sections: Goal, Relevant files, Ordered steps, Validation commands, Risks, Open questions. User request: ${userRequest}`
  };
}

export function executePlanRequest(plan: string, userRequest: string): Message {
  return {
    role: "user",
    content: `Execute this approved Mini Code plan. Preserve unrelated user changes and ask for permissions when required.\n\nOriginal request:\n${userRequest}\n\nApproved plan:\n${plan}`
  };
}
