import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProjectSkill, defaultSkills, discoverSkills, renderSkillInspect, renderSkillList, resolveSkill, skillInjection, skillRoots } from "./skills.js";

test("discoverSkills finds project and claude skill files", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-skills-"));
  await mkdir(path.join(cwd, ".mini-code", "skills", "review"), { recursive: true });
  await mkdir(path.join(cwd, ".claude", "skills", "docs"), { recursive: true });
  await writeFile(path.join(cwd, ".mini-code", "skills", "review", "SKILL.md"), "---\nname: code-review\ndescription: Review code carefully\nallowed-tools: read grep\n---\n# Review\nRead files first.\n");
  await writeFile(path.join(cwd, ".claude", "skills", "docs", "SKILL.md"), "---\nname: docs\ndescription: Write docs\ndisable-model-invocation: true\n---\nDocs body\n");

  const skills = await discoverSkills(cwd, [], true, { includeGlobal: false });

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

  assert.deepEqual(await discoverSkills(cwd, [], false, { includeGlobal: false }), []);
});

test("createProjectSkill scaffolds a discoverable project skill", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-skills-create-"));
  const created = await createProjectSkill(cwd, "Skill Builder", "Create high quality project skills");
  const skills = await discoverSkills(cwd, [], true, { includeGlobal: false });

  assert.equal(created.name, "skill-builder");
  assert.match(created.path, /SKILL\.md$/);
  assert.equal(skills[0]?.name, "skill-builder");
  assert.equal(skills[0]?.description, "Create high quality project skills");
  assert.match(skills[0]?.content ?? "", /## Workflow/);
  await assert.rejects(() => createProjectSkill(cwd, "Skill Builder"), /already exists/);
});

test("createProjectSkill can include task-specific instructions", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-skills-create-instructions-"));
  await createProjectSkill(cwd, "PR Reviewer", "Review pull requests", { instructions: "- Check tests first.\n- Summarize blocking risks." });
  const [skill] = await discoverSkills(cwd, [], true, { includeGlobal: false });

  assert.match(skill?.content ?? "", /## Skill Instructions/);
  assert.match(skill?.content ?? "", /Check tests first/);
  assert.match(skill?.content ?? "", /Summarize blocking risks/);
});

test("discoverSkills includes user-level skill roots by default", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-skills-global-cwd-"));
  const home = mkdtempSync(path.join(tmpdir(), "mini-skills-global-home-"));
  await mkdir(path.join(home, ".codex", "skills", ".system", "planner"), { recursive: true });
  await mkdir(path.join(home, ".agents", "skills", "review"), { recursive: true });
  await mkdir(path.join(home, ".codex", "plugins", "cache", "bundle", "skills", "browser"), { recursive: true });
  await writeFile(path.join(home, ".codex", "skills", ".system", "planner", "SKILL.md"), "---\nname: planner\ndescription: Plan work\n---\nBody\n");
  await writeFile(path.join(home, ".agents", "skills", "review", "SKILL.md"), "---\nname: global-review\ndescription: Global review\n---\nBody\n");
  await writeFile(path.join(home, ".codex", "plugins", "cache", "bundle", "skills", "browser", "SKILL.md"), "---\nname: browser\ndescription: Browser automation\n---\nBody\n");

  const skills = await discoverSkills(cwd, [], true, { homeDir: home });

  assert.deepEqual(skills.map((skill) => skill.name), ["browser", "global-review", "planner"]);
});

test("skillRoots keeps project roots before global roots and configured paths", () => {
  const cwd = path.join(tmpdir(), "mini-skills-roots-cwd");
  const home = path.join(tmpdir(), "mini-skills-roots-home");
  const roots = skillRoots(cwd, ["custom/skills"], { homeDir: home });

  assert.equal(roots[0], path.resolve(cwd, ".mini-code", "skills"));
  assert.equal(roots[1], path.resolve(cwd, ".agents", "skills"));
  assert.equal(roots[2], path.resolve(cwd, ".claude", "skills"));
  assert.ok(roots.includes(path.resolve(home, ".codex", "plugins", "cache")));
  assert.equal(roots.at(-1), path.resolve(cwd, "custom", "skills"));
});

test("discoverSkills parses structured manifest fields", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-skills-manifest-"));
  await mkdir(path.join(cwd, ".mini-code", "skills", "review"), { recursive: true });
  await writeFile(path.join(cwd, ".mini-code", "skills", "review", "SKILL.md"), [
    "---",
    "name: reviewer",
    "description: Review code",
    "allowed-tools: read_file search",
    "references: references/checklist.md",
    "activation:",
    "  keywords: [review, audit]",
    "  file_globs: [src/**/*.ts]",
    "helpers:",
    "  - type: command",
    "    name: run-review-checks",
    "    command: npm test",
    "    risk: shell",
    "---",
    "Body"
  ].join("\n"), "utf8");

  const [skill] = await discoverSkills(cwd, [], true, { includeGlobal: false });

  assert.equal(skill?.source, "project");
  assert.deepEqual(skill?.activation?.keywords, ["review", "audit"]);
  assert.deepEqual(skill?.activation?.fileGlobs, ["src/**/*.ts"]);
  assert.deepEqual(skill?.references, ["references/checklist.md"]);
  assert.equal(skill?.helpers?.[0]?.name, "run-review-checks");
  assert.match(renderSkillInspect(skill!), /helpers: run-review-checks/);
});

