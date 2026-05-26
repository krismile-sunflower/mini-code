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
| Resume by id | `npm run dev -- --resume <id-or-path>` |
| Continue latest session | `npm run dev -- --continue` |
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
| `/cost` | Show estimated token usage for the current session. |
| `/bug [description]` | Prepare a diagnostic bug report for sharing. |
| `/release-notes` | Show recent Mini Code changes. |
| `/output-style` | Show the active response style. |
| `/output-style list` | List built-in and custom response styles. |
| `/output-style set <name>` | Persist and activate a response style. |
| `/output-style create <name> <instructions>` | Create a project output style and activate it. |
| `/model` | Show active provider, model, plan model, base URL, and tool protocol. |
| `/config` | Show resolved Mini Code configuration and config sources. |
| `/config list` | Show values persisted in `.mini-code/config.json`. |
| `/config get <key>` | Show one project config value. |
| `/config set <key> <value>` | Persist one project config value for future sessions. |
| `/config unset <key>` | Remove one project config value. |
| `/doctor` | Run local provider/config/MCP/skills diagnostics. |
| `/features` | Show enabled `FEATURE_*` flags. |
| `/login` | Show provider authentication setup guidance. |
| `/memory` | Show loaded user, project, and local `CLAUDE.md` memory. |
| `/memory list` | Show memory file locations and sizes. |
| `/memory add <project\|local\|user> <note>` | Append a note to a memory file and reload it into the active session. |
| `/memory reload` | Reload `CLAUDE.md` memory into the active session without restarting. |
| `/init` | Generate a project `CLAUDE.md` by inspecting the repository. |
| `/tools` | Show built-in workspace tools. |
| `/permissions` | Show permission mode, remembered approvals, and settings permission rules. |
| `/permissions allow <matcher>` | Add a project-local permission allow rule. |
| `/permissions deny <matcher>` | Add a project-local permission deny rule. |
| `/permissions remove <allow\|deny> <matcher>` | Remove a project-local permission rule. |
| `/permissions reload` | Reload permission rules without restarting. |
| `/hooks` | Show configured tool and prompt hooks. |
| `/hooks reload` | Rediscover hooks from settings files without restarting. |
| `/commands` | Show discovered custom slash commands. |
| `/commands reload` | Rediscover custom slash commands without restarting. |
| `/agents` | Show discovered project and user subagents. |
| `/agents reload` | Rediscover subagents without restarting. |
| `/agent inspect <name>` | Inspect a subagent definition. |
| `/agent create <name> [description]` | Create a project subagent definition. |
| `/agent:<name> <task>` | Run a foreground subagent with a task. |
| `/skills` | Show every discovered skill with stable id, source, status, description, and path. |
| `/skill inspect <name-or-id>` | Show a skill manifest; duplicate names show all candidates and the default. |
| `/skill create <name> [description]` | Create `.mini-code/skills/<name>/SKILL.md` and reload skills. |
| `/skill reload` | Rediscover skills and refresh the session/TUI skill list without restarting. |
| `/skill:<name-or-id> <args>` | Load the default skill for a name, or an exact skill by id. |
| `/mcp` | Show configured MCP servers. |
| `/mcp tools` | Show tools exposed by configured MCP servers. |
| `/mcp resources` | Show resources exposed by configured MCP servers. |
| `/mcp reconnect <server>` | Restart one MCP server connection. |
| `/capabilities` | Show the unified capability snapshot. |
| `/review [target]` | Review code and report findings without editing files. |
| `/plan <request>` | Create a read-only implementation plan. |
| `/execute <plan-id>` | Execute an approved/saved plan. |
| `/todos` | Show the latest task todo list. |
| `/tasks` | Show recent session tasks and tool counts. |
| `/resume [id]` | List sessions, or resume a previous session by id. |
| `/continue` | Resume the most recently updated session. |
| `/new` | Start a new session. |
| `/name <title>` | Rename the current session. |
| `/session` | Show the current session id. |
| `/compact` | Compact context. |
| `/summary` | Show current context summary. |
| `/sessions` | List local sessions. |
| `/fork <id>` | Copy a previous session into a new session. |
| `/rename <title>` | Rename current session. |
| `/export-session <path>` | Export current session JSON. |
| `/import-session <path>` | Import session JSON without switching sessions. |
| `/delete-session <id>` | Delete a saved session by id. |
| `/quit` | Exit. |

Important Mini Shell hotkeys:

| Hotkey | Purpose |
| --- | --- |
| `Shift+Tab` | Cycle permission mode: default -> accept edits -> bypass permissions. |
| `Ctrl+C` | Exit. |

Mini Code implements its own permission prompts for write, patch, shell, sensitive paths, deletes, and dangerous commands.

