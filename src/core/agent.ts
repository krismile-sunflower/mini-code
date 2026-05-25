import { maybeCompactMessages } from "./compaction.js";
import { parseDecision } from "./decision.js";
import { DenialTracker } from "./denial.js";
import { loadProjectMemory } from "./memory.js";
import { fallbackReadFilePath, finalClaimsToolUse, requiresPlan, requiresWorkspaceTool } from "./policy.js";
import { executePlanRequest, planModeRequest, planRequiredCorrection, planSystemPrompt, repairPrompt, systemPrompt, toolRequiredCorrection } from "./prompt.js";
import { discoverSkills, renderSkillList, skillInjection } from "./skills.js";
import { complete } from "../providers/llm.js";
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
  PermissionMode,
  Message,
  PendingApproval,
  SessionRecord,
  TaskRecord,
  TaskTodo,
  PlanRecord,
  ToolErrorType,
  ToolMetadata,
  ToolDefinition,
  SkillInfo
} from "./types.js";

function titleFromRequest(request: string): string {
  const compact = request.replace(/\s+/g, " ").trim();
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}

function createTask(userRequest: string): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userRequest,
    status: "planning",
    todos: [],
    toolCalls: [],
    approvals: [],
    createdAt: now,
    updatedAt: now
  };
}

function createTodos(items: Array<{ content: string; status?: TaskTodo["status"] }>): TaskTodo[] {
  return items.map((item, index) => ({
    id: `${index + 1}`,
    content: item.content.trim(),
    status: item.status ?? (index === 0 ? "in_progress" : "pending")
  }));
}

function touchTask(task: TaskRecord): void {
  task.updatedAt = new Date().toISOString();
}

