import { maybeCompactMessages, shouldCompactMessages } from "./compaction.js";
import { renderCapabilityList, renderTable } from "./capabilities.js";
import { discoverCustomCommands, renderCustomCommandList, renderCustomCommandPrompt, resolveCustomCommand } from "./customCommands.js";
import { parseDecision } from "./decision.js";
import { DenialTracker } from "./denial.js";
import { hookRows, loadHookConfig, runHookEvent, type HookConfig } from "./hooks.js";
import { addSettingsPermissionRule, applySettingsPermissions, loadProjectSettings, removeSettingsPermissionRule, type ProjectSettings } from "./settings.js";
import { appendProjectMemory, loadProjectMemory, loadProjectMemorySources, parseMemoryScope, renderMemorySources } from "./memory.js";
import { createProjectOutputStyle, discoverOutputStyles, outputStylePrompt, renderOutputStyleList, resolveOutputStyle, type OutputStyleInfo } from "./outputStyles.js";
import { fallbackReadFilePath, finalClaimsToolUse, requiresPlan, requiresWorkspaceTool } from "./policy.js";
import { configurableKeys, formatConfigValue, getProjectConfigValue, renderProjectConfig, setProjectConfigValue, unsetProjectConfigValue } from "./projectConfig.js";
import { renderReleaseNotes } from "./releaseNotes.js";
import { executePlanRequest, planModeRequest, planRequiredCorrection, planSystemPrompt, repairPrompt, systemPrompt, toolRequiredCorrection } from "./prompt.js";
import { createProjectSkill, defaultSkills, discoverSkills, renderSkillInspect, renderSkillList, resolveSkill, skillInjection } from "./skills.js";
import { createProjectSubagent, discoverSubagents, renderSubagentInspect, renderSubagentList, resolveSubagent, subagentInjection, subagentToolNames } from "./subagents.js";
import { complete } from "../providers/llm.js";
import { commandPrefix, commandPrefixApprovalKey } from "../tools/permissions.js";
import { SessionStore } from "../storage/sessionStore.js";
import { createToolRegistry, createToolRegistryWithMcp } from "../tools/registry.js";
import type { McpManager } from "../mcp/manager.js";
import { existsSync } from "node:fs";
import path from "node:path";
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
  ToolResult,
  ToolDefinition,
  SkillInfo,
  CustomCommandInfo,
  SubagentInfo,
  CapabilityDescriptor
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

export class AgentSession {
  readonly id: string;
  private readonly tools: Map<string, ToolDefinition>;
  private readonly capabilities: CapabilityDescriptor[];
  private readonly toolDescriptions: string;
  private readonly mcpManager?: McpManager;
  private readonly sessionStore: SessionStore;
  private readonly approvalContext: ApprovalContext;
  private record!: SessionRecord;
  private messages: Message[];
  private events: AgentEvent[] = [];
  private summary = "";
  private permissionMode: PermissionMode;
  private abortController: AbortController | null;
  private activeSkills: string[] = [];
  private customCommands: CustomCommandInfo[] = [];
  private subagents: SubagentInfo[] = [];
  private activeSubagentName: string | undefined;
  private activeSubagentToolNames: Set<string> | undefined;
  private activeSubagentSystemPrompt: Message | undefined;
  private outputStyle: OutputStyleInfo;
  private readonly capabilityChangeSummary: string;
  private readonly denialTracker = new DenialTracker();

  abort(): void {
    this.abortController?.abort();
  }

  private constructor(
    private readonly config: AgentConfig,
    private readonly onEvent: AgentEventHandler,
    private readonly onApproval: ApprovalHandler,
    toolList: ToolDefinition[],
    private skills: SkillInfo[],
    private hooks: HookConfig,
    private settings: ProjectSettings,
    outputStyle: OutputStyleInfo,
    capabilities: CapabilityDescriptor[],
    toolDescriptions: string,
    mcpManager: McpManager | undefined,
    record: SessionRecord
  ) {
    this.abortController = null;
    this.tools = new Map(toolList.map((tool) => [tool.name, tool]));
    this.outputStyle = outputStyle;
    this.capabilities = capabilities;
    this.toolDescriptions = toolDescriptions;
    this.mcpManager = mcpManager;
    this.capabilityChangeSummary = capabilityDiff(record.capabilities ?? [], capabilities);
    this.sessionStore = new SessionStore(config.sessionDir);
    this.approvalContext = {
      cwd: config.cwd,
      mode: config.permissionMode,
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
    const { registry, mcpManager } = config.enableMcp === false
      ? { registry: createToolRegistry(config.cwd, config.maxToolOutputChars, config.allowDangerousCommands), mcpManager: undefined }
      : await createToolRegistryWithMcp(config.cwd, config.maxToolOutputChars, config.allowDangerousCommands, config.mcpConfigPath);
    const toolList = registry.list(config.toolsPolicy);
    const capabilities = registry.capabilities(config.toolsPolicy);
    const toolDescriptions = registry.describeTools(config.toolsPolicy);
    const skills = await discoverSkills(config.cwd, config.skills, config.enableSkills, { includeGlobal: config.includeGlobalSkills });
    const customCommands = await discoverCustomCommands(config.cwd, config.includeGlobalSkills !== false);
    const subagents = await discoverSubagents(config.cwd, config.includeGlobalSkills !== false);
    const hooks = await loadHookConfig(config.cwd, config.includeGlobalSkills !== false);
    const settings = await loadProjectSettings(config.cwd, config.includeGlobalSkills !== false);
    const projectMemory = await loadProjectMemory(config.cwd);
    const outputStyle = await resolveOutputStyle(config.cwd, config.outputStyle, config.includeGlobalSkills !== false);
    const store = new SessionStore(config.sessionDir);
    await store.ensure();
    const loaded = config.sessionId ? await store.load(config.sessionId) : undefined;
    const messages = loaded?.messages ?? [{ role: "system", content: systemPrompt(toolList, skills, projectMemory, outputStylePrompt(outputStyle)) }];
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
    const session = new AgentSession(config, onEvent, onApproval, toolList, skills, hooks, settings, outputStyle, capabilities, toolDescriptions, mcpManager, record);
    session.customCommands = customCommands;
    session.subagents = subagents;
    await session.runSessionStartHooks(loaded ? "resume" : "startup");
    await session.persist();
    return session;
  }

  async run(userRequest: string): Promise<string> {
    this.abortController = new AbortController();
    const task = createTask(userRequest);
    this.record.tasks = [...(this.record.tasks ?? []), task];
    const promptHook = await this.runUserPromptSubmitHooks(userRequest);
    if (!promptHook.ok) {
      task.status = "failed";
      task.error = promptHook.output;
      touchTask(task);
      await this.emit({ type: "error", category: promptHook.errorType === "permission_blocked" ? "permission" : "runtime", error: promptHook.output });
      await this.persist();
      return promptHook.output;
    }
    const effectiveRequest = promptHook.output.trim()
      ? `${userRequest}\n\n<context from UserPromptSubmit hook>\n${promptHook.output.trimEnd()}\n</context from UserPromptSubmit hook>`
      : userRequest;
    this.messages.push({ role: "user", content: effectiveRequest });
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
      const { raw, decision } = await this.nextDecision({ allowMarkdownFinal: !mustUseTool && !mustPlan });
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
        await this.runStopHooks(answer);
        await this.runSubagentStopHooks(answer);
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
    const inspectionEvents: string[] = [];
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
        const plan = parsePlanRecord(userRequest, this.config.planModel, answer, inspectionEvents);
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
      inspectionEvents.push(`tool ${tool.name}: ${description}`);
      await this.emit({ type: "tool_request", turn, tool: tool.name, input, thought: decision.thought, description });
      const validation = tool.validate(input);
      const result = validation ?? await tool.run(input);
      inspectionEvents.push(`result ${tool.name}: ${result.ok ? "ok" : "failed"}`);
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
    if (plan.status === "executed") throw new Error(`Plan already executed: ${plan.id}`);
    plan.status = "cancelled";
    plan.statusReason = "Cancelled by user.";
    await this.persist();
    return plan;
  }

  async executePlan(id: string): Promise<string> {
    const plan = this.findPlan(id);
    if (plan.status === "cancelled") throw new Error(`Plan is cancelled and cannot be executed: ${plan.id}`);
    if (plan.status === "executed") throw new Error(`Plan has already been executed: ${plan.id}`);
    await this.approvePlan(id);
    const answer = await this.run(executePlanRequest(plan.answer, plan.request).content);
    plan.status = "executed";
    plan.statusReason = "Executed from approved plan.";
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
        const result = await this.runToolWithPostHooks(tool, input);
        await this.recordToolResult(task, turn, tool.name, result.ok, result.output, result.errorType, result.metadata);
        return true;
      }

      const pre = await this.runPreToolUseHooks(tool, input);
      if (!pre.ok) {
        await this.recordToolResult(task, turn, tool.name, false, pre.output, pre.errorType, pre.metadata);
        return true;
      }

      const requirement = applySettingsPermissions(tool.requiresApproval(input, this.approvalContext), this.settings.permissions, tool.name, input);
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
        if (pre.metadata?.hookDecision === "approve") {
          this.denialTracker.reset(requirement.approvalKey ?? requirement.allowAlwaysKey ?? `${tool.name}:${description}`);
        } else {
        await this.runNotificationHooks("permission_required", "Permission required", requirement.reason);
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
      }

      const result = await this.runToolWithPostHooks(tool, input);
      await this.recordToolResult(task, turn, tool.name, result.ok, result.output, result.errorType, result.metadata);
      if (result.ok && tool.name === "create_skill") await this.refreshSkillContext();
      if (result.ok && tool.name === "create_subagent") await this.refreshSubagents();
      return true;
  }

