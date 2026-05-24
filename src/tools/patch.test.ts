import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyUnifiedPatch } from "./patch.js";

test("applyUnifiedPatch creates a file", async () => {
  const dir = await tempDir();
  try {
    await applyUnifiedPatch(
      dir,
      ["--- /dev/null", "+++ b/hello.txt", "@@ -0,0 +1,2 @@", "+hello", "+world", ""].join("\n")
    );
    assert.equal(await readFile(path.join(dir, "hello.txt"), "utf8"), "hello\nworld\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyUnifiedPatch modifies a file", async () => {
  const dir = await tempDir();
  try {
    await writeFile(path.join(dir, "hello.txt"), "hello\nworld\n", "utf8");
    await applyUnifiedPatch(
      dir,
      ["--- a/hello.txt", "+++ b/hello.txt", "@@ -1,2 +1,2 @@", " hello", "-world", "+agent", ""].join("\n")
    );
    assert.equal(await readFile(path.join(dir, "hello.txt"), "utf8"), "hello\nagent\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyUnifiedPatch rejects mismatched context without partial write", async () => {
  const dir = await tempDir();
  try {
    const filePath = path.join(dir, "hello.txt");
    await writeFile(filePath, "hello\nworld\n", "utf8");
    await assert.rejects(
      applyUnifiedPatch(dir, ["--- a/hello.txt", "+++ b/hello.txt", "@@ -1,2 +1,2 @@", " nope", "-world", "+agent", ""].join("\n")),
      /context mismatch/
    );
    assert.equal(await readFile(filePath, "utf8"), "hello\nworld\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyUnifiedPatch rejects paths outside workspace", async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(
      applyUnifiedPatch(dir, ["--- /dev/null", "+++ b/../escape.txt", "@@ -0,0 +1 @@", "+bad", ""].join("\n")),
      /Path escapes workspace/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "mini-agent-"));
}
