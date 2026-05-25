import { test } from "node:test";
import assert from "node:assert/strict";
import { shellApproval, patchApproval, readApproval, writeApproval, commandApprovalKey, commandPrefixApprovalKey } from "./permissions.js";
import type { ApprovalContext, PermissionMode } from "../core/types.js";

test("read tools do not require approval", () => {
  assert.equal(readApproval().required, false);
});

test("ordinary shell command requires approval", () => {
  const result = shellApproval("npm test", context());
  assert.equal(result.required, true);
  assert.equal(result.risk, "shell");
  assert.equal(result.details?.find((detail) => detail.label === "prefix")?.value, "npm test");
  assert.equal(result.details?.find((detail) => detail.label === "scopeType")?.value, "command prefix");
  assert.equal(result.details?.find((detail) => detail.label === "rememberPolicy")?.value, "command prefix");
  assert.equal(result.scope, "npm test");
  assert.equal(result.allowAlwaysKey, commandPrefixApprovalKey("npm test"));
  assert.equal(result.approvalKey, commandApprovalKey("npm test"));
  assert.equal(result.rememberable, true);
  assert.match(result.riskReason ?? "", /Low-risk verification/);
});

test("remembered shell approvals are exact command scoped", () => {
  const approvalContext = context();
  approvalContext.allowedApprovalKeys.add(commandApprovalKey("node scripts/check.js"));
  assert.equal(shellApproval("node scripts/check.js", approvalContext).required, false);
  assert.equal(shellApproval("node scripts/check.js --watch", approvalContext).required, true);
});

test("remembered low-risk shell approvals can allow a command prefix", () => {
  const approvalContext = context();
  approvalContext.allowedCommandPrefixes.add("npm test");
  approvalContext.allowedApprovalKeys.add(commandPrefixApprovalKey("npm test"));
  assert.equal(shellApproval("npm test -- --watch", approvalContext).required, false);
  assert.equal(shellApproval("npm test -- --watch", approvalContext).scope, "npm test");
});

test("accept edits mode allows writes but not shell", () => {
  const approvalContext = context("accept_edits");
  assert.equal(patchApproval("apply_patch", ["--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-old", "+new", ""].join("\n"), approvalContext).required, false);
  assert.equal(writeApproval("write_file", "a.txt", approvalContext).required, false);
  assert.equal(shellApproval("npm test", approvalContext).required, true);
});

test("bypass permissions mode allows non-dangerous shell", () => {
  const approvalContext = context("bypass_permissions");
  assert.equal(shellApproval("npm test", approvalContext).required, false);
  assert.equal(writeApproval("write_file", "a.txt", approvalContext).required, false);
  assert.equal(shellApproval("rm -rf dist", approvalContext).blocked, true);
});

test("default mode requires ordinary workspace writes and patches", () => {
  const write = writeApproval("write_file", "a.txt", context());
  const patch = patchApproval("apply_patch", ["--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-old", "+new", ""].join("\n"), context());
  assert.equal(write.required, true);
  assert.equal(write.details?.find((detail) => detail.label === "scopeType")?.value, "file path");
  assert.equal(patch.required, true);
  assert.equal(patch.details?.find((detail) => detail.label === "scopeType")?.value, "patch file set");
});

test("risk-based mode keeps ordinary writes reviewable and rememberable", () => {
  const approvalContext = context("risk-based");
  const write = writeApproval("write_file", "a.txt", approvalContext);
  const patch = patchApproval("apply_patch", ["--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-old", "+new", ""].join("\n"), approvalContext);
  assert.equal(write.required, true);
  assert.equal(write.rememberable, true);
  assert.equal(write.details?.find((detail) => detail.label === "mode")?.value, "risk-based");
  assert.equal(patch.required, true);
  assert.equal(patch.rememberable, true);
});

test("remembered write path and patch file set are allowed", () => {
  const approvalContext = context();
  const write = writeApproval("write_file", "a.txt", approvalContext);
  approvalContext.allowedApprovalKeys.add(write.allowAlwaysKey ?? "");
  assert.equal(writeApproval("write_file", "a.txt", approvalContext).required, false);

  const patchText = ["--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-old", "+new", ""].join("\n");
  const patch = patchApproval("apply_patch", patchText, approvalContext);
  approvalContext.allowedApprovalKeys.add(patch.allowAlwaysKey ?? "");
  assert.equal(patchApproval("apply_patch", patchText, approvalContext).required, false);
});

test("dangerous shell command is blocked without allowDangerousCommands", () => {
  const result = shellApproval("rm -rf dist", context());
  assert.equal(result.required, true);
  assert.equal(result.risk, "dangerous");
  assert.equal(result.denied, true);
  assert.equal(result.blocked, true);
  assert.equal(result.rememberable, false);
});

test("dangerous shell command can be approved with allowDangerousCommands", () => {
  const result = shellApproval("rm -rf dist", context(), true);
  assert.equal(result.required, true);
  assert.equal(result.risk, "dangerous");
  assert.equal(result.denied, false);
  assert.equal(result.rememberable, false);
});

test("dangerous shell command is not bypassed by prefix approval", () => {
  const approvalContext = context("bypass_permissions");
  approvalContext.allowedCommandPrefixes.add("rm -rf");
  approvalContext.allowedApprovalKeys.add(commandPrefixApprovalKey("rm -rf"));
  const result = shellApproval("rm -rf dist", approvalContext);
  assert.equal(result.blocked, true);
  assert.equal(result.rememberable, false);
});

test("delete patch requires approval", () => {
  const result = patchApproval("apply_patch", ["--- a/a.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-old", ""].join("\n"), context());
  assert.equal(result.required, true);
  assert.equal(result.details?.find((detail) => detail.label === "deletes")?.value, "yes");
  assert.equal(result.rememberable, false);
});

test("sensitive patch cannot be remembered", () => {
  const result = patchApproval("apply_patch", ["--- a/.env", "+++ b/.env", "@@ -1 +1 @@", "-A=1", "+A=2", ""].join("\n"), context());
  assert.equal(result.required, true);
  assert.equal(result.rememberable, false);
  assert.match(result.riskReason ?? "", /sensitive/i);
});

function context(mode: PermissionMode = "default"): ApprovalContext {
  const allowedApprovalKeys = new Set<string>();
  if (mode === "accept_edits") allowedApprovalKeys.add("mode:accept_edits");
  if (mode === "bypass_permissions") allowedApprovalKeys.add("mode:bypass_permissions");
  return { cwd: process.cwd(), mode, allowedCommandPrefixes: new Set(), allowedApprovalKeys };
}