  private async runUserPromptSubmitHooks(prompt: string): Promise<ToolResult> {
    return runHookEvent(this.hooks, {
      cwd: this.config.cwd,
      event: "UserPromptSubmit",
      prompt,
      maxOutputChars: this.config.maxToolOutputChars,
      allowDangerousCommands: this.config.allowDangerousCommands
    });
  }

  private async runSessionStartHooks(source: "startup" | "resume"): Promise<void> {
    const result = await runHookEvent(this.hooks, {
      cwd: this.config.cwd,
      event: "SessionStart",
      sessionId: this.id,
      source,
      matcherTarget: source,
      maxOutputChars: this.config.maxToolOutputChars,
      allowDangerousCommands: this.config.allowDangerousCommands
    });
    if (!result.ok) {
      await this.emit({ type: "error", category: result.errorType === "permission_blocked" ? "permission" : "runtime", error: result.output });
      return;
    }
    if (!result.output.trim()) return;
    this.messages.push({
      role: "user",
      content: `<context from SessionStart hook source="${source}">\n${result.output.trimEnd()}\n</context from SessionStart hook>`
    });
  }

  private async runStopHooks(finalAnswer: string): Promise<void> {
    const result = await runHookEvent(this.hooks, {
      cwd: this.config.cwd,
      event: "Stop",
      sessionId: this.id,
      finalAnswer,
      maxOutputChars: this.config.maxToolOutputChars,
      allowDangerousCommands: this.config.allowDangerousCommands
    });
    if (!result.ok) {
      await this.emit({ type: "error", category: result.errorType === "permission_blocked" ? "permission" : "runtime", error: result.output });
    }
  }

  private async runSubagentStopHooks(finalAnswer: string): Promise<void> {
    if (!this.activeSubagentName) return;
    const result = await runHookEvent(this.hooks, {
      cwd: this.config.cwd,
      event: "SubagentStop",
      sessionId: this.id,
      matcherTarget: this.activeSubagentName,
      subagentName: this.activeSubagentName,
      finalAnswer,
      maxOutputChars: this.config.maxToolOutputChars,
      allowDangerousCommands: this.config.allowDangerousCommands
    });
    if (!result.ok) {
      await this.emit({ type: "error", category: result.errorType === "permission_blocked" ? "permission" : "runtime", error: result.output });
    }
  }

  private async runPreCompactHooks(trigger: "manual" | "auto"): Promise<ToolResult> {
    return runHookEvent(this.hooks, {
      cwd: this.config.cwd,
      event: "PreCompact",
      sessionId: this.id,
      trigger,
      matcherTarget: trigger,
      maxOutputChars: this.config.maxToolOutputChars,
      allowDangerousCommands: this.config.allowDangerousCommands
    });
  }

  private async runNotificationHooks(type: string, title: string, message: string): Promise<void> {
    const result = await runHookEvent(this.hooks, {
      cwd: this.config.cwd,
      event: "Notification",
      sessionId: this.id,
      matcherTarget: type,
      notification: { type, title, message },
      maxOutputChars: this.config.maxToolOutputChars,
      allowDangerousCommands: this.config.allowDangerousCommands
    });
    if (!result.ok) {
      await this.emit({ type: "error", category: result.errorType === "permission_blocked" ? "permission" : "runtime", error: result.output });
    }
  }

  private async runPreToolUseHooks(tool: ToolDefinition, input: Record<string, unknown>): Promise<ToolResult> {
    return runHookEvent(this.hooks, {
      cwd: this.config.cwd,
      event: "PreToolUse",
      tool: tool.name,
      input,
      maxOutputChars: this.config.maxToolOutputChars,
      allowDangerousCommands: this.config.allowDangerousCommands
    });
  }

  private async runToolWithPostHooks(tool: ToolDefinition, input: Record<string, unknown>): Promise<ToolResult> {
    const result = await tool.run(input);
    if (!result.ok) return result;

    const post = await runHookEvent(this.hooks, {
      cwd: this.config.cwd,
      event: "PostToolUse",
      tool: tool.name,
      input,
      result,
      maxOutputChars: this.config.maxToolOutputChars,
      allowDangerousCommands: this.config.allowDangerousCommands
    });
    if (post.ok || post.output.trim() === "") {
      return post.metadata ? { ...result, metadata: { ...result.metadata, ...post.metadata } } : result;
    }
    return {
      ...result,
      output: `${result.output}\n\n[hook warning]\n${post.output}`,
      metadata: { ...result.metadata, hookWarning: true, ...post.metadata }
    };
  }

  async forceCompact(): Promise<void> {
    const pre = await this.runPreCompactHooks("manual");
    if (!pre.ok) {
      await this.emit({ type: "error", category: pre.errorType === "permission_blocked" ? "permission" : "runtime", error: pre.output });
      return;
    }
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

    throw new Error("Could not generate CLAUDE.md - model did not produce a final answer.");
  }

