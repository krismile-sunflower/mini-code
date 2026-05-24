import { maybeCompactMessages } from "./compaction.js";
import { chat } from "../providers/llm.js";
import { commandPrefix } from "../tools/permissions.js";
import { SessionStore } from "../storage/sessionStore.js";
import { createTools } from "../tools/registry.js";
import type {
  AgentConfig,
  AgentDecision,
  AgentEvent,
  AgentEventHandler,
  ApprovalContext,
  ApprovalDecision,
  ApprovalHandler,
  Message,
  PendingApproval,
  SessionRecord,
  ToolDefinition
} from "./types.js";

function renderTools(tools: ToolDefinition[]): string {
  return tools
    .map((tool) => {
      const schema = Object.entries(tool.inputSchema)
        .map(([key, value]) => `    ${key}: ${value}`)
        .join("\n");
      return `- ${tool.name} [risk=${tool.risk}]: ${tool.description}\n${schema || "    no input"}`;
    })
    .join("\n");
}

function systemPrompt(tools: ToolDefinition[]): string {
  return `You are Mini Code Agent, a local coding assistant running in a user's workspace.

Work like a careful terminal coding harness:
- Inspect the repository before editing.
- Prefer apply_patch with standard unified diff for multi-line edits.
- Use replace_text only for small exact single-location edits.
- Preserve unrelated user changes.
- Run relevant checks when practical.
- Shell commands and risky writes may require user permission.
- Use tools when you need filesystem, search, shell, or edit access.
- Return exactly one JSON object each turn. Do not wrap it in markdown.

Available tools:
${renderTools(tools)}

Decision format:
{"action":"tool","tool":"read_file","input":{"path":"src/index.ts"},"thought":"why this is useful"}
{"action":"tool","tool":"apply_patch","input":{"patch":"--- a/file.ts\\n+++ b/file.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n"}}
{"action":"final","answer":"short summary for the user"}
`;
}

function parseDecision(raw: string): AgentDecision {
  const trimmed = raw.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const firstBrace = withoutFence.indexOf("{");
  const lastBrace = withoutFence.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error(`Model did not return JSON: ${raw}`);
  }
  const parsed = JSON.parse(withoutFence.slice(firstBrace, lastBrace + 1)) as AgentDecision;
  if (parsed.action !== "tool" && parsed.action !== "final") {
    throw new Error(`Invalid action: ${String(parsed.action)}`);
  }
  return parsed;
}

export class AgentSession {
  readonly id: string;
  private readonly tools: Map<string, ToolDefinition>;
  private readonly sessionStore: SessionStore;
  private readonly approvalContext: ApprovalContext;
  private record!: SessionRecord;
  private messages: Message[];
  private events: AgentEvent[] = [];
  private summary = "";

  private constructor(
    private readonly config: AgentConfig,
    private readonly onEvent: AgentEventHandler,
    private readonly onApproval: ApprovalHandler,
    toolList: ToolDefinition[],
    record: SessionRecord
  ) {
    this.tools = new Map(toolList.map((tool) => [tool.name, tool]));
    this.sessionStore = new SessionStore(config.sessionDir);
    this.approvalContext = {
      cwd: config.cwd,
      allowedTools: new Set<string>(),
      allowedCommandPrefixes: new Set<string>()
    };
    this.record = record;
    this.id = record.id;
    this.messages = [...record.messages];
    this.events = [...record.events];
    this.summary = record.summary;
  }

  static async create(config: AgentConfig, onEvent: AgentEventHandler, onApproval: ApprovalHandler): Promise<AgentSession> {
    const toolList = createTools(config.cwd, config.maxToolOutputChars);
    const store = new SessionStore(config.sessionDir);
    await store.ensure();
    const loaded = config.sessionId ? await store.load(config.sessionId) : undefined;
    const messages = loaded?.messages ?? [{ role: "system", content: systemPrompt(toolList) }];
    const record =
      loaded ??
      store.createRecord({
        id: config.sessionId,
        cwd: config.cwd,
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
        messages
      });
    const session = new AgentSession(config, onEvent, onApproval, toolList, record);
    await session.persist();
    return session;
  }

