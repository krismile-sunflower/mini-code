import type { ToolDefinition } from "../../core/types.js";
import { createEditTools } from "./edit.js";
import { createFileTools } from "./files.js";
import { createGitTools } from "./git.js";
import { createShellTools } from "./shell.js";
import { createSkillTools } from "./skills.js";
import { createTodoTools } from "./todo.js";
import { finalizeBuiltinTools, type BuiltinToolContext } from "./common.js";

export function createBuiltinTools(cwd: string, maxOutputChars: number, allowDangerousCommands = false): ToolDefinition[] {
  const context: BuiltinToolContext = { cwd, maxOutputChars, allowDangerousCommands };
  return finalizeBuiltinTools([
    ...createFileTools(context),
    ...createEditTools(context),
    ...createShellTools(context),
    ...createGitTools(context),
    ...createSkillTools(context),
    ...createTodoTools()
  ]);
}