Project and user settings can add persistent allow/deny rules. Mini Code reads `permissions.allow` and `permissions.deny` from the same settings files used for hooks: `.mini-code/settings.json`, `.mini-code/settings.local.json`, `.claude/settings.json`, `.claude/settings.local.json`, `~/.mini-code/settings.json`, and `~/.claude/settings.json`.

Use `/permissions allow <matcher>`, `/permissions deny <matcher>`, and `/permissions remove <allow|deny> <matcher>` to edit project-local rules in `.mini-code/settings.local.json` and reload them immediately.

```json
{
  "permissions": {
    "allow": [
      "Bash(npm test)",
      "Bash(npm run typecheck)",
      "write_file(src/generated/*)"
    ],
    "deny": [
      "Bash(rm -rf *)",
      "write_file(.env*)"
    ]
  }
}
```

`deny` rules take priority over `allow` rules. `allow` rules skip prompts only for otherwise permitted actions; they do not unblock dangerous commands unless Mini Code is started with `--allow-dangerous`.

Permission matchers accept Mini Code tool names and common Claude-style aliases. Examples include `Bash(npm test)`, `Bash(git diff:*)`, `Read(.env*)`, `Edit(src/*.ts)`, `Write(docs/*)`, `Grep(todo)`, and `LS(src)`. `deny` rules also apply to read-only tools that would otherwise run without prompting, so sensitive reads can be blocked from settings.

### Custom Slash Commands

Mini Code discovers project and user custom commands from:

| Location | Notes |
| --- | --- |
| `.mini-code/commands/*.md` | Mini Code project commands. |
| `.claude/commands/*.md` | Claude-style project commands. |
| `~/.mini-code/commands/*.md` | User Mini Code commands. |
| `~/.claude/commands/*.md` | User Claude-style commands. |

Each Markdown file becomes a slash command named after its path. For example, `.claude/commands/review.md` becomes `/review`, and `.claude/commands/git/fix.md` becomes `/git/fix`. Running the command injects the Markdown body as instructions and passes trailing text as user arguments through the normal Mini Code agent loop, including planning, permissions, tools, and session recording.

```bash
/commands
/commands reload
/review src/core
```

Command files may include frontmatter metadata. `description` is shown in `/commands`; frontmatter is removed before the command body is sent to the model. Command bodies support argument placeholders: `$ARGUMENTS` expands to the full trailing text, `$ARGUMENTS[0]` expands to the first parsed argument, and `$1`, `$2`, etc. expand to one-based positional arguments. If no placeholder is present, Mini Code appends the trailing text as user arguments.

### Subagents

Mini Code discovers Claude-style subagents from:

| Location | Notes |
| --- | --- |
| `.mini-code/agents/*.md` | Mini Code project subagents. |
| `.claude/agents/*.md` | Claude-style project subagents. |
| `~/.mini-code/agents/*.md` | User Mini Code subagents. |
| `~/.claude/agents/*.md` | User Claude-style subagents. |

Subagent files support frontmatter fields such as `name`, `description`, and `tools`, followed by Markdown instructions. Use `/agents` to list them, `/agent inspect <name>` to inspect one, `/agent create <name> [description]` to scaffold `.mini-code/agents/<name>.md`, `/agents reload` after editing files, and `/agent:<name> <task>` to run a foreground subagent. Mini Code also exposes a model-callable `create_subagent` tool, so natural-language requests such as "create a release review subagent" can create the file through the normal permission and session-recording path. In foreground mode, declared `tools` constrain the tool list shown to the model and Mini Code rejects undeclared tool calls before execution. This foreground mode applies the subagent instructions to the current session and current permission policy; it does not yet create an isolated child context or parallel worktree.

### Hooks

Mini Code can run trusted project or user hook commands from `.mini-code/settings.json`, `.mini-code/settings.local.json`, `.claude/settings.json`, `.claude/settings.local.json`, `~/.mini-code/settings.json`, and `~/.claude/settings.json`.

```bash
/hooks
/hooks reload
```

