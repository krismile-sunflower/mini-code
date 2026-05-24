import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "./agent.js";
import { parseDecision } from "./decision.js";
import { fallbackReadFilePath, finalClaimsToolUse, requiresWorkspaceTool } from "./policy.js";
import type { AgentConfig, AgentEvent, ToolDefinition } from "./types.js";

test("parseDecision accepts fenced JSON", () => {
  const decision = parseDecision('```json\n{"action":"final","answer":"done"}\n```');
  assert.equal(decision.action, "final");
  assert.equal(decision.answer, "done");
});

test("parseDecision validates final answer", () => {
  assert.throws(() => parseDecision('{"action":"final"}'), /answer/);
});

test("parseDecision validates tool name and input", () => {
  const tools = new Map<string, ToolDefinition>([["read_file", fakeTool("read_file")]]);
  assert.equal(parseDecision('{"action":"tool","tool":"read_file","input":{"path":"a.ts"}}', tools).tool, "read_file");
  assert.throws(() => parseDecision('{"action":"tool","tool":"missing"}', tools), /Unknown tool/);
  assert.throws(() => parseDecision('{"action":"tool","tool":"read_file","input":[]}', tools), /input/);
});

test("parseDecision rejects non-json and unknown actions", () => {
  assert.throws(() => parseDecision("hello"), /did not return JSON/);
  assert.throws(() => parseDecision('{"action":"noop"}'), /Invalid action/);
});

test("requiresWorkspaceTool detects workspace requests conservatively", () => {
  assert.equal(requiresWorkspaceTool("读取 src/index.ts"), true);
  assert.equal(requiresWorkspaceTool("read package.json"), true);
  assert.equal(requiresWorkspaceTool("search for AgentSession"), true);
  assert.equal(requiresWorkspaceTool("解释 TypeScript interface"), false);
});

test("fallbackReadFilePath extracts explicit read targets", () => {
  assert.equal(fallbackReadFilePath("readme.md里面有些什么"), "README.md");
  assert.equal(fallbackReadFilePath("读取 src/index.ts"), "src/index.ts");
  assert.equal(fallbackReadFilePath("解释 interface"), undefined);
});

test("finalClaimsToolUse detects unsupported claims", () => {
  assert.equal(finalClaimsToolUse("I read the file and it says hello."), true);
  assert.equal(finalClaimsToolUse("我已经读取了这个文件。"), true);
  assert.equal(finalClaimsToolUse("An interface describes an object shape."), false);
});

