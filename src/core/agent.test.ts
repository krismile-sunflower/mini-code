import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "./agent.js";
import { parseDecision } from "./decision.js";
import { fallbackReadFilePath, finalClaimsToolUse, requiresWorkspaceTool } from "./policy.js";
import { SessionStore } from "../storage/sessionStore.js";
import type { AgentConfig, AgentEvent, ToolDefinition } from "./types.js";

test("parseDecision accepts fenced JSON", () => {
  const decision = parseDecision('```json\n{"action":"final","answer":"done"}\n```');
  assert.equal(decision.action, "final");
  assert.equal(decision.answer, "done");
});

test("parseDecision accepts answer shorthand and ignores trailing text", () => {
  const shorthand = parseDecision('{"answer":"hello, how can I help?"}');
  assert.equal(shorthand.action, "final");
  assert.equal(shorthand.answer, "hello, how can I help?");

  const trailed = parseDecision('{"action":"final","answer":"done"}\nextra markdown');
  assert.equal(trailed.action, "final");
  assert.equal(trailed.answer, "done");
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
  assert.equal(requiresWorkspaceTool("read src/index.ts"), true);
  assert.equal(requiresWorkspaceTool("read package.json"), true);
  assert.equal(requiresWorkspaceTool("search for AgentSession"), true);
  assert.equal(requiresWorkspaceTool("explain TypeScript interface"), false);
});

test("fallbackReadFilePath extracts explicit read targets", () => {
  assert.equal(fallbackReadFilePath("read README.md"), "README.md");
  assert.equal(fallbackReadFilePath("read src/index.ts"), "src/index.ts");
  assert.equal(fallbackReadFilePath("explain interface"), undefined);
});

