import type { ToolDefinition } from "../../core/types.js";
import { shellApproval } from "../permissions.js";
import { clip, execAsync, requireString, validateToolInput, type BuiltinToolContext } from "./common.js";

export function createShellTools(context: BuiltinToolContext): ToolDefinition[] {
  const { cwd, maxOutputChars, allowDangerousCommands } = context;
  return [
    {
      name: "run_command",
      description: "Run a shell command in the workspace. Always asks for approval in risk-based mode.",
      inputSchema: { command: "Required shell command.", timeoutMs: "Optional timeout in milliseconds." },
      risk: "shell",
      describe(input) {
        return `Run command: ${String(input.command)}`;
      },
      requiresApproval(input, approvalContext) {
        return shellApproval(requireString(input, "command"), approvalContext, allowDangerousCommands);
      },
      validate(input) {
        return validateToolInput("run_command", input);
      },
      async run(input) {
        const command = normalizeShellCommand(requireString(input, "command"));
        const timeout = typeof input.timeoutMs === "number" ? input.timeoutMs : 30_000;
        try {
          const { stdout, stderr } = await execAsync(command, { cwd, timeout });
          return { ok: true, output: clip([stdout, stderr].filter(Boolean).join("\n") || "[command completed]", maxOutputChars).output, metadata: { command, exitCode: 0 } };
        } catch (error) {
          const maybe = error as { code?: number | string; stdout?: string; stderr?: string; signal?: string; killed?: boolean; message?: string };
          return {
            ok: false,
            output: clip(formatExecError(maybe), maxOutputChars).output,
            errorType: "runtime",
            metadata: { command, exitCode: typeof maybe.code === "number" ? maybe.code : String(maybe.code ?? "unknown") }
          };
        }
      }
    }
  ];
}

function normalizeShellCommand(command: string): string {
  if (!/^node(?:\s|$)/.test(command.trim())) return command;
  return command.replace(/^node\b/, JSON.stringify(process.execPath));
}

function formatExecError(error: { stdout?: string; stderr?: string; code?: number | string; signal?: string; killed?: boolean; message?: string }): string {
  const parts = [
    error.killed ? "timed out" : undefined,
    error.code !== undefined ? `exit code: ${String(error.code)}` : undefined,
    error.signal ? `signal: ${error.signal}` : undefined,
    error.stdout ? `stdout:\n${error.stdout}` : undefined,
    error.stderr ? `stderr:\n${error.stderr}` : undefined,
    error.message ? `error: ${error.message}` : undefined
  ].filter(Boolean);
  return parts.join("\n") || "Command failed.";
}