test("AgentSession retries once after invalid model JSON", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-loop-"));
  const originalFetch = globalThis.fetch;
  const responses = ["not json", '{"action":"final","answer":"recovered"}'];
  globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: responses.shift() } }] });
  const events: AgentEvent[] = [];
  try {
    const session = await AgentSession.create(config(dir), (event) => events.push(event), async () => "allow_once");
    const answer = await session.run("do it");
    assert.equal(answer, "recovered");
    assert.ok(events.some((event) => event.type === "error" && event.category === "parse"));
    assert.equal(session.getRecord().title, "do it");
    assert.equal(session.getRecord().lastUserMessage, "do it");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession forces a tool before final answer for read requests", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-force-tool-"));
  await writeFile(path.join(dir, "README.md"), "hello\n", "utf8");
  const originalFetch = globalThis.fetch;
  const responses = [
    '{"action":"final","answer":"I read README.md."}',
    '{"action":"tool","tool":"read_file","input":{"path":"README.md"},"thought":"Need to actually read the file."}',
    '{"action":"final","answer":"README.md contains hello."}'
  ];
  globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: responses.shift() } }] });
  const events: AgentEvent[] = [];
  try {
    const session = await AgentSession.create(config(dir), (event) => events.push(event), async () => "allow_once");
    const answer = await session.run("读取 README.md");
    assert.equal(answer, "README.md contains hello.");
    assert.ok(events.some((event) => event.type === "error" && event.category === "protocol"));
    assert.ok(events.some((event) => event.type === "tool_request" && event.tool === "read_file"));
    assert.ok(events.some((event) => event.type === "tool_result" && event.tool === "read_file" && event.ok));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession falls back to read_file when model repeatedly answers explicit file questions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-fallback-read-"));
  await writeFile(path.join(dir, "README.md"), "hello from readme\n", "utf8");
  const originalFetch = globalThis.fetch;
  const responses = [
    '{"action":"final","answer":"README exists."}',
    '{"action":"final","answer":"Still answering without tools."}',
    '{"action":"final","answer":"README.md contains hello from readme."}'
  ];
  globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: responses.shift() } }] });
  const events: AgentEvent[] = [];
  try {
    const session = await AgentSession.create(config(dir, { maxTurns: 5 }), (event) => events.push(event), async () => "allow_once");
    const answer = await session.run("readme.md里面有些什么");
    assert.equal(answer, "README.md contains hello from readme.");
    assert.ok(events.some((event) => event.type === "tool_request" && event.tool === "read_file"));
    assert.ok(events.some((event) => event.type === "tool_result" && event.tool === "read_file" && event.ok && /hello from readme/.test(event.output)));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession allows final answer for ordinary questions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-no-tool-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: '{"action":"final","answer":"Interfaces describe object shapes."}' } }] });
  const events: AgentEvent[] = [];
  try {
    const session = await AgentSession.create(config(dir), (event) => events.push(event), async () => "allow_once");
    const answer = await session.run("解释 TypeScript interface");
    assert.equal(answer, "Interfaces describe object shapes.");
    assert.equal(events.some((event) => event.type === "error" && event.category === "protocol"), false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession allows final after a failed tool call", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-failed-tool-"));
  const originalFetch = globalThis.fetch;
  const responses = [
    '{"action":"tool","tool":"read_file","input":{"path":"missing.md"}}',
    '{"action":"final","answer":"missing.md could not be read."}'
  ];
  globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: responses.shift() } }] });
  const events: AgentEvent[] = [];
  try {
    const session = await AgentSession.create(config(dir), (event) => events.push(event), async () => "allow_once");
    const answer = await session.run("读取 missing.md");
    assert.equal(answer, "missing.md could not be read.");
    assert.ok(events.some((event) => event.type === "tool_result" && event.tool === "read_file" && !event.ok));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession returns validation tool result and lets the model repair input", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-validation-"));
  await writeFile(path.join(dir, "README.md"), "hello\n", "utf8");
  const originalFetch = globalThis.fetch;
  const responses = [
    '{"action":"tool","tool":"read_file","input":{}}',
    '{"action":"tool","tool":"read_file","input":{"path":"README.md"}}',
    '{"action":"final","answer":"README.md contains hello."}'
  ];
  globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: responses.shift() } }] });
  const events: AgentEvent[] = [];
  try {
    const session = await AgentSession.create(config(dir, { maxTurns: 4 }), (event) => events.push(event), async () => "allow_once");
    const answer = await session.run("read README.md");
    assert.equal(answer, "README.md contains hello.");
    assert.ok(events.some((event) => event.type === "tool_result" && event.errorType === "validation"));
    assert.ok(session.getRecord().tasks?.at(-1)?.toolCalls.some((call) => call.status === "validation_error"));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession records blocked permissions without counting successful tool access", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-blocked-"));
  const originalFetch = globalThis.fetch;
  const responses = [
    '{"action":"tool","tool":"run_command","input":{"command":"rm -rf dist"}}',
    '{"action":"final","answer":"Dangerous command was blocked."}'
  ];
  globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: responses.shift() } }] });
  const events: AgentEvent[] = [];
  try {
    const session = await AgentSession.create(config(dir, { maxTurns: 3 }), (event) => events.push(event), async () => "allow_once");
    const answer = await session.run("try dangerous command");
    assert.equal(answer, "Dangerous command was blocked.");
    assert.ok(events.some((event) => event.type === "tool_result" && event.errorType === "permission_blocked"));
    assert.equal(session.getRecord().tasks?.at(-1)?.toolCalls.at(-1)?.status, "blocked");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession runs a full plan, edit, command, final loop", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-full-loop-"));
  await writeFile(path.join(dir, "note.txt"), "old\n", "utf8");
  const originalFetch = globalThis.fetch;
  const responses = [
    '{"action":"plan","todos":[{"content":"Read note","status":"in_progress"},{"content":"Edit note","status":"pending"},{"content":"Verify","status":"pending"}]}',
    '{"action":"tool","tool":"read_file","input":{"path":"note.txt"},"thought":"Inspect current content."}',
    '{"action":"tool","tool":"apply_patch","input":{"patch":"--- a/note.txt\\n+++ b/note.txt\\n@@ -1 +1 @@\\n-old\\n+new\\n"}}',
    '{"action":"tool","tool":"run_command","input":{"command":"cat note.txt"}}',
    '{"action":"final","answer":"Updated note.txt and verified it contains new."}'
  ];
  globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: responses.shift() } }] });
  const events: AgentEvent[] = [];
  try {
    const session = await AgentSession.create(config(dir, { maxTurns: 6 }), (event) => events.push(event), async () => "allow_once");
    const answer = await session.run("change note.txt from old to new and verify");
    assert.equal(answer, "Updated note.txt and verified it contains new.");
    assert.equal(await readFile(path.join(dir, "note.txt"), "utf8"), "new\n");
    assert.ok(events.some((event) => event.type === "plan"));
    assert.ok(events.some((event) => event.type === "tool_result" && event.tool === "apply_patch" && event.ok));
    assert.ok(events.some((event) => event.type === "permission_request" && event.tool === "run_command"));
    const task = session.getRecord().tasks?.at(-1);
    assert.equal(task?.status, "done");
    assert.equal(task?.toolCalls.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession records denied permission and lets the model continue", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-deny-"));
  const originalFetch = globalThis.fetch;
  const responses = [
    '{"action":"plan","todos":[{"content":"Request command approval","status":"in_progress"}]}',
    '{"action":"tool","tool":"run_command","input":{"command":"echo blocked"}}',
    '{"action":"final","answer":"Command was denied, so I stopped."}'
  ];
  globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: responses.shift() } }] });
  const events: AgentEvent[] = [];
  try {
    const session = await AgentSession.create(config(dir), (event) => events.push(event), async () => "deny");
    const answer = await session.run("run echo blocked");
    assert.equal(answer, "Command was denied, so I stopped.");
    assert.ok(events.some((event) => event.type === "tool_result" && event.errorType === "permission_denied" && /User denied permission/.test(event.output)));
    const task = session.getRecord().tasks?.at(-1);
    assert.equal(task?.status, "done");
    assert.equal(task?.approvals.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession compacts context with structured summary and keeps running", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-compact-"));
  await writeFile(path.join(dir, "README.md"), "hello\n", "utf8");
  const originalFetch = globalThis.fetch;
  const responses = [
    '{"action":"tool","tool":"read_file","input":{"path":"README.md"}}',
    '{"action":"final","answer":"Read README.md."}',
    '{"action":"final","answer":"Continued after compaction."}'
  ];
  globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: responses.shift() } }] });
  try {
    const session = await AgentSession.create(config(dir, { apiKey: "", maxContextMessages: 3 }), () => undefined, async () => "allow_once");
    assert.equal(await session.run("read README.md"), "Read README.md.");
    assert.equal(await session.run("continue"), "Continued after compaction.");
    assert.match(session.getSummary(), /Current goal:/);
    assert.match(session.getSummary(), /Completed work:/);
    assert.match(session.getSummary(), /Key files:/);
    assert.ok(session.getMessageCount() <= 5);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession uses fallback read instead of protocol error after repeated final answers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-protocol-"));
  await writeFile(path.join(dir, "README.md"), "fallback content\n", "utf8");
  const originalFetch = globalThis.fetch;
  const responses = [
    '{"action":"final","answer":"I read README.md."}',
    '{"action":"final","answer":"I still did not call a tool."}',
    '{"action":"final","answer":"README.md contains fallback content."}'
  ];
  globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: responses.shift() } }] });
  const events: AgentEvent[] = [];
  try {
    const session = await AgentSession.create(config(dir), (event) => events.push(event), async () => "allow_once");
    const answer = await session.run("读取 README.md");
    assert.equal(answer, "README.md contains fallback content.");
    assert.ok(events.some((event) => event.type === "tool_result" && event.tool === "read_file" && event.ok));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession createPlan uses plan model and read-only tools", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-plan-readonly-"));
  await writeFile(path.join(dir, "README.md"), "hello plan\n", "utf8");
  const originalFetch = globalThis.fetch;
  const calls: Array<{ body: { model: string; messages: Array<{ role: string; content: string }> } }> = [];
  const responses = [
    '{"action":"tool","tool":"read_file","input":{"path":"README.md"},"thought":"Inspect project context before planning."}',
    '{"action":"final","answer":"Goal:\\nPlan the requested change.\\n\\nRelevant files:\\n- README.md\\n\\nOrdered steps:\\n- Inspect README.md\\n- Implement the change\\n\\nValidation commands:\\n- npm test\\n\\nRisks:\\n- None known\\n\\nOpen questions:\\n- None"}'
  ];
  globalThis.fetch = async (_url, init) => {
    calls.push({ body: JSON.parse(String(init?.body)) });
    return jsonResponse({ choices: [{ message: { content: responses.shift() } }] });
  };
  const events: AgentEvent[] = [];
  try {
    const session = await AgentSession.create(config(dir, { planModel: "planner-model" }), (event) => events.push(event), async () => "allow_once");
    const plan = await session.createPlan("plan README update");
    assert.equal(plan.model, "planner-model");
    assert.ok(plan.files.some((file) => /README\.md/.test(file)));
    assert.ok(events.some((event) => event.type === "tool_request" && event.tool === "read_file"));
    assert.ok(events.some((event) => event.type === "tool_result" && event.tool === "read_file" && event.ok));
    assert.ok(calls.every((call) => call.body.model === "planner-model"));
    const system = calls[0]?.body.messages[0]?.content ?? "";
    assert.match(system, /read-only plan mode/);
    assert.doesNotMatch(system, /apply_patch \[risk=write\]/);
    assert.doesNotMatch(system, /run_command/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession read-only tools policy removes write and shell tools", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-readonly-policy-"));
  try {
    const session = await AgentSession.create(config(dir, { toolsPolicy: "read_only" }), () => undefined, async () => "allow_once");
    const tools = session.describeTools();
    assert.match(tools, /read_file/);
    assert.doesNotMatch(tools, /apply_patch/);
    assert.doesNotMatch(tools, /run_command/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession createPlan does not execute write tools", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-plan-no-write-"));
  const file = path.join(dir, "note.txt");
  await writeFile(file, "old\n", "utf8");
  const originalFetch = globalThis.fetch;
  const responses = [
    '{"action":"tool","tool":"apply_patch","input":{"patch":"--- a/note.txt\\n+++ b/note.txt\\n@@ -1 +1 @@\\n-old\\n+new\\n"}}',
    '{"action":"final","answer":"Goal:\\nPlan only.\\n\\nRelevant files:\\n- note.txt\\n\\nOrdered steps:\\n- Update note.txt after approval\\n\\nValidation commands:\\n- npm test\\n\\nRisks:\\n- Requires write approval\\n\\nOpen questions:\\n- None"}'
  ];
  globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: responses.shift() } }] });
  const events: AgentEvent[] = [];
  try {
    const session = await AgentSession.create(config(dir), (event) => events.push(event), async () => "allow_once");
    const plan = await session.createPlan("plan note update");
    assert.match(plan.answer, /Plan only/);
    assert.equal(await readFile(file, "utf8"), "old\n");
    assert.ok(events.some((event) => event.type === "error" && event.category === "parse" && /Unknown tool: apply_patch/.test(event.error)));
    assert.equal(events.some((event) => event.type === "tool_request" && event.tool === "apply_patch"), false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

function fakeTool(name: string): ToolDefinition {
  return {
    name,
    description: "fake",
    inputSchema: {},
    risk: "read",
    describe: () => "fake",
    validate: () => undefined,
    requiresApproval: () => ({ required: false, risk: "read", reason: "ok" }),
    run: async () => ({ ok: true, output: "ok" })
  };
}

function config(dir: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    cwd: dir,
    provider: "openai",
    model: "test-model",
    planModel: "test-model",
    baseUrl: "https://api.test/v1",
    apiKey: "key",
    maxTurns: 3,
    allowDangerousCommands: false,
    agentDir: path.join(dir, ".mini-code"),
    sessionDir: path.join(dir, ".mini-code", "sessions"),
    permissionMode: "risk-based",
    toolsPolicy: "default",
    skills: [],
    enableSkills: true,
    maxContextMessages: 40,
    maxToolOutputChars: 12_000,
    plain: false,
    ...overrides
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