function selectToolsForPolicy(tools: ToolDefinition[], policy: AgentConfig["toolsPolicy"]): ToolDefinition[] {
  if (policy === "read_only") return tools.filter((tool) => tool.risk === "read");
  return tools;
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
  private permissionMode: PermissionMode;
  private abortController: AbortController | null;
  private readonly denialTracker = new DenialTracker();

  abort(): void {
    this.abortController?.abort();
  }

  private constructor(
    private readonly config: AgentConfig,
    private readonly onEvent: AgentEventHandler,
    private readonly onApproval: ApprovalHandler,
    toolList: ToolDefinition[],
    private readonly skills: SkillInfo[],
    record: SessionRecord
  ) {
    this.abortController = null;
    this.tools = new Map(toolList.map((tool) => [tool.name, tool]));
    this.sessionStore = new SessionStore(config.sessionDir);
    this.approvalContext = {
      cwd: config.cwd,
      allowedTools: new Set<string>(),
      allowedCommandPrefixes: new Set<string>(),
      allowedApprovalKeys: new Set<string>()
    };
    this.applyPermissionMode(config.permissionMode);
    this.record = record;
    this.id = record.id;
    this.permissionMode = config.permissionMode;
    this.messages = [...record.messages];
    this.events = [...record.events];
    this.record.tasks = [...(record.tasks ?? [])];
    this.record.plans = [...(record.plans ?? [])];
    this.summary = record.summary;
  }

  static async create(config: AgentConfig, onEvent: AgentEventHandler, onApproval: ApprovalHandler): Promise<AgentSession> {
    const toolList = selectToolsForPolicy(createTools(config.cwd, config.maxToolOutputChars, config.allowDangerousCommands), config.toolsPolicy);
    const skills = await discoverSkills(config.cwd, config.skills, config.enableSkills);
    const projectMemory = await loadProjectMemory(config.cwd);
    const store = new SessionStore(config.sessionDir);
    await store.ensure();
    const loaded = config.sessionId ? await store.load(config.sessionId) : undefined;
    const messages = loaded?.messages ?? [{ role: "system", content: systemPrompt(toolList, skills, projectMemory) }];
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
    const session = new AgentSession(config, onEvent, onApproval, toolList, skills, record);
    await session.persist();
    return session;
  }

  async run(userRequest: string): Promise<string> {
    this.abortController = new AbortController();
    const task = createTask(userRequest);
    this.record.tasks = [...(this.record.tasks ?? []), task];
    this.messages.push({ role: "user", content: userRequest });
    this.record = {
      ...this.record,
      title: this.record.title || titleFromRequest(userRequest),
      lastUserMessage: userRequest
    };
    await this.persist();
    const mustUseTool = requiresWorkspaceTool(userRequest);
    const mustPlan = requiresPlan(userRequest);
    const fallbackReadPath = fallbackReadFilePath(userRequest);
    let hasPlan = false;
    let planCorrections = 0;
    let toolCallsThisRequest = 0;
    let toolRequiredCorrections = 0;

    for (let turn = 1; turn <= this.config.maxTurns; turn += 1) {
      if (this.abortController.signal.aborted) {
        const msg = "Aborted by user.";
        task.status = "failed";
        task.error = msg;
        completeActiveTodo(task);
        touchTask(task);
        await this.emit({ type: "final", answer: msg });
        await this.persist();
        return msg;
      }
      await this.compactIfNeeded();
      const { raw, decision } = await this.nextDecision();
      if (mustPlan && !hasPlan && decision.action !== "plan") {
        if (planCorrections < 2) {
          planCorrections += 1;
          await this.recordTaskError(task, "A plan is required before continuing this coding task.", false);
          await this.emit({ type: "error", category: "protocol", error: "A plan is required before continuing this coding task. Asking the model to produce todos." });
          this.messages.push(planRequiredCorrection(userRequest));
          await this.persist();
          continue;
        }
        const message = "Model returned tool/final decisions before producing a required plan.";
        await this.recordTaskError(task, message, true);
        await this.emit({ type: "error", category: "protocol", error: message });
        await this.persist();
        return message;
      }
      if (decision.action === "plan") {
        const todos = createTodos(decision.todos ?? []);
        task.todos = todos;
        task.status = "planning";
        hasPlan = true;
        touchTask(task);
        await this.emit({ type: "plan", turn, todos });
        await this.persist();
        continue;
      }
      if (decision.action === "final") {
        const answer = decision.answer ?? "";
        if (mustUseTool && toolCallsThisRequest === 0) {
          if (fallbackReadPath && toolRequiredCorrections >= 1) {
            toolCallsThisRequest += 1;
            await this.runToolDecision(task, turn, { action: "tool", tool: "read_file", input: { path: fallbackReadPath }, thought: "Fallback read for explicit file request." });
            continue;
          }
          if (toolRequiredCorrections < 2) {
            toolRequiredCorrections += 1;
            await this.emit({ type: "error", category: "protocol", error: "A workspace tool is required before the final answer. Asking the model to call a tool." });
            this.messages.push(toolRequiredCorrection(userRequest));
            await this.persist();
            continue;
          }
          const message = finalClaimsToolUse(answer)
            ? "Model claimed workspace work without calling a tool."
            : "Model returned a final answer before required workspace tool access.";
          await this.emit({ type: "error", category: "protocol", error: message });
          await this.recordTaskError(task, message, true);
          await this.persist();
          return message;
        }
        task.status = "done";
        task.finalAnswer = answer;
        completeActiveTodo(task);
        touchTask(task);
        await this.emit({ type: "final", answer });
        await this.persist();
        return answer;
      }

      const ran = await this.runToolDecision(task, turn, decision);
      if (ran) toolCallsThisRequest += 1;
    }

    const lastCall = task.toolCalls.at(-1);
    const answer = [
      "I reached the maximum number of turns before finishing.",
      lastCall ? `Last tool: ${lastCall.tool} (${lastCall.status ?? (lastCall.ok ? "ok" : "failed")}).` : "No tool calls completed.",
      task.error ? `Last error: ${task.error}` : undefined,
      `Tool calls attempted: ${task.toolCalls.length}.`
    ].filter(Boolean).join("\n");
    task.status = "failed";
    task.error = answer;
    touchTask(task);
    await this.emit({ type: "final", answer });
    await this.persist();
    return answer;
  }

  async createPlan(userRequest: string): Promise<PlanRecord> {
    const readOnlyTools = Array.from(this.tools.values()).filter((tool) => tool.risk === "read");
    const readOnlyToolMap = new Map(readOnlyTools.map((tool) => [tool.name, tool]));
    const planMessages: Message[] = [
      { role: "system", content: planSystemPrompt(readOnlyTools, this.skills) },
      ...(this.summary ? [{ role: "user" as const, content: `Current session summary:\n${this.summary}` }] : []),
      planModeRequest(userRequest)
    ];
    let lastError: string | undefined;

    for (let turn = 1; turn <= this.config.maxTurns; turn += 1) {
      const response = await complete({
        provider: this.config.provider,
        baseUrl: this.config.baseUrl,
        apiKey: this.config.apiKey,
        model: this.config.planModel,
        messages: planMessages
      });
      planMessages.push({ role: "assistant", content: response.content });
      await this.emit({ type: "model_response", raw: response.raw, content: response.content, provider: response.provider, model: response.model, streamEvents: response.streamEvents });

      let decision: AgentDecision;
      try {
        decision = parseDecision(response.content, readOnlyToolMap);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await this.emit({ type: "error", category: "parse", error: lastError });
        planMessages.push(repairPrompt(error, response.content));
        await this.persist();
        continue;
      }

      if (decision.action === "plan") {
        const todos = createTodos(decision.todos ?? []);
        await this.emit({ type: "plan", turn, todos });
        planMessages.push({ role: "user", content: "Planning todos noted. Continue with read-only inspection if useful, then return a final JSON answer containing the implementation plan." });
        await this.persist();
        continue;
      }

      if (decision.action === "final") {
        const answer = decision.answer ?? "";
        const plan = parsePlanRecord(userRequest, this.config.planModel, answer);
        this.record.plans = [...(this.record.plans ?? []), plan];
        await this.persist();
        return plan;
      }

      const tool = readOnlyToolMap.get(decision.tool ?? "");
      if (!tool) {
        lastError = `Unknown read-only planning tool: ${String(decision.tool)}`;
        await this.emit({ type: "error", category: "protocol", error: lastError });
        planMessages.push(repairPrompt(lastError, response.content));
        await this.persist();
        continue;
      }

      const input = decision.input ?? {};
      const description = tool.describe(input);
      await this.emit({ type: "tool_request", turn, tool: tool.name, input, thought: decision.thought, description });
      const validation = tool.validate(input);
      const result = validation ?? await tool.run(input);
      await this.emit({ type: "tool_result", turn, tool: tool.name, ok: result.ok, output: result.output, errorType: result.errorType, metadata: result.metadata });
      planMessages.push({
        role: "tool",
        content: JSON.stringify({ tool: tool.name, ok: result.ok, output: result.output, errorType: result.errorType, metadata: result.metadata })
      });
      if (!result.ok) lastError = result.output;
      await this.persist();
    }

    throw new Error(`Plan mode reached max turns before producing a final plan.${lastError ? ` Last error: ${lastError}` : ""}`);
  }

  async approvePlan(id: string): Promise<PlanRecord> {
    const plan = this.findPlan(id);
    if (plan.status !== "draft") return plan;
    plan.status = "approved";
    plan.approvedAt = new Date().toISOString();
    await this.persist();
    return plan;
  }

  async cancelPlan(id: string): Promise<PlanRecord> {
    const plan = this.findPlan(id);
    plan.status = "cancelled";
    await this.persist();
    return plan;
  }

  async executePlan(id: string): Promise<string> {
    const plan = await this.approvePlan(id);
    const answer = await this.run(executePlanRequest(plan.answer, plan.request).content);
    plan.status = "executed";
    plan.executedAt = new Date().toISOString();
    await this.persist();
    return answer;
  }

  getPlans(): PlanRecord[] {
    return [...(this.record.plans ?? [])];
  }

  private findPlan(id: string): PlanRecord {
    const plan = this.record.plans?.find((item) => item.id === id || item.id.startsWith(id));
    if (!plan) throw new Error(`Plan not found: ${id}`);
    return plan;
  }

  private async runToolDecision(task: TaskRecord, turn: number, decision: AgentDecision): Promise<boolean> {
      const tool = this.tools.get(decision.tool ?? "");
      if (!tool) throw new Error(`Unknown tool: ${String(decision.tool)}`);

      const input = decision.input ?? {};
      const description = tool.describe(input);
      task.status = "running_tool";
      startNextTodo(task);
      task.toolCalls.push({ turn, tool: tool.name, input });
      touchTask(task);
      await this.emit({ type: "tool_request", turn, tool: tool.name, input, thought: decision.thought, description });

      const validation = tool.validate(input);
      if (validation) {
        await this.recordToolResult(task, turn, tool.name, false, validation.output, validation.errorType ?? "validation", validation.metadata);
        return true;
      }

      // todo_write: intercept to update task todos then emit a plan event
      if (tool.name === "todo_write" && Array.isArray(input.todos)) {
        const rawTodos = input.todos as Array<{ id: string; content: string; status: string }>;
        task.todos = rawTodos.map((t) => ({
          id: t.id,
          content: t.content,
          status: (["pending", "in_progress", "completed"].includes(t.status) ? t.status : "pending") as TaskTodo["status"]
        }));
        touchTask(task);
        await this.emit({ type: "plan", turn, todos: task.todos });
        const result = await tool.run(input);
        await this.recordToolResult(task, turn, tool.name, result.ok, result.output, result.errorType, result.metadata);
        return true;
      }

      const requirement = tool.requiresApproval(input, this.approvalContext);
      if (requirement.required) {
        task.status = "waiting_permission";
        touchTask(task);
        if (requirement.denied || requirement.blocked) {
          const event: AgentEvent = { type: "permission_request", id: "blocked", tool: tool.name, input, description, requirement };
          task.approvals.push(event);
          await this.emit(event);
          await this.recordToolResult(task, turn, tool.name, false, requirement.reason, "permission_blocked", approvalMetadata(requirement));
          return true;
        }
        const approvalId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const denialKey = requirement.approvalKey ?? requirement.allowAlwaysKey ?? `${tool.name}:${description}`;
        const decisionResult = await this.onApproval({
          id: approvalId,
          tool: tool.name,
          input,
          description,
          requirement,
          resolve: () => undefined
        });
        const event: AgentEvent = { type: "permission_request", id: approvalId, tool: tool.name, input, description, requirement };
        task.approvals.push(event);
        await this.emit(event);
        if (decisionResult === "deny") {
          this.denialTracker.record(denialKey);
          await this.emit({ type: "error", category: "permission", error: `User denied permission: ${requirement.reason}` });
          await this.recordToolResult(task, turn, tool.name, false, `User denied permission: ${requirement.reason}`, "permission_denied", approvalMetadata(requirement));
          if (this.denialTracker.shouldInjectCorrection(denialKey)) {
            this.messages.push({ role: "user", content: this.denialTracker.correctionMessage(denialKey) });
            await this.persist();
          }
          return true;
        }
        this.denialTracker.reset(denialKey);
        this.rememberApproval(tool.name, input, requirement.allowAlwaysKey, decisionResult);
      }

      const result = await tool.run(input);
      await this.recordToolResult(task, turn, tool.name, result.ok, result.output, result.errorType, result.metadata);
      return true;
  }

  async forceCompact(): Promise<void> {
    const compacted = await maybeCompactMessages(this.config, this.messages, this.summary);
    this.messages = compacted.messages;
    this.summary = compacted.summary;
    await this.emit({ type: "compaction", summary: this.summary });
    await this.persist();
  }

  /**
   * Generate a CLAUDE.md project memory file by inspecting the repository
   * structure and key files, then writing the result to {cwd}/CLAUDE.md.
   * Mirrors Claude Code's /init command.
   */
  async initProjectMemory(): Promise<string> {
    const { writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const readOnlyTools = Array.from(this.tools.values()).filter((tool) => tool.risk === "read");
    const readOnlyToolMap = new Map(readOnlyTools.map((tool) => [tool.name, tool]));

    const initPrompt = `You are generating a CLAUDE.md project memory file for this repository.

Your task:
1. Use read_tree to get the project layout
2. Use read_many_files to read key config files (package.json, tsconfig.json, README.md if they exist)
3. Use search to find entry points and important patterns if needed
4. Return a final JSON answer with a markdown document that can serve as CLAUDE.md

The CLAUDE.md should cover:
- Project purpose and tech stack
- Key directories and what they contain
- Build/test/run commands
- Important conventions and patterns
- Files that should not be modified

Return only valid JSON: {"action":"final","answer":"<full CLAUDE.md content>"}`;

    const initMessages: Message[] = [
      { role: "system", content: `You are a read-only code analyser. Only use read tools. Return exactly one JSON object per turn.\n\nAvailable tools:\n${Array.from(readOnlyTools).map((t) => `- ${t.name}: ${t.description}`).join("\n")}` },
      { role: "user", content: initPrompt }
    ];

    for (let turn = 1; turn <= 10; turn += 1) {
      const response = await complete({
        provider: this.config.provider,
        baseUrl: this.config.baseUrl,
        apiKey: this.config.apiKey,
        model: this.config.model,
        messages: initMessages,
        signal: this.abortController?.signal ?? undefined,
        onDelta: (text) => { void this.onEvent({ type: "model_stream_delta", text }); }
      });
      initMessages.push({ role: "assistant", content: response.content });
      await this.onEvent({ type: "model_response", raw: response.raw, content: response.content, streamEvents: response.streamEvents });

      let decision: AgentDecision;
      try {
        decision = parseDecision(response.content, readOnlyToolMap);
      } catch {
        break;
      }

      if (decision.action === "final") {
        const claudeMdContent = decision.answer ?? "";
        const outPath = path.default.join(this.config.cwd, "CLAUDE.md");
        await writeFile(outPath, claudeMdContent, "utf8");
        return outPath;
      }

      if (decision.action === "tool") {
        const tool = readOnlyToolMap.get(decision.tool ?? "");
        if (!tool) break;
        const input = decision.input ?? {};
        await this.onEvent({ type: "tool_request", turn, tool: tool.name, input, thought: decision.thought, description: tool.describe(input) });
        const result = await tool.run(input);
        await this.onEvent({ type: "tool_result", turn, tool: tool.name, ok: result.ok, output: result.output });
        initMessages.push({ role: "tool", content: JSON.stringify({ tool: tool.name, ok: result.ok, output: result.output }) });
      }
    }

    throw new Error("Could not generate CLAUDE.md — model did not produce a final answer.");
  }

  getSummary(): string {
    return this.summary;
  }

  getMessageCount(): number {
    return this.messages.length;
  }

  getRecord(): SessionRecord {
    return { ...this.record, messages: [...this.messages], events: [...this.events], tasks: [...(this.record.tasks ?? [])], plans: [...(this.record.plans ?? [])], summary: this.summary };
  }

  describeTools(): string {
    return Array.from(this.tools.values())
      .map((tool) => `${tool.name} [${tool.risk}] ${tool.description}`)
      .join("\n");
  }

  describePermissions(): string {
    const remembered = Array.from(this.approvalContext.allowedApprovalKeys).sort();
    return [
      "read: allowed",
      "ordinary write: allowed; sensitive/delete/unusual writes require approval",
      "shell: ask; dangerous commands blocked unless --allow-dangerous",
      remembered.length ? `remembered approvals:\n${remembered.join("\n")}` : "remembered approvals: none"
    ].join("\n");
  }

  describeSkills(): string {
    return renderSkillList(this.skills);
  }

  async useSkill(name: string, args: string): Promise<string> {
    const normalized = name.toLowerCase();
    const skill = this.skills.find((item) => item.name === normalized || item.name.startsWith(normalized));
    if (!skill) throw new Error(`Skill not found: ${name}`);
    const content = skillInjection(skill, args);
    this.messages.push({ role: "user", content });
    await this.persist();
    return `Loaded skill ${skill.name}.`;
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
    this.applyPermissionMode(mode);
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  private applyPermissionMode(mode: PermissionMode): void {
    this.approvalContext.allowedApprovalKeys.delete("mode:accept_edits");
    this.approvalContext.allowedApprovalKeys.delete("mode:bypass_permissions");
    if (mode === "accept_edits") this.approvalContext.allowedApprovalKeys.add("mode:accept_edits");
    if (mode === "bypass_permissions") this.approvalContext.allowedApprovalKeys.add("mode:bypass_permissions");
  }

  private async nextDecision(): Promise<{ raw: string; decision: AgentDecision }> {
    let raw = await this.callModel();
    try {
      return { raw, decision: parseDecision(raw, this.tools) };
    } catch (error) {
      await this.emit({ type: "error", category: "parse", error: error instanceof Error ? error.message : String(error) });
      this.messages.push(repairPrompt(error, raw));
      await this.persist();
      raw = await this.callModel();
      try {
        return { raw, decision: parseDecision(raw, this.tools) };
      } catch (secondError) {
        const message = secondError instanceof Error ? secondError.message : String(secondError);
        await this.emit({ type: "error", category: "parse", error: message });
        throw secondError;
      }
    }
  }

  private async callModel(): Promise<string> {
    let response;
    try {
      response = await complete({
        provider: this.config.provider,
        baseUrl: this.config.baseUrl,
        apiKey: this.config.apiKey,
        model: this.config.model,
        messages: this.messages,
        signal: this.abortController?.signal ?? undefined,
        onDelta: (text) => { void this.onEvent({ type: "model_stream_delta", text }); }
      });
    } catch (error) {
      if (this.abortController?.signal.aborted) return "";
      throw error;
    }
    this.messages.push({ role: "assistant", content: response.content });
    await this.emit({ type: "model_response", raw: response.raw, content: response.content, provider: response.provider, model: response.model, streamEvents: response.streamEvents });
    return response.content;
  }

  private rememberApproval(tool: string, input: Record<string, unknown>, key: string | undefined, decision: ApprovalDecision): void {
    if (decision !== "always_allow") return;
    const approvalKey = key ?? (tool === "run_command" && typeof input.command === "string" ? commandPrefix(input.command) : undefined);
    if (approvalKey) this.approvalContext.allowedApprovalKeys.add(approvalKey);
  }

  private async recordToolResult(task: TaskRecord, turn: number, tool: string, ok: boolean, output: string, errorType?: ToolErrorType, metadata?: ToolMetadata): Promise<void> {
    const toolCall = [...task.toolCalls].reverse().find((item) => item.turn === turn && item.tool === tool && item.ok === undefined);
    if (toolCall) {
      toolCall.ok = ok;
      toolCall.output = output;
      toolCall.errorType = errorType;
      toolCall.metadata = metadata;
      toolCall.status = toolStatus(ok, errorType, output);
    }
    task.status = "running_tool";
    if (ok) completeActiveTodo(task);
    if (!ok) task.error = output;
    touchTask(task);
    await this.emit({ type: "tool_result", turn, tool, ok, output, errorType, metadata });
    this.messages.push({
      role: "tool",
      content: JSON.stringify({ tool, ok, output, errorType, metadata })
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
      title: this.record.title,
      lastUserMessage: this.record.lastUserMessage,
      messages: this.messages,
      events: this.events,
      tasks: this.record.tasks ?? [],
      plans: this.record.plans ?? [],
      summary: this.summary
    };
    await this.sessionStore.save(this.record);
  }

  private async recordTaskError(task: TaskRecord, error: string, failed: boolean): Promise<void> {
    task.error = error;
    if (failed) task.status = "failed";
    touchTask(task);
    await this.persist();
  }
}

function parsePlanRecord(request: string, model: string, answer: string): PlanRecord {
  const now = new Date().toISOString();
  return {
    id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    request,
    status: "draft",
    model,
    answer,
    steps: sectionLines(answer, /ordered steps|steps|实施步骤|步骤/i),
    files: sectionLines(answer, /relevant files|files|关键文件|相关文件/i),
    validations: sectionLines(answer, /validation|验证|test|checks/i),
    risks: sectionLines(answer, /risks|风险/i),
    openQuestions: sectionLines(answer, /open questions|待确认|问题/i),
    createdAt: now
  };
}

function sectionLines(answer: string, heading: RegExp): string[] {
  const lines = answer.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return [];
  const result: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s+|^[A-Z][A-Za-z ]+:\s*$/.test(line.trim()) && result.length > 0) break;
    const cleaned = line.replace(/^\s*[-*\d.)]+\s*/, "").trim();
    if (cleaned) result.push(cleaned);
    if (result.length >= 12) break;
  }
  return result;
}

