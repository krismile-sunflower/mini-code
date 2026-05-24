import type { AgentDecision, TodoStatus, ToolDefinition } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

export function parseDecision(raw: string, tools?: Map<string, ToolDefinition>): AgentDecision {
  const trimmed = raw.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const firstBrace = withoutFence.indexOf("{");
  const lastBrace = withoutFence.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error(`Model did not return JSON: ${raw}`);
  }
  const parsed = JSON.parse(withoutFence.slice(firstBrace, lastBrace + 1)) as unknown;
  if (!isPlainObject(parsed)) throw new Error("Model decision must be a JSON object.");
  if (parsed.action !== "plan" && parsed.action !== "tool" && parsed.action !== "final") {
    throw new Error(`Invalid action: ${String(parsed.action)}`);
  }
  if (parsed.input !== undefined && !isPlainObject(parsed.input)) {
    throw new Error("Decision input must be an object when provided.");
  }
  if (parsed.action === "plan") validatePlanDecision(parsed);
  if (parsed.action === "tool") {
    if (typeof parsed.tool !== "string" || parsed.tool.trim() === "") throw new Error("Tool decision omitted tool name.");
    if (tools && !tools.has(parsed.tool)) throw new Error(`Unknown tool: ${parsed.tool}`);
  }
  if (parsed.action === "final" && typeof parsed.answer !== "string") {
    throw new Error("Final decision omitted string answer.");
  }
  return parsed as unknown as AgentDecision;
}

function validatePlanDecision(parsed: Record<string, unknown>): void {
  if (!Array.isArray(parsed.todos) || parsed.todos.length === 0) {
    throw new Error("Plan decision requires a non-empty todos array.");
  }
  for (const todo of parsed.todos) {
    if (!isPlainObject(todo)) throw new Error("Each plan todo must be an object.");
    if (typeof todo.content !== "string" || todo.content.trim() === "") throw new Error("Each plan todo requires content.");
    if (todo.status !== undefined && !isTodoStatus(todo.status)) throw new Error(`Invalid todo status: ${String(todo.status)}`);
  }
}