test("discoverSkills keeps duplicate names and marks default versus shadowed", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-skills-dupes-"));
  const home = mkdtempSync(path.join(tmpdir(), "mini-skills-dupes-home-"));
  await mkdir(path.join(cwd, ".mini-code", "skills", "browser"), { recursive: true });
  await mkdir(path.join(home, ".codex", "plugins", "cache", "openai-bundled", "browser", "skills", "browser"), { recursive: true });
  await writeFile(path.join(cwd, ".mini-code", "skills", "browser", "SKILL.md"), "---\nname: browser\ndescription: Project browser\n---\nProject body\n");
  await writeFile(path.join(home, ".codex", "plugins", "cache", "openai-bundled", "browser", "skills", "browser", "SKILL.md"), "---\nname: browser\ndescription: Plugin browser\n---\nPlugin body\n");

  const skills = await discoverSkills(cwd, [], true, { homeDir: home });
  const browsers = skills.filter((skill) => skill.name === "browser");

  assert.equal(browsers.length, 2);
  assert.equal(defaultSkills(browsers).length, 1);
  assert.equal(defaultSkills(browsers)[0]?.source, "project");
  assert.ok(browsers.some((skill) => skill.source === "plugin" && skill.shadowedBy));
  assert.match(renderSkillList(skills), /shadowed=1/);
  assert.match(renderSkillList(skills), /\/skill:<id>/);
});

test("resolveSkill supports default name lookup and exact id lookup", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-skills-resolve-"));
  const home = mkdtempSync(path.join(tmpdir(), "mini-skills-resolve-home-"));
  await mkdir(path.join(cwd, ".mini-code", "skills", "browser"), { recursive: true });
  await mkdir(path.join(home, ".codex", "plugins", "cache", "pkg", "skills", "browser"), { recursive: true });
  await writeFile(path.join(cwd, ".mini-code", "skills", "browser", "SKILL.md"), "---\nname: browser\ndescription: Project browser\n---\nProject body\n");
  await writeFile(path.join(home, ".codex", "plugins", "cache", "pkg", "skills", "browser", "SKILL.md"), "---\nname: browser\ndescription: Plugin browser\n---\nPlugin body\n");

  const skills = await discoverSkills(cwd, [], true, { homeDir: home });
  const byName = resolveSkill(skills, "browser");
  const shadowed = skills.find((skill) => skill.name === "browser" && skill.shadowedBy);
  const byId = resolveSkill(skills, shadowed!.id);

  assert.equal(byName.skill?.source, "project");
  assert.equal(byName.candidates.length, 2);
  assert.equal(byId.skill?.id, shadowed?.id);
  assert.equal(byId.skill?.source, "plugin");
});

test("discoverSkills ignores ordinary markdown under roots but accepts configured files", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-skills-md-"));
  await mkdir(path.join(cwd, ".mini-code", "skills", "notes"), { recursive: true });
  await writeFile(path.join(cwd, ".mini-code", "skills", "notes", "README.md"), "# Not a skill\n");
  await writeFile(path.join(cwd, "legacy-skill.md"), "---\nname: legacy\ndescription: Legacy configured skill\n---\nBody\n");

  const withoutConfig = await discoverSkills(cwd, [], true, { includeGlobal: false });
  const withConfig = await discoverSkills(cwd, ["legacy-skill.md"], true, { includeGlobal: false });

  assert.deepEqual(withoutConfig.map((skill) => skill.name), []);
  assert.deepEqual(withConfig.map((skill) => skill.name), ["legacy"]);
  assert.equal(withConfig[0]?.source, "config");
});

test("renderSkillInspect shows all candidates for duplicate names", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-skills-inspect-"));
  const home = mkdtempSync(path.join(tmpdir(), "mini-skills-inspect-home-"));
  await mkdir(path.join(cwd, ".mini-code", "skills", "dup"), { recursive: true });
  await mkdir(path.join(home, ".agents", "skills", "dup"), { recursive: true });
  await writeFile(path.join(cwd, ".mini-code", "skills", "dup", "SKILL.md"), "---\nname: duplicate\ndescription: Project duplicate\n---\nBody\n");
  await writeFile(path.join(home, ".agents", "skills", "dup", "SKILL.md"), "---\nname: duplicate\ndescription: Global duplicate\n---\nBody\n");

  const skills = await discoverSkills(cwd, [], true, { homeDir: home });
  const resolved = resolveSkill(skills, "duplicate");
  const inspect = renderSkillInspect(resolved.skill!, resolved.candidates);

  assert.match(inspect, /matches for: duplicate/);
  assert.match(inspect, /project:duplicate/);
  assert.match(inspect, /global:duplicate/);
  assert.match(inspect, /default:/);
});