  async run(userRequest: string): Promise<string> {
    this.messages.push({ role: "user", content: userRequest });
    await this.persist();

    for (let turn = 1; turn <= this.config.maxTurns; turn += 1) {
      await this.compactIfNeeded();
      const raw = await chat({
        provider: this.config.provider,
        baseUrl: this.config.baseUrl,
        apiKey: this.config.apiKey,
        model: this.config.model,
        messages: this.messages
      });
      this.messages.push({ role: "assistant", content: raw });
      await this.emit({ type: "model_response", raw });

      const decision = parseDecision(raw);
      if (decision.action === "final") {
        const answer = decision.answer ?? "";
        await this.emit({ type: "final", answer });
        await this.persist();
        return answer;
      }

      if (!decision.tool) throw new Error("Tool decision omitted tool name.");
      const tool = this.tools.get(decision.tool);
      if (!tool) throw new Error(`Unknown tool: ${decision.tool}`);

      const input = decision.input ?? {};
      const description = tool.describe(input);
      await this.emit({ type: "tool_request", turn, tool: tool.name, input, thought: decision.thought, description });

      const requirement = tool.requiresApproval(input, this.approvalContext);
      if (requirement.required) {
        const approvalId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const decisionResult = await this.onApproval({
          id: approvalId,
          tool: tool.name,
          input,
          description,
          requirement,
          resolve: () => undefined
        });
        await this.emit({ type: "permission_request", id: approvalId, tool: tool.name, input, description, requirement });
        if (decisionResult === "deny") {
          await this.recordToolResult(turn, tool.name, false, `User denied permission: ${requirement.reason}`);
          continue;
        }
        this.rememberApproval(tool.name, input, requirement.allowAlwaysKey, decisionResult);
      }

      const result = await tool.run(input);
      await this.recordToolResult(turn, tool.name, result.ok, result.output);
    }

    const answer = "I reached the maximum number of turns before finishing.";
    await this.emit({ type: "final", answer });
    await this.persist();
    return answer;
  }

  async forceCompact(): Promise<void> {
    const compacted = await maybeCompactMessages(this.config, this.messages, this.summary);
    this.messages = compacted.messages;
    this.summary = compacted.summary;
    await this.emit({ type: "compaction", summary: this.summary });
    await this.persist();
  }

  private rememberApproval(tool: string, input: Record<string, unknown>, key: string | undefined, decision: ApprovalDecision): void {
    if (decision !== "always_allow") return;
    if (tool === "run_command" && typeof input.command === "string") {
      this.approvalContext.allowedCommandPrefixes.add(key ?? commandPrefix(input.command));
    } else {
      this.approvalContext.allowedTools.add(tool);
    }
  }

  private async recordToolResult(turn: number, tool: string, ok: boolean, output: string): Promise<void> {
    await this.emit({ type: "tool_result", turn, tool, ok, output });
    this.messages.push({
      role: "tool",
      content: JSON.stringify({ tool, ok, output })
    });
    await this.persist();
  }

  private async compactIfNeeded(): Promise<void> {
    const compacted = await maybeCompactMessages(this.config, this.messages, this.summary);
    if (!compacted.compacted) return;
    this.messages = compacted.messages;
    this.summary = compacted.summary;
    await this.emit({ type: "compaction", summary: this.summary });
    await this.persist();
  }

  private async emit(event: AgentEvent): Promise<void> {
    this.events.push(event);
    this.onEvent(event);
    await this.persist();
  }

  private async persist(): Promise<void> {
    this.record = {
      ...this.record,
      cwd: this.config.cwd,
      provider: this.config.provider,
      model: this.config.model,
      baseUrl: this.config.baseUrl,
      messages: this.messages,
      events: this.events,
      summary: this.summary
    };
    await this.sessionStore.save(this.record);
  }
}
