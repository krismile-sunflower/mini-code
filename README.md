# Mini Code Agent

Mini Code Agent is a Claude-Code-style terminal coding agent shell built around a local TypeScript agent core, with Pi available as the underlying ecosystem/runtime escape hatch.

The default path is now Mini Shell: Mini Code owns the TUI, configuration, permission workflow, slash commands, plan workflow, session metadata, and `.mini-code/` state. Pi remains installed and can be invoked explicitly with `--pi-pass-through -- ...` while the Pi-engine integration is tightened.

This project stays clean-room: it uses public npm packages, public docs, and public product behavior only. It does not copy leaked or proprietary source code.

## Quick Start

```bash
npm install
npm run dev
```

Run against another workspace:

```bash
npm run dev -- --cwd /path/to/repo
```

Non-interactive print mode:

```bash
npm run dev -- --plain "read README.md and summarize it"
```

`--plain` is translated to Pi's `--print` flag. Most other Pi flags pass through unchanged.

## Mini Shell

Useful Mini Code capabilities:

| Capability | Usage |
| --- | --- |
| Interactive TUI | `npm run dev` |
| Plain Mini Shell | `npm run dev -- --plain` |
| Select provider | `npm run dev -- --provider openai` |
| Select model | `npm run dev -- --model gpt-4o` |
| Select plan model | `npm run dev -- --plan-model claude-sonnet-4-5` |
| Permission mode | `npm run dev -- --permission-mode accept_edits` |
| Native provider tools | `npm run dev -- --tool-protocol native` |
| Create plan | `npm run dev -- --plain --plan "design the refactor"` |
| Execute saved plan | `npm run dev -- --plain --execute-plan <plan-id>` |
| Pi pass-through | `npm run dev -- --pi-pass-through -- --help` |

Pi package currently installed: `@earendil-works/pi-coding-agent@0.75.5`.

Pi capabilities are available through pass-through:

| Capability | Usage |
| --- | --- |
| Pi TUI | `npm run dev -- --pi-pass-through --` |
| Pi print mode | `npm run dev -- --pi-pass-through -- --print "inspect src"` |
| Pi JSON events | `npm run dev -- --pi-pass-through -- --mode json --print "inspect src"` |
| Pi RPC mode | `npm run dev -- --pi-pass-through -- --mode rpc` |
| Select provider | `npm run dev -- --provider openai` |
| Select model | `npm run dev -- --model openai/gpt-4o` |
| Plan mode | `npm run dev -- --plan "design the refactor"` |
| Plan model | `npm run dev -- --plan-model claude-sonnet-4-5 --plan "design the refactor"` |
| Thinking level | `npm run dev -- --model sonnet:high` or `--thinking high` |
| Resume picker | `npm run dev -- --resume` |
| Resume session | `npm run dev -- --session <id-or-path>` |
| New ephemeral session | `npm run dev -- --new-session` |
| Session directory | `npm run dev -- --session-dir .mini-code/sessions` |
| Read-only tool set | `npm run dev -- --tools read,grep,find,ls` |
| Disable tools | `npm run dev -- --no-tools` |
| Disable context files | `npm run dev -- --no-context-files` |
| Load extension | `npm run dev -- --extension ./my-extension.ts` |
| Load skill | `npm run dev -- --skill ./skills/my-skill.md` |

Pi's public CLI help is available with:

```bash
npm run dev -- --pi-pass-through -- --help
```

## Interactive Commands

Mini Shell provides Claude-Code-like workflows through slash commands and hotkeys. Common commands include:

