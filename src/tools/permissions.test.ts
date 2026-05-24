import { test } from "node:test";
import assert from "node:assert/strict";
import { shellApproval, patchApproval, readApproval, commandApprovalKey } from "./permissions.js";
import type { ApprovalContext } from "../core/types.js";

test("read tools do not require approval", () => {
  assert.equal(readApproval().required, false);
});

test("ordinary shell command requires approval", () => {
  const result = shellApproval("npm test", context());
  assert.equal(result.required, true);
  assert.equal(result.risk, "shell");
  assert.equal(result.details?.find((detail) => detail.label === "prefix")?.value, "npm test");
  assert.equal(result.scope, "npm test");
  assert.equal(result.rememberable, true);
  assert.match(result.riskReason ?? "", /Low-risk verification/);
});

test("remembered shell approvals are exact command scoped", () => {
  const approvalContext = context();
  approvalContext.allowedApprovalKeys.add(commandApprovalKey("npm test"));
  assert.equal(shellApproval("npm test", approvalContext).required, false);
  assert.equal(shellApproval("npm test -- --watch", approvalContext).required, true);
});

test("accept edits mode allows writes but not shell", () => {
  const approvalContext = context();
  approvalContext.allowedApprovalKeys.add("mode:accept_edits");
  assert.equal(patchApproval("apply_patch", ["--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-old", "+new", ""].join("\n"), approvalContext).required, false);
  assert.equal(shellApproval("npm test", approvalContext).required, true);
});

test("bypass permissions mode allows non-dangerous shell", () => {
  const approvalContext = context();
  approvalContext.allowedApprovalKeys.add("mode:bypass_permissions");
  assert.equal(shellApproval("npm test", approvalContext).required, false);
  assert.equal(shellApproval("rm -rf dist", approvalContext).blocked, true);
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

function context(): ApprovalContext {
  return { cwd: process.cwd(), allowedTools: new Set(), allowedCommandPrefixes: new Set(), allowedApprovalKeys: new Set() };
}
