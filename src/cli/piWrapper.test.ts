import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { translateInvocation } from "./piWrapper.js";

test("translateArgs maps legacy mini-agent flags to pi flags", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-pi-flags-"));
  assert.deepEqual(translateInvocation(["--cwd", cwd, "--legacy", "--plain", "--provider", "anthropic", "--model", "sonnet", "hello"], { shellEnv: {} }).args, ["--print", "--provider", "anthropic", "--model", "sonnet", "hello"]);
  assert.deepEqual(translateInvocation(["--cwd", cwd, "--session", "abc", "--new-session", "--allow-dangerous"], { shellEnv: {} }).args, ["--session", "abc", "--no-session"]);
});

test("translateInvocation keeps cwd as spawn option instead of changing process cwd", () => {
  const before = process.cwd();
  const invocation = translateInvocation(["--cwd", "../other-repo", "--mode", "json", "hello"], { shellEnv: {} });

  assert.equal(process.cwd(), before);
  assert.equal(invocation.cwd, path.resolve("../other-repo"));
  assert.deepEqual(invocation.args, ["--mode", "json", "hello"]);
});

test("translateInvocation maps legacy model env to pi provider and model flags", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-pi-agent-dir-"));
  const invocation = translateInvocation(["--cwd", cwd], {
    shellEnv: {
      MINI_AGENT_PROVIDER: "anthropic",
      ANTHROPIC_MODEL: "claude-test",
      ANTHROPIC_API_KEY: "sk-ant-test"
    }
  });

  assert.deepEqual(invocation.args, ["--model", "claude-test", "--provider", "anthropic"]);
  assert.equal(invocation.env.PI_CODING_AGENT_DIR, path.join(cwd, ".mini-code"));
  assert.equal(invocation.env.ANTHROPIC_API_KEY, "sk-ant-test");
});

test("translateInvocation preserves explicit pi agent dir", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-pi-explicit-dir-"));
  const explicitDir = path.join(cwd, "custom-pi-dir");
  const invocation = translateInvocation(["--cwd", cwd], {
    shellEnv: {
      PI_CODING_AGENT_DIR: explicitDir,
      MINI_AGENT_PROVIDER: "openai",
      OPENAI_MODEL: "gpt-env"
    }
  });

  assert.equal(invocation.env.PI_CODING_AGENT_DIR, explicitDir);
});

test("translateInvocation lets explicit cli flags win over legacy env", () => {
  const invocation = translateInvocation(["--provider", "openai", "--model", "gpt-explicit"], {
    shellEnv: {
      MINI_AGENT_PROVIDER: "anthropic",
      ANTHROPIC_MODEL: "claude-env"
    }
  });

  assert.deepEqual(invocation.args, ["--provider", "openai", "--model", "gpt-explicit"]);
});

test("translateInvocation loads .env files from target cwd", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-pi-env-"));
  writeText(path.join(cwd, ".env"), "MINI_AGENT_PROVIDER=openai\nOPENAI_MODEL=gpt-env\nOPENAI_API_KEY=sk-env\n");
  const invocation = translateInvocation(["--cwd", cwd], { shellEnv: {} });

  assert.equal(invocation.cwd, cwd);
  assert.deepEqual(invocation.args, ["--model", "gpt-env", "--provider", "openai"]);
  assert.equal(invocation.env.OPENAI_API_KEY, "sk-env");
});

test("translateInvocation prepares project-local pi models config for OpenAI-compatible base urls", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-pi-models-"));
  const invocation = translateInvocation(["--cwd", cwd], {
    shellEnv: {
      MINI_AGENT_PROVIDER: "openai",
      OPENAI_MODEL: "qwen2.5-coder:7b",
      OPENAI_API_KEY: "ollama",
      OPENAI_BASE_URL: "http://localhost:11434/v1"
    },
    writeModelsJson: true
  });

  const agentDir = path.join(cwd, ".mini-code");
  assert.equal(invocation.env.PI_CODING_AGENT_DIR, agentDir);
  const models = JSON.parse(readFileSync(path.join(agentDir, "models.json"), "utf8"));
  assert.equal(models.providers.openai.baseUrl, "http://localhost:11434/v1");
  assert.equal(models.providers.openai.api, "openai-completions");
  assert.deepEqual(models.providers.openai.models, [{ id: "qwen2.5-coder:7b" }]);
});

test("translateInvocation enables Mini Code plan mode with read-only tools and plan prompt", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-pi-plan-"));
  const invocation = translateInvocation(["--cwd", cwd, "--plan", "design the change"], { shellEnv: {} });

  assert.ok(invocation.args.includes("--append-system-prompt"));
  assert.deepEqual(invocation.args.slice(-5), ["design the change", "--tools", "read,grep,find,ls", "--append-system-prompt", invocation.args.at(-1)]);
  assert.match(String(invocation.args.at(-1)), /Mini Code plan mode is active/);
});

test("translateInvocation uses plan model without overriding explicit model", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-pi-plan-model-"));
  const planned = translateInvocation(["--cwd", cwd, "--plan-model", "planner-model"], {
    shellEnv: { MINI_AGENT_PROVIDER: "openai", OPENAI_MODEL: "worker-model" }
  });
  const explicit = translateInvocation(["--cwd", cwd, "--model", "explicit-model", "--plan-model", "planner-model"], {
    shellEnv: { MINI_AGENT_PROVIDER: "openai", OPENAI_MODEL: "worker-model" }
  });

  assert.deepEqual(planned.args.slice(0, 4), ["--model", "planner-model", "--provider", "openai"]);
  assert.equal(explicit.args.includes("planner-model"), false);
  assert.ok(explicit.args.includes("explicit-model"));
});

test("translateInvocation respects explicit tools and system prompt in plan mode", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-pi-plan-explicit-"));
  const invocation = translateInvocation(["--cwd", cwd, "--plan", "--tools", "read", "--append-system-prompt", "custom plan"], { shellEnv: {} });

  assert.deepEqual(invocation.args, ["--tools", "read", "--append-system-prompt", "custom plan"]);
});

test("translateInvocation enables plan mode from env", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-pi-plan-env-"));
  const invocation = translateInvocation(["--cwd", cwd], {
    shellEnv: {
      MINI_CODE_PLAN_MODE: "true",
      MINI_CODE_PLAN_MODEL: "planner-env-model",
      MINI_AGENT_PROVIDER: "anthropic"
    }
  });

  assert.deepEqual(invocation.args.slice(0, 4), ["--model", "planner-env-model", "--provider", "anthropic"]);
  assert.ok(invocation.args.includes("--tools"));
  assert.ok(invocation.args.includes("read,grep,find,ls"));
});

function writeText(filePath: string, text: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, text);
}
