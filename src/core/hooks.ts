import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { settingsFiles } from "./settings.js";
import { isDangerousCommand } from "../tools/permissions.js";
import type { ToolResult } from "./types.js";

export type HookEvent = "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "SessionStart" | "Stop" | "SubagentStop" | "PreCompact" | "Notification";

export interface HookCommand {
  type: "command";
  command: string;
  timeoutMs: number;
}

export interface HookRule {
  matcher: string;
  hooks: HookCommand[];
  source: string;
}

export interface HookConfig {
  PreToolUse: HookRule[];
  PostToolUse: HookRule[];
  UserPromptSubmit: HookRule[];
  SessionStart: HookRule[];
  Stop: HookRule[];
  SubagentStop?: HookRule[];
  PreCompact: HookRule[];
  Notification: HookRule[];
}

export interface HookRow {
  event: HookEvent;
  matcher: string;
  command: string;
  timeoutMs: number;
  source: string;
}

export interface HookRunContext {
  cwd: string;
  event: HookEvent;
  tool?: string;
  input?: Record<string, unknown>;
  prompt?: string;
  finalAnswer?: string;
  subagentName?: string;
  trigger?: "manual" | "auto";
  notification?: {
    message: string;
    title?: string;
    type: string;
  };
  sessionId?: string;
  source?: "startup" | "resume";
  matcherTarget?: string;
  result?: ToolResult;
  maxOutputChars: number;
  allowDangerousCommands: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function loadHookConfig(cwd: string, includeGlobal = true, homeDir?: string): Promise<HookConfig> {
  const config: HookConfig = { PreToolUse: [], PostToolUse: [], UserPromptSubmit: [], SessionStart: [], Stop: [], SubagentStop: [], PreCompact: [], Notification: [] };
  for (const filePath of settingsFiles(cwd, includeGlobal, homeDir)) {
    if (!existsSync(filePath)) continue;
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    mergeHookSettings(config, parsed, filePath);
  }

  return config;
}

export function matchingHooks(config: HookConfig, event: HookEvent, tool: string): HookRule[] {
  if (event === "UserPromptSubmit" || event === "Stop") return config[event];
  const rules = config[event] ?? [];
  const names = toolMatcherNames(tool);
  return rules.filter((rule) => names.some((name) => matchesHookMatcher(rule.matcher, name)));
}

export function hookRows(config: HookConfig): HookRow[] {
  return (["PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart", "Stop", "SubagentStop", "PreCompact", "Notification"] as const).flatMap((event) =>
    (config[event] ?? []).flatMap((rule) =>
      rule.hooks.map((hook) => ({
        event,
        matcher: rule.matcher,
        command: hook.command,
        timeoutMs: hook.timeoutMs,
        source: rule.source
      }))
    )
  );
}

export async function runHookEvent(config: HookConfig, context: HookRunContext): Promise<ToolResult> {
  const target = context.tool ?? context.matcherTarget ?? context.event;
  const rules = matchingHooks(config, context.event, target);
  const outputs: string[] = [];
  let hookDecision: "approve" | undefined;

  for (const rule of rules) {
    for (const hook of rule.hooks) {
      if (isDangerousCommand(hook.command) && !context.allowDangerousCommands) {
        return {
          ok: false,
          output: `Hook ${context.event} blocked dangerous command for ${target}: ${hook.command}`,
          errorType: "permission_blocked",
          metadata: { hookEvent: context.event, hookCommand: hook.command, hookSource: rule.source }
        };
      }
      const result = await runCommandHook(hook, context);
      const decision = parseHookDecision(result.stdout);
      if (result.output && !decision.decision) outputs.push(result.output);
      if (decision.decision === "block") {
        return {
          ok: false,
          output: clipHookOutput(decision.reason || `Hook ${context.event} blocked ${target}.`, context.maxOutputChars),
          errorType: "permission_blocked",
          metadata: { hookEvent: context.event, hookCommand: hook.command, hookSource: rule.source, hookDecision: "block" }
        };
      }
      if (decision.decision === "approve") {
        hookDecision = "approve";
        outputs.push(decision.reason || `Hook ${context.event} approved ${target}.`);
      }
      if (!result.ok) {
        return {
          ok: false,
          output: clipHookOutput(formatHookFailure(context.event, target, hook.command, result), context.maxOutputChars),
          errorType: "runtime",
          metadata: { hookEvent: context.event, hookCommand: hook.command, hookSource: rule.source, exitCode: result.exitCode }
        };
      }
    }
  }

  return {
    ok: true,
    output: clipHookOutput(outputs.filter(Boolean).join("\n"), context.maxOutputChars),
    metadata: rules.length ? {
      hookEvent: context.event,
      hookCount: rules.reduce((sum, rule) => sum + rule.hooks.length, 0),
      hookDecision
    } : undefined
  };
}

function mergeHookSettings(config: HookConfig, raw: unknown, source: string): void {
  if (!isRecord(raw) || !isRecord(raw.hooks)) return;
  for (const event of ["PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart", "Stop", "SubagentStop", "PreCompact", "Notification"] as const) {
    const value = raw.hooks[event];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const rule = parseHookRule(item, source);
      if (rule) (config[event] ??= []).push(rule);
    }
  }
}