function startNextTodo(task: TaskRecord): void {
  if (task.todos.some((todo) => todo.status === "in_progress")) return;
  const next = task.todos.find((todo) => todo.status === "pending");
  if (next) next.status = "in_progress";
}

function completeActiveTodo(task: TaskRecord): void {
  const active = task.todos.find((todo) => todo.status === "in_progress");
  if (active) active.status = "completed";
  const next = task.todos.find((todo) => todo.status === "pending");
  if (next && task.status !== "done") next.status = "in_progress";
}

function toolStatus(ok: boolean, errorType: ToolErrorType | undefined, output: string): NonNullable<import("./types.js").TaskToolCall["status"]> {
  if (ok) return "ok";
  if (errorType === "validation") return "validation_error";
  if (errorType === "permission_denied") return "denied";
  if (errorType === "permission_blocked") return "blocked";
  if (/User denied permission/i.test(output)) return "denied";
  if (/blocked unless --allow-dangerous/i.test(output)) return "blocked";
  return "failed";
}

function approvalMetadata(requirement: import("./types.js").ApprovalRequirement): ToolMetadata {
  return {
    approvalKey: requirement.approvalKey,
    scope: requirement.scope,
    riskReason: requirement.riskReason,
    blocked: requirement.blocked,
    rememberable: requirement.rememberable
  };
}
