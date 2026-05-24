import { test } from "node:test";
import assert from "node:assert/strict";
import { chat } from "./llm.js";

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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