function parseHookRule(raw: unknown, source: string): HookRule | undefined {
  if (!isRecord(raw)) return undefined;
  const matcher = typeof raw.matcher === "string" && raw.matcher.trim() ? raw.matcher.trim() : "*";
  const hooks = Array.isArray(raw.hooks)
    ? raw.hooks.map(parseHookCommand).filter((hook): hook is HookCommand => Boolean(hook))
    : [parseHookCommand(raw)].filter((hook): hook is HookCommand => Boolean(hook));
  return hooks.length ? { matcher, hooks, source } : undefined;
}

function parseHookCommand(raw: unknown): HookCommand | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.type !== undefined && raw.type !== "command") return undefined;
  if (typeof raw.command !== "string" || raw.command.trim() === "") return undefined;
  const timeoutMsRaw = raw.timeoutMs;
  const timeoutSecondsRaw = raw.timeout;
  const timeoutMs = typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
    ? timeoutMsRaw
    : typeof timeoutSecondsRaw === "number" && Number.isFinite(timeoutSecondsRaw) && timeoutSecondsRaw > 0
      ? timeoutSecondsRaw * 1000
      : DEFAULT_TIMEOUT_MS;
  return { type: "command", command: raw.command.trim(), timeoutMs };
}

function matchesHookMatcher(matcher: string, toolName: string): boolean {
  if (matcher === "*" || matcher === "") return true;
  if (matcher === toolName) return true;
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return false;
  }
}

function toolMatcherNames(tool: string): string[] {
  const aliases: Record<string, string[]> = {
    run_command: ["Bash"],
    read_file: ["Read"],
    read_many_files: ["Read"],
    write_file: ["Write"],
    create_file: ["Write"],
    replace_text: ["Edit"],
    apply_patch: ["Edit"],
    search: ["Grep"],
    list_files: ["LS"],
    read_tree: ["LS"]
  };
  return [tool, ...(aliases[tool] ?? [])];
}

interface CommandHookResult {
  ok: boolean;
  exitCode: number | string;
  stdout: string;
  stderr: string;
  output: string;
}

async function runCommandHook(hook: HookCommand, context: HookRunContext): Promise<CommandHookResult> {
  return new Promise((resolve) => {
    const input = context.input ?? {};
    const payload = JSON.stringify({
      hook_event_name: context.event,
      cwd: context.cwd,
      session_id: context.sessionId,
      source: context.source,
      trigger: context.trigger,
      tool_name: context.tool,
      tool_input: context.tool ? input : undefined,
      prompt: context.prompt,
      final_answer: context.finalAnswer,
      stop_hook_active: context.event === "Stop",
      subagent_name: context.subagentName,
      message: context.notification?.message,
      title: context.notification?.title,
      notification_type: context.notification?.type,
      tool_response: context.result ? { ok: context.result.ok, output: context.result.output, errorType: context.result.errorType, metadata: context.result.metadata } : undefined
    });
    const child = spawn(hook.command, {
      cwd: context.cwd,
      shell: true,
      windowsHide: true,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: context.cwd,
        MINI_CODE_HOOK_EVENT: context.event,
        MINI_CODE_HOOK_TOOL: context.tool ?? "",
        MINI_CODE_HOOK_INPUT: JSON.stringify(input),
        MINI_CODE_HOOK_PROMPT: context.prompt ?? "",
        MINI_CODE_HOOK_FINAL_ANSWER: context.finalAnswer ?? "",
        MINI_CODE_HOOK_SUBAGENT_NAME: context.subagentName ?? "",
        MINI_CODE_HOOK_TRIGGER: context.trigger ?? "",
        MINI_CODE_HOOK_NOTIFICATION_MESSAGE: context.notification?.message ?? "",
        MINI_CODE_HOOK_NOTIFICATION_TITLE: context.notification?.title ?? "",
        MINI_CODE_HOOK_NOTIFICATION_TYPE: context.notification?.type ?? "",
        MINI_CODE_HOOK_OK: context.result ? String(context.result.ok) : "",
        MINI_CODE_HOOK_OUTPUT: context.result?.output ?? context.finalAnswer ?? ""
      }
    });
    const chunks = { stdout: "", stderr: "" };
    const timer = setTimeout(() => child.kill(), hook.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { chunks.stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { chunks.stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: "error", stdout: chunks.stdout, stderr: chunks.stderr, output: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const exitCode = signal ? `signal:${signal}` : code ?? "unknown";
      const output = [chunks.stdout.trimEnd(), chunks.stderr.trimEnd()].filter(Boolean).join("\n");
      resolve({ ok: code === 0 && signal === null, exitCode, stdout: chunks.stdout, stderr: chunks.stderr, output });
    });
    child.stdin.end(payload);
  });
}

function formatHookFailure(event: HookEvent, tool: string, command: string, result: CommandHookResult): string {
  return [
    `Hook ${event} failed for ${tool}: ${command}`,
    `exit code: ${String(result.exitCode)}`,
    result.stdout.trim() ? `stdout:\n${result.stdout.trimEnd()}` : undefined,
    result.stderr.trim() ? `stderr:\n${result.stderr.trimEnd()}` : undefined,
    result.output && !result.stdout.trim() && !result.stderr.trim() ? result.output : undefined
  ].filter(Boolean).join("\n");
}

function parseHookDecision(stdout: string): { decision?: "approve" | "block"; reason?: string } {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) return {};
    if (parsed.decision !== "approve" && parsed.decision !== "block") return {};
    const reason = typeof parsed.reason === "string" ? parsed.reason : typeof parsed.message === "string" ? parsed.message : undefined;
    return { decision: parsed.decision, reason };
  } catch {
    return {};
  }
}

function clipHookOutput(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[hook output clipped at ${maxChars} chars]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
