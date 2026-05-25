import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpManager } from "./manager.js";
import type { McpConfig } from "./types.js";

test("McpManager lists and calls tools from a stdio server", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-mcp-manager-"));
  try {
    const serverPath = path.join(dir, "server.mjs");
    await writeFile(serverPath, mockServerSource(), "utf8");
    const config: McpConfig = {
      mcpServers: {
        mock: { command: process.execPath, args: [serverPath], risk: "read" }
      }
    };
    const manager = new McpManager(config, dir);
    assert.deepEqual(manager.serverStatuses(), [{ name: "mock", status: "stopped", command: process.execPath, args: [serverPath], risk: "read" }]);

    const tools = await manager.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.server, "mock");
    assert.equal(tools[0]?.name, "echo");
    assert.equal(tools[0]?.risk, "read");
    assert.equal(manager.serverStatuses()[0]?.status, "connected");

    const result = await manager.callTool("mock", "echo", { text: "hello" });
    assert.deepEqual(result, { content: [{ type: "text", text: "hello" }] });

    manager.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function mockServerSource(): string {
  return `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (!msg.id) return;
  if (msg.method === "tools/list") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } }));
  } else if (msg.method === "tools/call") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: msg.params.arguments.text }] } }));
  } else {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
  }
});
`;
}