Example settings:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          { "type": "command", "command": "node scripts/session-context.js" }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "node scripts/prompt-context.js" }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "read_file",
        "hooks": [
          { "type": "command", "command": "node scripts/pre-read.js" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node scripts/post-tool.js", "timeoutMs": 10000 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node scripts/after-response.js" }
        ]
      }
    ],
    "SubagentStop": [
      {
        "matcher": "reviewer",
        "hooks": [
          { "type": "command", "command": "node scripts/after-subagent.js" }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "manual",
        "hooks": [
          { "type": "command", "command": "node scripts/before-compact.js" }
        ]
      }
    ]
  }
}
```

`matcher` supports exact Mini Code tool names such as `read_file` and `run_command`, `*`, regular expressions, and common Claude-style aliases such as `Read` and `Bash`. `SessionStart` runs when a session is created or resumed and can match `startup` or `resume`; successful stdout is loaded as session context. `UserPromptSubmit` runs before a user request is sent to the model; successful stdout is injected as extra context for that request, and failure blocks the request. Tool hook commands run in the workspace after normal tool validation. `PreToolUse` runs before permission approval and can block the tool call before a prompt is shown; `PostToolUse` runs after successful tool execution, and failures are appended as hook warnings. `Stop` runs after a final answer and receives the final answer in hook context; failures are reported without changing the answer. `SubagentStop` runs after a foreground subagent final answer and can match the subagent name. `PreCompact` runs before manual or automatic compaction and can match `manual` or `auto`; failure blocks that compaction. Dangerous command patterns are blocked unless Mini Code is started with `--allow-dangerous`.

Hook commands receive JSON context on stdin and these environment variables: `CLAUDE_PROJECT_DIR`, `MINI_CODE_HOOK_EVENT`, `MINI_CODE_HOOK_TOOL`, `MINI_CODE_HOOK_INPUT`, `MINI_CODE_HOOK_PROMPT`, `MINI_CODE_HOOK_FINAL_ANSWER`, `MINI_CODE_HOOK_SUBAGENT_NAME`, `MINI_CODE_HOOK_TRIGGER`, `MINI_CODE_HOOK_NOTIFICATION_MESSAGE`, `MINI_CODE_HOOK_NOTIFICATION_TITLE`, `MINI_CODE_HOOK_NOTIFICATION_TYPE`, `MINI_CODE_HOOK_OK`, and `MINI_CODE_HOOK_OUTPUT`.

A command hook can also return structured JSON on stdout to block the current action without relying on a nonzero exit code:

```json
{ "decision": "block", "reason": "explain why the action is blocked" }
```

### Config And Diagnostics

Mini Code exposes Claude-Code-style configuration visibility through slash commands:

```bash
/model
/config
/config list
/config get model
/config set model gpt-4.1-mini
/config unset model
/doctor
/features
/login
/output-style list
/output-style set concise
```

`/config set` writes `.mini-code/config.json` with validated project defaults such as `provider`, `model`, `planModel`, `outputStyle`, `permissionMode`, `toolsPolicy`, `toolProtocol`, `enableSkills`, `enableMcp`, `skills`, and `featureFlags`. Startup configuration changes apply to new sessions or after restart. `/output-style set` updates `outputStyle` and refreshes the active system prompt immediately. `/doctor` checks the active API key, base URL, provider, model, session directory, MCP config, skills, and tool protocol. Experimental flags can be enabled with `FEATURE_<NAME>=1`; for example `FEATURE_BUDDY=1` appears as `buddy` in `/features` and `/status`.

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

Mini Code also exposes a native `create_skill` write tool to its model. When the user asks in normal language to create a reusable skill, the agent can call this tool instead of guessing the `.mini-code/skills/<name>/SKILL.md` layout by hand.

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
/skill create code-review Review code carefully before changes
/skill inspect code-review
/skill:code-review inspect auth flow
/skill:project:code-review inspect auth flow
npm run dev -- --skill ./.claude/skills/code-review
npm run dev -- --no-skills
```

`/skill create <name> [description]` scaffolds a project-local skill in `.mini-code/skills/<name>/SKILL.md`, normalizes the name to lowercase hyphen-case, refuses to overwrite an existing skill, and reloads the skill index immediately. The same behavior is available to the model through the `create_skill` tool, so natural-language requests such as "create a skill for reviewing pull requests" can be handled directly. `/skills` prints a table with `id`, `name`, `source`, `status`, `description`, and `path`. Status is `default` when `/skill:<name>` will load that item, `shadowed` when another skill with the same name wins by priority, and `disabled` when `disable-model-invocation=true`. Duplicate names are no longer hidden: use `/skill:<name>` for the default item or `/skill:<id>` for an exact duplicate.

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
| `--new-session` or `--no-session` | Starts a fresh Mini Code session. |
| `--list-sessions` or `--resume` | Lists saved Mini Code sessions. |
| `--resume <id-or-path>` | Resumes a saved Mini Code session. |
| `--session-dir <path>` | Uses a custom Mini Code session directory. |
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
| `MINI_CODE_OUTPUT_STYLE` | Selects the active built-in or custom output style. |
| `MINI_CODE_SKILLS` | Comma-separated skill files or directories. |
| `MINI_CODE_NO_SKILLS` | Disables Mini Shell skills when truthy. |

Example `.mini-code/config.json`:

```json
{
  "provider": "openai",
  "model": "gpt-4o",
  "planModel": "claude-sonnet-4-5",
  "outputStyle": "concise",
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
npm run dev -- --continue
npm run dev -- --session <id-or-path>
npm run dev -- --fork <id-or-path>
npm run dev -- --session-dir .mini-code/sessions
npm run dev -- --no-session
```

Inside Mini Code, use `/export-session <path>` to write the active session JSON and `/import-session <path>` to add a saved session JSON to the current session directory. Import preserves the session id and rejects duplicates; use `/fork <path>` when you need a copied session with a new id.

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