| Command | Purpose |
| --- | --- |
| `/help` | Show Mini Code commands. |
| `/status` | Show effective session/config status. |
| `/model` | Show active provider, model, plan model, base URL, and tool protocol. |
| `/config` | Show resolved Mini Code configuration and config sources. |
| `/doctor` | Run local provider/config/MCP/skills diagnostics. |
| `/features` | Show enabled `FEATURE_*` flags. |
| `/login` | Show provider authentication setup guidance. |
| `/tools` | Show built-in workspace tools. |
| `/permissions` | Show permission mode and remembered approvals. |
| `/skills` | Show every discovered skill with stable id, source, status, description, and path. |
| `/skill inspect <name-or-id>` | Show a skill manifest; duplicate names show all candidates and the default. |
| `/skill reload` | Rediscover skills and refresh the session/TUI skill list without restarting. |
| `/skill:<name-or-id> <args>` | Load the default skill for a name, or an exact skill by id. |
| `/mcp` | Show configured MCP servers. |
| `/mcp tools` | Show tools exposed by configured MCP servers. |
| `/mcp resources` | Show resources exposed by configured MCP servers. |
| `/mcp reconnect <server>` | Restart one MCP server connection. |
| `/capabilities` | Show the unified capability snapshot. |
| `/plan <request>` | Create a read-only implementation plan. |
| `/execute <plan-id>` | Execute an approved/saved plan. |
| `/resume` | Resume a previous session. |
| `/new` | Start a new session. |
| `/name` | Rename the current session. |
| `/session` | Show the current session id. |
| `/compact` | Compact context. |
| `/summary` | Show current context summary. |
| `/sessions` | List local sessions. |
| `/rename <title>` | Rename current session. |
| `/export-session <path>` | Export current session JSON. |
| `/quit` | Exit. |

Important Mini Shell hotkeys:

| Hotkey | Purpose |
| --- | --- |
| `Shift+Tab` | Cycle permission mode: default -> accept edits -> bypass permissions. |
| `Ctrl+C` | Exit. |

Mini Code implements its own permission prompts for write, patch, shell, sensitive paths, deletes, and dangerous commands.

### Config And Diagnostics

Mini Code exposes Claude-Code-style configuration visibility through slash commands:

```bash
/model
/config
/doctor
/features
/login
```

`/doctor` checks the active API key, base URL, provider, model, session directory, MCP config, skills, and tool protocol. Experimental flags can be enabled with `FEATURE_<NAME>=1`; for example `FEATURE_BUDDY=1` appears as `buddy` in `/features` and `/status`.

## Plan Mode

Mini Code supports two-stage plan mode:

```bash
npm run dev -- --plain --plan "design the auth refactor"
npm run dev -- --plan-model claude-sonnet-4-5
```

Plan mode is intentionally different from normal coding mode:

| Behavior | Description |
| --- | --- |
| Read-only planning | `/plan` uses the configured `planModel` and asks for a plan before execution. |
| User confirmation | TUI offers `[y] execute`, `[n] cancel`, `[e] edit request` after a plan is created. |
| Separate model | `--plan-model <model>` uses a planner model without changing normal `--model`. |
| Env switch | `MINI_CODE_PLAN_MODE=true` enables plan mode. |
| Env model | `MINI_CODE_PLAN_MODEL=<model>` selects the planner model. |

The expected output is a concrete implementation plan: goal, relevant files, ordered steps, validation commands, risks, and open questions. It should not edit files or run mutating commands.

## Tools And Context

Pi's built-in tools are:

| Tool | Purpose |
| --- | --- |
| `read` | Read file contents. |
| `bash` | Execute shell commands. |
| `edit` | Edit files with find/replace. |
| `write` | Create or overwrite files. |
| `grep` | Search file contents. |
| `find` | Find files by glob. |
| `ls` | List directory contents. |

By default Pi gives the model `read`, `write`, `edit`, and `bash`. `grep`, `find`, and `ls` can be enabled with `--tools`.

Pi discovers `AGENTS.md` and `CLAUDE.md` context files unless `--no-context-files` is passed.

## Skills And Pi Ecosystem

Mini Code supports an Agent Skills-compatible MVP in the Mini Shell while keeping Pi's richer ecosystem available through pass-through/RPC.

Mini Shell discovers skills from:

| Location | Notes |
| --- | --- |
| `.mini-code/skills/` | Mini Code project-local skills. |
| `.agents/skills/` | Shared Agent Skills location. |
| `.claude/skills/` | Project Claude Code skills. |
| `~/.mini-code/skills/` | User Mini Code skills. |
| `~/.agents/skills/` | User Agent Skills. |
| `~/.claude/skills/` | User Claude-style skills. |
| `~/.codex/skills/` | User Codex skills. |
| `~/.codex/plugins/cache/` | Plugin-provided skills. |
| `~/.cc-switch/skills/` | Additional local skill packs. |
| `.mini-code/config.json` `skills` | Extra explicit files or directories. |
| `--skill <path>` | Extra explicit skill path, repeatable. |

Only `SKILL.md` files inside skill-pack directories are discovered from project, global, and plugin roots. Explicit configured single-file `.md` paths are still accepted for backwards compatibility.

Supported skill format:

