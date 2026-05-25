import { test } from "node:test";
import assert from "node:assert/strict";
import { chat, complete, toProviderMessages } from "./llm.js";
import type { ToolDefinition } from "../core/types.js";

test("chat sends OpenAI-compatible chat completions request", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return jsonResponse({ choices: [{ message: { content: "ok" } }] });
  };
  try {
    const result = await chat({
      provider: "openai",
      baseUrl: "https://api.openai.test/v1",
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "hello" }]
    });
    assert.equal(result, "ok");
    assert.equal(calls[0]?.url, "https://api.openai.test/v1/chat/completions");
    assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("complete normalizes OpenAI-compatible responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: '{"action":"final","answer":"ok"}' } }] });
  try {
    const result = await complete({
      provider: "openai",
      baseUrl: "https://api.openai.test/v1",
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "hello" }]
    });
    assert.equal(result.provider, "openai");
    assert.equal(result.model, "model");
    assert.equal(result.raw, '{"action":"final","answer":"ok"}');
    assert.equal(result.content, result.raw);
    assert.deepEqual(result.streamEvents, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible conversion renders tool messages as user text", async () => {
  const calls: Array<{ body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls.push({ body: JSON.parse(String(init?.body)) });
    return jsonResponse({ choices: [{ message: { content: "{\"action\":\"final\",\"answer\":\"ok\"}" } }] });
  };
  try {
    await complete({
      provider: "openai",
      baseUrl: "https://api.openai.test/v1",
      apiKey: "key",
      model: "model",
      messages: [
        { role: "user", content: "read package.json" },
        { role: "assistant", content: "{\"action\":\"tool\",\"tool\":\"read_file\",\"input\":{\"path\":\"package.json\"}}" },
        { role: "tool", content: JSON.stringify({ tool: "read_file", ok: true, output: "package text", metadata: { path: "package.json" } }) }
      ]
    });
    const body = calls[0]?.body as { messages: Array<{ role: string; content: string }> };
    assert.equal(body.messages.some((message) => message.role === "tool"), false);
    assert.equal(body.messages.at(-1)?.role, "user");
    assert.match(body.messages.at(-1)?.content ?? "", /Tool result for read_file/);
    assert.match(body.messages.at(-1)?.content ?? "", /package text/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("toProviderMessages merges tool result without call ids", () => {
  const messages = toProviderMessages([
    { role: "system", content: "rules" },
    { role: "tool", content: JSON.stringify({ tool: "read_file", ok: true, output: "ok" }) }
  ]);
  assert.deepEqual(messages.map((message) => message.role), ["system", "user"]);
  assert.match(messages[1]?.content ?? "", /Tool result for read_file/);
});

test("OpenAI native tool calls normalize to JSON tool decisions", async () => {
  const calls: Array<{ body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls.push({ body: JSON.parse(String(init?.body)) });
    return jsonResponse({
      choices: [{
        message: {
          tool_calls: [{ function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }]
        }
      }]
    });
  };
  try {
    const result = await complete({
      provider: "openai",
      baseUrl: "https://api.openai.test/v1",
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "read README.md" }],
      toolProtocol: "native",
      tools: [fakeTool("read_file")]
    });
    assert.equal(JSON.parse(result.content).tool, "read_file");
    assert.deepEqual(JSON.parse(result.content).input, { path: "README.md" });
    const body = calls[0]?.body as { tools?: unknown[]; stream?: boolean };
    assert.equal(body.stream, false);
    assert.equal(Array.isArray(body.tools), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat sends Anthropic messages request and converts system/tool roles", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return jsonResponse({ content: [{ type: "text", text: "ok" }] });
  };
  try {
    const result = await chat({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "ant-key",
      model: "claude",
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: "hello" },
        { role: "tool", content: "{\"ok\":true}" }
      ]
    });
    assert.equal(result, "ok");
    assert.equal(calls[0]?.url, "https://api.anthropic.test/v1/messages");
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "ant-key");
    assert.equal(headers["anthropic-version"], "2023-06-01");
    const body = JSON.parse(String(calls[0]?.init.body));
    assert.equal(body.system, "rules");
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, "user");
    assert.match(body.messages[0].content, /Tool result/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("complete normalizes Anthropic responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ content: [{ type: "text", text: "{\"action\":\"final\",\"answer\":\"ok\"}" }] });
  try {
    const result = await complete({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "ant-key",
      model: "claude",
      messages: [{ role: "user", content: "hello" }]
    });
    assert.equal(result.provider, "anthropic");
    assert.equal(result.model, "claude");
    assert.equal(result.content, '{"action":"final","answer":"ok"}');
    assert.deepEqual(result.streamEvents, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic native tool calls normalize to JSON tool decisions", async () => {
  const calls: Array<{ body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls.push({ body: JSON.parse(String(init?.body)) });
    return jsonResponse({ content: [{ type: "tool_use", name: "read_file", input: { path: "README.md" } }] });
  };
  try {
    const result = await complete({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "ant-key",
      model: "claude",
      messages: [{ role: "user", content: "read README.md" }],
      toolProtocol: "native",
      tools: [fakeTool("read_file")]
    });
    assert.equal(JSON.parse(result.content).tool, "read_file");
    assert.deepEqual(JSON.parse(result.content).input, { path: "README.md" });
    const body = calls[0]?.body as { tools?: unknown[]; stream?: boolean };
    assert.equal(body.stream, false);
    assert.equal(Array.isArray(body.tools), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function fakeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    inputSchema: { path: "Path to read." },
    risk: "read",
    describe: () => name,
    validate: () => undefined,
    requiresApproval: () => ({ required: false, risk: "read", reason: "ok" }),
    run: async () => ({ ok: true, output: "ok" })
  };
}
