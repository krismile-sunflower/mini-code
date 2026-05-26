import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getProjectConfigValue, readProjectConfig, renderProjectConfig, setProjectConfigValue, unsetProjectConfigValue } from "./projectConfig.js";

test("project config set/get/list/unset persists typed values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-project-config-"));
  try {
    await setProjectConfigValue(dir, "model", "gpt-4.1");
    await setProjectConfigValue(dir, "enableMcp", "false");
    await setProjectConfigValue(dir, "maxTurns", "7");
    await setProjectConfigValue(dir, "outputStyle", "concise");
    await setProjectConfigValue(dir, "skills", "a,b, c");

    assert.equal(getProjectConfigValue(dir, "model"), "gpt-4.1");
    assert.equal(getProjectConfigValue(dir, "enableMcp"), false);
    assert.equal(getProjectConfigValue(dir, "maxTurns"), 7);
    assert.equal(getProjectConfigValue(dir, "outputStyle"), "concise");
    assert.deepEqual(getProjectConfigValue(dir, "skills"), ["a", "b", "c"]);
    assert.match(renderProjectConfig(dir), /model=gpt-4\.1/);

    const raw = JSON.parse(await readFile(path.join(dir, ".mini-code", "config.json"), "utf8"));
    assert.equal(raw.enableMcp, false);
    assert.equal(raw.maxTurns, 7);

    const unset = await unsetProjectConfigValue(dir, "model");
    assert.equal(unset.existed, true);
    assert.equal(readProjectConfig(dir).model, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("project config validates supported keys and choices", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-project-config-validation-"));
  try {
    await assert.rejects(() => setProjectConfigValue(dir, "missing", "x"), /Unsupported config key/);
    await assert.rejects(() => setProjectConfigValue(dir, "provider", "local"), /expects one of/);
    await assert.rejects(() => setProjectConfigValue(dir, "enableMcp", "maybe"), /expects a boolean/);
    await assert.rejects(() => setProjectConfigValue(dir, "maxTurns", "many"), /expects a number/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
