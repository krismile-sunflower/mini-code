import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTools } from "./registry.js";

test("write_file writes content and creates parent directories", async () => {
  const dir = await tempDir();
  try {
    const tool = requiredTool(dir, "write_file");
    const result = await tool.run({ path: "nested/a.txt", content: "hello" });
    assert.equal(result.ok, true);
    assert.equal(await readFile(path.join(dir, "nested", "a.txt"), "utf8"), "hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read_many_files reports per-file errors without failing all reads", async () => {
  const dir = await tempDir();
  try {
    await writeFile(path.join(dir, "a.txt"), "one\ntwo\n", "utf8");
    const tool = requiredTool(dir, "read_many_files");
    const result = await tool.run({ paths: ["a.txt", "missing.txt"] });
    assert.equal(result.ok, true);
    assert.match(result.output, /--- a\.txt/);
    assert.match(result.output, /1: one/);
    assert.match(result.output, /--- missing\.txt/);
    assert.match(result.output, /\[error\]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tool validators return validation errors before execution", async () => {
  const dir = await tempDir();
  try {
    const tool = requiredTool(dir, "read_file");
    const result = tool.validate({});
    assert.equal(result?.ok, false);
    assert.equal(result?.errorType, "validation");
    assert.match(result?.output ?? "", /read_file\.path/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("run_command returns stdout stderr and exit code on failure", async () => {
  const dir = await tempDir();
  try {
    const tool = requiredTool(dir, "run_command");
    const result = await tool.run({ command: "node -e \"console.log('out'); console.error('err'); process.exit(7)\"" });
    assert.equal(result.ok, false);
    assert.match(result.output, /exit code: 7/);
    assert.match(result.output, /out/);
    assert.match(result.output, /err/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("list_files supports maxDepth and glob", async () => {
  const dir = await tempDir();
  try {
    await writeFile(path.join(dir, "a.ts"), "", "utf8");
    await writeFile(path.join(dir, "a.txt"), "", "utf8");
    await writeFile(path.join(dir, "deep.ts"), "", "utf8");
    await writeFile(path.join(dir, "deep.txt"), "", "utf8");
    const tool = requiredTool(dir, "list_files");
    const result = await tool.run({ path: ".", glob: "*.ts", maxDepth: 1 });
    assert.equal(result.ok, true);
    assert.match(result.output, /a\.ts|deep\.ts/);
    assert.doesNotMatch(result.output, /a\.txt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read_tree shows a compact directory tree", async () => {
  const dir = await tempDir();
  try {
    await mkdir(path.join(dir, "src", "core"), { recursive: true });
    await writeFile(path.join(dir, "src", "core", "agent.ts"), "", "utf8");
    await writeFile(path.join(dir, "README.md"), "", "utf8");
    const tool = requiredTool(dir, "read_tree");
    const result = await tool.run({ path: ".", maxDepth: 2 });
    assert.equal(result.ok, true);
    assert.match(result.output, /\[d\] src/);
    assert.match(result.output, /\[f\] src\/core\/agent\.ts/);
    assert.match(result.output, /\[f\] README\.md/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("show_file_outline extracts source symbols", async () => {
  const dir = await tempDir();
  try {
    await writeFile(
      path.join(dir, "mod.ts"),
      "export class Agent {}\nfunction helper() {}\nexport const value = 1\nconst local = () => 2\n",
      "utf8"
    );
    const tool = requiredTool(dir, "show_file_outline");
    const result = await tool.run({ path: "mod.ts" });
    assert.equal(result.ok, true);
    assert.match(result.output, /1: Agent/);
    assert.match(result.output, /2: helper/);
    assert.match(result.output, /3: value/);
    assert.match(result.output, /4: local/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("git_apply_check validates a patch without writing files", async () => {
  const dir = await tempDir();
  try {
    await writeFile(path.join(dir, "a.txt"), "old\n", "utf8");
    const tool = requiredTool(dir, "git_apply_check");
    const result = await tool.run({ patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n" });
    assert.equal(result.ok, true);
    assert.match(result.output, /Patch can be applied cleanly/);
    assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "old\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("list_changed_files returns changed file names", async () => {
  const dir = await tempDir();
  try {
    await requiredTool(dir, "run_command").run({ command: "git init" });
    await writeFile(path.join(dir, "new.txt"), "hello\n", "utf8");
    const tool = requiredTool(dir, "list_changed_files");
    const result = await tool.run({});
    assert.equal(result.ok, true);
    assert.match(result.output, /new\.txt/);
    assert.doesNotMatch(result.output, /\?\?/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function requiredTool(cwd: string, name: string) {
  const tool = createTools(cwd, 20_000, true).find((item) => item.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "mini-agent-tools-"));
}
