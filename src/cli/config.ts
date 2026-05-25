import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { AgentConfig, ConfigSource, ConfigSources, LlmProvider, PermissionMode, ToolsPolicy } from "../core/types.js";
import { loadConfigEnvDetailed, type EnvMap } from "./env.js";

export interface CliArgs extends Partial<AgentConfig> {
  listSessions: boolean;
  newSession: boolean;
  legacy: boolean;
  piPassThrough: boolean;
  piArgs: string[];
  planRequest?: string;
  executePlanId?: string;
}

export function readArgs(argv = process.argv.slice(2)): CliArgs {
  const config: CliArgs = { listSessions: false, newSession: false, legacy: false, piPassThrough: false, piArgs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--pi-pass-through") {
      config.piPassThrough = true;
      const rest = argv.slice(index + 1);
      config.piArgs = rest[0] === "--" ? rest.slice(1) : rest;
      break;
    }
    if (arg === "--cwd" && next) {
      config.cwd = next;
      index += 1;
    } else if (arg === "--model" && next) {
      config.model = next;
      index += 1;
    } else if (arg === "--plan-model" && next) {
      config.planModel = next;
      index += 1;
    } else if (arg === "--provider" && next) {
      config.provider = parseProvider(next);
      index += 1;
    } else if (arg === "--base-url" && next) {
      config.baseUrl = next;
      index += 1;
    } else if (arg === "--max-turns" && next) {
      config.maxTurns = Number(next);
      index += 1;
    } else if (arg === "--session" && next) {
      config.sessionId = next;
      index += 1;
    } else if (arg === "--new-session") {
      config.newSession = true;
    } else if (arg === "--list-sessions") {
      config.listSessions = true;
    } else if (arg === "--plain") {
      config.plain = true;
    } else if (arg === "--allow-dangerous") {
      config.allowDangerousCommands = true;
    } else if (arg === "--permission-mode" && next) {
      config.permissionMode = parsePermissionMode(next);
      index += 1;
    } else if (arg === "--plan") {
      config.toolsPolicy = "read_only";
      if (next && !next.startsWith("--")) {
        config.planRequest = next;
        index += 1;
      }
    } else if (arg === "--execute-plan" && next) {
      config.executePlanId = next;
      index += 1;
    } else if (arg === "--skill" && next) {
      config.skills = [...(config.skills ?? []), next];
      index += 1;
    } else if (arg === "--no-skills") {
      config.enableSkills = false;
    } else if (arg === "--legacy") {
      config.legacy = true;
    }
  }
  return config;
}

export function buildConfig(args: CliArgs): AgentConfig {
  const cwd = path.resolve(args.cwd ?? process.cwd());
  const loadedEnv = loadConfigEnvDetailed(cwd);
  const env = loadedEnv.values;
  const projectConfig = readProjectConfig(cwd);
  const agentDirChoice = select(args.agentDir, env.MINI_CODE_AGENT_DIR, env.MINI_AGENT_DIR, stringValue(projectConfig.agentDir));
  const agentDir = path.resolve(agentDirChoice.value ?? path.join(cwd, ".mini-code"));
  const providerChoice = select(args.provider, env.MINI_CODE_PROVIDER, env.MINI_AGENT_PROVIDER, env.LLM_PROVIDER, stringValue(projectConfig.provider));
  const provider = providerChoice.value ? parseProvider(providerChoice.value) : inferProvider(env);
  const modelChoice = select(args.model, env.MINI_CODE_MODEL, env.MINI_AGENT_MODEL, env.LLM_MODEL, provider === "anthropic" ? env.ANTHROPIC_MODEL : env.OPENAI_MODEL, stringValue(projectConfig.model));
  const planModelChoice = select(args.planModel, env.MINI_CODE_PLAN_MODEL, env.MINI_AGENT_PLAN_MODEL, stringValue(projectConfig.planModel));
  const permissionChoice = select(args.permissionMode, env.MINI_CODE_PERMISSION_MODE, env.MINI_AGENT_PERMISSION_MODE, stringValue(projectConfig.permissionMode));
  const sessionDirChoice = select(args.sessionDir, env.MINI_CODE_SESSION_DIR, env.MINI_AGENT_SESSION_DIR, stringValue(projectConfig.sessionDir));
  const toolsPolicyChoice = select(args.toolsPolicy, env.MINI_CODE_TOOLS_POLICY, stringValue(projectConfig.toolsPolicy));
  const configSkills = Array.isArray(projectConfig.skills) ? projectConfig.skills.filter((item): item is string => typeof item === "string") : [];
  const envSkills = splitList(env.MINI_CODE_SKILLS);
  const enableSkills = args.enableSkills ?? (!truthy(env.MINI_CODE_NO_SKILLS) && !truthy(env.MINI_AGENT_NO_SKILLS) && projectConfig.enableSkills !== false);
  const sources: ConfigSources = {
    provider: sourceFor(providerChoice.source, provider ? "default" : "default"),
    model: sourceFor(modelChoice.source, "default"),
    planModel: sourceFor(planModelChoice.source, modelChoice.source ?? "default"),
    permissionMode: sourceFor(permissionChoice.source, "default"),
    agentDir: sourceFor(agentDirChoice.source, "default"),
    sessionDir: sourceFor(sessionDirChoice.source, "default"),
    toolsPolicy: sourceFor(toolsPolicyChoice.source, "default")
  };
  return {
    cwd,
    provider,
    model: modelChoice.value ?? defaultModel(provider, env),
    planModel: planModelChoice.value ?? modelChoice.value ?? defaultModel(provider, env),
    baseUrl: args.baseUrl ?? defaultBaseUrl(provider, env),
    apiKey: defaultApiKey(provider, env),
    maxTurns: args.maxTurns ?? 20,
    allowDangerousCommands: args.allowDangerousCommands ?? false,
    sessionId: args.newSession ? undefined : args.sessionId,
    agentDir,
    sessionDir: path.resolve(sessionDirChoice.value ?? path.join(agentDir, "sessions")),
    permissionMode: permissionChoice.value ? parsePermissionMode(permissionChoice.value) : "default",
    toolsPolicy: parseToolsPolicy(toolsPolicyChoice.value),
    skills: [...configSkills, ...envSkills, ...(args.skills ?? [])],
    enableSkills,
    maxContextMessages: args.maxContextMessages ?? 40,
    maxToolOutputChars: args.maxToolOutputChars ?? 12_000,
    plain: args.plain ?? false,
    configSources: sources
  };
}