```markdown
---
name: code-review
description: Review code carefully before changes
allowed-tools: read grep
disable-model-invocation: false
---

# Code Review

Read relevant files first and report risks.
```

Commands:

```bash
/skills
/skill inspect code-review
/skill:code-review inspect auth flow
/skill:project:code-review inspect auth flow
npm run dev -- --skill ./.claude/skills/code-review
npm run dev -- --no-skills
```

`/skills` prints a table with `id`, `name`, `source`, `status`, `description`, and `path`. Status is `default` when `/skill:<name>` will load that item, `shadowed` when another skill with the same name wins by priority, and `disabled` when `disable-model-invocation=true`. Duplicate names are no longer hidden: use `/skill:<name>` for the default item or `/skill:<id>` for an exact duplicate.

Mini Shell skills are instruction-first: they are discovered, listed with their source and status, inspected, injected into the prompt, and can be forced with `/skill:name` or `/skill:id`. Structured frontmatter can declare activation hints, references, allowed tools, and helper commands. Helper commands are suggestions only in this release and must still run through Mini Code's normal permission flow.

## Native MCP

Mini Code can load project-local MCP servers from `.mini-code/mcp.json`:

```json
{
  "mcpServers": {
    "example": {
      "command": "node",
      "args": ["./scripts/mock-mcp-server.mjs"],
      "env": {},
      "risk": "read"
    }
  }
}
```

MCP tools are exposed as `mcp:<server>:<tool>` and flow through the same validation, approval, event, and session-recording path as built-in tools. Unknown or omitted MCP risk defaults to `shell`; only tools configured as `read` are available in read-only plan mode.

## Tool Protocols

Mini Code defaults to its provider-neutral JSON decision protocol. Providers that support native tool calling can be enabled with:

```bash
npm run dev -- --tool-protocol native
```

Native OpenAI and Anthropic tool-call responses are normalized back into Mini Code's internal JSON decisions, so permissions, events, session records, and tool execution stay provider-agnostic.

For Pi packages, extensions, prompt templates, custom tools, and future MCP-style workflows, use Pi directly through pass-through while Mini Code's native engine integration matures:

```bash
npm run dev -- --pi-pass-through -- install npm:@org/pi-tools
npm run dev -- --pi-pass-through -- config
npm run dev -- --pi-pass-through -- --mode rpc
```

This keeps Mini Code responsible for permissions, planning, TUI, and config boundaries while still reusing Pi's mature ecosystem where it is stronger.

## Wrapper Compatibility

Mini Code Agent keeps a few old flags as aliases so existing commands do not immediately break:

| Mini flag | Pi behavior |
| --- | --- |
| `--plain` | Runs the plain Mini Shell. |
| `--cwd <path>` | Runs Pi with that working directory. |
| `--new-session` | Translates to `--no-session`. |
| `--list-sessions` | Translates to `--resume`. |
| `--plan` | Enables Mini Code plan mode. |
| `--plan-model <model>` | Uses a planner model for plan mode. |
| `--execute-plan <id>` | Executes a saved plan in plain mode. |
| `--skill <path>` | Adds a skill file or directory. |
| `--no-skills` | Disables Mini Shell skill discovery. |
| `--pi-pass-through -- <args>` | Directly invokes Pi for debugging/escape hatch. |
| `--provider <name>` | Passed through. |
| `--model <name>` | Passed through. |
| `--session <id>` | Passed through. |
| `--legacy` | Runs the old in-repo agent instead of Pi. |

`--allow-dangerous`, `--base-url`, and `--max-turns` are Mini Shell flags. Pi-specific flags should be sent after `--pi-pass-through --`.

## Authentication

Use Pi's supported environment variables, `/login`, or the compatibility variables below. The wrapper loads `.env` and `.env.local` from the selected workspace before starting Pi. Shell environment variables still win over file values.

