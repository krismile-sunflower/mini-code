import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProjectOutputStyle, discoverOutputStyles, outputStylePrompt, renderOutputStyleList, resolveOutputStyle } from "./outputStyles.js";

test("discoverOutputStyles includes built-ins and project styles", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-output-style-discover-"));
  try {
    await mkdir(path.join(dir, ".claude", "output-styles"), { recursive: true });
    await writeFile(path.join(dir, ".claude", "output-styles", "teach.md"), "---\ndescription: Teach mode\n---\n\nExplain with examples.\n", "utf8");

    const styles = await discoverOutputStyles(dir, "teach", false);
    assert.ok(styles.some((style) => style.name === "default" && style.source === "builtin"));
    const teach = styles.find((style) => style.name === "teach");
    assert.equal(teach?.active, true);
    assert.equal(teach?.description, "Teach mode");
    assert.match(renderOutputStyleList(styles), /teach/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveOutputStyle falls back to default", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-output-style-resolve-"));
  try {
    const style = await resolveOutputStyle(dir, "missing", false);
    assert.equal(style.name, "default");
    assert.match(outputStylePrompt(style), /Active style: default/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createProjectOutputStyle writes a project markdown style", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-output-style-create-"));
  try {
    const created = await createProjectOutputStyle(dir, "Pair Coach", "Ask one clarifying question before broad refactors.");
    assert.equal(created.name, "pair-coach");
    assert.match(await readFile(path.join(dir, ".mini-code", "output-styles", "pair-coach.md"), "utf8"), /Ask one clarifying question/);
    await assert.rejects(() => createProjectOutputStyle(dir, "Pair Coach", "duplicate"), /EEXIST/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
