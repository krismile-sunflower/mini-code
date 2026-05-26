import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildConfig, collectConfigWarnings, readArgs } from "./config.js";

test("buildConfig reads .mini-code config and env aliases", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-config-"));
  mkdirSync(path.join(cwd, ".mini-code"), { recursive: true });
  writeFileSync(path.join(cwd, ".mini-code", "config.json"), JSON.stringify({ provider: "openai", model: "config-model", planModel: "config-plan", permissionMode: "accept_edits", toolsPolicy: "read_only", outputStyle: "explanatory", skills: ["skills/a"], enableSkills: true }));
  writeFileSync(path.join(cwd, ".env.local"), "MINI_CODE_MODEL=env-model\nMINI_CODE_PLAN_MODEL=env-plan\nMINI_CODE_OUTPUT_STYLE=concise\nMINI_CODE_SKILLS=skills/b,skills/c\nOPENAI_API_KEY=key\n");

  const config = buildConfig(readArgs(["--cwd", cwd, "--model", "cli-model", "--permission-mode", "bypass_permissions"]));

  assert.equal(config.agentDir, path.join(cwd, ".mini-code"));
  assert.equal(config.sessionDir, path.join(cwd, ".mini-code", "sessions"));
  assert.equal(config.provider, "openai");
  assert.equal(config.model, "cli-model");
  assert.equal(config.planModel, "env-plan");
  assert.equal(config.permissionMode, "bypass_permissions");
  assert.equal(config.toolsPolicy, "read_only");
  assert.equal(config.outputStyle, "concise");
  assert.deepEqual(config.skills, ["skills/a", "skills/b", "skills/c"]);
  assert.equal(config.enableSkills, true);
});

test("buildConfig collects FEATURE flags from env and config", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-config-features-"));
  mkdirSync(path.join(cwd, ".mini-code"), { recursive: true });
  writeFileSync(path.join(cwd, ".mini-code", "config.json"), JSON.stringify({ featureFlags: ["custom-mode"] }));
  writeFileSync(path.join(cwd, ".env.local"), "FEATURE_BUDDY=1\nFEATURE_REMOTE_MONITOR=true\nFEATURE_OFF=0\nOPENAI_API_KEY=key\n");

  const config = buildConfig(readArgs(["--cwd", cwd]));

  assert.deepEqual(config.featureFlags, ["buddy", "custom-mode", "remote-monitor"]);
});

test("readArgs parses mini shell public flags", () => {
  const args = readArgs(["--plan", "fix tests", "--plan-model", "planner", "--output-style", "concise", "--skill", "skills/x", "--no-skills", "--execute-plan", "plan-1", "--fork", "source-session", "--continue", "--pi-pass-through", "--", "--help"]);

  assert.equal(args.planRequest, "fix tests");
  assert.equal(args.planModel, "planner");
  assert.equal(args.outputStyle, "concise");
  assert.equal(args.executePlanId, "plan-1");
  assert.equal(args.forkSessionId, "source-session");
  assert.equal(args.continueSession, true);
  assert.deepEqual(args.skills, ["skills/x"]);
  assert.equal(args.enableSkills, false);
  assert.equal(args.piPassThrough, true);
  assert.deepEqual(args.piArgs, ["--help"]);
});

test("readArgs supports resume aliases", () => {
  const byId = readArgs(["--resume", "session-1"]);
  assert.equal(byId.sessionId, "session-1");
  assert.equal(byId.listSessions, false);

  const picker = readArgs(["--resume"]);
  assert.equal(picker.sessionId, undefined);
  assert.equal(picker.listSessions, true);
});

test("readArgs parses session directory and fresh-session aliases", () => {
  const args = readArgs(["--agent-dir", ".agent", "--session-dir", ".sessions", "--no-session"]);

  assert.equal(args.agentDir, ".agent");
  assert.equal(args.sessionDir, ".sessions");
  assert.equal(args.newSession, true);
});

test("collectConfigWarnings reports apiKeyHelper and API key conflicts", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-auth-warning-"));
  writeFileSync(path.join(cwd, ".env"), "ANTHROPIC_API_KEY=key\nANTHROPIC_AUTH_TOKEN=token\n");

  const warnings = collectConfigWarnings(cwd);

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /apiKeyHelper/);
  assert.match(warnings[0] ?? "", /ANTHROPIC_API_KEY/);
});