  getSummary(): string {
    return this.summary;
  }

  getMessageCount(): number {
    return this.messages.length;
  }

  getRecord(): SessionRecord {
    return { ...this.record, messages: [...this.messages], events: [...this.events], tasks: [...(this.record.tasks ?? [])], plans: [...(this.record.plans ?? [])], capabilities: [...this.capabilities], summary: this.summary };
  }

  describeSession(): string {
    return [
      `session: ${this.id}`,
      `title: ${this.record.title ?? "Untitled session"}`,
      `createdAt: ${this.record.createdAt}`,
      `updatedAt: ${this.record.updatedAt}`,
      `cwd: ${this.record.cwd}`,
      `messages: ${this.messages.length}`
    ].join("\n");
  }

  describeTodos(): string {
    const task = this.record.tasks?.at(-1);
    if (!task) return "todos: none";
    if (task.todos.length === 0) return [`todos: none`, `latest task: ${task.status} - ${task.userRequest}`].join("\n");
    const rows = task.todos.map((todo) => ({
      status: todo.status,
      id: todo.id,
      content: todo.content
    }));
    return [
      `todos: ${task.status} - ${task.userRequest}`,
      renderTable(rows, [
        { key: "status", width: 14, value: (item) => item.status },
        { key: "id", width: 6, value: (item) => item.id },
        { key: "content", width: 90, value: (item) => item.content }
      ])
    ].join("\n");
  }

  describeTasks(): string {
    const tasks = this.record.tasks ?? [];
    if (tasks.length === 0) return "tasks: none";
    const rows = tasks.slice(-12).map((task) => ({
      id: task.id,
      status: task.status,
      todos: `${task.todos.filter((todo) => todo.status === "completed").length}/${task.todos.length}`,
      tools: String(task.toolCalls.length),
      request: task.userRequest
    }));
    return [
      `tasks: showing ${rows.length} of ${tasks.length}`,
      renderTable(rows, [
        { key: "status", width: 14, value: (item) => item.status },
        { key: "todos", width: 8, value: (item) => item.todos },
        { key: "tools", width: 7, value: (item) => item.tools },
        { key: "request", width: 90, value: (item) => item.request }
      ])
    ].join("\n");
  }

  async renameSession(title: string): Promise<string> {
    const trimmed = title.replace(/\s+/g, " ").trim();
    if (!trimmed) throw new Error("Session title cannot be empty.");
    this.record = { ...this.record, title: trimmed };
    await this.persist();
    return `renamed session: ${trimmed}`;
  }

  describeTools(): string {
    return this.toolDescriptions;
  }

  async describeMemory(): Promise<string> {
    const memory = await loadProjectMemory(this.config.cwd);
    return memory || "No CLAUDE.md files found.";
  }

  async describeMemorySources(): Promise<string> {
    return renderMemorySources(await loadProjectMemorySources(this.config.cwd));
  }

  async addMemory(scopeValue: string, note: string): Promise<string> {
    const scope = parseMemoryScope(scopeValue.trim());
    const written = await appendProjectMemory(this.config.cwd, scope, note);
    await this.refreshSystemPromptForSkills();
    await this.persist();
    return `Added ${scope} memory: ${written}`;
  }

  async reloadMemory(): Promise<string> {
    await this.refreshSystemPromptForSkills();
    await this.persist();
    const sources = await loadProjectMemorySources(this.config.cwd);
    const loaded = sources.filter((source) => source.exists && source.bytes > 0).length;
    return `Reloaded memory: ${loaded} source${loaded === 1 ? "" : "s"}`;
  }

  async describeOutputStyles(): Promise<string> {
    return renderOutputStyleList(await discoverOutputStyles(this.config.cwd, this.outputStyle.name, this.config.includeGlobalSkills !== false));
  }

  describeOutputStyle(): string {
    return [
      `output style: ${this.outputStyle.name}`,
      `source: ${this.outputStyle.source}`,
      `description: ${this.outputStyle.description}`,
      this.outputStyle.path ? `path: ${this.outputStyle.path}` : undefined,
      "",
      this.outputStyle.content
    ].filter((line): line is string => line !== undefined).join("\n");
  }

  async setOutputStyle(name: string): Promise<string> {
    this.outputStyle = await resolveOutputStyle(this.config.cwd, name, this.config.includeGlobalSkills !== false);
    await setProjectConfigValue(this.config.cwd, "outputStyle", this.outputStyle.name);
    await this.refreshSystemPromptForSkills();
    await this.persist();
    return `Set output style: ${this.outputStyle.name}`;
  }

  async createOutputStyle(name: string, instructions: string): Promise<string> {
    const created = await createProjectOutputStyle(this.config.cwd, name, instructions);
    this.outputStyle = { ...created, active: true };
    await setProjectConfigValue(this.config.cwd, "outputStyle", created.name);
    await this.refreshSystemPromptForSkills();
    await this.persist();
    return [`Created output style ${created.name}`, `path: ${created.path}`, `Set output style: ${created.name}`].join("\n");
  }

  describeCapabilities(): string {
    return renderCapabilityList(this.capabilities);
  }

  describeStatusExtras(): string {
    const mcpServers = this.mcpManager?.names().join(", ") || "none";
    const defaultSkillCount = defaultSkills(this.skills).length;
    const shadowedSkillCount = this.skills.filter((skill) => skill.shadowedBy).length;
    const features = this.config.featureFlags?.length ? this.config.featureFlags.join(", ") : "none";
    return [
      `skillsTotal=${this.skills.length}`,
      `skillsDefault=${defaultSkillCount}`,
      `skillsShadowed=${shadowedSkillCount}`,
      `activeSkills=${this.activeSkills.join(", ") || "none"}`,
      `mcpServers=${mcpServers}`,
      `capabilities=${this.capabilities.length}`,
      `toolProtocol=${this.config.toolProtocol ?? "json"}`,
      `features=${features}`
    ].join("\n");
  }

  describeStatus(): string {
    const task = this.record.tasks?.at(-1);
    const plan = this.record.plans?.at(-1);
    const defaultSkillCount = defaultSkills(this.skills).length;
    const shadowedSkillCount = this.skills.filter((skill) => skill.shadowedBy).length;
    const mcpServers = this.mcpManager?.names() ?? [];
    const rows = [
      { field: "session", value: this.id },
      { field: "cwd", value: this.config.cwd },
      { field: "provider", value: this.config.provider },
      { field: "model", value: this.config.model },
      { field: "planModel", value: this.config.planModel },
      { field: "outputStyle", value: this.outputStyle.name },
      { field: "permissionMode", value: this.permissionMode },
      { field: "messages", value: String(this.messages.length) },
      { field: "summary", value: this.summary ? "yes" : "no" },
      { field: "task", value: task ? task.status : "none" },
      { field: "toolCalls", value: String(task?.toolCalls.length ?? 0) },
      { field: "lastError", value: task?.error ?? "none" },
      { field: "plan", value: plan ? `${plan.id} ${plan.status}${plan.executedAt ? " executed" : ""}` : "none" },
      { field: "skillsTotal", value: String(this.skills.length) },
      { field: "skillsDefault", value: String(defaultSkillCount) },
      { field: "skillsShadowed", value: String(shadowedSkillCount) },
      { field: "activeSkills", value: this.activeSkills.join(", ") || "none" },
      { field: "mcpServers", value: mcpServers.join(", ") || "none" },
      { field: "capabilities", value: String(this.capabilities.length) },
      { field: "toolProtocol", value: this.config.toolProtocol ?? "json" },
      { field: "features", value: this.config.featureFlags?.join(", ") || "none" }
    ];
    return ["status:", renderTable(rows, [
      { key: "field", width: 18, value: (item) => item.field },
      { key: "value", width: 90, value: (item) => item.value }
    ])].join("\n");
  }