export function collectConfigWarnings(cwd: string): string[] {
  const loadedEnv = loadConfigEnvDetailed(cwd);
  const env = loadedEnv.values;
  const warnings: string[] = [];
  if ((env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN || env.APIKEYHELPER || env.API_KEY_HELPER) && env.ANTHROPIC_API_KEY) {
    warnings.push(
      [
        "Auth conflict: Both a token (apiKeyHelper) and an API key (ANTHROPIC_API_KEY) are set. This may lead",
        "  to unexpected behavior.",
        "  · Trying to use apiKeyHelper? Unset the ANTHROPIC_API_KEY environment variable, or logout",
        "    then say \"No\" to the API key approval before login.",
        "  · Trying to use ANTHROPIC_API_KEY? Unset the apiKeyHelper setting.",
      ].join("\n")
    );
  }
  if (env.ANTHROPIC_API_KEY && env.OPENAI_API_KEY) {
    warnings.push(
      [
        "Auth conflict: Both ANTHROPIC_API_KEY and OPENAI_API_KEY are set. This may lead to unexpected behavior.",
        "  · Use --provider anthropic or --provider openai to explicitly select one.",
        "  · Or unset the unused API key environment variable.",
      ].join("\n")
    );
  }
  return warnings;
}

function splitList(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function truthy(value: string | undefined): boolean {
  return value ? ["1", "true", "yes", "on"].includes(value.toLowerCase()) : false;
}

function readProjectConfig(cwd: string): Record<string, unknown> {
  const filePath = path.join(cwd, ".mini-code", "config.json");
  if (!existsSync(filePath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function select<T extends string | undefined>(...values: Array<T>): { value: Exclude<T, undefined> | undefined; source?: ConfigSource } {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined || value === "") continue;
    const source: ConfigSource = index === 0 ? "cli" : index <= 3 ? "env" : "config";
    return { value: value as Exclude<T, undefined>, source };
  }
  return { value: undefined };
}

function sourceFor(source: ConfigSource | undefined, fallback: ConfigSource): ConfigSource {
  return source ?? fallback;
}

function parseProvider(value: string): LlmProvider {
  if (value === "openai" || value === "anthropic") return value;
  throw new Error(`Unsupported provider: ${value}. Use openai or anthropic.`);
}

function parsePermissionMode(value: string): PermissionMode {
  if (value === "default" || value === "accept_edits" || value === "bypass_permissions" || value === "risk-based") return value;
  throw new Error(`Unsupported permission mode: ${value}. Use default, accept_edits, or bypass_permissions.`);
}

function parseToolsPolicy(value: string | undefined): ToolsPolicy {
  if (!value || value === "default") return "default";
  if (value === "read_only") return "read_only";
  throw new Error(`Unsupported tools policy: ${value}. Use default or read_only.`);
}

function inferProvider(env: EnvMap): LlmProvider {
  const raw = env.MINI_CODE_PROVIDER ?? env.MINI_AGENT_PROVIDER ?? env.LLM_PROVIDER;
  if (raw) return parseProvider(raw);
  if (env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) return "anthropic";
  return "openai";
}

function defaultModel(provider: LlmProvider, env: EnvMap): string {
  if (provider === "anthropic") return env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514";
  return env.OPENAI_MODEL ?? "gpt-4.1-mini";
}

function defaultBaseUrl(provider: LlmProvider, env: EnvMap): string {
  if (provider === "anthropic") return env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1";
  return env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
}

function defaultApiKey(provider: LlmProvider, env: EnvMap): string {
  if (provider === "anthropic") return env.ANTHROPIC_API_KEY ?? "";
  return env.OPENAI_API_KEY ?? "";
}
