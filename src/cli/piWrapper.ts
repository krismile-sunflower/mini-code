import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigEnv, type EnvMap } from "./env.js";

export interface PiInvocation {
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
}

const MINI_CODE_PLAN_PROMPT = [
  "Mini Code plan mode is active.",
  "Do not edit files, write files, or run mutating shell commands.",
  "Inspect the workspace with read-only tools first when context is needed.",
  "Return a concrete implementation plan only: goal, relevant files, ordered steps, validation commands, risks, and open questions.",
  "Keep the plan actionable enough that a coding agent can execute it in a later run."
].join("\n");

export interface TranslateInvocationOptions {
  shellEnv?: EnvMap;
  writeModelsJson?: boolean;
}

export async function runPiCli(argv = process.argv.slice(2)): Promise<number> {
  const invocation = translateInvocation(argv, { writeModelsJson: true });
  const piBin = resolvePiBin();
  return new Promise((resolve, reject) => {
    const child = spawn(piBin, invocation.args, { stdio: "inherit", env: invocation.env, cwd: invocation.cwd ?? process.cwd() });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

export function translateArgs(argv: string[]): string[] {
  return translateInvocation(argv, { writeModelsJson: false }).args;
}

export function translateInvocation(argv: string[], options: TranslateInvocationOptions = {}): PiInvocation {
  const output: string[] = [];
  let cwd: string | undefined;
  let explicitProvider = false;
  let explicitModel = false;
  let explicitApiKey = false;
  let explicitTools = false;
  let explicitSystemPrompt = false;
  let planMode = false;
  let planModel: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--legacy") continue;
    if (arg === "--plain") {
      output.push("--print");
      continue;
    }
    if (arg === "--cwd" && next) {
      cwd = path.resolve(next);
      index += 1;
      continue;
    }
    if (arg === "--provider" && next) {
      explicitProvider = true;
      output.push("--provider", next);
      index += 1;
      continue;
    }
    if (arg === "--model" && next) {
      explicitModel = true;
      output.push("--model", next);
      index += 1;
      continue;
    }
    if (arg === "--api-key" && next) explicitApiKey = true;
    if ((arg === "--tools" || arg === "-t") && next) explicitTools = true;
    if (arg === "--no-tools" || arg === "-nt" || arg === "--no-builtin-tools" || arg === "-nbt") explicitTools = true;
    if ((arg === "--system-prompt" || arg === "--append-system-prompt") && next) explicitSystemPrompt = true;
    if (arg === "--plan") {
      planMode = true;
      continue;
    }
    if (arg === "--plan-model" && next) {
      planMode = true;
      planModel = next;
      index += 1;
      continue;
    }
    if (arg === "--session-dir" && next) {
      output.push(arg, path.resolve(next));
      index += 1;
      continue;
    }
    if (arg === "--session" && next) {
      output.push("--session", next);
      index += 1;
      continue;
    }
    if (arg === "--new-session") {
      output.push("--no-session");
      continue;
    }
    if (arg === "--list-sessions") {
      output.push("--resume");
      continue;
    }
    if (arg === "--allow-dangerous") continue;
    output.push(arg);
  }
  const env = buildPiEnv(cwd ?? process.cwd(), options.shellEnv);
  applyMiniCodeAgentDir(env, cwd ?? process.cwd());
  const envPlanMode = parseBoolean(env.MINI_CODE_PLAN_MODE ?? env.MINI_AGENT_PLAN_MODE);
  planMode ||= envPlanMode;
  planModel ??= env.MINI_CODE_PLAN_MODEL ?? env.MINI_AGENT_PLAN_MODEL;
  const provider = explicitProvider ? undefined : inferPiProvider(env);
  if (provider) output.unshift("--provider", provider);
  const resolvedProvider = provider ?? findFlagValue(output, "--provider");
  const model = explicitModel ? undefined : planModel ?? inferPiModel(env, resolvedProvider);
  if (model) output.unshift("--model", model);
  applyPlanMode(output, planMode, explicitTools, explicitSystemPrompt);
  applyApiKeyCompat(env, resolvedProvider, explicitApiKey);
  applyOpenAiCompatibleBaseUrlCompat(env, cwd ?? process.cwd(), output, options.writeModelsJson ?? false);
  return { args: output, cwd, env };
}

function resolvePiBin(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(currentDir, "..", "..");
  return path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
}

function buildPiEnv(cwd: string, shellEnv: EnvMap = process.env): NodeJS.ProcessEnv {
  const loaded = loadConfigEnv(cwd, shellEnv);
  return Object.fromEntries(Object.entries(loaded).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function applyMiniCodeAgentDir(env: NodeJS.ProcessEnv, cwd: string): void {
  env.PI_CODING_AGENT_DIR ??= path.join(cwd, ".mini-code");
}

function applyPlanMode(args: string[], planMode: boolean, explicitTools: boolean, explicitSystemPrompt: boolean): void {
  if (!planMode) return;
  if (!explicitTools) args.push("--tools", "read,grep,find,ls");
  if (!explicitSystemPrompt) args.push("--append-system-prompt", MINI_CODE_PLAN_PROMPT);
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function inferPiProvider(env: EnvMap): string | undefined {
  const configured = env.MINI_AGENT_PROVIDER ?? env.LLM_PROVIDER ?? env.PI_PROVIDER;
  if (configured) return configured;
  if (env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY && !env.GEMINI_API_KEY) return "anthropic";
  if (env.OPENAI_API_KEY && !env.GEMINI_API_KEY) return "openai";
  return undefined;
}

function inferPiModel(env: EnvMap, provider: string | undefined): string | undefined {
  if (env.MINI_AGENT_MODEL) return env.MINI_AGENT_MODEL;
  if (env.LLM_MODEL) return env.LLM_MODEL;
  if (provider === "anthropic") return env.ANTHROPIC_MODEL;
  if (provider === "openai") return env.OPENAI_MODEL;
  if (provider === "google") return env.GEMINI_MODEL ?? env.GOOGLE_MODEL;
  return undefined;
}

function applyApiKeyCompat(env: NodeJS.ProcessEnv, provider: string | undefined, explicitApiKey: boolean): void {
  const key = env.MINI_AGENT_API_KEY ?? env.LLM_API_KEY;
  if (!key) return;
  if (explicitApiKey) return;
  if (provider === "anthropic") env.ANTHROPIC_API_KEY ??= key;
  if (provider === "openai") env.OPENAI_API_KEY ??= key;
  if (provider === "google") env.GEMINI_API_KEY ??= key;
}

function applyOpenAiCompatibleBaseUrlCompat(env: NodeJS.ProcessEnv, cwd: string, args: string[], writeModelsJson: boolean): void {
  const baseUrl = env.MINI_AGENT_BASE_URL ?? env.OPENAI_BASE_URL;
  const model = env.MINI_AGENT_MODEL ?? env.OPENAI_MODEL;
  if (!baseUrl || !model) return;
  if (findFlagValue(args, "--provider") !== "openai") return;

  const agentDir = env.PI_CODING_AGENT_DIR ?? path.join(cwd, ".mini-code");
  if (writeModelsJson) ensureOpenAiCompatModel(agentDir, baseUrl, model, env.OPENAI_API_KEY ?? env.MINI_AGENT_API_KEY ?? "openai");
}

function ensureOpenAiCompatModel(agentDir: string, baseUrl: string, model: string, apiKey: string): void {
  mkdirSync(agentDir, { recursive: true });
  const modelsPath = path.join(agentDir, "models.json");
  const current = readJsonObject(modelsPath);
  const providers = isRecord(current.providers) ? current.providers : {};
  providers.openai = {
    ...(isRecord(providers.openai) ? providers.openai : {}),
    baseUrl,
    api: "openai-completions",
    apiKey,
    models: [{ id: model }]
  };
  writeFileSync(modelsPath, `${JSON.stringify({ ...current, providers }, null, 2)}\n`, { mode: 0o600 });
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}