  describeModel(): string {
    return [
      "model:",
      renderTable([
        { field: "provider", value: this.config.provider, source: this.config.configSources?.provider ?? "default" },
        { field: "model", value: this.config.model, source: this.config.configSources?.model ?? "default" },
        { field: "planModel", value: this.config.planModel, source: this.config.configSources?.planModel ?? "default" },
        { field: "outputStyle", value: this.outputStyle.name, source: this.config.configSources?.outputStyle ?? "default" },
        { field: "baseUrl", value: this.config.baseUrl, source: "config" },
        { field: "toolProtocol", value: this.config.toolProtocol ?? "json", source: "config" }
      ], [
        { key: "field", width: 16, value: (item) => item.field },
        { key: "value", width: 72, value: (item) => item.value },
        { key: "source", width: 12, value: (item) => item.source }
      ]),
      "",
      "Change the model by restarting with --model <name>, or set MINI_CODE_MODEL / OPENAI_MODEL / ANTHROPIC_MODEL."
    ].join("\n");
  }

  describeConfig(): string {
    const rows = [
      { field: "cwd", value: this.config.cwd, source: "runtime" },
      { field: "agentDir", value: this.config.agentDir, source: this.config.configSources?.agentDir ?? "default" },
      { field: "sessionDir", value: this.config.sessionDir, source: this.config.configSources?.sessionDir ?? "default" },
      { field: "provider", value: this.config.provider, source: this.config.configSources?.provider ?? "default" },
      { field: "model", value: this.config.model, source: this.config.configSources?.model ?? "default" },
      { field: "planModel", value: this.config.planModel, source: this.config.configSources?.planModel ?? "default" },
      { field: "outputStyle", value: this.outputStyle.name, source: this.config.configSources?.outputStyle ?? "default" },
      { field: "permissionMode", value: this.permissionMode, source: this.config.configSources?.permissionMode ?? "default" },
      { field: "toolsPolicy", value: this.config.toolsPolicy, source: this.config.configSources?.toolsPolicy ?? "default" },
      { field: "toolProtocol", value: this.config.toolProtocol ?? "json", source: "config" },
      { field: "enableSkills", value: String(this.config.enableSkills), source: "config" },
      { field: "includeGlobalSkills", value: String(this.config.includeGlobalSkills !== false), source: "config" },
      { field: "enableSkillHelpers", value: String(this.config.enableSkillHelpers !== false), source: "config" },
      { field: "enableMcp", value: String(this.config.enableMcp !== false), source: "config" },
      { field: "mcpConfigPath", value: this.mcpConfigPath(), source: "config" },
      { field: "features", value: this.config.featureFlags?.join(", ") || "none", source: "config" }
    ];
    return ["config:", renderTable(rows, [
      { key: "field", width: 22, value: (item) => item.field },
      { key: "value", width: 88, value: (item) => item.value },
      { key: "source", width: 12, value: (item) => item.source }
    ]), "", "Use /config get <key>, /config set <key> <value>, or /config unset <key>. Most changes apply to new sessions."].join("\n");
  }

  describeProjectConfig(): string {
    return [
      "project config:",
      renderProjectConfig(this.config.cwd),
      "",
      `supported keys: ${configurableKeys().join(", ")}`
    ].join("\n");
  }

  getProjectConfig(key: string): string {
    const value = getProjectConfigValue(this.config.cwd, key);
    return value === undefined ? `${key} is not set in project config.` : `${key}=${formatConfigValue(value)}`;
  }

  async setProjectConfig(key: string, value: string): Promise<string> {
    const result = await setProjectConfigValue(this.config.cwd, key, value);
    return [
      `Set ${result.key}=${formatConfigValue(result.value)}`,
      `path: ${result.path}`,
      "Restart or run /new for startup config changes to take effect."
    ].join("\n");
  }

  async unsetProjectConfig(key: string): Promise<string> {
    const result = await unsetProjectConfigValue(this.config.cwd, key);
    return [
      result.existed ? `Unset ${result.key}` : `${result.key} was not set`,
      `path: ${result.path}`,
      "Restart or run /new for startup config changes to take effect."
    ].join("\n");
  }

  describeFeatures(): string {
    const flags = this.config.featureFlags ?? [];
    return [
      flags.length ? "Enabled feature flags:" : "No feature flags enabled.",
      ...flags.map((flag) => `- ${flag}`),
      "",
      "Enable experimental flags with FEATURE_<NAME>=1, for example FEATURE_BUDDY=1."
    ].filter((line, index) => flags.length > 0 || index !== 1).join("\n");
  }

  describeCost(): string {
    const messages = this.messages;
    const events = this.events;
    const tasks = this.record.tasks ?? [];
    const inputChars = messages.filter((message) => message.role === "system" || message.role === "user" || message.role === "tool").reduce((sum, message) => sum + message.content.length, 0);
    const assistantChars = messages.filter((message) => message.role === "assistant").reduce((sum, message) => sum + message.content.length, 0);
    const streamChars = events.filter((event): event is Extract<AgentEvent, { type: "model_stream_delta" }> => event.type === "model_stream_delta").reduce((sum, event) => sum + event.text.length, 0);
    const modelResponses = events.filter((event) => event.type === "model_response").length;
    const toolCalls = tasks.reduce((sum, task) => sum + task.toolCalls.length, 0);
    const toolOutputChars = tasks.flatMap((task) => task.toolCalls).reduce((sum, call) => sum + (call.output?.length ?? 0), 0);
    const totalInputTokens = estimateTokens(inputChars + toolOutputChars);
    const totalOutputTokens = estimateTokens(assistantChars + streamChars);
    const totalTokens = totalInputTokens + totalOutputTokens;
    const rows = [
      { field: "model", value: this.config.model },
      { field: "provider", value: this.config.provider },
      { field: "modelResponses", value: String(modelResponses) },
      { field: "messages", value: String(messages.length) },
      { field: "toolCalls", value: String(toolCalls) },
      { field: "inputTokens", value: `~${totalInputTokens}` },
      { field: "outputTokens", value: `~${totalOutputTokens}` },
      { field: "totalTokens", value: `~${totalTokens}` },
      { field: "note", value: "Local estimate only; provider billing may differ." }
    ];
    return ["cost:", renderTable(rows, [
      { key: "field", width: 18, value: (item) => item.field },
      { key: "value", width: 90, value: (item) => item.value }
    ])].join("\n");
  }

  describeReleaseNotes(): string {
    return renderReleaseNotes();
  }

