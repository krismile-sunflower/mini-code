# Mini Code Agent

## 中文

一个 clean-room TypeScript coding agent。它借鉴公开终端 coding harness 的通用架构思想：小核心、工具驱动循环、本地工作区访问、会话持久化和终端 UI。

本项目不复制泄漏源码或专有源码。

### 功能

- 支持 OpenAI-compatible `/chat/completions` provider。
- 支持 Anthropic Messages API provider。
- 默认使用 Ink TUI。
- 支持 `--plain` readline 简易终端模式。
- 会话保存在当前项目的 `.mini-agent/sessions/`。
- 对 shell 命令和敏感写入使用基于风险的权限确认。
- 支持上下文压缩：优先使用 LLM 摘要，失败时回退到确定性摘要。
- 自动读取配置来源，优先级如下：
  1. CLI 参数
  2. 进程环境变量
  3. 项目内 `.env.local`
  4. 项目内 `.env`
  5. 默认值
- 内置工具：
  - `list_files`
  - `search`
  - `read_file`
  - `replace_text`
  - `create_file`
  - `apply_patch`
  - `run_command`
  - `git_diff`

### 安装

```bash
npm install
```

OpenAI：

```bash
set MINI_AGENT_PROVIDER=openai
set OPENAI_API_KEY=sk-...
set OPENAI_MODEL=gpt-4.1-mini
```

Anthropic：

```bash
set MINI_AGENT_PROVIDER=anthropic
set ANTHROPIC_API_KEY=sk-ant-...
set ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

OpenAI-compatible 本地服务：

```bash
set MINI_AGENT_PROVIDER=openai
set OPENAI_API_KEY=ollama
set OPENAI_BASE_URL=http://localhost:11434/v1
set OPENAI_MODEL=qwen2.5-coder:7b
```

### 运行

TUI：

```bash
npm run dev
```

简易 CLI：

```bash
npm run dev -- --plain
```

常用参数：

```bash
npm run dev -- --cwd D:\path\to\repo --model gpt-4.1-mini --max-turns 30
npm run dev -- --provider anthropic --model claude-sonnet-4-20250514
npm run dev -- --session 20260524120000-abc123
npm run dev -- --new-session
npm run dev -- --list-sessions
```

TUI 命令：

- `/exit`
- `/sessions`
- `/clear`
- `/compact`
- `/expand`

权限确认：

- `y`：允许一次
- `n`：拒绝
- `a`：当前会话始终允许该工具或命令前缀

### 架构

```text
src/
  index.ts              # 进程入口
  cli/                  # 参数解析、.env 读取、plain readline
  ui/                   # Ink TUI
  core/                 # agent loop、事件、上下文压缩、共享类型
  providers/            # 模型 API 适配器
  tools/                # 工作区工具、patch、权限、路径安全
  storage/              # 会话持久化
```

依赖方向保持单向：

```text
cli/ui -> core -> providers/tools/storage
tools/storage/providers -> core/types only
```

模型每轮返回一个 JSON 决策：

```json
{"action":"tool","tool":"read_file","input":{"path":"src/index.ts"}}
```

或：

```json
{"action":"final","answer":"Done."}
```

编辑文件时，agent 会优先使用标准 unified diff patch：

```json
{
  "action": "tool",
  "tool": "apply_patch",
  "input": {
    "patch": "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n"
  }
}
```

### 验证

```bash
npm run typecheck
npm test
npm run build
```

## English

A clean-room TypeScript coding agent inspired by common public terminal coding harness patterns: a small core, a tool-driven loop, local workspace access, session persistence, and a terminal UI.

This project does not copy leaked or proprietary source code.

### Features

- OpenAI-compatible `/chat/completions` provider.
- Anthropic Messages API provider.
- Ink-based TUI by default.
- `--plain` readline mode for simple terminals.
- Project-local sessions in `.mini-agent/sessions/`.
- Risk-based permissions for shell commands and sensitive writes.
- Context compaction with an LLM summary and deterministic fallback.
- Configuration loading priority:
  1. CLI arguments
  2. Process environment variables
  3. Project `.env.local`
  4. Project `.env`
  5. Defaults
- Built-in tools:
  - `list_files`
  - `search`
  - `read_file`
  - `replace_text`
  - `create_file`
  - `apply_patch`
  - `run_command`
  - `git_diff`

### Setup

```bash
npm install
```

OpenAI:

```bash
set MINI_AGENT_PROVIDER=openai
set OPENAI_API_KEY=sk-...
set OPENAI_MODEL=gpt-4.1-mini
```

Anthropic:

```bash
set MINI_AGENT_PROVIDER=anthropic
set ANTHROPIC_API_KEY=sk-ant-...
set ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

OpenAI-compatible local server:

```bash
set MINI_AGENT_PROVIDER=openai
set OPENAI_API_KEY=ollama
set OPENAI_BASE_URL=http://localhost:11434/v1
set OPENAI_MODEL=qwen2.5-coder:7b
```

### Run

TUI:

```bash
npm run dev
```

Plain CLI:

```bash
npm run dev -- --plain
```

Useful flags:

```bash
npm run dev -- --cwd D:\path\to\repo --model gpt-4.1-mini --max-turns 30
npm run dev -- --provider anthropic --model claude-sonnet-4-20250514
npm run dev -- --session 20260524120000-abc123
npm run dev -- --new-session
npm run dev -- --list-sessions
```

TUI commands:

- `/exit`
- `/sessions`
- `/clear`
- `/compact`
- `/expand`

Permission prompts:

- `y`: allow once
- `n`: deny
- `a`: always allow that tool or command prefix for the current session

### Architecture

```text
src/
  index.ts              # process entrypoint
  cli/                  # args, .env loading, plain readline mode
  ui/                   # Ink TUI
  core/                 # agent loop, events, compaction, shared types
  providers/            # model API adapters
  tools/                # workspace tools, patching, permissions, path safety
  storage/              # session persistence
```

Dependency direction is intentionally one-way:

```text
cli/ui -> core -> providers/tools/storage
tools/storage/providers -> core/types only
```

The model returns one JSON decision per turn:

```json
{"action":"tool","tool":"read_file","input":{"path":"src/index.ts"}}
```

or:

```json
{"action":"final","answer":"Done."}
```

For edits, the agent is instructed to prefer standard unified diff patches:

```json
{
  "action": "tool",
  "tool": "apply_patch",
  "input": {
    "patch": "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n"
  }
}
```

### Verify

```bash
npm run typecheck
npm test
npm run build
```