Common API-key environment variables include:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export GEMINI_API_KEY=...
export OPENROUTER_API_KEY=...
```

Pi also supports many other providers. Run `npm run dev -- --help` for the current list.

### Compatibility Env

Mini Code reads `.mini-code/config.json`, `.env.local`, `.env`, environment variables, and CLI args. CLI wins over env; env wins over files.

The old Mini Code Agent environment variables still work as aliases:

| Old variable | Pi wrapper behavior |
| --- | --- |
| `MINI_AGENT_PROVIDER` or `LLM_PROVIDER` | Adds `--provider <value>` unless `--provider` was passed explicitly. |
| `MINI_AGENT_MODEL` or `LLM_MODEL` | Adds `--model <value>` unless `--model` was passed explicitly. |
| `ANTHROPIC_MODEL` | Adds `--model <value>` when provider is `anthropic`. |
| `OPENAI_MODEL` | Adds `--model <value>` when provider is `openai`. |
| `GEMINI_MODEL` or `GOOGLE_MODEL` | Adds `--model <value>` when provider is `google`. |
| `MINI_AGENT_API_KEY` or `LLM_API_KEY` | Copies into the provider API key env var when a provider is known. |
| `OPENAI_BASE_URL` or `MINI_AGENT_BASE_URL` | Creates a project-local Pi `models.json` override for OpenAI-compatible endpoints. |
| `MINI_CODE_PLAN_MODE` or `MINI_AGENT_PLAN_MODE` | Enables Mini Code plan mode when set to `true`, `1`, `yes`, or `on`. |
| `MINI_CODE_PLAN_MODEL` or `MINI_AGENT_PLAN_MODEL` | Selects the model used by plan mode. |
| `MINI_CODE_SKILLS` | Comma-separated skill files or directories. |
| `MINI_CODE_NO_SKILLS` | Disables Mini Shell skills when truthy. |

Example `.mini-code/config.json`:

```json
{
  "provider": "openai",
  "model": "gpt-4o",
  "planModel": "claude-sonnet-4-5",
  "permissionMode": "default",
  "skills": [".claude/skills/code-review"],
  "enableSkills": true
}
```

### Common Errors

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `call_id` or `tool_call_id` is empty | Provider received a native tool-result role without a matching tool call. | Mini Code converts internal tool results to user text before provider calls; update and rerun tests if this appears. |
| API key or 401 error | Provider credentials are missing or wrong. | Check `/status`, `.env.local`, and provider env vars. |
| OpenAI-compatible 404/base URL error | `OPENAI_BASE_URL` points at the wrong root. | Use a `/v1` compatible URL such as `http://localhost:11434/v1`. |
| Skill not found | The skill path was not discovered, name differs, or a duplicate needs an exact id. | Run `/skills` and use the listed name or id. |

Example `.env.local` for Anthropic:

```bash
MINI_AGENT_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-5
```

Example `.env.local` for OpenAI:

```bash
MINI_AGENT_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
```

Example `.env.local` for Ollama or another OpenAI-compatible local server:

```bash
MINI_AGENT_PROVIDER=openai
OPENAI_API_KEY=ollama
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL=qwen2.5-coder:7b
```

Mini Code stores state in `.mini-code` by default. Pi pass-through also uses `.mini-code` as `PI_CODING_AGENT_DIR` unless overridden.

When `OPENAI_BASE_URL`/`MINI_AGENT_BASE_URL` is set with an OpenAI model, the wrapper writes `.mini-code/models.json`. This keeps custom endpoint config local to the project instead of modifying `~/.pi/agent/models.json`.

Explicit CLI flags always win over compatibility env values:

```bash
npm run dev -- --provider anthropic --model claude-sonnet-4-5
```

## Sessions

Mini Code stores Pi state under `.mini-code/` by default. Pi sessions are therefore saved under `.mini-code/sessions/` unless `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, or `--session-dir` overrides that.

Useful session commands:

```bash
npm run dev -- --resume
npm run dev -- --session <id-or-path>
npm run dev -- --fork <id-or-path>
npm run dev -- --session-dir .mini-code/sessions
npm run dev -- --no-session
```

When resuming a session, Mini Code compares the saved capability snapshot with the currently discovered tools, MCP servers, and skills. If capabilities were added or removed, the shell prints a short warning so the model's available actions do not change silently.

## Legacy Mode

The previous TypeScript + Ink implementation remains available:

```bash
npm run dev -- --legacy
npm run dev -- --legacy --plain
```

Legacy mode still uses the old local architecture under `src/core`, `src/tools`, `src/providers`, `src/storage`, and `src/ui`. New product work should target the Pi wrapper path unless there is a specific reason to preserve old behavior.

## Development

```bash
npm run typecheck
npm test
npm run build
```

Scripts:

| Script | Description |
| --- | --- |
| `npm run dev` | Run the source entrypoint with `tsx`. |
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm run start` | Run compiled `dist/index.js`. |
| `npm run typecheck` | Run TypeScript type checking. |
| `npm test` | Run Node test runner tests. |