  describeBugReport(description = ""): string {
    const task = this.record.tasks?.at(-1);
    const lastError = [...this.events].reverse().find((event): event is Extract<AgentEvent, { type: "error" }> => event.type === "error");
    const toolCalls = this.record.tasks?.flatMap((item) => item.toolCalls) ?? [];
    const failedTools = toolCalls.filter((call) => call.ok === false || call.status === "failed" || call.status === "blocked" || call.status === "denied" || call.status === "validation_error");
    const body = description.trim() || "[describe what happened]";
    return [
      "# Mini Code Bug Report",
      "",
      "## Problem",
      body,
      "",
      "## Session",
      `- session: ${this.id}`,
      `- cwd: ${this.config.cwd}`,
      `- provider: ${this.config.provider}`,
      `- model: ${this.config.model}`,
      `- planModel: ${this.config.planModel}`,
      `- permissionMode: ${this.permissionMode}`,
      `- toolProtocol: ${this.config.toolProtocol ?? "json"}`,
      `- featureFlags: ${this.config.featureFlags?.join(", ") || "none"}`,
      "",
      "## Recent State",
      `- messages: ${this.messages.length}`,
      `- summary: ${this.summary ? "yes" : "no"}`,
      `- latestTask: ${task ? task.status : "none"}`,
      `- latestRequest: ${task?.userRequest ?? this.record.lastUserMessage ?? "none"}`,
      `- toolCalls: ${toolCalls.length}`,
      `- failedToolCalls: ${failedTools.length}`,
      `- lastError: ${lastError?.error ?? task?.error ?? "none"}`,
      "",
      "## Diagnostics",
      "```",
      this.describeDoctor(),
      "```",
      "",
      "## Notes",
      "- Remove secrets, tokens, private paths, and proprietary code before sharing.",
      "- Include the exact command or prompt that triggered the issue if safe to share."
    ].join("\n");
  }

  describeLogin(): string {
    return [
      "Mini Code authentication is env/config based in this release.",
      "",
      "OpenAI:",
      "  OPENAI_API_KEY=sk-...",
      "  MINI_CODE_PROVIDER=openai",
      "  MINI_CODE_MODEL=gpt-4.1-mini",
      "",
      "Anthropic:",
      "  ANTHROPIC_API_KEY=sk-ant-...",
      "  MINI_CODE_PROVIDER=anthropic",
      "  MINI_CODE_MODEL=claude-sonnet-4-20250514",
      "",
      "Project config lives at .mini-code/config.json. Secrets should stay in .env.local or your shell environment."
    ].join("\n");
  }

