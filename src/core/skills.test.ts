import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverSkills, renderSkillList, skillInjection } from "./skills.js";

test("discoverSkills finds project and claude skill files", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-skills-"));
  await mkdir(path.join(cwd, ".mini-code", "skills", "review"), { recursive: true });
  await mkdir(path.join(cwd, ".claude", "skills", "docs"), { recursive: true });
  await writeFile(path.join(cwd, ".mini-code", "skills", "review", "SKILL.md"), "---\nname: code-review\ndescription: Review code carefully\nallowed-tools: read grep\n---\n# Review\nRead files first.\n");
  await writeFile(path.join(cwd, ".claude", "skills", "docs", "SKILL.md"), "---\nname: docs\ndescription: Write docs\ndisable-model-invocation: true\n---\nDocs body\n");

  const skills = await discoverSkills(cwd, [], true);

  assert.deepEqual(skills.map((skill) => skill.name), ["code-review", "docs"]);
  assert.deepEqual(skills[0]?.allowedTools, ["read", "grep"]);
  assert.equal(skills[1]?.disableModelInvocation, true);
  assert.match(renderSkillList(skills), /code-review/);
  assert.match(skillInjection(skills[0]!, "check src"), /User arguments: check src/);
});

test("discoverSkills can be disabled", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-skills-off-"));
  await mkdir(path.join(cwd, ".mini-code", "skills", "review"), { recursive: true });
  await writeFile(path.join(cwd, ".mini-code", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review\n---\nBody\n");

  assert.deepEqual(await discoverSkills(cwd, [], false), []);
});
