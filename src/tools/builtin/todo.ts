import type { TaskTodo, ToolDefinition } from "../../core/types.js";
import { readApproval } from "../permissions.js";

export function createTodoTools(): ToolDefinition[] {
  return [
    {
      name: "todo_write",
      description: "Update the task todo list. Call this to track progress on multi-step tasks. Replaces the current todo list with the provided items.",
      inputSchema: {
        todos: "Required array of todo objects with id (string), content (string), and status ('pending'|'in_progress'|'completed')."
      },
      risk: "read",
      describe(input) {
        const count = Array.isArray(input.todos) ? (input.todos as unknown[]).length : 0;
        return `Update todo list (${count} item${count === 1 ? "" : "s"})`;
      },
      requiresApproval: readApproval,
      validate(input) {
        if (!Array.isArray(input.todos)) {
          return { ok: false, output: "todo_write requires a 'todos' array.", errorType: "validation" };
        }
        for (const item of input.todos as unknown[]) {
          if (typeof item !== "object" || item === null) {
            return { ok: false, output: "Each todo must be an object.", errorType: "validation" };
          }
          const todo = item as Record<string, unknown>;
          if (typeof todo.id !== "string" || typeof todo.content !== "string") {
            return { ok: false, output: "Each todo must have a string 'id' and 'content'.", errorType: "validation" };
          }
          if (!["pending", "in_progress", "completed"].includes(todo.status as string)) {
            return { ok: false, output: `Invalid todo status: ${String(todo.status)}. Must be pending, in_progress, or completed.`, errorType: "validation" };
          }
        }
        return undefined;
      },
      async run(input) {
        const todos = input.todos as Array<{ id: string; content: string; status: TaskTodo["status"] }>;
        const summary = todos.map((t) => `[${t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " "}] ${t.content}`).join("\n");
        return { ok: true, output: `Todo list updated:\n${summary}`, metadata: { count: todos.length } };
      }
    }
  ];
}
