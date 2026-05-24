import path from "node:path";
import type { AgentConfig, LlmProvider } from "../core/types.js";
import { loadConfigEnv, type EnvMap } from "./env.js";

export interface CliArgs extends Partial<AgentConfig> {
  listSessions: boolean;
  newSession: boolean;
}

export function readArgs(argv = process.argv.slice(2)): CliArgs {
  const config: CliArgs = { listSessions: false, newSession: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--cwd" && next) {
      config.cwd = next;
      index += 1;
    } else if (arg === "--model" && next) {
      config.model = next;
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
    }
  }
  return config;
}

export function buildConfig(args: CliArgs): AgentConfig {
  const cwd = path.resolve(args.cwd ?? process.cwd());
  const env = loadConfigEnv(cwd);
  const provider = args.provider ?? inferProvider(env);
  return {
    cwd,
    provider,
    model: args.model ?? defaultModel(provider, env),
    baseUrl: args.baseUrl ?? defaultBaseUrl(provider, env),
    apiKey: defaultApiKey(provider, env),
    maxTurns: args.maxTurns ?? 20,
    allowDangerousCommands: args.allowDangerousCommands ?? false,
    sessionId: args.newSession ? undefined : args.sessionId,
    sessionDir: args.sessionDir ?? path.join(cwd, ".mini-agent", "sessions"),
    permissionMode: "risk-based",
    maxContextMessages: args.maxContextMessages ?? 40,
    maxToolOutputChars: args.maxToolOutputChars ?? 12_000,
    plain: args.plain ?? false
  };
}

function parseProvider(value: string): LlmProvider {
  if (value === "openai" || value === "anthropic") return value;
  throw new Error(`Unsupported provider: ${value}. Use openai or anthropic.`);
}

function inferProvider(env: EnvMap): LlmProvider {
  const raw = env.MINI_AGENT_PROVIDER ?? env.LLM_PROVIDER;
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
