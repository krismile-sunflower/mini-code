import type { ToolMetadata, ToolResult } from "../core/types.js";

export interface FieldRule {
  type: "string" | "string[]" | "number";
  required?: boolean;
}

export type ToolRules = Record<string, FieldRule>;

export function validateInput(tool: string, input: Record<string, unknown>, rules: ToolRules): ToolResult | undefined {
  for (const [field, rule] of Object.entries(rules)) {
    const value = input[field];
    if (value === undefined || value === null || value === "") {
      if (rule.required) return validationError(tool, field, rule, value);
      continue;
    }
    if (rule.type === "string" && typeof value !== "string") return validationError(tool, field, rule, value);
    if (rule.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return validationError(tool, field, rule, value);
    if (rule.type === "string[]" && (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === ""))) {
      return validationError(tool, field, rule, value);
    }
  }
  return undefined;
}

function validationError(tool: string, field: string, rule: FieldRule, value: unknown): ToolResult {
  const metadata: ToolMetadata = {
    tool,
    field,
    expected: rule.required ? `required ${rule.type}` : rule.type,
    received: Array.isArray(value) ? "array" : typeof value
  };
  return {
    ok: false,
    output: `Tool input validation failed for ${tool}.${field}: expected ${metadata.expected}, received ${metadata.received}.`,
    errorType: "validation",
    metadata
  };
}
