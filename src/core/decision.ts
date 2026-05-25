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
  const jsonText = firstJsonObject(withoutFence);
  if (!jsonText) {
    throw new Error(`Model did not return JSON: ${raw}`);
  }
  const parsed = normalizeDecisionObject(JSON.parse(jsonText) as unknown);
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

function normalizeDecisionObject(parsed: unknown): unknown {
  if (!isPlainObject(parsed)) return parsed;
  if (parsed.action === undefined && typeof parsed.answer === "string") {
    return { ...parsed, action: "final" };
  }
  return parsed;
}

function firstJsonObject(value: string): string | undefined {
  const start = value.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return undefined;
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
