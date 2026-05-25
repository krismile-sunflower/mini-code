import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approvalRows,
  approvalCardRows,
  blockedApprovalText,
  claudeActivityLines,
  claudeDisplay,
  codeChangeFromToolRequest,
  codeChangeFromToolResult,
  commandGroups,
  detailForItem,
  diffSummary,
  emptyStates,
  estimateRunUsage,
  estimateTextTokens,
  eventToTimelineItems,
  extractDisplayMarkdown,
  headerFields,
  asciiArt,
  inputStatusModel,
  markdownPreview,
  nextPermissionMode,
  normalizeDisplayMarkdown,
  outputPreview,
  piLikeModelEventsToTimeline,
  permissionModeLabel,
  planSummaryRows,
  renderDiffLines,
  renderCommandHelp,
  skillPickerRows,
  slashCommands,
  stateColor,
  statusModel,
  timelineLabel,
  timelineMarkdownLines,
  timelineRenderBlocks,
  tokenizeCodeLine,
  todoLabel,
  toolRequestLabel,
  filterCommandsAndSkills,
  welcomeTips
} from "./renderModel.js";
import type { AgentConfig, PendingApproval, PlanRecord } from "../core/types.js";

test("eventToTimelineItems splits thought and tool request", () => {
  const items = eventToTimelineItems({
    type: "tool_request",
    turn: 2,
    tool: "read_file",
    input: { path: "src/index.ts" },
    thought: "Need to inspect the entrypoint.",
    description: "Read src/index.ts"
  });
  assert.equal(items.length, 2);
  assert.equal(items[0]?.kind, "thinking");
  assert.equal(items[1]?.kind, "tool_request");
});

test("eventToTimelineItems maps Pi-like stream text and thinking deltas", () => {
  const items = eventToTimelineItems({
    type: "model_response",
    raw: "stream",
    streamEvents: [
      { type: "thinking_delta", text: "Need context. " },
      { type: "text_delta", text: "I will inspect files." }
    ]
  });
  assert.equal(items[0]?.kind, "thinking");
  assert.equal(items[1]?.kind, "assistant_text");
  assert.equal(piLikeModelEventsToTimeline([{ type: "text_delta", text: "{\"action\":\"final\",\"answer\":\"ok\"}" }]).length, 0);
});

test("eventToTimelineItems maps plan events", () => {
  const items = eventToTimelineItems({
    type: "plan",
    turn: 1,
    todos: [
      { id: "1", content: "Inspect files", status: "in_progress" },
      { id: "2", content: "Patch code", status: "pending" }
    ]
  });
  assert.equal(items[0]?.kind, "plan");
  assert.equal(todoLabel({ id: "1", content: "Inspect files", status: "in_progress" }), "[>] Inspect files");
  assert.equal(todoLabel({ id: "2", content: "Patch code", status: "pending" }), "[ ] Patch code");
  assert.equal(todoLabel({ id: "3", content: "Done", status: "completed" }), "[x] Done");
});

test("toolRequestLabel summarizes common tool inputs", () => {
  assert.equal(
    toolRequestLabel({ kind: "tool_request", turn: 1, tool: "run_command", description: "Run command", input: { command: "npm test" } }),
    "run_command npm test"
  );
  assert.equal(
    toolRequestLabel({ kind: "tool_request", turn: 1, tool: "read_many_files", description: "Read files", input: { paths: ["a.ts", "b.ts"] } }),
    "read_many_files a.ts, b.ts"
  );
});

test("approvalRows includes risk, tool, action, and details", () => {
  const rows = approvalRows(pendingApproval());
  assert.deepEqual(rows.slice(0, 3), [
    { label: "risk", value: "shell" },
    { label: "tool", value: "run_command" },
    { label: "action", value: "Run command: npm test" }
  ]);
  assert.ok(rows.some((row) => row.label === "prefix" && row.value === "npm test"));
  assert.ok(rows.some((row) => row.label === "approvalKey" && row.value === "shell:exact:npm test"));
  assert.ok(rows.some((row) => row.label === "scope" && row.value === "npm test"));
  assert.ok(rows.some((row) => row.label === "scopeType" && row.value === "command prefix"));
  assert.ok(rows.some((row) => row.label === "rememberPolicy" && row.value === "command prefix"));
  assert.ok(rows.some((row) => row.label === "riskReason" && /Low-risk/.test(row.value)));
});

