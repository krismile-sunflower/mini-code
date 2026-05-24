import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfigEnv, parseEnvFile } from "./env.js";

test("parseEnvFile parses simple env entries", () => {
  const env = parseEnvFile([
    "OPENAI_API_KEY=abc",
    'OPENAI_MODEL="gpt-4.1-mini"',
    "export MINI_AGENT_PROVIDER=anthropic",
    "# comment"
  ].join("\n"));
  assert.equal(env.OPENAI_API_KEY, "abc");
  assert.equal(env.OPENAI_MODEL, "gpt-4.1-mini");
  assert.equal(env.MINI_AGENT_PROVIDER, "anthropic");
});

test("loadConfigEnv lets shell env override .env files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-env-"));
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, ".env"), "OPENAI_API_KEY=file-key\nOPENAI_MODEL=file-model\n", "utf8");
    const env = loadConfigEnv(dir, { OPENAI_API_KEY: "shell-key" });
    assert.equal(env.OPENAI_API_KEY, "shell-key");
    assert.equal(env.OPENAI_MODEL, "file-model");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
