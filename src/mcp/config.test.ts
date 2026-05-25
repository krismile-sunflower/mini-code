import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadMcpConfig } from "./config.js";

test("loadMcpConfig reads project mcp servers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-mcp-config-"));
  try {
    await mkdir(path.join(dir, ".mini-code"), { recursive: true });
    await writeFile(path.join(dir, ".mini-code", "mcp.json"), JSON.stringify({
      mcpServers: {
        test: { command: "node", args: ["server.js"], env: { A: "B" }, risk: "read" }
      }
    }), "utf8");

    const config = loadMcpConfig(dir);

    assert.equal(config.mcpServers.test?.command, "node");
    assert.deepEqual(config.mcpServers.test?.args, ["server.js"]);
    assert.deepEqual(config.mcpServers.test?.env, { A: "B" });
    assert.equal(config.mcpServers.test?.risk, "read");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadMcpConfig defaults unknown risk to shell", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-mcp-config-risk-"));
  try {
    await mkdir(path.join(dir, ".mini-code"), { recursive: true });
    await writeFile(path.join(dir, ".mini-code", "mcp.json"), JSON.stringify({
      mcpServers: { test: { command: "node", risk: "unknown" } }
    }), "utf8");

    assert.equal(loadMcpConfig(dir).mcpServers.test?.risk, "shell");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