test("approvalCardRows exposes fixed Claude Code style fields", () => {
  const rows = approvalCardRows(pendingApproval());

  assert.deepEqual(rows.map((row) => row.label), ["risk", "scope", "reason", "remember", "command", "path"]);
  assert.equal(rows.find((row) => row.label === "risk")?.value, "shell");
  assert.equal(rows.find((row) => row.label === "scope")?.value, "npm test");
  assert.match(rows.find((row) => row.label === "reason")?.value ?? "", /requires approval/);
  assert.equal(rows.find((row) => row.label === "remember")?.value, "command prefix");
  assert.equal(rows.find((row) => row.label === "command")?.value, "npm test");
});

test("blockedApprovalText hides allow actions for blocked approvals", () => {
  const approval = pendingApproval();
  approval.requirement.blocked = true;
  approval.requirement.denied = true;
  assert.doesNotMatch(blockedApprovalText(approval), /allow once/i);
  assert.match(blockedApprovalText(approval), /Blocked/);
});

test("blockedApprovalText names the remembered approval scope", () => {
  assert.match(blockedApprovalText(pendingApproval()), /always allow this command prefix/);
});

test("eventToTimelineItems maps validation tool results", () => {
  const items = eventToTimelineItems({ type: "tool_result", turn: 1, tool: "read_file", ok: false, output: "bad input", errorType: "validation" });
  assert.equal(items[0]?.kind, "tool_result");
  assert.equal(items[0]?.kind === "tool_result" ? items[0].status : undefined, "validation_error");
});

