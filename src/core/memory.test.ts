import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendProjectMemory, loadProjectMemory, loadProjectMemorySources, memoryPath, parseMemoryScope, renderMemorySources } from "./memory.js";

test("loadProjectMemory combines project and local CLAUDE.md files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-memory-load-"));
  try {
    await mkdir(path.join(dir, ".mini-code"), { recursive: true });
    await writeFile(path.join(dir, "CLAUDE.md"), "Project rule\n", "utf8");
    await writeFile(path.join(dir, ".mini-code", "CLAUDE.md"), "Local rule\n", "utf8");

    const memory = await loadProjectMemory(dir);
    assert.match(memory, /project memory:/);
    assert.match(memory, /Project rule/);
    assert.match(memory, /local override:/);
    assert.match(memory, /Local rule/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendProjectMemory creates and appends scoped memory notes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-memory-add-"));
  try {
    const written = await appendProjectMemory(dir, "local", "First note");
    assert.equal(written, memoryPath(dir, "local"));
    await appendProjectMemory(dir, "local", "Second note");

    const content = await readFile(path.join(dir, ".mini-code", "CLAUDE.md"), "utf8");
    assert.equal(content, "First note\n\nSecond note\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("memory sources render existence and sizes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-memory-sources-"));
  try {
    await writeFile(path.join(dir, "CLAUDE.md"), "abc\n", "utf8");
    const sources = await loadProjectMemorySources(dir);
    const rendered = renderMemorySources(sources);

    assert.equal(sources.find((source) => source.scope === "project")?.exists, true);
    assert.match(rendered, /scope\s+exists\s+bytes\s+path/);
    assert.match(rendered, /project\s+yes\s+4/);
    assert.match(rendered, /local\s+no\s+0/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseMemoryScope validates supported scopes", () => {
  assert.equal(parseMemoryScope("project"), "project");
  assert.equal(parseMemoryScope("local"), "local");
  assert.equal(parseMemoryScope("user"), "user");
  assert.throws(() => parseMemoryScope("repo"), /Usage: \/memory add/);
});
