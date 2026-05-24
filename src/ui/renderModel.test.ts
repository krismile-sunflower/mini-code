import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalRows, blockedApprovalText, detailForItem, eventToTimelineItems, nextPermissionMode, outputPreview, permissionModeLabel, slashCommands, statusModel, todoLabel, toolRequestLabel } from "./renderModel.js";
import type { AgentConfig, PendingApproval } from "../core/types.js";

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
  assert.ok(rows.some((row) => row.label === "riskReason" && /Low-risk/.test(row.value)));
});

test("blockedApprovalText hides allow actions for blocked approvals", () => {
  const approval = pendingApproval();
  approval.requirement.blocked = true;
  approval.requirement.denied = true;
  assert.doesNotMatch(blockedApprovalText(approval), /allow once/i);
  assert.match(blockedApprovalText(approval), /Blocked/);
});

test("eventToTimelineItems maps validation tool results", () => {
  const items = eventToTimelineItems({ type: "tool_result", turn: 1, tool: "read_file", ok: false, output: "bad input", errorType: "validation" });
  assert.equal(items[0]?.kind, "tool_result");
  assert.equal(items[0]?.kind === "tool_result" ? items[0].status : undefined, "validation_error");
});

test("eventToTimelineItems folds protocol correction noise", () => {
  const items = eventToTimelineItems({ type: "error", category: "protocol", error: "A workspace tool is required before the final answer. Asking the model to call a tool." });
  assert.deepEqual(items, []);
});

test("detailForItem adds provider error suggestions", () => {
  const detail = detailForItem({ kind: "error", category: "runtime", text: "Invalid input[7].call_id: empty string" }, false);
  assert.match(detail?.body ?? "", /Provider rejected tool-message shape/);
});

test("outputPreview clips long output unless expanded", () => {
  const output = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
  assert.match(outputPreview(output, false), /truncated/);
  assert.doesNotMatch(outputPreview(output, true), /truncated/);
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
  assert.ok(status.cwd.length <= 40);
  assert.ok(status.session.length <= 22);
});

test("permission mode helpers cycle Claude Code style modes", () => {
  assert.equal(nextPermissionMode("default"), "accept_edits");
  assert.equal(nextPermissionMode("accept_edits"), "bypass_permissions");
  assert.equal(nextPermissionMode("bypass_permissions"), "default");
  assert.equal(permissionModeLabel("accept_edits"), "accept edits");
  assert.ok(slashCommands.includes("/permissions"));
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
        { label: "cwd", value: "/repo" },
        { label: "command", value: "npm test" },
        { label: "prefix", value: "npm test" }
      ]
    },
    resolve: () => undefined
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
