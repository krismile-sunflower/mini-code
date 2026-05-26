import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverCustomCommands, renderCustomCommandContent, renderCustomCommandPrompt, resolveCustomCommand } from "./customCommands.js";

test("discoverCustomCommands reads project Claude-style commands", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-custom-commands-"));
  try {
    await mkdir(path.join(dir, ".claude", "commands"), { recursive: true });
    await writeFile(path.join(dir, ".claude", "commands", "review.md"), "# Review\n\nInspect the diff and report blockers.\n", "utf8");

    const commands = await discoverCustomCommands(dir, false);
    const command = resolveCustomCommand(commands, "review");

    assert.equal(commands.length, 1);
    assert.equal(command?.name, "review");
    assert.match(command?.description ?? "", /Review/);
    assert.match(renderCustomCommandPrompt(command!, "src"), /User arguments: src/);
    assert.match(renderCustomCommandPrompt(command!, "src"), /Inspect the diff/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverCustomCommands prefers project commands over global duplicates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-custom-commands-project-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "mini-custom-commands-home-"));
  try {
    await mkdir(path.join(dir, ".mini-code", "commands"), { recursive: true });
    await mkdir(path.join(home, ".claude", "commands"), { recursive: true });
    await writeFile(path.join(dir, ".mini-code", "commands", "review.md"), "Project review\n", "utf8");
    await writeFile(path.join(home, ".claude", "commands", "review.md"), "Global review\n", "utf8");

    const [command] = await discoverCustomCommands(dir, true, home);

    assert.equal(command?.source, "project");
    assert.match(command?.content ?? "", /Project review/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("custom commands support frontmatter descriptions and argument placeholders", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-custom-commands-args-"));
  try {
    await mkdir(path.join(dir, ".claude", "commands"), { recursive: true });
    await writeFile(
      path.join(dir, ".claude", "commands", "fix.md"),
      "---\ndescription: Fix a focused target\nargument-hint: <path> <issue>\n---\nFix $ARGUMENTS[0] for $2.\nAll: $ARGUMENTS\n",
      "utf8"
    );

    const command = resolveCustomCommand(await discoverCustomCommands(dir, false), "fix");
    const prompt = renderCustomCommandPrompt(command!, "\"src/app.ts\" \"type errors\"");

    assert.equal(command?.description, "Fix a focused target");
    assert.doesNotMatch(command?.content ?? "", /argument-hint/);
    assert.doesNotMatch(prompt, /User arguments:/);
    assert.match(prompt, /Fix src\/app\.ts for type errors\./);
    assert.match(prompt, /All: "src\/app\.ts" "type errors"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("custom command placeholders leave ordinary arguments visible when unused", () => {
  const rendered = renderCustomCommandContent("Review the current diff.", "src/core");

  assert.equal(rendered.content, "Review the current diff.");
  assert.equal(rendered.usedArgumentsPlaceholder, false);
});