test("finalClaimsToolUse detects unsupported claims", () => {
  assert.equal(finalClaimsToolUse("I read the file and it says hello."), true);
  assert.equal(finalClaimsToolUse("I inspected the workspace already."), true);
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
    const answer = await session.run("read README.md");
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
    const answer = await session.run("read README.md");
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
    const answer = await session.run("explain TypeScript interface");
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
    const answer = await session.run("read missing.md");
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
    const answer = await session.run("read README.md");
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
    '{"action":"final","answer":"## Goal\\nPlan the requested change.\\n\\n## Summary\\nUpdate README safely.\\n\\n## Relevant files\\n- README.md\\n\\n## Ordered steps\\n- Inspect README.md\\n- Implement the change\\n\\n## Validation commands\\n- npm test\\n\\n## Risks\\n- None known\\n\\n## Assumptions\\n- Existing README format stays.\\n\\n## Acceptance criteria\\n- README includes the requested update.\\n\\n## Open questions\\n- None"}'
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
    assert.equal(plan.summary, "Update README safely.");
    assert.ok(plan.files.some((file) => /README\.md/.test(file)));
    assert.ok(plan.acceptanceCriteria.some((item) => /README/.test(item)));
    assert.ok(plan.inspectionEvents.length >= 2);
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

test("AgentSession createPlan marks limited inspection when no tools are used", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-plan-limited-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: '{"action":"final","answer":"Goal: Plan only\\n\\nSummary: No workspace inspection.\\n\\nRelevant files:\\n- src/index.ts\\n\\nOrdered steps:\\n- Inspect later\\n\\nValidation commands:\\n- npm test\\n\\nRisks:\\n- Limited context\\n\\nAssumptions:\\n- Request is accurate\\n\\nAcceptance criteria:\\n- Plan is reviewable\\n\\nOpen questions:\\n- None"}' } }] });
  try {
    const session = await AgentSession.create(config(dir), () => undefined, async () => "allow_once");
    const plan = await session.createPlan("plan without reading");
    assert.equal(plan.statusReason, "limited inspection");
    assert.deepEqual(plan.inspectionEvents, []);
    assert.equal(plan.summary, "No workspace inspection.");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession executePlan rejects cancelled and repeated plans", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-plan-status-"));
  const originalFetch = globalThis.fetch;
  const responses = [
    '{"action":"final","answer":"Goal: Plan\\n\\nSummary: Safe plan.\\n\\nRelevant files:\\n- README.md\\n\\nOrdered steps:\\n- Edit\\n\\nValidation commands:\\n- npm test\\n\\nRisks:\\n- None\\n\\nAssumptions:\\n- None\\n\\nAcceptance criteria:\\n- Done\\n\\nOpen questions:\\n- None"}',
    '{"action":"final","answer":"Goal: Plan\\n\\nSummary: Execute once.\\n\\nRelevant files:\\n- README.md\\n\\nOrdered steps:\\n- Edit\\n\\nValidation commands:\\n- npm test\\n\\nRisks:\\n- None\\n\\nAssumptions:\\n- None\\n\\nAcceptance criteria:\\n- Done\\n\\nOpen questions:\\n- None"}',
    '{"action":"plan","todos":[{"content":"Execute approved plan","status":"in_progress"}]}',
    '{"action":"tool","tool":"read_tree","input":{"path":".","maxDepth":1},"thought":"Inspect before executing."}',
    '{"action":"final","answer":"executed"}'
  ];
  globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: responses.shift() } }] });
  try {
    const session = await AgentSession.create(config(dir), () => undefined, async () => "allow_once");
    const cancelled = await session.createPlan("cancel this");
    await session.cancelPlan(cancelled.id);
    await assert.rejects(() => session.executePlan(cancelled.id), /cancelled/);

    const executable = await session.createPlan("execute this");
    await session.executePlan(executable.id);
    await assert.rejects(() => session.executePlan(executable.id), /already been executed/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession executePlan prompt carries approved-plan constraints", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-plan-prompt-"));
  const originalFetch = globalThis.fetch;
  const calls: Array<{ body: { messages: Array<{ role: string; content: string }> } }> = [];
  const responses = [
    '{"action":"final","answer":"Goal: Plan\\n\\nSummary: Prompt check.\\n\\nRelevant files:\\n- README.md\\n\\nOrdered steps:\\n- Edit\\n\\nValidation commands:\\n- npm test\\n\\nRisks:\\n- Scope change\\n\\nAssumptions:\\n- None\\n\\nAcceptance criteria:\\n- Done\\n\\nOpen questions:\\n- None"}',
    '{"action":"plan","todos":[{"content":"Execute approved plan","status":"in_progress"}]}',
    '{"action":"tool","tool":"read_tree","input":{"path":".","maxDepth":1},"thought":"Inspect before executing."}',
    '{"action":"final","answer":"executed"}'
  ];
  globalThis.fetch = async (_url, init) => {
    calls.push({ body: JSON.parse(String(init?.body)) });
    return jsonResponse({ choices: [{ message: { content: responses.shift() } }] });
  };
  try {
    const session = await AgentSession.create(config(dir), () => undefined, async () => "allow_once");
    const plan = await session.createPlan("prompt constraints");
    await session.executePlan(plan.id);
    const userMessages = calls.flatMap((call) => call.body.messages.filter((message) => message.role === "user").map((message) => message.content));
    const executePrompt = userMessages.find((message) => /Execute this approved Mini Code plan/.test(message)) ?? "";
    assert.match(executePrompt, /Follow the approved plan/);
    assert.match(executePrompt, /deviate/);
    assert.match(executePrompt, /risk or scope change/i);
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

test("AgentSession treats plain markdown as final for ordinary questions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-markdown-final-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: "Hello, how can I help?" } }] });
  const events: AgentEvent[] = [];
  try {
    const session = await AgentSession.create(config(dir), (event) => events.push(event), async () => "allow_once");
    const answer = await session.run("hello");
    assert.equal(answer, "Hello, how can I help?");
    assert.equal(events.some((event) => event.type === "error" && event.category === "parse"), false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession still repairs plain markdown when workspace tools are required", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-markdown-tool-required-"));
  await writeFile(path.join(dir, "package.json"), "{\"name\":\"mini\"}\n", "utf8");
  const originalFetch = globalThis.fetch;
  const responses = [
    "package.json has a name field.",
    '{"action":"tool","tool":"read_file","input":{"path":"package.json"}}',
    '{"answer":"package.json name is mini."}'
  ];
  globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: responses.shift() } }] });
  const events: AgentEvent[] = [];
  try {
    const session = await AgentSession.create(config(dir, { maxTurns: 5 }), (event) => events.push(event), async () => "allow_once");
    const answer = await session.run("read package.json");
    assert.equal(answer, "package.json name is mini.");
    assert.ok(events.some((event) => event.type === "error" && event.category === "parse"));
    assert.ok(events.some((event) => event.type === "tool_request" && event.tool === "read_file"));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession records capability snapshot and exposes source-labelled tools", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-capabilities-"));
  try {
    const session = await AgentSession.create(config(dir, { toolsPolicy: "read_only" }), () => undefined, async () => "allow_once");
    const record = session.getRecord();
    assert.ok(record.capabilities?.some((capability) => capability.id === "builtin:read_file"));
    assert.match(session.describeTools(), /source=builtin/);
    assert.match(session.describeCapabilities(), /builtin:read_file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession exposes model config doctor features and login guidance", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-describe-config-"));
  try {
    const session = await AgentSession.create(config(dir, { apiKey: "", featureFlags: ["buddy", "remote-monitor"] }), () => undefined, async () => "allow_once");

    assert.match(session.describeModel(), /model\s+test-model/);
    assert.match(session.describeModel(), /field\s+value\s+source/);
    assert.match(session.describeConfig(), /features\s+buddy, remote-monitor/);
    assert.match(session.describeConfig(), /field\s+value\s+source/);
    assert.match(session.describeFeatures(), /buddy/);
    assert.match(session.describeDoctor(), /status\s+check\s+detail/);
    assert.match(session.describeDoctor(), /warn\s+apiKey\s+missing/);
    assert.match(session.describeLogin(), /OPENAI_API_KEY/);
    assert.match(session.describePermissions(), /scope\s+decision\s+detail/);
    assert.match(session.describePermissions(), /ordinary write\s+ask/);
    assert.match(session.describeStatusExtras(), /features=buddy, remote-monitor/);
    assert.match(session.describeStatus(), /field\s+value/);
    assert.match(session.describeStatus(), /skillsTotal/);
    assert.match(session.describeStatus(), /toolProtocol/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession manages persistent project config values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-project-config-"));
  try {
    const session = await AgentSession.create(config(dir), () => undefined, async () => "allow_once");

    assert.match(session.describeConfig(), /\/config set <key> <value>/);
    assert.match(session.describeProjectConfig(), /Project config is empty/);
    assert.match(await session.setProjectConfig("model", "configured-model"), /Set model=configured-model/);
    assert.equal(session.getProjectConfig("model"), "model=configured-model");
    assert.match(session.describeProjectConfig(), /model=configured-model/);
    assert.match(await session.unsetProjectConfig("model"), /Unset model/);
    assert.match(session.getProjectConfig("model"), /model is not set/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession reports estimated session cost usage", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-cost-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: '{"action":"final","answer":"done"}' } }] });
  try {
    const session = await AgentSession.create(config(dir), () => undefined, async () => "allow_once");
    await session.run("say done");
    const cost = session.describeCost();

    assert.match(cost, /cost:/);
    assert.match(cost, /modelResponses/);
    assert.match(cost, /totalTokens\s+~/);
    assert.match(cost, /Local estimate only/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession describes latest todos and recent tasks", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-tasks-"));
  const originalFetch = globalThis.fetch;
  const responses = [
    '{"action":"plan","todos":[{"content":"Inspect note","status":"in_progress"},{"content":"Report back","status":"pending"}]}',
    '{"action":"final","answer":"done"}'
  ];
  globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: responses.shift() } }] });
  try {
    const session = await AgentSession.create(config(dir), () => undefined, async () => "allow_once");
    assert.equal(session.describeTodos(), "todos: none");

    await session.run("make a small plan");

    assert.match(session.describeTodos(), /todos: done - make a small plan/);
    assert.match(session.describeTodos(), /Inspect note/);
    assert.match(session.describeTodos(), /Report back/);
    assert.match(session.describeTasks(), /tasks: showing 1 of 1/);
    assert.match(session.describeTasks(), /done/);
    assert.match(session.describeTasks(), /make a small plan/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession exposes release notes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-release-notes-"));
  try {
    const session = await AgentSession.create(config(dir), () => undefined, async () => "allow_once");
    const notes = session.describeReleaseNotes();

    assert.match(notes, /release notes:/);
    assert.match(notes, /Claude-like command surface/);
    assert.match(notes, /Agent skills/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession prepares a diagnostic bug report", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-bug-report-"));
  try {
    const session = await AgentSession.create(config(dir, { apiKey: "" }), () => undefined, async () => "allow_once");
    const report = session.describeBugReport("TUI froze after permission prompt");

    assert.match(report, /# Mini Code Bug Report/);
    assert.match(report, /TUI froze after permission prompt/);
    assert.match(report, /session:/);
    assert.match(report, /doctor:/);
    assert.match(report, /Remove secrets/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession manages CLAUDE.md memory and refreshes the active prompt", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-memory-"));
  try {
    const session = await AgentSession.create(config(dir), () => undefined, async () => "allow_once");

    assert.match(await session.describeMemory(), /No CLAUDE\.md files found/);
    assert.match(await session.describeMemorySources(), /project\s+no\s+0/);
    assert.match(await session.addMemory("project", "Always run npm test before final answers."), /Added project memory:/);
    assert.match(await readFile(path.join(dir, "CLAUDE.md"), "utf8"), /Always run npm test/);
    assert.match(await session.describeMemory(), /Always run npm test/);
    assert.match(session.getRecord().messages[0]?.content ?? "", /Always run npm test/);
    assert.match(await session.reloadMemory(), /Reloaded memory: 1 source/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession manages output styles and refreshes the active prompt", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-output-style-"));
  try {
    const session = await AgentSession.create(config(dir), () => undefined, async () => "allow_once");

    assert.match(session.describeOutputStyle(), /output style: default/);
    assert.match(await session.describeOutputStyles(), /concise/);
    assert.match(await session.setOutputStyle("concise"), /Set output style: concise/);
    assert.match(session.getRecord().messages[0]?.content ?? "", /Active style: concise/);
    assert.match(await readFile(path.join(dir, ".mini-code", "config.json"), "utf8"), /"outputStyle": "concise"/);

    assert.match(await session.createOutputStyle("Pair Coach", "Ask one clarifying question before broad refactors."), /Created output style pair-coach/);
    assert.match(session.describeOutputStyle(), /pair-coach/);
    assert.match(session.getRecord().messages[0]?.content ?? "", /Ask one clarifying question/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession describes and renames the current session", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-name-"));
  try {
    const session = await AgentSession.create(config(dir), () => undefined, async () => "allow_once");

    assert.match(session.describeSession(), new RegExp(`session: ${session.id}`));
    assert.match(await session.renameSession("  Review fixes  "), /renamed session: Review fixes/);
    assert.match(session.describeSession(), /title: Review fixes/);

    const loaded = await new SessionStore(path.join(dir, ".mini-code", "sessions")).load(session.id);
    assert.equal(loaded?.title, "Review fixes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession reports capability changes when resuming", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-capability-diff-"));
  try {
    const first = await AgentSession.create(config(dir, { enableMcp: false }), () => undefined, async () => "allow_once");
    const record = first.getRecord();
    record.capabilities = [{ id: "missing:old", kind: "mcp_tool", name: "old", description: "old", risk: "read", source: "mcp:old" }];
    await new (await import("../storage/sessionStore.js")).SessionStore(path.join(dir, ".mini-code", "sessions")).save(record);

    const resumed = await AgentSession.create(config(dir, { sessionId: record.id, enableMcp: false }), () => undefined, async () => "allow_once");

    assert.match(resumed.getCapabilityChangeSummary(), /Capability snapshot changed/);
    assert.match(resumed.getCapabilityChangeSummary(), /removed: missing:old/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession can use provider native tool protocol", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-native-tools-"));
  await writeFile(path.join(dir, "README.md"), "native tool content\n", "utf8");
  const originalFetch = globalThis.fetch;
  const responses = [
    { choices: [{ message: { tool_calls: [{ function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }] } }] },
    { choices: [{ message: { content: "{\"action\":\"final\",\"answer\":\"README.md contains native tool content.\"}" } }] }
  ];
  globalThis.fetch = async () => new Response(JSON.stringify(responses.shift()), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  try {
    const session = await AgentSession.create(config(dir, { toolProtocol: "native", maxTurns: 4 }), () => undefined, async () => "allow_once");
    const answer = await session.run("read README.md");
    assert.equal(answer, "README.md contains native tool content.");
    assert.equal(session.getRecord().tasks?.at(-1)?.toolCalls[0]?.tool, "read_file");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession can create a skill through the model-callable tool", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-create-skill-"));
  const originalFetch = globalThis.fetch;
  const responses = [
    '{"action":"tool","tool":"create_skill","input":{"name":"Review Helper","description":"Review code changes before commit","instructions":"- Inspect the current diff first.\\n- Report blockers before suggestions."},"thought":"A dedicated skill scaffold is needed."}',
    '{"action":"final","answer":"Created the review-helper skill."}'
  ];
  globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: responses.shift() } }] });
  const events: AgentEvent[] = [];
  try {
    const session = await AgentSession.create(config(dir, { maxTurns: 4 }), (event) => events.push(event), async () => "allow_once");
    const answer = await session.run("create a skill named Review Helper for reviewing code changes");
    const skillPath = path.join(dir, ".mini-code", "skills", "review-helper", "SKILL.md");

    assert.equal(answer, "Created the review-helper skill.");
    const skillText = await readFile(skillPath, "utf8");
    assert.match(skillText, /name: review-helper/);
    assert.match(skillText, /Inspect the current diff first/);
    assert.ok(session.getSkills().some((skill) => skill.name === "review-helper"));
    assert.ok(events.some((event) => event.type === "tool_request" && event.tool === "create_skill"));
    assert.ok(events.some((event) => event.type === "tool_result" && event.tool === "create_skill" && event.ok));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession runs project custom slash commands", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-custom-command-"));
  await mkdir(path.join(dir, ".claude", "commands"), { recursive: true });
  await writeFile(path.join(dir, ".claude", "commands", "review.md"), "Review the requested target and summarize blockers.\n", "utf8");
  const originalFetch = globalThis.fetch;
  const responses = [
    '{"action":"tool","tool":"read_tree","input":{"path":".","maxDepth":1},"thought":"Inspect requested target before reviewing."}',
    '{"action":"final","answer":"reviewed"}'
  ];
  const captured: string[] = [];
  globalThis.fetch = async (_url, init) => {
    captured.push(String(init?.body ?? ""));
    return jsonResponse({ choices: [{ message: { content: responses.shift() } }] });
  };
  try {
    const session = await AgentSession.create(config(dir), () => undefined, async () => "allow_once");
    const answer = await session.runCustomCommand("review", "src/core");

    assert.equal(answer, "reviewed");
    assert.ok(session.getCustomCommands().some((command) => command.name === "review"));
    assert.match(captured[0] ?? "", /Run custom command \/review/);
    assert.match(captured[0] ?? "", /User arguments: src\/core/);
    assert.match(captured[0] ?? "", /summarize blockers/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession runs project foreground subagents", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-subagent-"));
  await mkdir(path.join(dir, ".claude", "agents"), { recursive: true });
  await writeFile(path.join(dir, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Review with extra care\ntools: Read, Grep\n---\nAlways inspect the relevant files before finalizing.\n", "utf8");
  const originalFetch = globalThis.fetch;
  const responses = [
    '{"action":"tool","tool":"read_file","input":{"path":"README.md"},"thought":"Inspect scope."}',
    '{"action":"final","answer":"subagent reviewed"}'
  ];
  const captured: string[] = [];
  globalThis.fetch = async (_url, init) => {
    captured.push(String(init?.body ?? ""));
    return jsonResponse({ choices: [{ message: { content: responses.shift() } }] });
  };
  try {
    const session = await AgentSession.create(config(dir), () => undefined, async () => "allow_once");
    const answer = await session.useSubagent("reviewer", "check src/core");

    assert.equal(answer, "subagent reviewed");
    assert.ok(session.getSubagents().some((agent) => agent.name === "reviewer"));
    assert.match(session.describeSubagents(), /reviewer/);
    assert.match(session.inspectSubagent("reviewer"), /Review with extra care/);
    assert.match(captured[0] ?? "", /Run foreground subagent: reviewer/);
    assert.match(captured[0] ?? "", /Task:\\ncheck src\/core/);
    assert.match(captured[0] ?? "", /Always inspect the relevant files/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession runs SubagentStop hook after foreground subagent final answer", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-subagent-stop-"));
  const marker = path.join(dir, "subagent-stop.txt");
  await mkdir(path.join(dir, ".claude", "agents"), { recursive: true });
  await mkdir(path.join(dir, ".mini-code"), { recursive: true });
  await writeFile(path.join(dir, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Review code\ntools: Read\n---\nReview carefully.\n", "utf8");
  await writeFile(path.join(dir, ".mini-code", "settings.json"), JSON.stringify({
    hooks: {
      SubagentStop: [
        { matcher: "reviewer", hooks: [{ type: "command", command: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync(${JSON.stringify(JSON.stringify(marker))}, process.env.MINI_CODE_HOOK_SUBAGENT_NAME + ':' + process.env.MINI_CODE_HOOK_FINAL_ANSWER)"`, timeoutMs: 5000 }] }
      ]
    }
  }), "utf8");
  const originalFetch = globalThis.fetch;
  const responses = [
    '{"action":"tool","tool":"read_file","input":{"path":"README.md"},"thought":"Inspect scope."}',
    '{"action":"final","answer":"subagent done"}'
  ];
  try {
    globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: responses.shift() } }] });

    const session = await AgentSession.create(config(dir), () => undefined, async () => "allow_once");
    const answer = await session.useSubagent("reviewer", "check src");

    assert.equal(answer, "subagent done");
    assert.equal(await readFile(marker, "utf8"), "reviewer:subagent done");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession scopes foreground subagent tools from frontmatter", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-subagent-tools-"));
  await mkdir(path.join(dir, ".claude", "agents"), { recursive: true });
  await writeFile(path.join(dir, ".claude", "agents", "reader.md"), "---\nname: reader\ndescription: Read only\ntools: Read\n---\nRead carefully.\n", "utf8");
  const originalFetch = globalThis.fetch;
  const responses = [
    '{"action":"tool","tool":"write_file","input":{"path":"out.txt","content":"no"},"thought":"try write"}',
    '{"action":"tool","tool":"read_file","input":{"path":"README.md"},"thought":"read instead"}',
    '{"action":"final","answer":"read only done"}'
  ];
  const captured: string[] = [];
  try {
    globalThis.fetch = async (_url, init) => {
      captured.push(String(init?.body ?? ""));
      return jsonResponse({ choices: [{ message: { content: responses.shift() } }] });
    };

    const session = await AgentSession.create(config(dir), () => undefined, async () => "allow_once");
    const answer = await session.useSubagent("reader", "inspect README");

    assert.equal(answer, "read only done");
    assert.match(captured[0] ?? "", /read_file/);
    assert.doesNotMatch(captured[0] ?? "", /write_file/);
    assert.match(captured[1] ?? "", /cannot use tool write_file/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession creates and reloads project subagents", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-create-subagent-"));
  try {
    const session = await AgentSession.create(config(dir), () => undefined, async () => "allow_once");
    const output = await session.createSubagent("Bug Hunter", "Find likely defects");

    assert.match(output, /Created subagent bug-hunter/);
    assert.ok(session.getSubagents().some((agent) => agent.name === "bug-hunter"));
    assert.match(session.inspectSubagent("bug-hunter"), /Find likely defects/);
    assert.match(await readFile(path.join(dir, ".mini-code", "agents", "bug-hunter.md"), "utf8"), /name: bug-hunter/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession can create a subagent through the model-callable tool", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-create-subagent-tool-"));
  const originalFetch = globalThis.fetch;
  const responses = [
    '{"action":"tool","tool":"create_subagent","input":{"name":"Release Reviewer","description":"Review release readiness","instructions":"- Check changed files.\\n- Identify release blockers.","tools":["Read","Grep","Bash"]},"thought":"A dedicated release review subagent is needed."}',
    '{"action":"final","answer":"Created the release-reviewer subagent."}'
  ];
  const events: AgentEvent[] = [];
  try {
    globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: responses.shift() } }] });

    const session = await AgentSession.create(config(dir, { permissionMode: "accept_edits" }), (event) => events.push(event), async () => "allow_once");
    const answer = await session.run("create a subagent for release reviews");
    const agentPath = path.join(dir, ".mini-code", "agents", "release-reviewer.md");

    assert.equal(answer, "Created the release-reviewer subagent.");
    const agentText = await readFile(agentPath, "utf8");
    assert.match(agentText, /name: release-reviewer/);
    assert.match(agentText, /tools: Read, Grep, Bash/);
    assert.ok(session.getSubagents().some((agent) => agent.name === "release-reviewer"));
    assert.ok(events.some((event) => event.type === "tool_request" && event.tool === "create_subagent"));
    assert.ok(events.some((event) => event.type === "tool_result" && event.tool === "create_subagent" && event.ok));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession runs built-in review workflow with review-only instructions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-review-"));
  const originalFetch = globalThis.fetch;
  const captured: string[] = [];
  const responses = [
    '{"action":"tool","tool":"read_tree","input":{"path":".","maxDepth":1},"thought":"Inspect scope before reviewing."}',
    '{"action":"final","answer":"No findings."}'
  ];
  try {
    globalThis.fetch = async (_url, init) => {
      captured.push(String(init?.body ?? ""));
      return jsonResponse({ choices: [{ message: { content: responses.shift() } }] });
    };

    const session = await AgentSession.create(config(dir), () => undefined, async () => "allow_once");
    const answer = await session.runReview("src/core");

    assert.equal(answer, "No findings.");
    assert.match(captured[0] ?? "", /Review src\/core/);
    assert.match(captured[0] ?? "", /Act as a code reviewer/);
    assert.match(captured[0] ?? "", /Do not edit files or run mutating commands/);
    assert.match(captured[0] ?? "", /Prioritize findings by severity/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession describes and reloads configured hooks", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-hooks-"));
  try {
    await mkdir(path.join(dir, ".mini-code"), { recursive: true });
    const settingsPath = path.join(dir, ".mini-code", "settings.json");
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "read_file", hooks: [{ type: "command", command: "node pre.js" }] }
        ]
      }
    }), "utf8");

    const session = await AgentSession.create(config(dir), () => undefined, async () => "allow_once");
    assert.match(session.describeHooks(), /PreToolUse/);
    assert.match(session.describeHooks(), /node pre\.js/);

    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: "run_command", hooks: [{ type: "command", command: "node post.js" }] }
        ]
      }
    }), "utf8");
    const summary = await session.reloadHooks();
    assert.match(summary, /before=1 after=1/);
    assert.match(session.describeHooks(), /PostToolUse/);
    assert.match(session.describeHooks(), /node post\.js/);
    assert.doesNotMatch(session.describeHooks(), /node pre\.js/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession injects UserPromptSubmit hook stdout into the model request", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-prompt-hook-"));
  const originalFetch = globalThis.fetch;
  const captured: string[] = [];
  try {
    await mkdir(path.join(dir, ".mini-code"), { recursive: true });
    const node = JSON.stringify(process.execPath);
    await writeFile(path.join(dir, ".mini-code", "settings.json"), JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: `${node} -e "process.stdout.write('extra repo policy')"`, timeoutMs: 5000 }] }
        ]
      }
    }), "utf8");
    globalThis.fetch = async (_url, init) => {
      captured.push(String(init?.body ?? ""));
      return jsonResponse({ choices: [{ message: { content: '{"action":"final","answer":"done"}' } }] });
    };

    const session = await AgentSession.create(config(dir), () => undefined, async () => "allow_once");
    const answer = await session.run("explain interfaces");

    assert.equal(answer, "done");
    assert.match(captured[0] ?? "", /explain interfaces/);
    assert.match(captured[0] ?? "", /extra repo policy/);
    assert.match(captured[0] ?? "", /context from UserPromptSubmit hook/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession blocks the model request when UserPromptSubmit hook fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-prompt-hook-block-"));
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  try {
    await mkdir(path.join(dir, ".mini-code"), { recursive: true });
    const node = JSON.stringify(process.execPath);
    await writeFile(path.join(dir, ".mini-code", "settings.json"), JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: `${node} -e "console.error('blocked prompt'); process.exit(3)"`, timeoutMs: 5000 }] }
        ]
      }
    }), "utf8");
    globalThis.fetch = async () => {
      fetchCount += 1;
      return jsonResponse({ choices: [{ message: { content: '{"action":"final","answer":"unexpected"}' } }] });
    };
    const events: AgentEvent[] = [];

    const session = await AgentSession.create(config(dir), (event) => events.push(event), async () => "allow_once");
    const answer = await session.run("explain interfaces");

    assert.equal(fetchCount, 0);
    assert.match(answer, /Hook UserPromptSubmit failed/);
    assert.match(answer, /blocked prompt/);
    assert.ok(events.some((event) => event.type === "error" && event.category === "runtime"));
    assert.equal(session.getRecord().tasks?.at(-1)?.status, "failed");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession injects SessionStart hook stdout before the first model request", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-start-hook-"));
  const originalFetch = globalThis.fetch;
  const captured: string[] = [];
  try {
    await mkdir(path.join(dir, ".claude"), { recursive: true });
    const node = JSON.stringify(process.execPath);
    await writeFile(path.join(dir, ".claude", "settings.local.json"), JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: "startup", hooks: [{ type: "command", command: `${node} -e "process.stdout.write('session bootstrap context')"`, timeoutMs: 5000 }] }
        ]
      }
    }), "utf8");
    globalThis.fetch = async (_url, init) => {
      captured.push(String(init?.body ?? ""));
      return jsonResponse({ choices: [{ message: { content: '{"action":"final","answer":"done"}' } }] });
    };

    const session = await AgentSession.create(config(dir), () => undefined, async () => "allow_once");
    const answer = await session.run("explain interfaces");

    assert.equal(answer, "done");
    assert.match(captured[0] ?? "", /context from SessionStart hook/);
    assert.match(captured[0] ?? "", /session bootstrap context/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession runs Stop hook after a final answer", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-stop-hook-"));
  const originalFetch = globalThis.fetch;
  try {
    await mkdir(path.join(dir, ".mini-code"), { recursive: true });
    const marker = path.join(dir, "stop.txt").replaceAll("\\", "\\\\");
    const node = JSON.stringify(process.execPath);
    await writeFile(path.join(dir, ".mini-code", "settings.json"), JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: `${node} -e "require('fs').writeFileSync('${marker}', process.env.MINI_CODE_HOOK_FINAL_ANSWER)"`, timeoutMs: 5000 }] }
        ]
      }
    }), "utf8");
    globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: '{"action":"final","answer":"finished"}' } }] });

    const session = await AgentSession.create(config(dir), () => undefined, async () => "allow_once");
    const answer = await session.run("explain interfaces");

    assert.equal(answer, "finished");
    assert.equal(await readFile(path.join(dir, "stop.txt"), "utf8"), "finished");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession reports Stop hook failures without changing the final answer", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-stop-hook-fail-"));
  const originalFetch = globalThis.fetch;
  const events: AgentEvent[] = [];
  try {
    await mkdir(path.join(dir, ".mini-code"), { recursive: true });
    const node = JSON.stringify(process.execPath);
    await writeFile(path.join(dir, ".mini-code", "settings.json"), JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: `${node} -e "console.error('stop failed'); process.exit(5)"`, timeoutMs: 5000 }] }
        ]
      }
    }), "utf8");
    globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: '{"action":"final","answer":"finished"}' } }] });

    const session = await AgentSession.create(config(dir), (event) => events.push(event), async () => "allow_once");
    const answer = await session.run("explain interfaces");

    assert.equal(answer, "finished");
    assert.ok(events.some((event) => event.type === "error" && event.category === "runtime" && /Hook Stop failed/.test(event.error)));
    assert.ok(events.some((event) => event.type === "final" && event.answer === "finished"));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession runs PreCompact hook before manual compaction", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-precompact-hook-"));
  try {
    await mkdir(path.join(dir, ".mini-code"), { recursive: true });
    const marker = path.join(dir, "precompact.txt").replaceAll("\\", "\\\\");
    const node = JSON.stringify(process.execPath);
    await writeFile(path.join(dir, ".mini-code", "settings.json"), JSON.stringify({
      hooks: {
        PreCompact: [
          { matcher: "manual", hooks: [{ type: "command", command: `${node} -e "require('fs').writeFileSync('${marker}', process.env.MINI_CODE_HOOK_TRIGGER)"`, timeoutMs: 5000 }] }
        ]
      }
    }), "utf8");

    const session = await AgentSession.create(config(dir), () => undefined, async () => "allow_once");
    await session.forceCompact();

    assert.equal(await readFile(path.join(dir, "precompact.txt"), "utf8"), "manual");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession blocks manual compaction when PreCompact hook fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-precompact-hook-fail-"));
  const events: AgentEvent[] = [];
  try {
    await mkdir(path.join(dir, ".mini-code"), { recursive: true });
    const node = JSON.stringify(process.execPath);
    await writeFile(path.join(dir, ".mini-code", "settings.json"), JSON.stringify({
      hooks: {
        PreCompact: [
          { matcher: "manual", hooks: [{ type: "command", command: `${node} -e "console.error('no compact'); process.exit(4)"`, timeoutMs: 5000 }] }
        ]
      }
    }), "utf8");

    const session = await AgentSession.create(config(dir), (event) => events.push(event), async () => "allow_once");
    await session.forceCompact();

    assert.ok(events.some((event) => event.type === "error" && event.category === "runtime" && /Hook PreCompact failed/.test(event.error)));
    assert.equal(events.some((event) => event.type === "compaction"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession runs Notification hook when waiting for permission", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-notification-hook-"));
  const originalFetch = globalThis.fetch;
  try {
    await mkdir(path.join(dir, ".mini-code"), { recursive: true });
    const marker = path.join(dir, "notification.txt").replaceAll("\\", "\\\\");
    const node = JSON.stringify(process.execPath);
    await writeFile(path.join(dir, ".mini-code", "settings.json"), JSON.stringify({
      hooks: {
        Notification: [
          { matcher: "permission_required", hooks: [{ type: "command", command: `${node} -e "require('fs').writeFileSync('${marker}', process.env.MINI_CODE_HOOK_NOTIFICATION_TYPE + ':' + process.env.MINI_CODE_HOOK_NOTIFICATION_MESSAGE)"`, timeoutMs: 5000 }] }
        ]
      }
    }), "utf8");
    const responses = [
      '{"action":"tool","tool":"run_command","input":{"command":"node -e \\"console.log(1)\\""}}',
      '{"action":"final","answer":"done"}'
    ];
    globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: responses.shift() } }] });

    const session = await AgentSession.create(config(dir), () => undefined, async () => "allow_once");
    const answer = await session.run("run a command");

    assert.equal(answer, "done");
    const markerText = await readFile(path.join(dir, "notification.txt"), "utf8");
    assert.match(markerText, /^permission_required:/);
    assert.match(markerText, /Shell command requires approval/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});