  describeDoctor(): string {
    const checks: Array<{ label: string; ok: boolean; detail: string }> = [
      { label: "apiKey", ok: Boolean(this.config.apiKey), detail: this.config.apiKey ? "configured" : "missing" },
      { label: "baseUrl", ok: /^https?:\/\//.test(this.config.baseUrl), detail: this.config.baseUrl },
      { label: "provider", ok: this.config.provider === "openai" || this.config.provider === "anthropic", detail: this.config.provider },
      { label: "model", ok: Boolean(this.config.model), detail: this.config.model || "missing" },
      { label: "sessionDir", ok: Boolean(this.config.sessionDir), detail: this.config.sessionDir },
      { label: "mcpConfig", ok: this.config.enableMcp === false || existsSync(this.mcpConfigPath()) || !this.config.mcpConfigPath, detail: this.config.enableMcp === false ? "disabled" : this.mcpConfigPath() },
      { label: "skills", ok: this.config.enableSkills === false || this.skills.length > 0 || this.config.skills.length === 0, detail: this.config.enableSkills === false ? "disabled" : `${this.skills.length} discovered` },
      { label: "toolProtocol", ok: this.config.toolProtocol === undefined || this.config.toolProtocol === "json" || this.config.toolProtocol === "native", detail: this.config.toolProtocol ?? "json" }
    ];
    const warnings = checks.filter((check) => !check.ok).length;
    return [
      `doctor: ${warnings === 0 ? "ok" : `${warnings} warning${warnings === 1 ? "" : "s"}`}`,
      renderTable(checks, [
        { key: "status", width: 8, value: (item) => item.ok ? "ok" : "warn" },
        { key: "check", width: 18, value: (item) => item.label },
        { key: "detail", width: 90, value: (item) => item.detail }
      ])
    ].join("\n");
  }

  getCapabilityChangeSummary(): string {
    return this.capabilityChangeSummary;
  }

  async describeMcp(kind: "servers" | "tools" | "resources" | "prompts" = "servers"): Promise<string> {
    if (!this.mcpManager) return "MCP is not configured.";
    if (kind === "servers") {
      const servers = this.mcpManager.serverStatuses();
      if (servers.length === 0) return "[no MCP servers]";
      return [
        `mcp servers: total=${servers.length}`,
        renderTable(servers, [
          { key: "server", width: 20, value: (item) => item.name },
          { key: "status", width: 12, value: (item) => item.status },
          { key: "risk", width: 9, value: (item) => item.risk },
          { key: "command", width: 28, value: (item) => item.command },
          { key: "args", width: 44, value: (item) => item.args.join(" ") || "[none]" }
        ])
      ].join("\n");
    }
    if (kind === "resources") {
      const resources = await this.mcpManager.listResources();
      if (resources.length === 0) return "[no MCP resources]";
      return [
        `mcp resources: total=${resources.length}`,
        renderTable(resources, [
          { key: "server", width: 20, value: (item) => item.server },
          { key: "uri", width: 48, value: (item) => item.uri },
          { key: "name", width: 24, value: (item) => item.name ?? "" },
          { key: "description", width: 80, value: (item) => item.description ?? "" }
        ])
      ].join("\n");
    }
    if (kind === "prompts") {
      const prompts = await this.mcpManager.listPrompts();
      if (prompts.length === 0) return "[no MCP prompts]";
      return [
        `mcp prompts: total=${prompts.length}`,
        renderTable(prompts, [
          { key: "server", width: 20, value: (item) => item.server },
          { key: "name", width: 28, value: (item) => item.name },
          { key: "description", width: 80, value: (item) => item.description ?? "" }
        ])
      ].join("\n");
    }
    return renderCapabilityList(this.capabilities.filter((item) => item.kind === "mcp_tool"), "mcp tools");
  }

  reconnectMcp(server: string): string {
    if (!this.mcpManager) return "MCP is not configured.";
    this.mcpManager.reconnect(server);
    return `Reconnected MCP server ${server}.`;
  }

  private mcpConfigPath(): string {
    return this.config.mcpConfigPath ? path.resolve(this.config.cwd, this.config.mcpConfigPath) : path.join(this.config.cwd, ".mini-code", "mcp.json");
  }

  describePermissions(): string {
    const remembered = Array.from(this.approvalContext.allowedApprovalKeys).filter((key) => !key.startsWith("mode:")).sort();
    const prefixes = Array.from(this.approvalContext.allowedCommandPrefixes).sort();
    const rows = [
      { scope: "read", decision: "allowed", detail: "Read-only tools do not require approval." },
      {
        scope: "ordinary write",
        decision: this.permissionMode === "accept_edits" || this.permissionMode === "bypass_permissions" ? "allowed" : "ask",
        detail: "Sensitive, delete, and unusual writes still require approval."
      },
      { scope: "shell", decision: this.permissionMode === "bypass_permissions" ? "allowed" : "ask", detail: "Dangerous commands are blocked unless --allow-dangerous is set." },
      { scope: "mode", decision: this.permissionMode, detail: this.permissionMode === "bypass_permissions" ? "Non-dangerous shell may run without prompting." : "Permission mode controls default approval behavior." },
      { scope: "remembered approvals", decision: String(remembered.length), detail: remembered.join(", ") || "none" },
      { scope: "remembered prefixes", decision: String(prefixes.length), detail: prefixes.join(", ") || "none" },
      { scope: "settings rules", decision: String(this.settings.permissions.length), detail: this.settings.permissions.map((rule) => `${rule.action}:${rule.matcher}`).join(", ") || "none" }
    ];
    return ["permissions:", renderTable(rows, [
      { key: "scope", width: 22, value: (item) => item.scope },
      { key: "decision", width: 18, value: (item) => item.decision },
      { key: "detail", width: 90, value: (item) => item.detail }
    ])].join("\n");
  }

  async addPermissionRule(action: "allow" | "deny", matcher: string): Promise<string> {
    const result = await addSettingsPermissionRule(this.config.cwd, action, matcher);
    this.settings = await loadProjectSettings(this.config.cwd, this.config.includeGlobalSkills !== false);
    await this.persist();
    return [
      `${result.added ? "Added" : "Already present"} permission rule: ${result.action}:${result.matcher}`,
      `path: ${result.path}`,
      `settings rules: ${this.settings.permissions.length}`
    ].join("\n");
  }

  async removePermissionRule(action: "allow" | "deny", matcher: string): Promise<string> {
    const result = await removeSettingsPermissionRule(this.config.cwd, action, matcher);
    this.settings = await loadProjectSettings(this.config.cwd, this.config.includeGlobalSkills !== false);
    await this.persist();
    return [
      `${result.removed ? "Removed" : "Rule not found"} permission rule: ${result.action}:${result.matcher}`,
      `path: ${result.path}`,
      `settings rules: ${this.settings.permissions.length}`
    ].join("\n");
  }

  async reloadPermissions(): Promise<string> {
    const before = this.settings.permissions.length;
    this.settings = await loadProjectSettings(this.config.cwd, this.config.includeGlobalSkills !== false);
    await this.persist();
    return `Reloaded permissions: before=${before} after=${this.settings.permissions.length}`;
  }

  describeHooks(): string {
    const rows = hookRows(this.hooks);
    if (rows.length === 0) return "hooks: none";
    return ["hooks:", renderTable(rows, [
      { key: "event", width: 14, value: (item) => item.event },
      { key: "matcher", width: 18, value: (item) => item.matcher },
      { key: "command", width: 44, value: (item) => item.command },
      { key: "timeout", width: 10, value: (item) => `${item.timeoutMs}ms` },
      { key: "source", width: 54, value: (item) => item.source }
    ])].join("\n");
  }

  async reloadHooks(): Promise<string> {
    const before = hookRows(this.hooks);
    this.hooks = await loadHookConfig(this.config.cwd, this.config.includeGlobalSkills !== false);
    this.settings = await loadProjectSettings(this.config.cwd, this.config.includeGlobalSkills !== false);
    const after = hookRows(this.hooks);
    await this.persist();
    return [
      `Reloaded hooks: before=${before.length} after=${after.length}`,
      `PreToolUse=${this.hooks.PreToolUse.reduce((sum, rule) => sum + rule.hooks.length, 0)}`,
      `PostToolUse=${this.hooks.PostToolUse.reduce((sum, rule) => sum + rule.hooks.length, 0)}`
    ].join("\n");
  }

  describeSkills(): string {
    return renderSkillList(this.skills);
  }

  getSkills(): SkillInfo[] {
    return [...this.skills];
  }

  inspectSkill(nameOrId: string): string {
    const { skill, candidates } = resolveSkill(this.skills, nameOrId);
    if (!skill) throw new Error(`Skill not found: ${nameOrId}`);
    return renderSkillInspect(skill, candidates);
  }

  async reloadSkills(): Promise<string> {
    const before = this.skills;
    const after = await discoverSkills(this.config.cwd, this.config.skills, this.config.enableSkills, { includeGlobal: this.config.includeGlobalSkills });
    this.skills = after;
    await this.refreshSystemPromptForSkills();
    const beforeIds = new Set(before.map((skill) => skill.id));
    const afterIds = new Set(after.map((skill) => skill.id));
    const added = after.filter((skill) => !beforeIds.has(skill.id)).map((skill) => skill.id).sort();
    const removed = before.filter((skill) => !afterIds.has(skill.id)).map((skill) => skill.id).sort();
    this.messages.push({
      role: "user",
      content: [
        `Skills reloaded: before=${before.length} after=${after.length}.`,
        added.length ? `Added skills: ${added.join(", ")}` : undefined,
        removed.length ? `Removed skills: ${removed.join(", ")}` : undefined
      ].filter(Boolean).join("\n")
    });
    await this.persist();
    return [
      `Reloaded skills: before=${before.length} after=${after.length}`,
      `defaults=${defaultSkills(after).length} shadowed=${after.filter((skill) => skill.shadowedBy).length}`,
      added.length ? `added: ${added.join(", ")}` : "added: none",
      removed.length ? `removed: ${removed.join(", ")}` : "removed: none"
    ].join("\n");
  }

  async reloadCustomCommands(): Promise<string> {
    const before = this.customCommands;
    const after = await discoverCustomCommands(this.config.cwd, this.config.includeGlobalSkills !== false);
    this.customCommands = after;
    const beforeNames = new Set(before.map((command) => command.name));
    const afterNames = new Set(after.map((command) => command.name));
    const added = after.filter((command) => !beforeNames.has(command.name)).map((command) => command.name);
    const removed = before.filter((command) => !afterNames.has(command.name)).map((command) => command.name);
    await this.persist();
    return [
      `Reloaded custom commands: before=${before.length} after=${after.length}`,
      added.length ? `added: ${added.join(", ")}` : "added: none",
      removed.length ? `removed: ${removed.join(", ")}` : "removed: none"
    ].join("\n");
  }

  describeCustomCommands(): string {
    return renderCustomCommandList(this.customCommands);
  }

  getCustomCommands(): CustomCommandInfo[] {
    return [...this.customCommands];
  }

  async runCustomCommand(name: string, args: string): Promise<string> {
    const command = resolveCustomCommand(this.customCommands, name);
    if (!command) throw new Error(`Custom command not found: /${name}`);
    return this.run(renderCustomCommandPrompt(command, args));
  }

  async reloadSubagents(): Promise<string> {
    const before = this.subagents;
    const after = await discoverSubagents(this.config.cwd, this.config.includeGlobalSkills !== false);
    this.subagents = after;
    const beforeNames = new Set(before.map((agent) => agent.name));
    const afterNames = new Set(after.map((agent) => agent.name));
    const added = after.filter((agent) => !beforeNames.has(agent.name)).map((agent) => agent.name);
    const removed = before.filter((agent) => !afterNames.has(agent.name)).map((agent) => agent.name);
    await this.persist();
    return [
      `Reloaded subagents: before=${before.length} after=${after.length}`,
      added.length ? `added: ${added.join(", ")}` : "added: none",
      removed.length ? `removed: ${removed.join(", ")}` : "removed: none"
    ].join("\n");
  }

  private async refreshSubagents(): Promise<void> {
    this.subagents = await discoverSubagents(this.config.cwd, this.config.includeGlobalSkills !== false);
    await this.persist();
  }

  describeSubagents(): string {
    return renderSubagentList(this.subagents);
  }

  inspectSubagent(nameOrId: string): string {
    const resolved = resolveSubagent(this.subagents, nameOrId);
    if (!resolved.agent) return `Subagent not found: ${nameOrId}`;
    return renderSubagentInspect(resolved.agent, resolved.candidates);
  }

  getSubagents(): SubagentInfo[] {
    return [...this.subagents];
  }

  async useSubagent(nameOrId: string, task: string): Promise<string> {
    const resolved = resolveSubagent(this.subagents, nameOrId);
    if (!resolved.agent) throw new Error(`Subagent not found: ${nameOrId}`);
    const previous = this.activeSubagentName;
    const previousTools = this.activeSubagentToolNames;
    const previousPrompt = this.activeSubagentSystemPrompt;
    this.activeSubagentName = resolved.agent.name;
    this.activeSubagentToolNames = subagentToolNames(resolved.agent, Array.from(this.tools.values()));
    this.activeSubagentSystemPrompt = this.scopedSubagentSystemPrompt(resolved.agent, this.activeSubagentToolNames);
    try {
      return await this.run(subagentInjection(resolved.agent, task));
    } finally {
      this.activeSubagentName = previous;
      this.activeSubagentToolNames = previousTools;
      this.activeSubagentSystemPrompt = previousPrompt;
    }
  }

  private scopedSubagentSystemPrompt(agent: SubagentInfo, allowedNames: Set<string> | undefined): Message | undefined {
    if (!allowedNames) return undefined;
    const scopedTools = Array.from(this.tools.values()).filter((tool) => allowedNames.has(tool.name));
    const allowed = Array.from(allowedNames).sort();
    const fallbackTool = allowed[0] ?? "";
    const exampleTool = allowed.includes("read_file") ? `{"action":"tool","tool":"read_file","input":{"path":"README.md"},"thought":"inspect the requested file"}` : fallbackTool ? `{"action":"tool","tool":"${fallbackTool}","input":{},"thought":"use an allowed tool"}` : "";
    return {
      role: "system",
      content: [
        [
          "You are Mini Code Agent, a local coding assistant running a foreground subagent in the user's workspace.",
          "",
          "Use only the available tools listed below. If a tool is not listed, do not call it.",
          "",
          `Available tools:\n${renderScopedTools(scopedTools)}`,
          "",
          "Decision format:",
          exampleTool,
          `{"action":"final","answer":"short summary for the user"}`
        ].filter(Boolean).join("\n"),
        `Foreground subagent ${agent.name} declared tools: ${agent.tools.join(", ")}.`,
        `Only these internal tools are allowed for this foreground subagent: ${Array.from(allowedNames).sort().join(", ") || "[none]"}.`
      ].join("\n\n")
    };
  }

  async createSubagent(rawName: string, rawDescription = ""): Promise<string> {
    const created = await createProjectSubagent(this.config.cwd, rawName, rawDescription);
    const reloadSummary = await this.reloadSubagents();
    this.messages.push({
      role: "user",
      content: [
        `Project subagent created: ${created.name}`,
        `Path: ${created.path}`,
        `Description: ${created.description}`,
        "Use /agent:<name> <task> to run it, or edit the Markdown file to specialize the persona."
      ].join("\n")
    });
    await this.persist();
    return [
      `Created subagent ${created.name}`,
      `path: ${created.path}`,
      `description: ${created.description}`,
      reloadSummary
    ].join("\n");
  }

  async runReview(target = ""): Promise<string> {
    const scope = target.trim() || "the current workspace changes";
    return this.run([
      `Review ${scope}.`,
      "",
      "Act as a code reviewer. Inspect relevant files and diffs before answering.",
      "Do not edit files or run mutating commands.",
      "Prioritize findings by severity with concrete file/line references when available.",
      "Focus on bugs, regressions, missing tests, security risks, and behavior changes.",
      "Keep any summary brief and place it after findings."
    ].join("\n"));
  }

  private async refreshSkillContext(): Promise<void> {
    this.skills = await discoverSkills(this.config.cwd, this.config.skills, this.config.enableSkills, { includeGlobal: this.config.includeGlobalSkills });
    await this.refreshSystemPromptForSkills();
    await this.persist();
  }

  private async refreshSystemPromptForSkills(): Promise<void> {
    const projectMemory = await loadProjectMemory(this.config.cwd);
    if (this.messages[0]?.role === "system") this.messages[0] = { role: "system", content: systemPrompt(Array.from(this.tools.values()), this.skills, projectMemory, outputStylePrompt(this.outputStyle)) };
  }

  async createSkill(rawName: string, rawDescription = ""): Promise<string> {
    const created = await createProjectSkill(this.config.cwd, rawName, rawDescription);
    const reloadSummary = await this.reloadSkills();
    this.messages.push({
      role: "user",
      content: [
        `Project skill created: ${created.name}`,
        `Path: ${created.path}`,
        `Description: ${created.description}`,
        "Use /skill:<name> to load it, or edit SKILL.md to specialize the workflow."
      ].join("\n")
    });
    await this.persist();
    return [
      `Created skill ${created.name}`,
      `path: ${created.path}`,
      `description: ${created.description}`,
      reloadSummary
    ].join("\n");
  }

  async useSkill(nameOrId: string, args: string): Promise<string> {
    const { skill, candidates } = resolveSkill(this.skills, nameOrId);
    if (!skill) throw new Error(`Skill not found: ${nameOrId}`);
    const content = skillInjection(skill, args);
    this.messages.push({ role: "user", content });
    if (!this.activeSkills.includes(skill.id)) this.activeSkills.push(skill.id);
    await this.persist();
    const duplicateNote = candidates.length > 1 && !nameOrId.includes(":")
      ? `\nResolved duplicate name "${skill.name}" to default id ${skill.id}. Use /skill:<id> for an exact match.`
      : "";
    return `Loaded skill ${skill.name} (${skill.id}).${duplicateNote}`;
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
    this.applyPermissionMode(mode);
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  private applyPermissionMode(mode: PermissionMode): void {
    this.approvalContext.mode = mode;
    this.approvalContext.allowedApprovalKeys.delete("mode:accept_edits");
    this.approvalContext.allowedApprovalKeys.delete("mode:bypass_permissions");
    if (mode === "accept_edits") this.approvalContext.allowedApprovalKeys.add("mode:accept_edits");
    if (mode === "bypass_permissions") this.approvalContext.allowedApprovalKeys.add("mode:bypass_permissions");
  }

  private async nextDecision(options: { allowMarkdownFinal?: boolean } = {}): Promise<{ raw: string; decision: AgentDecision }> {
    let raw = await this.callModel();
    try {
      const decision = parseDecision(raw, this.tools);
      this.assertSubagentToolAllowed(decision);
      return { raw, decision };
    } catch (error) {
      if (options.allowMarkdownFinal && isDisplayMarkdownFinal(raw)) {
        return { raw, decision: { action: "final", answer: raw.trim() } };
      }
      await this.emit({ type: "error", category: "parse", error: error instanceof Error ? error.message : String(error) });
      this.messages.push(repairPrompt(error, raw));
      await this.persist();
      raw = await this.callModel();
      try {
        const decision = parseDecision(raw, this.tools);
        this.assertSubagentToolAllowed(decision);
        return { raw, decision };
      } catch (secondError) {
        if (options.allowMarkdownFinal && isDisplayMarkdownFinal(raw)) {
          return { raw, decision: { action: "final", answer: raw.trim() } };
        }
        const message = secondError instanceof Error ? secondError.message : String(secondError);
        await this.emit({ type: "error", category: "parse", error: message });
        throw secondError;
      }
    }
  }

  private async callModel(): Promise<string> {
    let response;
    try {
      const messages = this.activeSubagentSystemPrompt ? [this.activeSubagentSystemPrompt, ...this.messages.filter((message) => message.role !== "system")] : this.messages;
      response = await complete({
        provider: this.config.provider,
        baseUrl: this.config.baseUrl,
        apiKey: this.config.apiKey,
        model: this.config.model,
        messages,
        toolProtocol: this.config.toolProtocol,
        tools: Array.from(this.tools.values()),
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

  private assertSubagentToolAllowed(decision: AgentDecision): void {
    if (decision.action !== "tool" || !this.activeSubagentToolNames) return;
    const tool = decision.tool ?? "";
    if (this.activeSubagentToolNames.has(tool)) return;
    throw new Error(`Subagent ${this.activeSubagentName ?? ""} cannot use tool ${tool}. Declared tools: ${Array.from(this.activeSubagentToolNames).sort().join(", ") || "[none]"}`);
  }

  private rememberApproval(tool: string, input: Record<string, unknown>, key: string | undefined, decision: ApprovalDecision): void {
    if (decision !== "always_allow") return;
    const approvalKey = key ?? (tool === "run_command" && typeof input.command === "string" ? commandPrefix(input.command) : undefined);
    if (!approvalKey) return;
    this.approvalContext.allowedApprovalKeys.add(approvalKey);
    if (approvalKey.startsWith("shell:prefix:")) this.approvalContext.allowedCommandPrefixes.add(approvalKey.slice("shell:prefix:".length));
    if (!approvalKey.startsWith("shell:") && tool === "run_command" && typeof input.command === "string") {
      this.approvalContext.allowedCommandPrefixes.add(commandPrefix(input.command));
      this.approvalContext.allowedApprovalKeys.add(commandPrefixApprovalKey(commandPrefix(input.command)));
    }
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
    if (!shouldCompactMessages(this.config, this.messages)) return;
    const pre = await this.runPreCompactHooks("auto");
    if (!pre.ok) {
      await this.emit({ type: "error", category: pre.errorType === "permission_blocked" ? "permission" : "runtime", error: pre.output });
      return;
    }
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
      capabilities: this.capabilities,
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

function parsePlanRecord(request: string, model: string, answer: string, inspectionEvents: string[] = []): PlanRecord {
  const now = new Date().toISOString();
  const summary = sectionText(answer, /summary|摘要/i) || sectionText(answer, /goal|目标/i) || firstContentLine(answer) || "Plan ready.";
  return {
    id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    request,
    status: "draft",
    model,
    answer,
    summary,
    steps: sectionLines(answer, /ordered steps|steps|实施步骤|步骤/i),
    files: sectionLines(answer, /relevant files|files|关键文件|相关文件/i),
    validations: sectionLines(answer, /validation commands|validation|验证|test|checks/i),
    risks: sectionLines(answer, /risks|风险/i),
    openQuestions: sectionLines(answer, /open questions|待确认|问题/i),
    assumptions: sectionLines(answer, /assumptions|假设/i),
    acceptanceCriteria: sectionLines(answer, /acceptance criteria|验收|验收标准/i),
    statusReason: inspectionEvents.length > 0 ? undefined : "limited inspection",
    inspectionEvents,
    createdAt: now
  };
}

function sectionLines(answer: string, heading: RegExp): string[] {
  return sectionBlock(answer, heading)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

function sectionText(answer: string, heading: RegExp): string {
  return sectionBlock(answer, heading)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 240);
}

function sectionBlock(answer: string, heading: RegExp): string[] {
  const lines = answer.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(cleanHeading(line)));
  if (start === -1) return [];
  const result: string[] = [];
  const inline = inlineHeadingContent(lines[start], heading);
  if (inline) result.push(inline);
  for (const line of lines.slice(start + 1)) {
    if (isSectionHeading(line) && result.length > 0) break;
    if (line.trim()) result.push(line);
  }
  return result;
}

function cleanHeading(line: string): string {
  return line.trim().replace(/^#{1,6}\s*/, "").replace(/[:：].*$/, "");
}

function inlineHeadingContent(line: string, heading: RegExp): string {
  const cleaned = line.trim().replace(/^#{1,6}\s*/, "");
  const match = cleaned.match(/^([^:：]+)[:：]\s*(.+)$/);
  if (!match || !heading.test(match[1])) return "";
  return match[2].trim();
}

function isSectionHeading(line: string): boolean {
  const cleaned = line.trim();
  return /^#{1,6}\s+\S/.test(cleaned) || /^[A-Z][A-Za-z ]+[:：]\s*$/.test(cleaned) || /^[\u4e00-\u9fa5A-Za-z ]{2,20}[:：]\s*$/.test(cleaned);
}

function firstContentLine(answer: string): string {
  return answer.split(/\r?\n/).map((line) => line.replace(/^#{1,6}\s*/, "").trim()).find(Boolean) ?? "";
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
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
  const detail = (label: string) => requirement.details?.find((item) => item.label === label)?.value;
  return {
    approvalKey: requirement.approvalKey,
    scope: requirement.scope,
    riskReason: requirement.riskReason,
    mode: detail("mode"),
    action: detail("action"),
    target: detail("target"),
    scopeType: detail("scopeType"),
    rememberPolicy: detail("rememberPolicy"),
    blocked: requirement.blocked,
    rememberable: requirement.rememberable
  };
}

function renderScopedTools(tools: ToolDefinition[]): string {
  if (tools.length === 0) return "[none]";
  return tools
    .map((tool) => {
      const schema = Object.entries(tool.inputSchema)
        .map(([key, value]) => `    ${key}: ${value}`)
        .join("\n");
      return `- ${tool.name} [risk=${tool.risk}]: ${tool.description}\n${schema || "    no input"}`;
    })
    .join("\n");
}

function looksJsonLike(value: string): boolean {
  return /^\s*[{[]/.test(value);
}

function isDisplayMarkdownFinal(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || looksJsonLike(trimmed)) return false;
  if (/^(not json|invalid json|error)$/i.test(trimmed)) return false;
  return /[.!?。？！]$/.test(trimmed) || /[\u4e00-\u9fff]/.test(trimmed) || /^#{1,6}\s+\S/m.test(trimmed) || /^[-*]\s+\S/m.test(trimmed) || trimmed.length > 20;
}

function capabilityDiff(previous: CapabilityDescriptor[], current: CapabilityDescriptor[]): string {
  if (previous.length === 0) return "";
  const previousIds = new Set(previous.map((item) => item.id));
  const currentIds = new Set(current.map((item) => item.id));
  const added = current.filter((item) => !previousIds.has(item.id)).map((item) => item.id).sort();
  const removed = previous.filter((item) => !currentIds.has(item.id)).map((item) => item.id).sort();
  if (added.length === 0 && removed.length === 0) return "";
  return [
    "Capability snapshot changed since this session was saved.",
    added.length ? `added: ${added.join(", ")}` : undefined,
    removed.length ? `removed: ${removed.join(", ")}` : undefined
  ].filter(Boolean).join("\n");
}