test("apply_patch tool request creates a planned code change item", () => {
  const event = {
    type: "tool_request" as const,
    turn: 1,
    tool: "apply_patch",
    description: "Apply patch",
    input: { patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n" }
  };
  const items = eventToTimelineItems(event);
  const change = items.find((item) => item.kind === "code_change");
  assert.equal(change?.kind, "code_change");
  assert.equal(change?.kind === "code_change" ? change.status : undefined, "planned");
  assert.match(change?.kind === "code_change" ? change.summary : "", /edit a\.txt \+1 -1/);
  assert.equal(codeChangeFromToolRequest(event)?.files[0], "a.txt");
});

test("git_apply_check tool request creates a checked code change item", () => {
  const change = codeChangeFromToolRequest({
    type: "tool_request",
    turn: 1,
    tool: "git_apply_check",
    description: "Check patch",
    input: { patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n" }
  });
  assert.equal(change?.status, "checked");
  assert.match(change?.summary ?? "", /check a\.txt \+1 -1/);
});

test("tool result diff metadata creates an applied code change item", () => {
  const change = codeChangeFromToolResult({
    type: "tool_result",
    turn: 2,
    tool: "replace_text",
    ok: true,
    output: "Updated a.txt",
    metadata: {
      path: "a.txt",
      diff: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n"
    }
  });
  assert.equal(change?.status, "applied");
  assert.equal(timelineLabel(change!).marker, "edit");
});

test("timeline labels map high-signal states to stable markers and colors", () => {
  assert.deepEqual(timelineLabel({ kind: "user", text: "hello" }), { marker: "user", color: "white", text: "hello", severity: "neutral" });
  assert.equal(timelineLabel({ kind: "plan", turn: 1, todos: [{ id: "1", content: "Read", status: "completed" }] }).marker, "plan");
  assert.equal(timelineLabel({ kind: "tool_request", turn: 1, tool: "read_file", description: "Read", input: { path: "package.json" } }).color, "blue");
  assert.equal(timelineLabel({ kind: "code_change", tool: "apply_patch", status: "planned", files: ["a.txt"], diff: "", summary: "edit a.txt +1 -1" }).marker, "edit");
  assert.equal(timelineLabel({ kind: "tool_result", turn: 1, tool: "read_file", ok: true, output: "ok", status: "ok" }).severity, "success");
  assert.equal(timelineLabel({ kind: "tool_result", turn: 1, tool: "read_file", ok: false, output: "bad", status: "validation_error" }).color, "yellow");
  assert.equal(timelineLabel({ kind: "permission", text: "Blocked", risk: "dangerous", blocked: true }).marker, "blocked");
  assert.equal(timelineLabel({ kind: "final", text: "Done" }).color, "green");
  assert.equal(timelineLabel({ kind: "final", text: "# Done\n\n- item" }).text, "answer");
  assert.equal(timelineLabel({ kind: "assistant_text", text: "Long markdown" }).text, "message");
  assert.equal(timelineLabel({ kind: "error", category: "runtime", text: "Boom\nStack line" }).text, "Boom");
  assert.equal(timelineLabel({ kind: "error", category: "runtime", text: "Boom" }).severity, "danger");
});

test("claudeDisplay maps conversation roles to Claude Code style rows", () => {
  const user = claudeDisplay({ kind: "user", text: "当前项目的 package.json 里面有什么" });
  assert.equal(user.role, "user");
  assert.equal(user.marker, ">");
  assert.equal(user.background, "#3a3a3a");

  const final = claudeDisplay({ kind: "final", text: "完成" });
  assert.equal(final.role, "assistant");
  assert.equal(final.marker, "●");

  const session = claudeDisplay({ kind: "session", text: "status" });
  assert.equal(session.role, "system");
  assert.equal(session.textColor, "gray");
});

test("claudeActivityLines renders read and thinking activity compactly", () => {
  const pending = claudeActivityLines([
    { kind: "thinking", turn: 1, text: "Need to read package metadata." },
    { kind: "tool_request", turn: 1, tool: "read_file", description: "Read package.json", input: { path: "package.json" } }
  ], false, { running: true, elapsedSeconds: 7, outputTokens: 15, thoughtTokens: 10 });
  assert.match(pending.map((line) => line.text).join("\n"), /Reading 1 file\.\.\. \(ctrl\+o to expand\)/);
  assert.match(pending.map((line) => line.text).join("\n"), /Blanching/);
  assert.match(pending.map((line) => line.text).join("\n"), /down 15 tokens \| thought for 7s/);

  const completed = claudeActivityLines([
    { kind: "tool_request", turn: 1, tool: "read_many_files", description: "Read files", input: { paths: ["a.ts", "b.ts"] } },
    { kind: "tool_result", turn: 1, tool: "read_many_files", ok: true, output: "ok", status: "ok" }
  ], false);
  assert.match(completed[0]?.text ?? "", /Read 2 files/);

  const withoutClock = claudeActivityLines([
    { kind: "thinking", turn: 1, text: "Need package metadata." }
  ], false);
  assert.doesNotMatch(withoutClock.map((line) => line.text).join("\n"), /Blanching/);
  assert.doesNotMatch(withoutClock.map((line) => line.text).join("\n"), /thought for 2s/);
});

test("claudeActivityLines deduplicates repeated compact activity rows", () => {
  const lines = claudeActivityLines([
    { kind: "tool_request", turn: 1, tool: "read_file", description: "Read package.json", input: { path: "package.json" } },
    { kind: "tool_request", turn: 2, tool: "read_file", description: "Read package.json", input: { path: "package.json" } },
    { kind: "tool_request", turn: 3, tool: "read_file", description: "Read package.json", input: { path: "package.json" } },
    { kind: "thinking", turn: 1, text: "Need package metadata." },
    { kind: "thinking", turn: 2, text: "Still checking package metadata." },
    { kind: "thinking", turn: 3, text: "Final check." }
  ], false, { running: true, elapsedSeconds: 24, outputTokens: 0, thoughtTokens: 94 });
  assert.equal(lines.filter((line) => /Reading 1 file/.test(line.text)).length, 1);
  assert.equal(lines.filter((line) => /Blanching/.test(line.text)).length, 1);
  assert.match(lines.map((line) => line.text).join("\n"), /thought for 24s/);
});

test("estimateRunUsage and inputStatusModel render dynamic footer state", () => {
  assert.ok(estimateTextTokens("package 文件里面有什么") > 0);
  const usage = estimateRunUsage([
    { kind: "user", text: "package 文件里面有什么" },
    { kind: "user", text: "queued follow up", queued: true },
    { kind: "thinking", turn: 1, text: "Need package metadata." },
    { kind: "tool_request", turn: 1, tool: "read_file", description: "Read package.json", input: { path: "package.json" } }
  ], "Reading result", 4);
  assert.equal(usage.toolCount, 1);
  assert.equal(usage.elapsedSeconds, 4);
  assert.equal(usage.lastActivity, "tool");

  const status = statusModel({
    config: config(),
    sessionId: "session",
    turn: 1,
    busy: true,
    approval: undefined,
    messageCount: 3,
    hasSummary: false
  });
  const footer = inputStatusModel({ status, promptInput: "", usage, hasConversation: true, expanded: false, detailsVisible: false, aborting: false, queueCount: 2 });
  assert.match(footer.runningLine ?? "", /Using tools/);
  assert.match(footer.runningLine ?? "", /esc/);
  assert.match(footer.runningLine ?? "", /queued 2/);
  assert.doesNotMatch(footer.runningLine ?? "", /openai:test-model/);
  assert.match(footer.usageLine, /openai:test-model/);
  assert.match(footer.usageLine, /queued 2/);
  assert.match(footer.hintLine ?? "", /ctrl\+o to expand/);
});

test("output previews point users to ctrl+o expansion", () => {
  const preview = outputPreview(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"), false);
  assert.match(preview, /type \/expand or press ctrl\+o/);
});

test("tokenizeCodeLine highlights JSON-like code without dependencies", () => {
  const tokens = tokenizeCodeLine('  "name": "mini", "private": true, "count": 2', "json");
  assert.ok(tokens.some((token) => token.kind === "key" && token.text === '"name"'));
  assert.ok(tokens.some((token) => token.kind === "string" && token.text === '"mini"'));
  assert.ok(tokens.some((token) => token.kind === "boolean" && token.text === "true"));
  assert.ok(tokens.some((token) => token.kind === "number" && token.text === "2"));
  assert.ok(tokens.some((token) => token.kind === "punctuation" && token.text === ":"));
});

test("eventToTimelineItems folds protocol correction noise", () => {
  const items = eventToTimelineItems({ type: "error", category: "protocol", error: "A workspace tool is required before the final answer. Asking the model to call a tool." });
  assert.deepEqual(items, []);
});

test("eventToTimelineItems hides parse noise and unwraps final markdown", () => {
  assert.deepEqual(eventToTimelineItems({ type: "error", category: "parse", error: "Unexpected non-whitespace character after JSON" }), []);
  const final = eventToTimelineItems({ type: "final", answer: '{"answer":"你好！有什么可以帮你的？"}' });
  assert.equal(final[0]?.kind, "final");
  assert.equal(final[0]?.kind === "final" ? final[0].text : "", "你好！有什么可以帮你的？");
});

test("extractDisplayMarkdown strips protocol wrappers", () => {
  assert.equal(extractDisplayMarkdown('{"action":"final","answer":"# 标题\\n\\n正文"}'), "# 标题\n\n正文");
  assert.equal(extractDisplayMarkdown('```json\n{"answer":"ok"}\n```'), "ok");
  assert.equal(extractDisplayMarkdown("# Already markdown"), "# Already markdown");
  assert.equal(piLikeModelEventsToTimeline([{ type: "text_delta", text: '{"answer":"ok"}' }]).length, 0);
});

test("normalizeDisplayMarkdown restores escaped markdown before parsing", () => {
  assert.equal(normalizeDisplayMarkdown('"#### Title\\n- item"'), "#### Title\n- item");
  assert.equal(normalizeDisplayMarkdown('{"answer":"#### Title\\n- item"}'), "#### Title\n- item");
  const lines = markdownPreview('{"answer":"#### Current goal\\n- Add `skill` file\\n- Verify"}', false);
  assert.equal(lines[0]?.kind, "heading");
  assert.equal(lines[1]?.kind, "bullet");
  assert.equal(lines[2]?.kind, "bullet");
});

test("markdown parser accepts lightly indented markdown structures", () => {
  const lines = markdownPreview("  #### Title\n  - item\n  1. next", false);
  assert.equal(lines[0]?.kind, "heading");
  assert.equal(lines[1]?.kind, "bullet");
  assert.equal(lines[2]?.kind, "ordered");
});

test("detailForItem adds provider error suggestions", () => {
  const detail = detailForItem({ kind: "error", category: "runtime", text: "Invalid input[7].call_id: empty string" }, false);
  assert.match(detail?.body ?? "", /Provider rejected tool-message shape/);
  assert.equal(detail?.type, "error");
});

test("detailForItem renders code changes with colored diff lines", () => {
  const detail = detailForItem({
    kind: "code_change",
    tool: "apply_patch",
    status: "planned",
    files: ["a.txt"],
    diff: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
    summary: "edit a.txt +1 -1"
  }, false);
  assert.equal(detail?.type, "code_change");
  assert.equal(detail?.diffLines?.some((line) => line.text === "-old" && line.color === "red"), true);
  assert.equal(detail?.diffLines?.some((line) => line.text === "+new" && line.color === "green"), true);
  assert.match(diffSummary("--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n"), /edit a\.txt \+1 -1/);
});

test("renderDiffLines clips long diffs unless expanded", () => {
  const diff = Array.from({ length: 40 }, (_, index) => `+line ${index}`).join("\n");
  assert.match(renderDiffLines(diff, false).at(-1)?.text ?? "", /truncated/);
  assert.doesNotMatch(renderDiffLines(diff, true).at(-1)?.text ?? "", /truncated/);
});

test("outputPreview clips long output unless expanded", () => {
  const output = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
  assert.match(outputPreview(output, false), /truncated/);
  assert.doesNotMatch(outputPreview(output, true), /truncated/);
});

test("timeline markdown expands answers but collapses tools and errors by default", () => {
  const finalLines = timelineMarkdownLines({ kind: "final", text: "# Answer\n\n- item" }, false);
  assert.equal(finalLines?.[0]?.kind, "heading");
  assert.equal(finalLines?.[1]?.kind, "blank");
  assert.equal(finalLines?.[2]?.kind, "bullet");

  assert.equal(timelineMarkdownLines({ kind: "tool_request", turn: 1, tool: "read_file", description: "Read", input: { path: "package.json" } }, false), undefined);
  assert.equal(timelineMarkdownLines({ kind: "tool_result", turn: 1, tool: "read_file", ok: true, output: "{\n  \"name\": \"mini\"\n}", status: "ok" }, false), undefined);
  assert.equal(timelineMarkdownLines({ kind: "error", category: "parse", text: "Unexpected JSON\nposition 1" }, false), undefined);

  const expandedTool = timelineMarkdownLines({ kind: "tool_request", turn: 1, tool: "read_file", description: "Read", input: { path: "package.json" } }, true);
  assert.equal(expandedTool?.[0]?.kind, "code");
  assert.match(expandedTool?.map((line) => line.text).join("\n") ?? "", /package\.json/);

  const expandedError = timelineMarkdownLines({ kind: "error", category: "parse", text: "Unexpected JSON\nposition 1" }, true);
  assert.match(expandedError?.map((line) => line.text).join("\n") ?? "", /Unexpected JSON/);
});

test("timeline filtering hides internal payloads and empty activity in compact mode", () => {
  const internal = timelineRenderBlocks([
    { kind: "assistant_text", text: '{"tool":"read_file","input":{"path":"package.json"}}' },
    { kind: "thinking", turn: 1, text: "raw thought only" },
    { kind: "final", text: '{"answer":"#### Done\\n- ok"}' }
  ], "", false);
  assert.equal(internal.length, 1);
  assert.equal(internal[0]?.kind, "message");
  assert.equal(internal[0]?.kind === "message" ? internal[0].item.kind : undefined, "final");
  assert.equal(internal[0]?.kind === "message" ? internal[0].markdown?.[0]?.kind : undefined, "heading");

  const expanded = timelineRenderBlocks([
    { kind: "tool_request", turn: 1, tool: "read_file", description: "Read", input: { path: "package.json" } },
    { kind: "tool_result", turn: 1, tool: "read_file", ok: true, output: "raw output", status: "ok", metadata: { path: "package.json" } }
  ], "", true);
  assert.match(expanded[0]?.kind === "activity" ? expanded[0].details.join("\n") : "", /raw output/);
});

test("timelineRenderBlocks groups operational activity between messages", () => {
  const blocks = timelineRenderBlocks([
    { kind: "user", text: "What is in package.json?" },
    { kind: "thinking", turn: 1, text: "Need to inspect package metadata." },
    { kind: "tool_request", turn: 1, tool: "read_file", description: "Read package.json", input: { path: "package.json" } },
    { kind: "tool_result", turn: 1, tool: "read_file", ok: true, output: "{\n  \"name\": \"mini-code-agent\"\n}", status: "ok", metadata: { path: "package.json" } },
    { kind: "tool_request", turn: 1, tool: "run_command", description: "Run npm test", input: { command: "npm test" } },
    { kind: "tool_result", turn: 1, tool: "run_command", ok: true, output: "passed", status: "ok", metadata: { command: "npm test" } },
    { kind: "final", text: "# Result\n\n- name: mini-code-agent" }
  ], "", false);

  assert.equal(blocks.length, 3);
  assert.equal(blocks[0]?.kind, "message");
  assert.equal(blocks[0]?.kind === "message" ? blocks[0].item.kind : undefined, "user");
  assert.equal(blocks[1]?.kind, "activity");
  assert.match(blocks[1]?.kind === "activity" ? blocks[1].summary : "", /inspected 1/);
  assert.match(blocks[1]?.kind === "activity" ? blocks[1].summary : "", /ran 1 command/);
  assert.deepEqual(blocks[1]?.kind === "activity" ? blocks[1].details : [], []);
  assert.equal(blocks[2]?.kind, "message");
  assert.equal(blocks[2]?.kind === "message" ? blocks[2].item.kind : undefined, "final");
  assert.equal(blocks[2]?.kind === "message" ? blocks[2].markdown?.[0]?.kind : undefined, "heading");
});

test("timelineRenderBlocks keeps errors separate and expands activity details", () => {
  const blocks = timelineRenderBlocks([
    { kind: "tool_request", turn: 1, tool: "search", description: "Search source", input: { query: "timeline" } },
    { kind: "tool_result", turn: 1, tool: "search", ok: true, output: "src/ui/App.tsx", status: "ok" },
    { kind: "error", category: "parse", text: "Unexpected non-whitespace character after JSON\nposition 180" }
  ], "Summarizing\n- done", true);

  assert.equal(blocks[0]?.kind, "activity");
  assert.match(blocks[0]?.kind === "activity" ? blocks[0].summary : "", /inspected 1/);
  assert.match(blocks[0]?.kind === "activity" ? blocks[0].details.join("\n") : "", /called search/);
  assert.equal(blocks[1]?.kind, "message");
  assert.equal(blocks[1]?.kind === "message" ? blocks[1].item.kind : undefined, "error");
  assert.equal(blocks[2]?.kind, "message");
  assert.equal(blocks[2]?.kind === "message" ? blocks[2].item.kind : undefined, "assistant_text");
  assert.match(blocks[2]?.kind === "message" && blocks[2].item.kind === "assistant_text" ? blocks[2].item.text : "", /Summarizing/);
});

test("plan record renders as compact ready message and expands markdown", () => {
  const plan = planRecord();
  const compact = timelineRenderBlocks([{ kind: "plan_record", plan }], "", false);
  assert.equal(compact[0]?.kind, "message");
  assert.match(compact[0]?.kind === "message" ? timelineLabel(compact[0].item).text : "", /draft/);
  assert.match(compact[0]?.kind === "message" ? compact[0].markdown?.map((line) => line.text).join("\n") ?? "" : "", /Plan ready/);

  const expanded = timelineRenderBlocks([{ kind: "plan_record", plan }], "", true);
  assert.match(expanded[0]?.kind === "message" ? expanded[0].markdown?.map((line) => line.text).join("\n") ?? "" : "", /Acceptance criteria/);
});

test("planSummaryRows exposes review-card counts and detail keeps full plan", () => {
  const plan = planRecord();
  const rows = planSummaryRows(plan);
  assert.ok(rows.some((row) => row.label === "steps" && row.value === "2"));
  assert.ok(rows.some((row) => row.label === "risks" && /Prompt drift/.test(row.value)));
  assert.ok(rows.some((row) => row.label === "files" && /src\/ui\/App\.tsx/.test(row.value)));
  assert.ok(rows.some((row) => row.label === "validation" && /typecheck/.test(row.value)));
  assert.ok(rows.some((row) => row.label === "acceptance" && /Plan card/.test(row.value)));
  const detail = detailForItem({ kind: "plan_record", plan }, true);
  assert.match(detail?.body ?? "", /Full plan body/);
  assert.match(detail?.body ?? "", /tool read_file/);
});

test("statusModel truncates long cwd and session", () => {
  const status = statusModel({
    config: { ...config(), cwd: "/very/long/path/to/a/project/with/many/segments/mini-code" },
    sessionId: "20260524120000-abcdefghijklmnopqrstuvwxyz",
    turn: 3,
    busy: true,
    approval: undefined,
    messageCount: 12,
    hasSummary: true
  });
  assert.equal(status.state, "running");
  assert.equal(status.permissionMode, "default");
  assert.equal(status.planModel, "test-model");
  assert.ok(status.cwd.length <= 40);
  assert.ok(status.session.length <= 22);
});

test("header model exposes Claude Code style compact fields", () => {
  const status = statusModel({
    config: { ...config(), planModel: "planner-model" },
    sessionId: "session-123",
    turn: 4,
    busy: false,
    approval: pendingApproval(),
    messageCount: 18,
    hasSummary: true,
    permissionMode: "accept_edits"
  });
  const fields = headerFields(status);
  assert.equal(status.state, "permission");
  assert.equal(stateColor(status.state), "yellow");
  assert.ok(fields.some((field) => field.label === "model" && field.value.includes("openai:test-model")));
  assert.ok(fields.some((field) => field.label === "plan" && field.value === "planner-model"));
  assert.ok(fields.some((field) => field.label === "mode" && field.value === "accept edits"));
  assert.ok(fields.some((field) => field.label === "summary" && field.value === "on"));
});

test("permission mode helpers cycle Claude Code style modes", () => {
  assert.equal(nextPermissionMode("default"), "accept_edits");
  assert.equal(nextPermissionMode("accept_edits"), "bypass_permissions");
  assert.equal(nextPermissionMode("bypass_permissions"), "default");
  assert.equal(permissionModeLabel("accept_edits"), "accept edits");
  assert.ok(slashCommands.includes("/permissions"));
});

test("command groups keep slash menu stable and grouped", () => {
  assert.ok(commandGroups.some((group) => group.title === "Session" && group.commands.includes("/help")));
  assert.ok(commandGroups.some((group) => group.title === "Work" && group.commands.includes("/permissions")));
  assert.ok(commandGroups.some((group) => group.title === "Work" && group.commands.includes("/skills")));
  assert.ok(commandGroups.some((group) => group.title === "Work" && group.commands.includes("/plan <request>")));
  assert.ok(commandGroups.some((group) => group.title === "Config" && group.commands.includes("/doctor")));
  assert.ok(commandGroups.some((group) => group.title === "Config" && group.commands.includes("/features")));
  assert.ok(commandGroups.some((group) => group.title === "View" && group.commands.includes("/details")));
  assert.ok(slashCommands.includes("/status"));
  assert.ok(slashCommands.includes("/model"));
  assert.match(emptyStates.timeline, /No activity/);
});

test("renderCommandHelp shows grouped command descriptions", () => {
  const help = renderCommandHelp();

  assert.match(help, /Session:/);
  assert.match(help, /Work:/);
  assert.match(help, /Config:/);
  assert.match(help, /\/doctor\s+Run local configuration diagnostics/);
  assert.match(help, /\/skills\s+List discovered project skills/);
});

test("welcome model mirrors the compact Claude Code style start screen", () => {
  assert.ok(asciiArt.length <= 5);
  assert.equal(welcomeTips.gettingStarted.title, "Tips for getting started");
  assert.match(welcomeTips.gettingStarted.items[0] ?? "", /\/init/);
  assert.equal(welcomeTips.whatsNew.title, "What's new");
});

test("slash filtering prioritizes commands before skill entries", () => {
  const entries = filterCommandsAndSkills("/ski", [{ id: "project:skill-generator", name: "skill-generator", displayName: "skill-generator", description: "Generate a project skill", path: "skills/skill-generator.md", content: "", allowedTools: [], disableModelInvocation: false }]);

  assert.equal(entries[0]?.command, "/skills");
  assert.equal(entries[1]?.command, "/skill inspect <name>");
  assert.equal(entries[2]?.command, "/skill reload");
  assert.equal(entries[3]?.command, "/skill:<name> <args>");
  assert.equal(entries[4]?.command, "/skill:skill-generator");
  assert.match(entries[4]?.description ?? "", /default project:project:skill-generator/);
});

test("slash filtering supports subcommands and exact skill ids", () => {
  const entries = filterCommandsAndSkills("/mcp ", []);
  assert.equal(entries[0]?.command, "/mcp tools");
  assert.equal(entries[1]?.command, "/mcp resources");
  assert.equal(entries[2]?.command, "/mcp prompts");
  assert.equal(entries[3]?.command, "/mcp reconnect <server>");

  const skills = [
    { id: "project:browser", name: "browser", displayName: "browser", description: "Project browser", path: "project/SKILL.md", content: "", allowedTools: [], disableModelInvocation: false },
    { id: "plugin:browser:openai-bundled-browser", name: "browser", displayName: "browser", description: "Plugin browser", path: "plugin/SKILL.md", content: "", allowedTools: [], disableModelInvocation: false, shadowedBy: "project:browser", source: "plugin" as const }
  ];
  const skillEntries = filterCommandsAndSkills("/skill:plugin", skills);
  assert.equal(skillEntries[0]?.command, "/skill:plugin:browser:openai-bundled-browser");
  assert.match(skillEntries[0]?.description ?? "", /shadowed plugin:plugin:browser:openai-bundled-browser/);
});

test("skillPickerRows filters skills and exposes Claude Code style metadata", () => {
  const rows = skillPickerRows([
    { id: "global:find-skills", name: "find-skills", displayName: "find-skills", description: "Find skills", path: "find/SKILL.md", content: "hello world", allowedTools: [], disableModelInvocation: false, source: "global" },
    { id: "plugin:browser:openai-bundled-browser", name: "browser", displayName: "browser", description: "Browser automation", path: "browser/SKILL.md", content: "many words here", allowedTools: [], disableModelInvocation: true, source: "plugin", shadowedBy: "project:browser" }
  ], "browser");

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.name, "browser");
  assert.equal(rows[0]?.status, "off");
  assert.equal(rows[0]?.source, "plugin");
  assert.match(rows[0]?.detail ?? "", /shadowed by project:browser/);

  const all = skillPickerRows([
    { id: "global:find-skills", name: "find-skills", displayName: "find-skills", description: "Find skills", path: "find/SKILL.md", content: "hello world", allowedTools: [], disableModelInvocation: false, source: "global" }
  ], "");
  assert.equal(all[0]?.source, "user");
  assert.ok((all[0]?.tokens ?? 0) >= 10);
});

function pendingApproval(): PendingApproval {
  return {
    id: "approval-1",
    tool: "run_command",
    input: { command: "npm test" },
    description: "Run command: npm test",
    requirement: {
      required: true,
      risk: "shell",
      reason: "Shell command requires approval: npm test",
      approvalKey: "shell:exact:npm test",
      scope: "npm test",
      riskReason: "Low-risk verification command.",
      rememberable: true,
      details: [
        { label: "mode", value: "default" },
        { label: "action", value: "shell" },
        { label: "target", value: "npm test" },
        { label: "scopeType", value: "command prefix" },
        { label: "cwd", value: "/repo" },
        { label: "riskReason", value: "Low-risk verification command." },
        { label: "rememberPolicy", value: "command prefix" },
        { label: "command", value: "npm test" },
        { label: "prefix", value: "npm test" }
      ]
    },
    resolve: () => undefined
  };
}

function planRecord(): PlanRecord {
  return {
    id: "plan-1",
    request: "Improve plan mode",
    status: "draft",
    model: "planner",
    answer: "## Goal\nFull plan body\n\n## Acceptance criteria\n- Plan card is compact",
    summary: "Improve plan review.",
    steps: ["Inspect plan UI", "Update card"],
    files: ["src/ui/App.tsx", "src/core/agent.ts"],
    validations: ["npm run typecheck"],
    risks: ["Prompt drift"],
    openQuestions: ["None"],
    assumptions: ["Session storage stays"],
    acceptanceCriteria: ["Plan card is compact"],
    inspectionEvents: ["tool read_file: src/ui/App.tsx", "result read_file: ok"],
    createdAt: "2026-05-25T00:00:00.000Z"
  };
}

function config(): AgentConfig {
  return {
    cwd: process.cwd(),
    provider: "openai",
    model: "test-model",
    planModel: "test-model",
    baseUrl: "https://api.test/v1",
    apiKey: "key",
    maxTurns: 3,
    allowDangerousCommands: false,
    agentDir: ".mini-code",
    sessionDir: ".mini-code/sessions",
    permissionMode: "default",
    toolsPolicy: "default",
    skills: [],
    enableSkills: true,
    maxContextMessages: 40,
    maxToolOutputChars: 12_000,
    plain: false
  };
}