test("AgentSession runs PreToolUse before permission prompts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-pretool-before-permission-"));
  const originalFetch = globalThis.fetch;
  const events: AgentEvent[] = [];
  try {
    await mkdir(path.join(dir, ".mini-code"), { recursive: true });
    const node = JSON.stringify(process.execPath);
    await writeFile(path.join(dir, ".mini-code", "settings.json"), JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "run_command", hooks: [{ type: "command", command: `${node} -e "process.stdout.write(JSON.stringify({ decision: 'block', reason: 'blocked before permission' }))"`, timeoutMs: 5000 }] }
        ]
      }
    }), "utf8");
    const responses = [
      '{"action":"tool","tool":"run_command","input":{"command":"node -e \\\"console.log(1)\\\""}}',
      '{"action":"final","answer":"blocked"}'
    ];
    globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: responses.shift() } }] });

    const session = await AgentSession.create(config(dir), (event) => events.push(event), async () => "allow_once");
    const answer = await session.run("run a blocked command");

    assert.equal(answer, "blocked");
    assert.equal(events.some((event) => event.type === "permission_request"), false);
    assert.ok(events.some((event) => event.type === "tool_result" && event.tool === "run_command" && !event.ok && /blocked before permission/.test(event.output)));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});
test("AgentSession blocks tool execution from JSON hook decision output", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-json-hook-block-"));
  const originalFetch = globalThis.fetch;
  const events: AgentEvent[] = [];
  try {
    await mkdir(path.join(dir, ".mini-code"), { recursive: true });
    const node = JSON.stringify(process.execPath);
    await writeFile(path.join(dir, ".mini-code", "settings.json"), JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "write_file", hooks: [{ type: "command", command: `${node} -e "process.stdout.write(JSON.stringify({ decision: 'block', reason: 'blocked by hook json' }))"`, timeoutMs: 5000 }] }
        ]
      }
    }), "utf8");
    const responses = [
      '{"action":"tool","tool":"write_file","input":{"path":"blocked.txt","content":"nope"}}',
      '{"action":"final","answer":"blocked"}'
    ];
    globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: responses.shift() } }] });

    const session = await AgentSession.create(config(dir, { permissionMode: "accept_edits" }), (event) => events.push(event), async () => "allow_once");
    const answer = await session.run("write a blocked file");

    assert.equal(answer, "blocked");
    await assert.rejects(() => readFile(path.join(dir, "blocked.txt"), "utf8"));
    assert.ok(events.some((event) => event.type === "tool_result" && event.tool === "write_file" && !event.ok && /blocked by hook json/.test(event.output)));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession allows matching settings permission without prompting", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-settings-allow-"));
  const originalFetch = globalThis.fetch;
  const events: AgentEvent[] = [];
  let approvalCalls = 0;
  try {
    await mkdir(path.join(dir, ".mini-code"), { recursive: true });
    await writeFile(path.join(dir, ".mini-code", "settings.json"), JSON.stringify({
      permissions: {
        allow: ["Bash(node -e *)"]
      }
    }), "utf8");
    const responses = [
      '{"action":"tool","tool":"run_command","input":{"command":"node -e \\"console.log(1)\\""}}',
      '{"action":"final","answer":"done"}'
    ];
    globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: responses.shift() } }] });

    const session = await AgentSession.create(config(dir), (event) => events.push(event), async () => {
      approvalCalls += 1;
      return "deny";
    });
    const answer = await session.run("run a settings-allowed command");

    assert.equal(answer, "done");
    assert.equal(approvalCalls, 0);
    assert.equal(events.some((event) => event.type === "permission_request"), false);
    assert.ok(events.some((event) => event.type === "tool_result" && event.tool === "run_command" && event.ok));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession edits and reloads permission settings", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-permission-edit-"));
  const originalFetch = globalThis.fetch;
  const events: AgentEvent[] = [];
  let approvalCalls = 0;
  try {
    const session = await AgentSession.create(config(dir), (event) => events.push(event), async () => {
      approvalCalls += 1;
      return "deny";
    });
    assert.match(await session.addPermissionRule("allow", "Bash(node -e *)"), /Added permission rule/);
    assert.match(session.describePermissions(), /allow:Bash\(node -e \*\)/);

    const responses = [
      '{"action":"tool","tool":"run_command","input":{"command":"node -e \\"console.log(1)\\""}}',
      '{"action":"final","answer":"done"}'
    ];
    globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: responses.shift() } }] });
    assert.equal(await session.run("run allowed command"), "done");
    assert.equal(approvalCalls, 0);
    assert.equal(events.some((event) => event.type === "permission_request"), false);

    assert.match(await session.removePermissionRule("allow", "Bash(node -e *)"), /Removed permission rule/);
    assert.match(await session.reloadPermissions(), /Reloaded permissions/);
    assert.doesNotMatch(session.describePermissions(), /allow:Bash\(node -e \*\)/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentSession blocks matching settings deny rule without prompting", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-settings-deny-"));
  const originalFetch = globalThis.fetch;
  const events: AgentEvent[] = [];
  let approvalCalls = 0;
  try {
    await mkdir(path.join(dir, ".mini-code"), { recursive: true });
    await writeFile(path.join(dir, ".mini-code", "settings.json"), JSON.stringify({
      permissions: {
        deny: ["Bash(node -e *)"]
      }
    }), "utf8");
    const responses = [
      '{"action":"tool","tool":"run_command","input":{"command":"node -e \\"console.log(1)\\""}}',
      '{"action":"final","answer":"blocked"}'
    ];
    globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: responses.shift() } }] });

    const session = await AgentSession.create(config(dir), (event) => events.push(event), async () => {
      approvalCalls += 1;
      return "allow_once";
    });
    const answer = await session.run("run a settings-denied command");

    assert.equal(answer, "blocked");
    assert.equal(approvalCalls, 0);
    assert.ok(events.some((event) => event.type === "permission_request" && event.requirement.blocked));
    assert.ok(events.some((event) => event.type === "tool_result" && event.tool === "run_command" && !event.ok && /Blocked by settings permission rule/.test(event.output)));
  } finally {
    globalThis.fetch = originalFetch;
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
    includeGlobalSkills: false,
    outputStyle: "default",
    maxContextMessages: 40,
    maxToolOutputChars: 12_000,
    plain: false,
    ...overrides
  };
}

function jsonResponse(body: unknown): Response {
  const content = (body as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
  const stream = [
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`,
    "data: [DONE]",
    ""
  ].join("\n\n");
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}
