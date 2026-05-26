import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProjectSubagent, discoverSubagents, renderSubagentInspect, renderSubagentList, resolveSubagent, subagentInjection, subagentToolNames } from "./subagents.js";

test("discoverSubagents reads Claude-style project agents", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-subagents-"));
  try {
    await mkdir(path.join(dir, ".claude", "agents"), { recursive: true });
    await writeFile(path.join(dir, ".claude", "agents", "reviewer.md"), "---\nname: code-reviewer\ndescription: Review code carefully\ntools: Read, Grep, Bash\n---\nInspect diffs before answering.\n", "utf8");

    const agents = await discoverSubagents(dir, false);
    const resolved = resolveSubagent(agents, "code-reviewer");

    assert.equal(agents.length, 1);
    assert.equal(resolved.agent?.name, "code-reviewer");
    assert.deepEqual(resolved.agent?.tools, ["Read", "Grep", "Bash"]);
    assert.match(renderSubagentList(agents), /code-reviewer/);
    assert.match(renderSubagentInspect(resolved.agent!), /Review code carefully/);
    assert.match(subagentInjection(resolved.agent!, "check src"), /Task:\ncheck src/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverSubagents prefers project agents over global duplicates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-subagents-project-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "mini-subagents-home-"));
  try {
    await mkdir(path.join(dir, ".mini-code", "agents"), { recursive: true });
    await mkdir(path.join(home, ".claude", "agents"), { recursive: true });
    await writeFile(path.join(dir, ".mini-code", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Project reviewer\n---\nProject body\n", "utf8");
    await writeFile(path.join(home, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Global reviewer\n---\nGlobal body\n", "utf8");

    const agents = await discoverSubagents(dir, true, home);
    const resolved = resolveSubagent(agents, "reviewer");

    assert.equal(agents.length, 2);
    assert.equal(resolved.agent?.description, "Project reviewer");
    assert.equal(agents.filter((agent) => agent.shadowedBy).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("createProjectSubagent scaffolds a discoverable project subagent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-subagents-create-"));
  try {
    const created = await createProjectSubagent(dir, "PR Reviewer", "Review pull requests");
    const text = await readFile(created.path, "utf8");
    const agents = await discoverSubagents(dir, false);

    assert.equal(created.name, "pr-reviewer");
    assert.match(text, /name: pr-reviewer/);
    assert.match(text, /description: Review pull requests/);
    assert.equal(resolveSubagent(agents, "pr-reviewer").agent?.name, "pr-reviewer");
    await assert.rejects(() => createProjectSubagent(dir, "PR Reviewer"), /already exists/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("subagentToolNames maps Claude-style declared tools to internal tools", () => {
  const allowed = subagentToolNames({
    id: "project:reviewer",
    name: "reviewer",
    description: "Review",
    path: "reviewer.md",
    source: "project",
    tools: ["Read", "Grep", "Bash"],
    content: "Review"
  }, [
    { name: "read_file", description: "", inputSchema: {}, risk: "read", describe: () => "", requiresApproval: () => ({ required: false, risk: "read", reason: "" }), validate: () => undefined, run: async () => ({ ok: true, output: "" }) },
    { name: "search", description: "", inputSchema: {}, risk: "read", describe: () => "", requiresApproval: () => ({ required: false, risk: "read", reason: "" }), validate: () => undefined, run: async () => ({ ok: true, output: "" }) },
    { name: "run_command", description: "", inputSchema: {}, risk: "shell", describe: () => "", requiresApproval: () => ({ required: true, risk: "shell", reason: "" }), validate: () => undefined, run: async () => ({ ok: true, output: "" }) },
    { name: "write_file", description: "", inputSchema: {}, risk: "write", describe: () => "", requiresApproval: () => ({ required: true, risk: "write", reason: "" }), validate: () => undefined, run: async () => ({ ok: true, output: "" }) }
  ]);

  assert.deepEqual(Array.from(allowed ?? []).sort(), ["read_file", "read_many_files", "run_command", "search", "show_file_outline"]);
});
