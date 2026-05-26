import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hookRows, loadHookConfig, matchingHooks, runHookEvent } from "./hooks.js";

test("loadHookConfig reads Claude-style and flat hook commands", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-hooks-load-"));
  try {
    await mkdir(path.join(dir, ".claude"), { recursive: true });
    await mkdir(path.join(dir, ".mini-code"), { recursive: true });
    await writeFile(path.join(dir, ".claude", "settings.json"), JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Read", hooks: [{ type: "command", command: "node pre.js" }] }
        ]
      }
    }), "utf8");
    await writeFile(path.join(dir, ".mini-code", "settings.json"), JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: "read_file", command: "node post.js" }
        ],
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "node prompt.js", timeout: 2 }] }
        ]
      }
    }), "utf8");
    await writeFile(path.join(dir, ".claude", "settings.local.json"), JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: "startup", hooks: [{ type: "command", command: "node session.js" }] }
        ],
        Stop: [
          { hooks: [{ type: "command", command: "node stop.js" }] }
        ],
        SubagentStop: [
          { matcher: "reviewer", hooks: [{ type: "command", command: "node subagent-stop.js" }] }
        ],
        PreCompact: [
          { matcher: "manual", hooks: [{ type: "command", command: "node compact.js" }] }
        ],
        Notification: [
          { matcher: "permission_required", hooks: [{ type: "command", command: "node notify.js" }] }
        ]
      }
    }), "utf8");

    const config = await loadHookConfig(dir, false);
    assert.equal(matchingHooks(config, "PreToolUse", "read_file").length, 1);
    assert.equal(matchingHooks(config, "PostToolUse", "read_file").length, 1);
    assert.deepEqual(hookRows(config).map((row) => [row.event, row.matcher, row.command]), [
      ["PreToolUse", "Read", "node pre.js"],
      ["PostToolUse", "read_file", "node post.js"],
      ["UserPromptSubmit", "*", "node prompt.js"],
      ["SessionStart", "startup", "node session.js"],
      ["Stop", "*", "node stop.js"],
      ["SubagentStop", "reviewer", "node subagent-stop.js"],
      ["PreCompact", "manual", "node compact.js"],
      ["Notification", "permission_required", "node notify.js"]
    ]);
    assert.equal(hookRows(config).find((row) => row.event === "UserPromptSubmit")?.timeoutMs, 2000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runHookEvent supports UserPromptSubmit prompt context", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-hooks-prompt-"));
  try {
    const node = JSON.stringify(process.execPath);
    const result = await runHookEvent({
      PreToolUse: [],
      PostToolUse: [],
      UserPromptSubmit: [
        { matcher: "*", source: "test", hooks: [{ type: "command", command: `${node} -e "const fs=require('fs'); const input=fs.readFileSync(0,'utf8'); process.stdout.write(process.env.MINI_CODE_HOOK_PROMPT + ':' + JSON.parse(input).hook_event_name)"`, timeoutMs: 5_000 }] }
      ],
      SessionStart: [],
      Stop: [],
      PreCompact: [],
      Notification: []
    }, {
      cwd: dir,
      event: "UserPromptSubmit",
      prompt: "review this",
      maxOutputChars: 10_000,
      allowDangerousCommands: false
    });

    assert.equal(result.ok, true);
    assert.equal(result.output, "review this:UserPromptSubmit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runHookEvent supports SessionStart source and session context", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-hooks-session-start-"));
  try {
    const node = JSON.stringify(process.execPath);
    const result = await runHookEvent({
      PreToolUse: [],
      PostToolUse: [],
      UserPromptSubmit: [],
      SessionStart: [
        { matcher: "resume", source: "test", hooks: [{ type: "command", command: `${node} -e "const fs=require('fs'); const input=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(input.source + ':' + input.session_id + ':' + process.env.CLAUDE_PROJECT_DIR)"`, timeoutMs: 5_000 }] }
      ],
      Stop: [],
      PreCompact: [],
      Notification: []
    }, {
      cwd: dir,
      event: "SessionStart",
      sessionId: "abc123",
      source: "resume",
      matcherTarget: "resume",
      maxOutputChars: 10_000,
      allowDangerousCommands: false
    });

    assert.equal(result.ok, true);
    assert.equal(result.output, `resume:abc123:${dir}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runHookEvent supports Stop final answer context", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-hooks-stop-"));
  try {
    const node = JSON.stringify(process.execPath);
    const result = await runHookEvent({
      PreToolUse: [],
      PostToolUse: [],
      UserPromptSubmit: [],
      SessionStart: [],
      Stop: [
        { matcher: "*", source: "test", hooks: [{ type: "command", command: `${node} -e "const fs=require('fs'); const input=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(input.hook_event_name + ':' + input.final_answer + ':' + process.env.MINI_CODE_HOOK_FINAL_ANSWER)"`, timeoutMs: 5_000 }] }
      ],
      PreCompact: [],
      Notification: []
    }, {
      cwd: dir,
      event: "Stop",
      sessionId: "abc123",
      finalAnswer: "finished",
      maxOutputChars: 10_000,
      allowDangerousCommands: false
    });

    assert.equal(result.ok, true);
    assert.equal(result.output, "Stop:finished:finished");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runHookEvent supports SubagentStop final answer and subagent context", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-hooks-subagent-stop-"));
  try {
    const node = JSON.stringify(process.execPath);
    const result = await runHookEvent({
      PreToolUse: [],
      PostToolUse: [],
      UserPromptSubmit: [],
      SessionStart: [],
      Stop: [],
      SubagentStop: [
        { matcher: "reviewer", source: "test", hooks: [{ type: "command", command: `${node} -e "const fs=require('fs'); const input=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(input.hook_event_name + ':' + input.subagent_name + ':' + input.final_answer + ':' + process.env.MINI_CODE_HOOK_SUBAGENT_NAME)"`, timeoutMs: 5_000 }] }
      ],
      PreCompact: [],
      Notification: []
    }, {
      cwd: dir,
      event: "SubagentStop",
      sessionId: "abc123",
      matcherTarget: "reviewer",
      subagentName: "reviewer",
      finalAnswer: "subagent finished",
      maxOutputChars: 10_000,
      allowDangerousCommands: false
    });

    assert.equal(result.ok, true);
    assert.equal(result.output, "SubagentStop:reviewer:subagent finished:reviewer");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runHookEvent supports PreCompact trigger context", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-hooks-precompact-"));
  try {
    const node = JSON.stringify(process.execPath);
    const result = await runHookEvent({
      PreToolUse: [],
      PostToolUse: [],
      UserPromptSubmit: [],
      SessionStart: [],
      Stop: [],
      PreCompact: [
        { matcher: "manual", source: "test", hooks: [{ type: "command", command: `${node} -e "const fs=require('fs'); const input=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(input.trigger + ':' + process.env.MINI_CODE_HOOK_TRIGGER)"`, timeoutMs: 5_000 }] }
      ],
      Notification: []
    }, {
      cwd: dir,
      event: "PreCompact",
      sessionId: "abc123",
      trigger: "manual",
      matcherTarget: "manual",
      maxOutputChars: 10_000,
      allowDangerousCommands: false
    });

    assert.equal(result.ok, true);
    assert.equal(result.output, "manual:manual");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runHookEvent supports Notification message context", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-hooks-notification-"));
  try {
    const node = JSON.stringify(process.execPath);
    const result = await runHookEvent({
      PreToolUse: [],
      PostToolUse: [],
      UserPromptSubmit: [],
      SessionStart: [],
      Stop: [],
      PreCompact: [],
      Notification: [
        { matcher: "permission_required", source: "test", hooks: [{ type: "command", command: `${node} -e "const fs=require('fs'); const input=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(input.notification_type + ':' + input.title + ':' + process.env.MINI_CODE_HOOK_NOTIFICATION_MESSAGE)"`, timeoutMs: 5_000 }] }
      ]
    }, {
      cwd: dir,
      event: "Notification",
      sessionId: "abc123",
      matcherTarget: "permission_required",
      notification: { type: "permission_required", title: "Permission required", message: "Shell command requires approval" },
      maxOutputChars: 10_000,
      allowDangerousCommands: false
    });

    assert.equal(result.ok, true);
    assert.equal(result.output, "permission_required:Permission required:Shell command requires approval");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runHookEvent executes matching hooks with Mini Code env vars", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-hooks-run-"));
  try {
    const node = JSON.stringify(process.execPath);
    const result = await runHookEvent({
      PreToolUse: [
        { matcher: "read_file", source: "test", hooks: [{ type: "command", command: `${node} -e "require('fs').writeFileSync('marker.txt', process.env.MINI_CODE_HOOK_TOOL + ':' + JSON.parse(process.env.MINI_CODE_HOOK_INPUT).path)"`, timeoutMs: 5_000 }] }
      ],
      PostToolUse: [],
      UserPromptSubmit: [],
      SessionStart: [],
      Stop: [],
      PreCompact: [],
      Notification: []
    }, {
      cwd: dir,
      event: "PreToolUse",
      tool: "read_file",
      input: { path: "README.md" },
      maxOutputChars: 10_000,
      allowDangerousCommands: false
    });

    assert.equal(result.ok, true);
    assert.equal(await readFile(path.join(dir, "marker.txt"), "utf8"), "read_file:README.md");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runHookEvent treats JSON decision block output as a blocking hook result", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-hooks-json-block-"));
  try {
    const node = JSON.stringify(process.execPath);
    const result = await runHookEvent({
      PreToolUse: [
        { matcher: "run_command", source: "test", hooks: [{ type: "command", command: `${node} -e "process.stdout.write(JSON.stringify({ decision: 'block', reason: 'command blocked by policy' }))"`, timeoutMs: 5_000 }] }
      ],
      PostToolUse: [],
      UserPromptSubmit: [],
      SessionStart: [],
      Stop: [],
      PreCompact: [],
      Notification: []
    }, {
      cwd: dir,
      event: "PreToolUse",
      tool: "run_command",
      input: { command: "npm install" },
      maxOutputChars: 10_000,
      allowDangerousCommands: false
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorType, "permission_blocked");
    assert.equal(result.output, "command blocked by policy");
    assert.equal(result.metadata?.hookDecision, "block");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runHookEvent fails when a pre hook exits nonzero", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-hooks-fail-"));
  try {
    const node = JSON.stringify(process.execPath);
    const result = await runHookEvent({
      PreToolUse: [
        { matcher: "*", source: "test", hooks: [{ type: "command", command: `${node} -e "console.error('stop'); process.exit(7)"`, timeoutMs: 5_000 }] }
      ],
      PostToolUse: [],
      UserPromptSubmit: [],
      SessionStart: [],
      Stop: [],
      PreCompact: [],
      Notification: []
    }, {
      cwd: dir,
      event: "PreToolUse",
      tool: "read_file",
      input: {},
      maxOutputChars: 10_000,
      allowDangerousCommands: false
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorType, "runtime");
    assert.match(result.output, /Hook PreToolUse failed/);
    assert.match(result.output, /stop/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runHookEvent blocks dangerous commands unless explicitly allowed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-hooks-danger-"));
  try {
    const result = await runHookEvent({
      PreToolUse: [
        { matcher: "*", source: "test", hooks: [{ type: "command", command: "git reset --hard", timeoutMs: 5_000 }] }
      ],
      PostToolUse: [],
      UserPromptSubmit: [],
      SessionStart: [],
      Stop: [],
      PreCompact: [],
      Notification: []
    }, {
      cwd: dir,
      event: "PreToolUse",
      tool: "read_file",
      input: {},
      maxOutputChars: 10_000,
      allowDangerousCommands: false
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorType, "permission_blocked");
    assert.match(result.output, /blocked dangerous command/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
