import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readApproval, shellApproval } from "../tools/permissions.js";
import { addSettingsPermissionRule, applySettingsPermissions, loadProjectSettings, removeSettingsPermissionRule } from "./settings.js";
import type { ApprovalContext } from "./types.js";

test("loadProjectSettings reads Mini Code and Claude permission settings", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-settings-load-"));
  try {
    await mkdir(path.join(dir, ".mini-code"), { recursive: true });
    await mkdir(path.join(dir, ".claude"), { recursive: true });
    await writeFile(path.join(dir, ".mini-code", "settings.json"), JSON.stringify({
      permissions: {
        allow: ["Bash(npm test)"]
      }
    }), "utf8");
    await writeFile(path.join(dir, ".claude", "settings.local.json"), JSON.stringify({
      permissions: {
        deny: [{ matcher: "Bash(rm -rf *)" }]
      }
    }), "utf8");

    const settings = await loadProjectSettings(dir, false);

    assert.deepEqual(settings.permissions.map((rule) => [rule.action, rule.matcher]), [
      ["allow", "Bash(npm test)"],
      ["deny", "Bash(rm -rf *)"]
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applySettingsPermissions allows matching non-dangerous shell approvals", () => {
  const context = approvalContext();
  const requirement = shellApproval("npm test", context, false);

  const applied = applySettingsPermissions(requirement, [
    { action: "allow", matcher: "Bash(npm test)", source: "test" }
  ], "run_command", { command: "npm test" });

  assert.equal(applied.required, false);
  assert.equal(applied.blocked, false);
  assert.match(applied.reason, /Allowed by settings permission rule/);
});

test("permission rule helpers edit project local settings", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-settings-edit-"));
  try {
    await addSettingsPermissionRule(dir, "allow", "Bash(npm test)");
    await addSettingsPermissionRule(dir, "allow", "Bash(npm test)");
    await addSettingsPermissionRule(dir, "deny", "Bash(rm -rf *)");

    const raw = JSON.parse(await readFile(path.join(dir, ".mini-code", "settings.local.json"), "utf8"));
    assert.deepEqual(raw.permissions.allow, ["Bash(npm test)"]);
    assert.deepEqual(raw.permissions.deny, ["Bash(rm -rf *)"]);

    const removed = await removeSettingsPermissionRule(dir, "allow", "Bash(npm test)");
    assert.equal(removed.removed, true);
    const settings = await loadProjectSettings(dir, false);
    assert.deepEqual(settings.permissions.map((rule) => [rule.action, rule.matcher]), [["deny", "Bash(rm -rf *)"]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applySettingsPermissions blocks denied rules before approval", () => {
  const context = approvalContext();
  const requirement = shellApproval("npm test", context, false);

  const applied = applySettingsPermissions(requirement, [
    { action: "deny", matcher: "Bash(npm *)", source: "test" }
  ], "run_command", { command: "npm test" });

  assert.equal(applied.required, true);
  assert.equal(applied.blocked, true);
  assert.equal(applied.denied, true);
  assert.match(applied.reason, /Blocked by settings permission rule/);
});

test("applySettingsPermissions blocks Claude Read aliases for read tools", () => {
  const requirement = readApproval();

  const applied = applySettingsPermissions(requirement, [
    { action: "deny", matcher: "Read(.env*)", source: "test" }
  ], "read_file", { path: ".env.local" });

  assert.equal(applied.required, true);
  assert.equal(applied.blocked, true);
  assert.equal(applied.denied, true);
  assert.match(applied.reason, /Blocked by settings permission rule/);
});

test("applySettingsPermissions matches Claude Bash prefix syntax", () => {
  const context = approvalContext();
  const requirement = shellApproval("git diff -- src/core/settings.ts", context, false);

  const applied = applySettingsPermissions(requirement, [
    { action: "allow", matcher: "Bash(git diff:*)", source: "test" }
  ], "run_command", { command: "git diff -- src/core/settings.ts" });

  assert.equal(applied.required, false);
  assert.equal(applied.blocked, false);
  assert.match(applied.reason, /Allowed by settings permission rule/);
});

test("applySettingsPermissions gives deny rules priority over allow rules", () => {
  const context = approvalContext();
  const requirement = shellApproval("npm test", context, false);

  const applied = applySettingsPermissions(requirement, [
    { action: "allow", matcher: "Bash(*)", source: "test" },
    { action: "deny", matcher: "Bash(npm test)", source: "test" }
  ], "run_command", { command: "npm test" });

  assert.equal(applied.blocked, true);
  assert.match(applied.reason, /Blocked by settings permission rule/);
});

test("applySettingsPermissions does not unblock dangerous commands", () => {
  const context = approvalContext();
  const requirement = shellApproval("rm -rf dist", context, false);

  const applied = applySettingsPermissions(requirement, [
    { action: "allow", matcher: "Bash(*)", source: "test" }
  ], "run_command", { command: "rm -rf dist" });

  assert.equal(applied.required, true);
  assert.equal(applied.blocked, true);
  assert.equal(applied.risk, "dangerous");
});

function approvalContext(): ApprovalContext {
  return {
    cwd: process.cwd(),
    mode: "risk-based",
    allowedCommandPrefixes: new Set<string>(),
    allowedApprovalKeys: new Set<string>()
  };
}
