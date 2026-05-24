import { test } from "node:test";
import assert from "node:assert/strict";
import { shellApproval, patchApproval, readApproval } from "./permissions.js";
import type { ApprovalContext } from "../core/types.js";

test("read tools do not require approval", () => {
  assert.equal(readApproval().required, false);
});

test("ordinary shell command requires approval", () => {
  const result = shellApproval("npm test", context());
  assert.equal(result.required, true);
  assert.equal(result.risk, "shell");
});

test("dangerous shell command is marked dangerous", () => {
  const result = shellApproval("rm -rf dist", context());
  assert.equal(result.required, true);
  assert.equal(result.risk, "dangerous");
});

test("delete patch requires approval", () => {
  const result = patchApproval("apply_patch", ["--- a/a.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-old", ""].join("\n"), context());
  assert.equal(result.required, true);
});

function context(): ApprovalContext {
  return { cwd: process.cwd(), allowedTools: new Set(), allowedCommandPrefixes: new Set() };
}
