import path from "node:path";
import type { AgentConfig, AgentEvent, ApprovalDecision, CustomCommandInfo, ModelStreamEvent, PendingApproval, PermissionMode, PlanRecord, SkillInfo, TaskTodo, ToolErrorType, ToolMetadata } from "../core/types.js";
import { releaseNoteHighlights } from "../core/releaseNotes.js";

export type TimelineKind = "user" | "assistant_text" | "plan" | "plan_record" | "thinking" | "tool_request" | "permission" | "code_change" | "tool_result" | "final" | "error" | "session" | "compact";
export type TimelineSeverity = "muted" | "neutral" | "active" | "success" | "warning" | "danger";
export type DetailType = "message" | "plan" | "tool" | "code_change" | "permission" | "final" | "error" | "session" | "compact" | "thinking";
export type CodeChangeStatus = "planned" | "checked" | "applied";

export type TimelineItem =
  | { kind: "user"; text: string; queued?: boolean }
  | { kind: "assistant_text"; text: string }
  | { kind: "plan"; turn: number; todos: TaskTodo[] }
  | { kind: "plan_record"; plan: PlanRecord }
  | { kind: "thinking"; turn: number; text: string }
  | { kind: "tool_request"; turn: number; tool: string; description: string; input: Record<string, unknown> }
  | { kind: "permission"; tool?: string; text: string; decision?: ApprovalDecision; risk?: string; details?: Array<{ label: string; value: string }>; blocked?: boolean; rememberable?: boolean }
  | { kind: "code_change"; turn?: number; tool: string; status: CodeChangeStatus; files: string[]; diff: string; summary: string }
  | { kind: "tool_result"; turn: number; tool: string; ok: boolean; output: string; status: "ok" | "failed" | "denied" | "blocked" | "validation_error"; errorType?: ToolErrorType; metadata?: ToolMetadata }
  | { kind: "final"; text: string }
  | { kind: "error"; text: string; category?: string }
  | { kind: "session"; text: string }
  | { kind: "compact"; text: string };

export interface StatusModel {
  title: string;
  cwd: string;
  provider: string;
  model: string;
  planModel: string;
  session: string;
  turn: number;
  state: "idle" | "running" | "aborting" | "permission";
  taskStatus?: string;
  permissionMode: PermissionMode;
  messages: number;
  summary: boolean;
}

export interface DetailModel {
  title: string;
  body: string;
  color: string;
  type: DetailType;
  diffLines?: Array<{ text: string; color: string }>;
}

export interface HeaderField {
  label: string;
  value: string;
  color?: string;
}

export interface CommandGroup {
  title: string;
  commands: string[];
}

export interface TimelineLabel {
  marker: string;
  color: string;
  text: string;
  severity: TimelineSeverity;
}

export interface ClaudeDisplay {
  role: "user" | "assistant" | "activity" | "system" | "error";
  marker: string;
  markerColor: string;
  textColor: string;
  background?: string;
}

export interface ClaudeActivityLine {
  marker: string;
  markerColor: string;
  text: string;
  textColor: string;
}

export interface RunUsageEstimate {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  toolCount: number;
  elapsedSeconds: number;
  lastActivity: "thinking" | "tool" | "permission" | "answer" | "idle";
}

export interface ActivityDisplayState {
  running: boolean;
  elapsedSeconds?: number;
  outputTokens: number;
  thoughtTokens: number;
}

export interface InputStatusModel {
  prompt: string;
  promptColor: string;
  runningLine?: string;
  runningColor: string;
  usageLine: string;
  hintLine?: string;
}

export interface PlanSummaryRow {
  label: string;
  value: string;
}

export interface ApprovalCardRow {
  label: string;
  value: string;
  tone?: "normal" | "warning" | "danger" | "muted" | "accent";
}

export type MarkdownLineKind = "heading" | "paragraph" | "bullet" | "ordered" | "task" | "quote" | "code" | "hr" | "blank";

export interface MarkdownLine {
  kind: MarkdownLineKind;
  text: string;
  level?: number;
  checked?: boolean;
  language?: string;
}

export type CodeTokenKind = "key" | "string" | "number" | "boolean" | "null" | "punctuation" | "plain";

export interface CodeToken {
  kind: CodeTokenKind;
  text: string;
}

export type TimelineRenderBlock =
  | { kind: "message"; item: TimelineItem; markdown?: MarkdownLine[] }
  | { kind: "activity"; summary: string; details: string[]; items: TimelineItem[] };

export function statusModel(input: {
  config: AgentConfig;
  sessionId: string;
  turn: number;
  busy: boolean;
  approval: PendingApproval | undefined;
  messageCount: number;
  hasSummary: boolean;
  permissionMode?: PermissionMode;
  aborting?: boolean;
}): StatusModel {
  return {
    title: "Mini Code Agent",
    cwd: shortPath(input.config.cwd, 40),
    provider: input.config.provider,
    model: input.config.model,
    planModel: input.config.planModel,
    session: truncateMiddle(input.sessionId, 22),
    turn: input.turn,
    state: input.approval ? "permission" : input.aborting ? "aborting" : input.busy ? "running" : "idle",
    permissionMode: input.permissionMode ?? input.config.permissionMode,
    messages: input.messageCount,
    summary: input.hasSummary
  };
}

export function estimateTextTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const cjk = trimmed.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const latin = trimmed.replace(/[\u3400-\u9fff]/g, " ").match(/[A-Za-z0-9_./:-]+/g)?.length ?? 0;
  const punctuation = Math.ceil(trimmed.replace(/\s/g, "").length / 18);
  return Math.max(1, Math.ceil(cjk * 1.1 + latin * 1.25 + punctuation));
}

export function estimateRunUsage(items: TimelineItem[], streamingText: string, elapsedSeconds: number): RunUsageEstimate {
  let lastUserIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "user" && !item.queued) {
      lastUserIndex = index;
      break;
    }
  }
  const recent = lastUserIndex >= 0 ? items.slice(lastUserIndex) : items;
  const lastUser = lastUserIndex >= 0 ? items[lastUserIndex] : undefined;
  const inputText = lastUser?.kind === "user" ? lastUser.text : "";
  let outputText = streamingText;
  let thoughtText = "";
  let toolCount = 0;
  let lastActivity: RunUsageEstimate["lastActivity"] = "idle";

  for (const item of recent) {
    if (item.kind === "assistant_text" || item.kind === "final") {
      outputText += `\n${item.text}`;
      lastActivity = "answer";
    } else if (item.kind === "thinking") {
      thoughtText += `\n${item.text}`;
      lastActivity = "thinking";
    } else if (item.kind === "tool_request") {
      toolCount += 1;
      lastActivity = "tool";
    } else if (item.kind === "permission") {
      lastActivity = "permission";
    }
  }

  return {
    inputTokens: estimateTextTokens(inputText),
    outputTokens: estimateTextTokens(outputText),
    thoughtTokens: estimateTextTokens(thoughtText),
    toolCount,
    elapsedSeconds,
    lastActivity
  };
}

export function inputStatusModel(input: {
  status: StatusModel;
  promptInput: string;
  usage: RunUsageEstimate;
  hasConversation: boolean;
  expanded: boolean;
  detailsVisible: boolean;
  aborting: boolean;
  queueCount?: number;
}): InputStatusModel {
  const model = `${input.status.provider}:${truncateMiddle(input.status.model, 26)}`;
  const totalTokens = input.usage.inputTokens + input.usage.outputTokens + input.usage.thoughtTokens;
  const queueText = input.queueCount ? ` | queued ${input.queueCount}` : "";
  const usageLine = `${model} | turn ${input.status.turn} | msg ${input.status.messages} | ~${totalTokens} tokens | tools ${input.usage.toolCount}${queueText} | ${permissionModeLabel(input.status.permissionMode)}`;
  if (input.status.state === "running" || input.status.state === "aborting") {
    const action = input.usage.lastActivity === "tool" ? "Using tools" : input.usage.lastActivity === "answer" ? "Answering" : "Thinking";
    const queued = input.queueCount ? ` | queued ${input.queueCount}` : "";
    return {
      prompt: "",
      promptColor: input.aborting ? "red" : "gray",
      runningLine: `* ${action}... ${Math.max(1, input.usage.elapsedSeconds)}s | out ${input.usage.outputTokens} | thought ${input.usage.thoughtTokens} | tools ${input.usage.toolCount}${queued} | ${input.aborting ? "stopping" : "esc"}`,
      runningColor: input.aborting ? "red" : "#ff7a45",
      usageLine,
      hintLine: input.expanded ? "expanded details on (ctrl+o to collapse)" : "compact details (ctrl+o to expand)"
    };
  }

  const modeHint = input.detailsVisible || input.expanded || input.status.permissionMode !== "default"
    ? `shift+tab ${permissionModeLabel(input.status.permissionMode)} | /details ${input.detailsVisible ? "on" : "off"} | /expand ${input.expanded ? "on" : "off"} | ctrl+o ${input.expanded ? "collapse" : "expand"}`
    : input.hasConversation ? undefined : "? for shortcuts";

  return {
    prompt: `> ${input.promptInput}`,
    promptColor: "white",
    runningColor: "gray",
    usageLine,
    hintLine: modeHint
  };
}

export function headerFields(status: StatusModel): HeaderField[] {
  return [
    { label: "state", value: status.state, color: stateColor(status.state) },
    { label: "model", value: `${status.provider}:${truncateMiddle(status.model, 24)}` },
    { label: "plan", value: truncateMiddle(status.planModel, 22) },
    { label: "mode", value: permissionModeLabel(status.permissionMode), color: permissionModeColor(status.permissionMode) },
    { label: "cwd", value: status.cwd },
    { label: "session", value: status.session },
    { label: "turn", value: String(status.turn) },
    { label: "msg", value: String(status.messages) },
    { label: "summary", value: status.summary ? "on" : "off", color: status.summary ? "cyan" : "gray" }
  ];
}

export const commandGroups: CommandGroup[] = [
  { title: "Session", commands: ["/help", "/status", "/cost", "/bug [description]", "/release-notes", "/output-style", "/output-style list", "/output-style set <name>", "/output-style create <name> <instructions>", "/memory", "/memory list", "/memory add <scope> <note>", "/memory reload", "/init", "/session", "/sessions", "/continue", "/new", "/resume [id]", "/fork <id>", "/name <title>", "/rename <title>", "/export-session <path>", "/import-session <path>", "/delete-session <id>"] },
  { title: "Work", commands: ["/review [target]", "/plan <request>", "/execute <plan-id>", "/todos", "/tasks", "/tools", "/permissions", "/permissions allow <matcher>", "/permissions deny <matcher>", "/permissions remove <action> <matcher>", "/permissions reload", "/hooks", "/hooks reload", "/commands", "/commands reload", "/agents", "/agents reload", "/agent inspect <name>", "/agent create <name> [description]", "/agent:<name> <task>", "/skills", "/skill inspect <name>", "/skill create <name> [description]", "/skill reload", "/skill:<name> <args>", "/capabilities"] },
  { title: "MCP", commands: ["/mcp", "/mcp tools", "/mcp resources", "/mcp prompts", "/mcp reconnect <server>"] },
  { title: "View", commands: ["/details", "/expand", "/history", "/clear", "/queue", "/queue clear"] },
  { title: "Context", commands: ["/compact", "/summary"] },
  { title: "Config", commands: ["/model", "/config", "/config list", "/config get <key>", "/config set <key> <value>", "/config unset <key>", "/doctor", "/features", "/login", "/pi (use --pi-pass-through -- ...)"] },
  { title: "Exit", commands: ["/exit"] }
];

export const slashCommands = commandGroups.flatMap((group) => group.commands);
const commandRank = new Map(slashCommands.map((command, index) => [command, index]));

export function renderCommandHelp(): string {
  return commandGroups
    .map((group) => [
      `${group.title}:`,
      ...group.commands.map((command) => {
        const key = commandKey(command);
        return `  ${command.padEnd(32)} ${commandDescriptions[key] ?? ""}`.trimEnd();
      })
    ].join("\n"))
    .join("\n\n");
}

export const emptyStates = {
  timeline: "No activity yet. Ask a question or type /help.",
  task: "No active plan.",
  detail: "Latest tool, error, and diff details appear here."
};

export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  if (mode === "default" || mode === "risk-based") return "accept_edits";
  if (mode === "accept_edits") return "bypass_permissions";
  return "default";
}

export function permissionModeLabel(mode: PermissionMode): string {
  if (mode === "accept_edits") return "accept edits";
  if (mode === "bypass_permissions") return "bypass permissions";
  return "default";
}

export function permissionModeColor(mode: PermissionMode): string {
  if (mode === "accept_edits") return "green";
  if (mode === "bypass_permissions") return "yellow";
  return "cyan";
}

export function stateColor(state: StatusModel["state"]): string {
  if (state === "permission") return "yellow";
  if (state === "running") return "blue";
  if (state === "aborting") return "red";
  return "gray";
}

export function eventToTimelineItems(event: AgentEvent): TimelineItem[] {
  if (event.type === "model_stream_delta") return [];
  if (event.type === "model_response") return piLikeModelEventsToTimeline(event.streamEvents ?? []);
  if (event.type === "plan") return [{ kind: "plan", turn: event.turn, todos: event.todos }];
  if (event.type === "error" && event.category === "parse") return [];
  if (event.type === "error" && event.category === "protocol" && /Asking the model/i.test(event.error)) return [];
  if (event.type === "tool_request") {
    const items: TimelineItem[] = [];
    if (event.thought?.trim()) items.push({ kind: "thinking", turn: event.turn, text: event.thought.trim() });
    items.push({ kind: "tool_request", turn: event.turn, tool: event.tool, description: event.description, input: event.input });
    const codeChange = codeChangeFromToolRequest(event);
    if (codeChange) items.push(codeChange);
    return items;
  }
  if (event.type === "permission_request") {
    return [
      {
        kind: "permission",
        tool: event.tool,
        text: event.requirement.reason,
        risk: event.requirement.risk,
        details: event.requirement.details,
        blocked: event.requirement.blocked,
        rememberable: event.requirement.rememberable
      }
    ];
  }
  if (event.type === "tool_result") {
    const result: TimelineItem = { kind: "tool_result", turn: event.turn, tool: event.tool, ok: event.ok, output: event.output, status: toolStatus(event.ok, event.output, event.errorType), errorType: event.errorType, metadata: event.metadata };
    const codeChange = codeChangeFromToolResult(event);
    return codeChange ? [result, codeChange] : [result];
  }
  if (event.type === "compaction") return [{ kind: "compact", text: event.summary || "[no summary]" }];
  if (event.type === "final") return [{ kind: "final", text: extractDisplayMarkdown(event.answer) }];
  return [{ kind: "error", text: event.error, category: event.category }];
}

// This mapper mirrors Pi SDK/RPC display concepts without depending on Pi's runtime.
// Pi emits message_update events with text/thinking/toolcall deltas; Mini Code can
// render the same display shape when providers start supplying stream events.
export function piLikeModelEventsToTimeline(events: ModelStreamEvent[]): TimelineItem[] {
  const text = events.filter((event) => event.type === "text_delta").map((event) => event.text).join("").trim();
  const thinking = events.filter((event) => event.type === "thinking_delta").map((event) => event.text).join("").trim();
  const items: TimelineItem[] = [];
  if (thinking) items.push({ kind: "thinking", turn: 0, text: thinking });
  if (text && !looksLikeInternalPayload(text)) items.push({ kind: "assistant_text", text: extractDisplayMarkdown(text) });
  return items;
}

export function extractDisplayMarkdown(text: string): string {
  const trimmed = normalizeDisplayMarkdown(text).trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const jsonText = firstJsonObject(withoutFence);
  if (!jsonText) return normalizeDisplayMarkdown(text);
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (isObject(parsed) && typeof parsed.answer === "string") return normalizeDisplayMarkdown(parsed.answer);
  } catch {
    return normalizeDisplayMarkdown(text);
  }
  return normalizeDisplayMarkdown(text);
}

export function normalizeDisplayMarkdown(text: string): string {
  let value = text.trim();
  const decoded = decodeJsonStringLiteral(value);
  if (decoded !== undefined) value = decoded.trim();
  const wrapper = decodeJsonAnswerWrapper(value);
  if (wrapper !== undefined) value = wrapper.trim();
  if (shouldUnescapeMarkdown(value)) value = unescapeTextMarkup(value);
  return value;
}

function decodeJsonStringLiteral(value: string): string | undefined {
  if (!((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) return undefined;
  try {
    return JSON.parse(value) as string;
  } catch {
    return undefined;
  }
}

function decodeJsonAnswerWrapper(value: string): string | undefined {
  const withoutFence = value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const jsonText = firstJsonObject(withoutFence);
  if (!jsonText) return undefined;
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (isObject(parsed) && typeof parsed.answer === "string") return parsed.answer;
  } catch {
    return undefined;
  }
  return undefined;
}

function shouldUnescapeMarkdown(value: string): boolean {
  if (!/\\[nrt"]/.test(value)) return false;
  if (/^```/.test(value)) return false;
  return /\\n\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>|```)|\\n\\n|\\t/.test(value);
}

function unescapeTextMarkup(value: string): string {
  return value
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "  ")
    .replace(/\\"/g, "\"");
}

export function codeChangeFromToolRequest(event: Extract<AgentEvent, { type: "tool_request" }>): Extract<TimelineItem, { kind: "code_change" }> | undefined {
  if ((event.tool !== "apply_patch" && event.tool !== "git_apply_check") || typeof event.input.patch !== "string") return undefined;
  const diff = event.input.patch;
  const status: CodeChangeStatus = event.tool === "git_apply_check" ? "checked" : "planned";
  return {
    kind: "code_change",
    turn: event.turn,
    tool: event.tool,
    status,
    files: patchFilesList(diff),
    diff,
    summary: diffSummary(diff, status)
  };
}

export function codeChangeFromToolResult(event: Extract<AgentEvent, { type: "tool_result" }>): Extract<TimelineItem, { kind: "code_change" }> | undefined {
  if (!event.ok || typeof event.metadata?.diff !== "string") return undefined;
  const diff = event.metadata.diff;
  const files = metadataFiles(event.metadata) || patchFilesList(diff);
  return {
    kind: "code_change",
    turn: event.turn,
    tool: event.tool,
    status: "applied",
    files,
    diff,
    summary: diffSummary(diff, "applied", files)
  };
}

export function diffSummary(diff: string, status: CodeChangeStatus = "planned", files = patchFilesList(diff)): string {
  const counts = diffCounts(diff);
  const action = status === "checked" ? "check" : "edit";
  const target = files.length > 0 ? files.join(", ") : "patch";
  return `${action} ${truncateEnd(target, 80)} +${counts.added} -${counts.removed}`;
}

export function renderDiffLines(diff: string, expanded: boolean): Array<{ text: string; color: string }> {
  const maxLines = expanded ? 120 : 24;
  const maxChars = expanded ? 8000 : 1800;
  let chars = 0;
  const lines: Array<{ text: string; color: string }> = [];
  for (const line of diff.split(/\r?\n/)) {
    if (lines.length >= maxLines || chars + line.length > maxChars) {
      lines.push({ text: "[diff truncated, type /expand or press ctrl+o]", color: "gray" });
      break;
    }
    lines.push({ text: line || " ", color: diffLineColor(line) });
    chars += line.length + 1;
  }
  return lines.length > 0 ? lines : [{ text: "[no diff]", color: "gray" }];
}

export function todoLabel(todo: TaskTodo): string {
  const marker = todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[>]" : "[ ]";
  return `${marker} ${todo.content}`;
}

export function toolRequestLabel(item: Extract<TimelineItem, { kind: "tool_request" }>): string {
  const target = toolTarget(item.tool, item.input) || item.description;
  return target ? `${item.tool} ${target}` : item.tool;
}

export function timelineLabel(item: TimelineItem): TimelineLabel {
  if (item.kind === "user") return { marker: "user", color: "white", text: item.text, severity: "neutral" };
  if (item.kind === "assistant_text") return { marker: "assistant", color: "cyan", text: "message", severity: "neutral" };
  if (item.kind === "plan") return { marker: "plan", color: "cyan", text: `${item.todos.filter((todo) => todo.status === "completed").length}/${item.todos.length} done`, severity: "active" };
  if (item.kind === "plan_record") return { marker: "plan", color: "cyan", text: `${item.plan.status} ${truncateEnd(item.plan.summary, 120)}`, severity: item.plan.status === "cancelled" ? "warning" : item.plan.status === "executed" ? "success" : "active" };
  if (item.kind === "thinking") return { marker: "think", color: "gray", text: truncateEnd(item.text, 120), severity: "muted" };
  if (item.kind === "tool_request") return { marker: "tool", color: "blue", text: toolRequestLabel(item), severity: "active" };
  if (item.kind === "code_change") return { marker: "edit", color: item.status === "checked" ? "cyan" : "yellow", text: item.summary, severity: "active" };
  if (item.kind === "tool_result") return { marker: item.status, color: toolResultColor(item.status), text: `${item.tool}${item.metadata ? metadataSummary(item.metadata) : ""}`, severity: toolResultSeverity(item.status) };
  if (item.kind === "permission") return { marker: item.blocked ? "blocked" : "perm", color: item.blocked || item.risk === "dangerous" ? "red" : "yellow", text: item.text, severity: item.blocked || item.risk === "dangerous" ? "danger" : "warning" };
  if (item.kind === "compact") return { marker: "summary", color: "magenta", text: "context compacted", severity: "muted" };
  if (item.kind === "final") return { marker: "done", color: "green", text: "answer", severity: "success" };
  if (item.kind === "session") return { marker: "session", color: "cyan", text: truncateEnd(item.text.split(/\r?\n/)[0] ?? "session", 180), severity: "neutral" };
  return { marker: item.category ? `err:${item.category}` : "error", color: "red", text: truncateEnd(firstLine(item.text), 120), severity: "danger" };
}

export function claudeDisplay(item: TimelineItem): ClaudeDisplay {
  if (item.kind === "user") return { role: "user", marker: ">", markerColor: "#bfc1ff", textColor: "white", background: "#3a3a3a" };
  if (item.kind === "assistant_text" || item.kind === "final") return { role: "assistant", marker: "*", markerColor: "white", textColor: "white" };
  if (item.kind === "error") return { role: "error", marker: "*", markerColor: "red", textColor: "red" };
  if (item.kind === "session" || item.kind === "compact") return { role: "system", marker: "", markerColor: "gray", textColor: "gray" };
  return { role: "activity", marker: "*", markerColor: "gray", textColor: "gray" };
}

export function detailForItem(item: TimelineItem | undefined, expanded: boolean): DetailModel | undefined {
  if (!item) return undefined;
  if (item.kind === "assistant_text") {
    return { title: "Assistant", color: "cyan", type: "message", body: outputPreview(item.text, expanded) };
  }
  if (item.kind === "tool_request") {
    return { title: `Tool request: ${item.tool}`, color: "blue", type: "tool", body: JSON.stringify(item.input, null, 2) };
  }
  if (item.kind === "code_change") {
    const diffLines = renderDiffLines(item.diff, expanded);
    return { title: `${item.status === "checked" ? "Checked" : item.status === "applied" ? "Applied" : "Planned"} code change`, color: item.status === "checked" ? "cyan" : "yellow", type: "code_change", body: item.summary, diffLines };
  }
  if (item.kind === "tool_result") {
    const metadata = item.metadata ? `\n\nmetadata:\n${JSON.stringify(item.metadata, null, 2)}` : "";
    return { title: `${item.status}: ${item.tool}`, color: toolResultColor(item.status), type: "tool", body: `${outputPreview(item.output, expanded)}${metadata}` };
  }
  if (item.kind === "permission") {
    const details = item.details?.map((row) => `${row.label}: ${row.value}`).join("\n") ?? "";
    return { title: item.blocked ? "Permission blocked" : "Permission required", color: item.blocked || item.risk === "dangerous" ? "red" : "yellow", type: "permission", body: [item.text, details].filter(Boolean).join("\n\n") };
  }
  if (item.kind === "plan") return { title: "Plan", color: "cyan", type: "plan", body: item.todos.map(todoLabel).join("\n") };
  if (item.kind === "plan_record") return { title: `Plan ${item.plan.id}`, color: "cyan", type: "plan", body: planDetailBody(item.plan, expanded) };
  if (item.kind === "final") return { title: "Final answer", color: "green", type: "final", body: item.text };
  if (item.kind === "error") return { title: item.category ? `Error: ${item.category}` : "Error", color: "red", type: "error", body: errorDetail(item) };
  if (item.kind === "compact") return { title: "Context summary", color: "magenta", type: "compact", body: outputPreview(item.text, expanded) };
  if (item.kind === "session") return { title: "Session", color: "cyan", type: "session", body: outputPreview(item.text, expanded) };
  if (item.kind === "thinking") return { title: "Thinking", color: "gray", type: "thinking", body: item.text };
  return { title: "User request", color: "white", type: "message", body: item.text };
}

function errorDetail(item: Extract<TimelineItem, { kind: "error" }>): string {
  const suggestions: string[] = [];
  if (/call_id|tool_call_id|role.*tool|input\[\d+\]/i.test(item.text)) suggestions.push("Provider rejected tool-message shape. Mini Code should convert internal tool results to user text before provider calls.");
  if (/api key|unauthorized|401/i.test(item.text)) suggestions.push("Check API key and provider configuration with /status.");
  if (/base.?url|404|not found/i.test(item.text)) suggestions.push("Check base URL and OpenAI-compatible endpoint configuration.");
  return [item.text, suggestions.length ? `Suggestions:\n${suggestions.map((text) => `- ${text}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
}

export function timelineMarkdownLines(item: TimelineItem, expanded: boolean): MarkdownLine[] | undefined {
  if (item.kind === "assistant_text" || item.kind === "final" || item.kind === "session" || item.kind === "compact") {
    if (item.kind === "assistant_text" && !expanded && looksLikeInternalPayload(item.text)) return undefined;
    return markdownPreview(item.text, expanded);
  }
  if (item.kind === "plan") {
    return parseMarkdown(item.todos.map((todo) => `- ${todo.status === "completed" ? "[x]" : "[ ]"} ${todo.content}`).join("\n"));
  }
  if (item.kind === "plan_record") {
    return expanded ? markdownPreview(item.plan.answer, true) : parseMarkdown(`**Plan ready:** ${item.plan.summary}`);
  }
  if (!expanded) return undefined;
  if (item.kind === "error") return markdownPreview(errorDetail(item), true);
  if (item.kind === "tool_request") return parseMarkdown(`\`\`\`json\n${JSON.stringify(item.input, null, 2)}\n\`\`\``);
  if (item.kind === "tool_result" && item.output.trim()) return markdownPreview(item.output, true);
  if (item.kind === "permission" && item.details?.length) return parseMarkdown(item.details.map((row) => `- **${row.label}:** ${row.value}`).join("\n"));
  return undefined;
}

export function timelineRenderBlocks(items: TimelineItem[], streamingText: string, expanded: boolean): TimelineRenderBlock[] {
  const blocks: TimelineRenderBlock[] = [];
  let activity: TimelineItem[] = [];

  const flushActivity = () => {
    if (activity.length === 0) return;
    if (!expanded && !hasCompactActivity(activity)) {
      activity = [];
      return;
    }
    blocks.push({
      kind: "activity",
      summary: asciiActivitySummary(activity),
      details: expanded ? asciiActivityDetails(activity) : [],
      items: activity
    });
    activity = [];
  };

  for (const item of items) {
    if (isActivityItem(item)) {
      activity.push(item);
      continue;
    }
    flushActivity();
    const markdown = timelineMarkdownLines(item, expanded);
    if (item.kind === "assistant_text" && !expanded && !markdown) continue;
    blocks.push({ kind: "message", item, markdown });
  }

  flushActivity();
  if (streamingText.trim()) {
    blocks.push({
      kind: "message",
      item: { kind: "assistant_text", text: streamingText },
      markdown: markdownPreview(streamingText.slice(expanded ? -4000 : -900), expanded)
    });
  }
  return blocks;
}

function isActivityItem(item: TimelineItem): boolean {
  return item.kind === "thinking" || item.kind === "tool_request" || item.kind === "tool_result" || item.kind === "code_change" || item.kind === "permission";
}

function hasCompactActivity(items: TimelineItem[]): boolean {
  return items.some((item) => item.kind === "tool_request" || item.kind === "code_change" || item.kind === "permission");
}

export function claudeActivityLines(items: TimelineItem[], expanded: boolean, state?: ActivityDisplayState): ClaudeActivityLine[] {
  const lines: ClaudeActivityLine[] = [];
  const thinking = items.filter((item): item is Extract<TimelineItem, { kind: "thinking" }> => item.kind === "thinking");
  const toolRequests = items.filter((item): item is Extract<TimelineItem, { kind: "tool_request" }> => item.kind === "tool_request");
  const codeChanges = items.filter((item): item is Extract<TimelineItem, { kind: "code_change" }> => item.kind === "code_change");
  const permissions = items.filter((item): item is Extract<TimelineItem, { kind: "permission" }> => item.kind === "permission");

  for (const request of compactToolRequests(toolRequests, items)) {
    lines.push(request);
  }
  for (const change of compactCodeChanges(codeChanges)) {
    const fileCount = change.files.length || 1;
    lines.push({ marker: "*", markerColor: "gray", textColor: "gray", text: `${change.status === "applied" ? "Edited" : "Editing"} ${fileCount} file${fileCount === 1 ? "" : "s"} (ctrl+o to expand)` });
  }
  for (const item of permissions) {
    lines.push({ marker: item.blocked ? "!" : "*", markerColor: item.blocked ? "red" : "yellow", textColor: item.blocked ? "red" : "yellow", text: item.blocked ? `Permission blocked: ${item.text}` : `Permission required: ${item.text}` });
  }
  const latestThinking = thinking.at(-1);
  if (latestThinking && state?.running) {
    lines.push({ marker: "*", markerColor: "#ff7a45", textColor: "#ff7a45", text: thinkingText(thinking.map((item) => item.text).join("\n"), state) });
  }
  if (expanded) {
    for (const detail of asciiActivityDetails(items)) {
      lines.push({ marker: " ", markerColor: "gray", textColor: "gray", text: detail });
    }
  }
  if (!expanded && lines.length === 0) return [];
  if (lines.length === 0) return [{ marker: "*", markerColor: "gray", textColor: "gray", text: asciiActivitySummary(items) }];
  return lines;
}

function compactToolRequests(toolRequests: Array<Extract<TimelineItem, { kind: "tool_request" }>>, items: TimelineItem[]): ClaudeActivityLine[] {
  const grouped = new Map<string, { request: Extract<TimelineItem, { kind: "tool_request" }>; unitCount: number }>();
  for (const request of toolRequests) {
    const key = toolActivityKey(request);
    const existing = grouped.get(key);
    if (existing) {
      existing.unitCount = Math.max(existing.unitCount, toolUnitCount(request));
    } else {
      grouped.set(key, { request, unitCount: toolUnitCount(request) });
    }
  }

  const byKind = new Map<string, { request: Extract<TimelineItem, { kind: "tool_request" }>; unitCount: number }>();
  for (const groupedRequest of grouped.values()) {
    const kind = toolActivityKind(groupedRequest.request);
    const existing = byKind.get(kind);
    if (existing) {
      existing.unitCount += groupedRequest.unitCount;
    } else {
      byKind.set(kind, groupedRequest);
    }
  }

  return Array.from(byKind.values()).map((entry) => toolActivityLine(entry.request, items, entry.unitCount));
}

function compactCodeChanges(codeChanges: Array<Extract<TimelineItem, { kind: "code_change" }>>): Array<Extract<TimelineItem, { kind: "code_change" }>> {
  const grouped = new Map<string, Extract<TimelineItem, { kind: "code_change" }>>();
  for (const change of codeChanges) {
    const key = `${change.status}:${change.files.slice().sort().join("|") || change.summary}`;
    if (!grouped.has(key)) grouped.set(key, change);
  }
  return Array.from(grouped.values());
}

function toolActivityKey(request: Extract<TimelineItem, { kind: "tool_request" }>): string {
  return `${request.tool}:${toolTarget(request.tool, request.input) || JSON.stringify(request.input)}`;
}

function toolActivityKind(request: Extract<TimelineItem, { kind: "tool_request" }>): string {
  if (request.tool === "run_command") return "command";
  if (isExplorationTool(request.tool)) return "explore";
  return request.tool;
}

function toolActivityLine(request: Extract<TimelineItem, { kind: "tool_request" }>, items: TimelineItem[], unitCount = toolUnitCount(request)): ClaudeActivityLine {
  const completed = items.some((item) => item.kind === "tool_result" && item.tool === request.tool && item.turn === request.turn);
  const count = Math.max(1, unitCount);
  const plural = count === 1 ? "" : "s";
  if (request.tool === "run_command") {
    return { marker: "*", markerColor: "gray", textColor: "gray", text: `${completed ? "Ran" : "Running"} command (ctrl+o to expand)` };
  }
  if (isExplorationTool(request.tool)) {
    const verb = completed ? "Read" : "Reading";
    const suffix = completed ? "" : "...";
    return { marker: "*", markerColor: "gray", textColor: "gray", text: `${verb} ${count} file${plural}${suffix} (ctrl+o to expand)` };
  }
  return { marker: "*", markerColor: "gray", textColor: "gray", text: `${completed ? "Used" : "Using"} ${request.tool} (ctrl+o to expand)` };
}

function toolUnitCount(request: Extract<TimelineItem, { kind: "tool_request" }>): number {
  if (request.tool === "read_many_files" && Array.isArray(request.input.paths)) return Math.max(1, request.input.paths.length);
  if (typeof request.input.path === "string" || typeof request.input.query === "string") return 1;
  return 1;
}

function thinkingText(thought: string, state?: ActivityDisplayState): string {
  const thoughtTokens = state?.thoughtTokens || estimateTextTokens(thought);
  const outputTokens = state?.outputTokens ?? 0;
  const tokenText = outputTokens > 0 ? `down ${outputTokens} tokens` : `${thoughtTokens} thought tokens`;
  const elapsedText = typeof state?.elapsedSeconds === "number" && state.elapsedSeconds > 0 ? ` | thought for ${Math.max(1, state.elapsedSeconds)}s` : "";
  return `Thinking... (${tokenText}${elapsedText})`;
}

function asciiActivitySummary(items: TimelineItem[]): string {
  let explored = 0;
  let commands = 0;
  let edits = 0;
  let approvals = 0;

  for (const item of items) {
    if (item.kind === "tool_request") {
      if (item.tool === "run_command") commands += 1;
      else if (isExplorationTool(item.tool)) explored += 1;
    } else if (item.kind === "code_change") {
      edits += 1;
    } else if (item.kind === "permission") {
      approvals += 1;
    }
  }

  const parts: string[] = [];
  if (explored > 0) parts.push(`inspected ${explored}`);
  if (commands > 0) parts.push(`ran ${commands} command${commands === 1 ? "" : "s"}`);
  if (edits > 0) parts.push(`edited ${edits}`);
  if (approvals > 0) parts.push(`requested ${approvals} approval${approvals === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(" | ") : `processed ${items.length} event${items.length === 1 ? "" : "s"}`;
}

function asciiActivityDetails(items: TimelineItem[]): string[] {
  const details: string[] = [];
  for (const item of items) {
    if (item.kind === "thinking") {
      details.push(`thinking ${truncateEnd(item.text.replace(/\s+/g, " "), 120)}`);
    } else if (item.kind === "tool_request") {
      details.push(`called ${toolRequestLabel(item)}`);
    } else if (item.kind === "tool_result") {
      const output = firstLine(item.output);
      details.push(`${item.status} ${item.tool}${item.metadata ? metadataSummary(item.metadata) : ""}${output ? ` - ${truncateEnd(output, 100)}` : ""}`);
    } else if (item.kind === "code_change") {
      details.push(`${item.status} ${item.summary}`);
    } else if (item.kind === "permission") {
      details.push(`${item.blocked ? "blocked" : "permission"} ${truncateEnd(item.text.replace(/\s+/g, " "), 120)}`);
    }
  }
  return details;
}

function isExplorationTool(tool: string): boolean {
  return ["read_file", "read_many_files", "read_tree", "show_file_outline", "search", "list_files", "git_diff", "list_changed_files"].includes(tool);
}

function looksLikeInternalPayload(text: string): boolean {
  const raw = text.trim();
  if (looksLikeDecisionJson(raw)) return true;
  if (/^\s*{[\s\S]*"(action|tool|tool_calls|tool_call_id|mcp|server|resources|prompts|input|schema|answer)"\s*:/.test(raw)) return true;
  const normalized = normalizeDisplayMarkdown(text).trim();
  if (!normalized) return false;
  if (looksLikeDecisionJson(normalized)) return true;
  if (/^\s*{[\s\S]*"(action|tool|tool_calls|tool_call_id|mcp|server|resources|prompts|input|schema)"\s*:/.test(normalized)) return true;
  if (/^\s*\[[\s\S]*"(type|tool|server|resource|prompt)"\s*:/.test(normalized)) return true;
  if (/\\n\s*[-*]\s+\*\*(Tool Calling|MCP|Skill|核心能力)/.test(text)) return true;
  return false;
}

export function planSummaryRows(plan: PlanRecord): PlanSummaryRow[] {
  return [
    { label: "id", value: plan.id },
    { label: "status", value: plan.status },
    { label: "model", value: plan.model },
    { label: "files", value: plan.files.length ? plan.files.slice(0, 3).join(", ") : "none listed" },
    { label: "steps", value: String(plan.steps.length) },
    { label: "validation", value: plan.validations.length ? plan.validations.slice(0, 2).join("; ") : "none listed" },
    { label: "risks", value: plan.risks.length ? plan.risks.slice(0, 2).join("; ") : "none listed" },
    { label: "acceptance", value: plan.acceptanceCriteria.length ? plan.acceptanceCriteria.slice(0, 2).join("; ") : "none listed" },
    { label: "inspection", value: plan.statusReason === "limited inspection" ? "limited inspection" : `${plan.inspectionEvents.length} events` }
  ];
}

function planDetailBody(plan: PlanRecord, expanded: boolean): string {
  const meta = [
    `id: ${plan.id}`,
    `status: ${plan.status}${plan.statusReason ? ` (${plan.statusReason})` : ""}`,
    `model: ${plan.model}`,
    `request: ${plan.request}`,
    `inspection: ${plan.inspectionEvents.length ? `${plan.inspectionEvents.length} events` : "limited inspection"}`
  ].join("\n");
  const inspection = plan.inspectionEvents.length ? `\n\nInspection events:\n${plan.inspectionEvents.map((event) => `- ${event}`).join("\n")}` : "";
  return `${meta}\n\n${outputPreview(plan.answer, expanded)}${expanded ? inspection : ""}`;
}

export function outputPreview(output: string, expanded: boolean): string {
  const maxChars = expanded ? 4000 : 700;
  const maxLines = expanded ? 80 : 8;
  const clippedLines = output.split(/\r?\n/).slice(0, maxLines).join("\n");
  const clipped = clippedLines.length > maxChars ? clippedLines.slice(0, maxChars) : clippedLines;
  if (clipped.length < output.length || clippedLines.length < output.length) return `${clipped}\n[truncated, type /expand or press ctrl+o]`;
  return clipped || "[no output]";
}

export function markdownPreview(markdown: string, expanded: boolean): MarkdownLine[] {
  const preview = outputPreview(normalizeDisplayMarkdown(markdown), expanded);
  return parseMarkdown(preview);
}

export function parseMarkdown(markdown: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let inCode = false;
  let language = "";
  for (const sourceLine of normalizeDisplayMarkdown(markdown).replace(/\t/g, "  ").split(/\r?\n/)) {
    const rawLine = sourceLine.replace(/^\s{1,3}(?=(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?))/, "");
    const fence = rawLine.match(/^\s*```([\w-]*)\s*$/);
    if (fence) {
      inCode = !inCode;
      language = inCode ? fence[1] ?? "" : "";
      lines.push({ kind: "code", text: inCode ? `\`\`\`${language}` : "```", language });
      continue;
    }
    if (inCode) {
      lines.push({ kind: "code", text: rawLine, language });
      continue;
    }
    if (!rawLine.trim()) {
      lines.push({ kind: "blank", text: "" });
      continue;
    }
    const heading = rawLine.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      lines.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(rawLine)) {
      lines.push({ kind: "hr", text: "-".repeat(48) });
      continue;
    }
    const task = rawLine.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (task) {
      lines.push({ kind: "task", level: indentLevel(task[1]), checked: task[2].toLowerCase() === "x", text: task[3] });
      continue;
    }
    const bullet = rawLine.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bullet) {
      lines.push({ kind: "bullet", level: indentLevel(bullet[1]), text: bullet[2] });
      continue;
    }
    const ordered = rawLine.match(/^(\s*)(\d+[.)])\s+(.+)$/);
    if (ordered) {
      lines.push({ kind: "ordered", level: indentLevel(ordered[1]), text: `${ordered[2]} ${ordered[3]}` });
      continue;
    }
    const quote = rawLine.match(/^\s*>\s?(.+)$/);
    if (quote) {
      lines.push({ kind: "quote", text: quote[1] });
      continue;
    }
    lines.push({ kind: "paragraph", text: rawLine.trimEnd() });
  }
  return lines.length > 0 ? lines : [{ kind: "paragraph", text: "[no output]" }];
}

export function tokenizeCodeLine(text: string, language = ""): CodeToken[] {
  if (!/^(json|jsonc|js|javascript|ts|typescript)?$/i.test(language)) return [{ kind: "plain", text }];
  const tokens: CodeToken[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === '"' || char === "'") {
      const { value, end } = readQuoted(text, index, char);
      const rest = text.slice(end).trimStart();
      tokens.push({ kind: rest.startsWith(":") ? "key" : "string", text: value });
      index = end;
      continue;
    }
    const number = text.slice(index).match(/^-?\d+(?:\.\d+)?/);
    if (number) {
      tokens.push({ kind: "number", text: number[0] });
      index += number[0].length;
      continue;
    }
    const word = text.slice(index).match(/^(true|false|null)\b/);
    if (word) {
      tokens.push({ kind: word[0] === "null" ? "null" : "boolean", text: word[0] });
      index += word[0].length;
      continue;
    }
    if (/^[{}\[\]():,]$/.test(char)) {
      tokens.push({ kind: "punctuation", text: char });
      index += 1;
      continue;
    }
    const whitespace = text.slice(index).match(/^\s+/)?.[0];
    if (whitespace) {
      tokens.push({ kind: "plain", text: whitespace });
      index += whitespace.length;
      continue;
    }
    const plain = text.slice(index).match(/^[^"'\s{}\[\]():,\d]+/)?.[0] ?? char;
    tokens.push({ kind: "plain", text: plain });
    index += plain.length;
  }
  return mergePlainTokens(tokens);
}

function readQuoted(text: string, start: number, quote: string): { value: string; end: number } {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === quote) return { value: text.slice(start, index + 1), end: index + 1 };
    index += 1;
  }
  return { value: text.slice(start), end: text.length };
}

function mergePlainTokens(tokens: CodeToken[]): CodeToken[] {
  const merged: CodeToken[] = [];
  for (const token of tokens) {
    const previous = merged.at(-1);
    if (previous?.kind === "plain" && token.kind === "plain") previous.text += token.text;
    else merged.push({ ...token });
  }
  return merged;
}

function indentLevel(value: string): number {
  return Math.min(4, Math.floor(value.length / 2));
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim() ?? value.trim();
}

export function approvalRows(approval: PendingApproval): Array<{ label: string; value: string }> {
  const detailRows = approval.requirement.details ?? [];
  const rows = [
    { label: "risk", value: approval.requirement.risk },
    { label: "tool", value: approval.tool },
    { label: "action", value: approval.description },
    { label: "scope", value: approval.requirement.scope ?? "" },
    { label: "approvalKey", value: approval.requirement.approvalKey ?? approval.requirement.allowAlwaysKey ?? "" },
    { label: "riskReason", value: approval.requirement.riskReason ?? "" },
    { label: "remember", value: approval.requirement.rememberable === false ? "no" : approval.requirement.rememberable ? "yes" : "" },
    ...detailRows
  ];
  return dedupeRows(rows).map((row) => ({ label: row.label, value: truncateEnd(row.value, 120) }));
}

export function approvalCardRows(approval: PendingApproval): ApprovalCardRow[] {
  const rows = approvalRows(approval);
  const value = (label: string) => rows.find((row) => row.label === label)?.value ?? "";
  const rememberPolicy = value("rememberPolicy") || (approval.requirement.rememberable === false ? "never" : approval.requirement.rememberable ? "available" : "not offered");
  const command = value("command") || (typeof approval.input.command === "string" ? approval.input.command : "");
  const target = value("target");
  const scope = approval.requirement.scope ?? value("scope");
  return [
    { label: "risk", value: approval.requirement.risk, tone: approval.requirement.risk === "dangerous" || approval.requirement.blocked ? "danger" : "warning" },
    { label: "scope", value: scope || "[none]", tone: "normal" },
    { label: "reason", value: approval.requirement.reason, tone: approval.requirement.blocked ? "danger" : "normal" },
    { label: "remember", value: rememberPolicy, tone: approval.requirement.rememberable === false ? "muted" : "accent" },
    { label: "command", value: command || target || "[not a command]", tone: command ? "accent" : "muted" },
    { label: "path", value: target && target !== command ? target : value("cwd") || "[workspace]", tone: "muted" }
  ];
}

export function decisionText(decision: ApprovalDecision): string {
  if (decision === "allow_once") return "allowed once";
  if (decision === "always_allow") return "always allowed for this session";
  return "denied";
}

export function truncateEnd(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return `${value.slice(0, max - 3)}...`;
}

export function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 5) return truncateEnd(value, max);
  const left = Math.ceil((max - 3) / 2);
  const right = Math.floor((max - 3) / 2);
  return `${value.slice(0, left)}...${value.slice(value.length - right)}`;
}

function shortPath(value: string, max: number): string {
  const home = process.env.HOME;
  const display = home && value.startsWith(home) ? `~${value.slice(home.length)}` : value;
  if (display.length <= max) return display;
  const base = path.basename(display);
  return truncateMiddle(base.length < max - 4 ? display : base, max);
}

export function blockedApprovalText(approval: PendingApproval): string {
  if (approval.requirement.blocked || approval.requirement.denied) return "Blocked. Change the request or restart with --allow-dangerous when appropriate.";
  if (approval.requirement.rememberable === false) return "[y] allow once  [n] deny";
  const scopeType = approval.requirement.details?.find((detail) => detail.label === "scopeType")?.value ?? "scope";
  return `[y] allow once  [n] deny  [a] always allow this ${scopeType}`;
}

function toolStatus(ok: boolean, output: string, errorType?: ToolErrorType): "ok" | "failed" | "denied" | "blocked" | "validation_error" {
  if (ok) return "ok";
  if (errorType === "validation") return "validation_error";
  if (errorType === "permission_denied") return "denied";
  if (errorType === "permission_blocked") return "blocked";
  if (/User denied permission/i.test(output)) return "denied";
  if (/blocked unless --allow-dangerous/i.test(output)) return "blocked";
  return "failed";
}

function toolResultColor(status: "ok" | "failed" | "denied" | "blocked" | "validation_error"): string {
  if (status === "ok") return "green";
  if (status === "denied" || status === "validation_error") return "yellow";
  return "red";
}

function toolResultSeverity(status: "ok" | "failed" | "denied" | "blocked" | "validation_error"): TimelineSeverity {
  if (status === "ok") return "success";
  if (status === "denied" || status === "validation_error") return "warning";
  return "danger";
}

function looksLikeDecisionJson(text: string): boolean {
  const jsonText = firstJsonObject(text.trim());
  if (!jsonText) return false;
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    return isObject(parsed) && (typeof parsed.action === "string" || typeof parsed.answer === "string");
  } catch {
    return /^\s*\{/.test(text) && /"action"\s*:/.test(text);
  }
}

function firstJsonObject(value: string): string | undefined {
  const start = value.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metadataFiles(metadata: ToolMetadata): string[] | undefined {
  const paths = metadata.touchedPaths ?? metadata.files ?? metadata.path;
  if (Array.isArray(paths)) return paths.map(String).filter(Boolean);
  if (typeof paths === "string" && paths.trim()) return [paths];
  return undefined;
}

function diffCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function diffLineColor(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "green";
  if (line.startsWith("-") && !line.startsWith("---")) return "red";
  if (line.startsWith("@@")) return "cyan";
  if (line.startsWith("+++") || line.startsWith("---")) return "gray";
  return "gray";
}

function toolTarget(tool: string, input: Record<string, unknown>): string {
  if (tool === "run_command" && typeof input.command === "string") return truncateEnd(input.command, 90);
  if ((tool === "read_file" || tool === "write_file" || tool === "create_file" || tool === "replace_text" || tool === "git_diff") && typeof input.path === "string") {
    return input.path;
  }
  if (tool === "read_many_files" && Array.isArray(input.paths)) return input.paths.map(String).join(", ");
  if ((tool === "read_tree" || tool === "show_file_outline") && typeof input.path === "string") return input.path;
  if (tool === "search" && typeof input.query === "string") return JSON.stringify(input.query);
  if (tool === "list_files" && typeof input.path === "string") return input.path;
  if ((tool === "apply_patch" || tool === "git_apply_check") && typeof input.patch === "string") return patchFiles(input.patch);
  if (tool === "create_skill" && typeof input.name === "string") return input.name;
  if (tool === "list_changed_files") return "changed files";
  return "";
}

function metadataSummary(metadata: ToolMetadata): string {
  const pathValue = metadata.path ?? metadata.command ?? metadata.files ?? metadata.touchedPaths;
  if (Array.isArray(pathValue)) return pathValue.length ? ` ${truncateEnd(pathValue.join(", "), 80)}` : "";
  if (typeof pathValue === "string") return ` ${truncateEnd(pathValue, 80)}`;
  return "";
}

function patchFiles(patch: string): string {
  const files = patchFilesList(patch);
  return files.length > 0 ? truncateEnd(files.join(", "), 90) : "patch";
}

function patchFilesList(patch: string): string[] {
  const files = patch
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+++ "))
    .map((line) => line.slice(4).trim().replace(/^[ab]\//, ""))
    .filter((file) => file !== "/dev/null");
  return files;
}

function dedupeRows(rows: Array<{ label: string; value: string }>): Array<{ label: string; value: string }> {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.label}:${row.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return row.value !== "";
  });
}


export const asciiArt: string[] = [
  "    ____    ",
  "  _|    |_  ",
  " |  [] [] | ",
  " |   __   | ",
  "  |_|  |_|  "
];
export const welcomeTips = {
  gettingStarted: {
    title: "Tips for getting started",
    items: [
      "Run /init to create a CLAUDE.md file with instructions",
    ],
  },
  whatsNew: {
    title: "What's new",
    items: releaseNoteHighlights(4),
  },
};

export interface CommandEntry {
  command: string;
  description: string;
}

export interface SkillPickerRow {
  skill: SkillInfo;
  status: "on" | "off";
  name: string;
  source: string;
  tokens: number;
  detail: string;
}

export const commandDescriptions: Record<string, string> = {
  "/help": "Show all available commands",
  "/status": "Show session status and configuration",
  "/cost": "Show estimated session token usage",
  "/bug": "Prepare a diagnostic bug report",
  "/release-notes": "Show Mini Code release notes",
  "/output-style": "Show active response style",
  "/output-style list": "List built-in and custom response styles",
  "/output-style set": "Persist and activate an output style",
  "/output-style create": "Create and activate a project output style",
  "/model": "Show active provider, model, plan model, and tool protocol",
  "/config": "Show resolved Mini Code configuration",
  "/config list": "Show project config file values",
  "/config get": "Show one project config value",
  "/config set": "Persist one project config value",
  "/config unset": "Remove one project config value",
  "/doctor": "Run local configuration diagnostics",
  "/features": "Show enabled FEATURE_* flags",
  "/login": "Show provider auth setup guidance",
  "/memory": "Show loaded CLAUDE.md project memory",
  "/memory list": "List user, project, and local memory files",
  "/memory add": "Append a note to project, local, or user memory",
  "/memory reload": "Reload memory into the active system prompt",
  "/init": "Generate CLAUDE.md by analysing this repository",
  "/sessions": "List all saved sessions",
  "/continue": "Resume the most recently updated session",
  "/session": "Show the current session id and metadata",
  "/new": "Start a new session",
  "/resume": "List sessions, or resume a previous session by ID",
  "/fork": "Copy a previous session into a new session",
  "/name": "Rename the current session",
  "/rename": "Rename the current session",
  "/export-session": "Export session history to a file",
  "/import-session": "Import session history from a JSON file",
  "/delete-session": "Delete a saved session by id",
  "/plan": "Create a step-by-step plan before coding",
  "/execute": "Execute a previously created plan",
  "/todos": "Show the latest task todo list",
  "/tasks": "Show recent session tasks",
  "/review": "Review code and report findings",
  "/tools": "List all available tools",
  "/permissions": "Show current permission settings",
  "/permissions allow": "Add a project allow rule",
  "/permissions deny": "Add a project deny rule",
  "/permissions remove": "Remove a project permission rule",
  "/permissions reload": "Reload permission settings",
  "/hooks": "List configured tool and prompt hooks",
  "/hooks reload": "Reload hooks from settings files without restarting",
  "/commands": "List project and user custom slash commands",
  "/commands reload": "Rediscover custom slash commands without restarting",
  "/agents": "List discovered project and user subagents",
  "/agents reload": "Rediscover subagents without restarting",
  "/agent inspect": "Inspect a subagent manifest",
  "/agent create": "Create a project subagent",
  "/agent:": "Run a foreground subagent",
  "/skills": "List discovered project skills",
  "/queue": "Show queued requests",
  "/queue clear": "Clear queued requests",
  "/skill inspect": "Inspect one skill or duplicate candidates",
  "/skill create": "Create a project skill under .mini-code/skills",
  "/skill reload": "Rediscover skills without restarting",
  "/skill:": "Run a named skill with optional args",
  "/mcp": "Show configured MCP servers",
  "/mcp tools": "Show MCP tools",
  "/mcp resources": "Show MCP resources",
  "/mcp prompts": "Show MCP prompts",
  "/mcp reconnect": "Reconnect one MCP server",
  "/capabilities": "Show the unified capability snapshot",
  "/details": "Toggle the detailed view panel on/off",
  "/expand": "Toggle expanded diff output",
  "/history": "Toggle extended history view",
  "/clear": "Clear the conversation display",
  "/compact": "Summarize and compact context history",
  "/summary": "Show current context summary",
  "/exit": "Exit Mini Code Agent",
};

export function filterCommandsAndSkills(prefix: string, skills: SkillInfo[], customCommands: CustomCommandInfo[] = []): CommandEntry[] {
  const query = prefix.toLowerCase();
  const cmdEntries = commandGroups.flatMap((group) => group.commands.map((command) => commandEntry(command)));
  const customEntries = customCommands.map((command) => ({
    command: `/${command.name}`,
    description: `custom ${command.source} - ${command.description}`
  }));
  const skillEntries = skills.flatMap((skill) => {
    const status = skill.shadowedBy ? "shadowed" : skill.disableModelInvocation ? "disabled" : "default";
    const source = skill.source ?? "project";
    const description = `${status} ${source}:${skill.id} - ${skill.description}`;
    const entries: CommandEntry[] = [{ command: `/skill:${skill.name}`, description }];
    if (skill.id !== skill.name) entries.push({ command: `/skill:${skill.id}`, description });
    return entries;
  });
  const all = [...cmdEntries, ...customEntries, ...skillEntries];
  if (query === "/") return all.slice(0, 12);
  return all
    .filter((entry) => commandMatches(entry.command, query))
    .sort((left, right) => {
      const leftExact = normalizeCommandTemplate(left.command).toLowerCase() === query ? 0 : 1;
      const rightExact = normalizeCommandTemplate(right.command).toLowerCase() === query ? 0 : 1;
      if (leftExact !== rightExact) return leftExact - rightExact;
      const leftSkill = left.command.startsWith("/skill:") ? 1 : 0;
      const rightSkill = right.command.startsWith("/skill:") ? 1 : 0;
      if (leftSkill !== rightSkill) return leftSkill - rightSkill;
      const leftCustom = customEntries.some((entry) => entry.command === left.command) ? 1 : 0;
      const rightCustom = customEntries.some((entry) => entry.command === right.command) ? 1 : 0;
      if (leftCustom !== rightCustom) return rightCustom - leftCustom;
      if (leftSkill && rightSkill) {
        const leftExactSkillId = left.command.slice("/skill:".length).includes(":") ? 1 : 0;
        const rightExactSkillId = right.command.slice("/skill:".length).includes(":") ? 1 : 0;
        if (leftExactSkillId !== rightExactSkillId) return leftExactSkillId - rightExactSkillId;
      }
      const leftRank = commandRank.get(left.command) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = commandRank.get(right.command) ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      if (left.command === "/skills" && right.command !== "/skills") return -1;
      if (right.command === "/skills" && left.command !== "/skills") return 1;
      return commandSortKey(left.command).localeCompare(commandSortKey(right.command));
    })
    .slice(0, 12);
}

export function skillPickerRows(skills: SkillInfo[], query: string): SkillPickerRow[] {
  const normalized = query.trim().toLowerCase();
  return skills
    .map((skill) => {
      const source = skill.source === "global" ? "user" : skill.source ?? "project";
      const duplicateDetail = skill.shadowedBy ? `shadowed by ${skill.shadowedBy}` : skill.id !== `${source}:${skill.name}` ? skill.id : "";
      return {
        skill,
        status: skill.disableModelInvocation ? "off" as const : "on" as const,
        name: skill.name,
        source,
        tokens: estimateSkillTokens(skill),
        detail: duplicateDetail
      };
    })
    .filter((row) => {
      if (!normalized) return true;
      return [row.name, row.source, row.skill.id, row.skill.description, row.detail].some((value) => value.toLowerCase().includes(normalized));
    })
    .sort((left, right) => {
      const leftDefault = left.skill.shadowedBy ? 1 : 0;
      const rightDefault = right.skill.shadowedBy ? 1 : 0;
      if (leftDefault !== rightDefault) return leftDefault - rightDefault;
      return left.name.localeCompare(right.name) || left.skill.id.localeCompare(right.skill.id);
    });
}

function estimateSkillTokens(skill: SkillInfo): number {
  const text = [skill.description, skill.content].filter(Boolean).join(" ");
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return Math.max(10, Math.round(words * 1.3 / 10) * 10);
}

function commandEntry(command: string): CommandEntry {
  const key = commandKey(command);
  return { command, description: commandDescriptions[key] ?? "" };
}

function commandMatches(command: string, query: string): boolean {
  const normalized = normalizeCommandTemplate(command).toLowerCase();
  const compact = commandKey(command).toLowerCase();
  return normalized.startsWith(query) || compact.startsWith(query);
}

function commandKey(command: string): string {
  if (command.startsWith("/skill:")) return "/skill:";
  if (command.startsWith("/agent:")) return "/agent:";
  return command.replace(/\s+<.*$/, "").replace(/\s+\[.*$/, "").replace(/\s+\(.+$/, "");
}

function normalizeCommandTemplate(command: string): string {
  return command.replace(/\s+<[^>]+>/g, "").replace(/\s+\[[^\]]+\]/g, "");
}

function commandSortKey(command: string): string {
  return command.replace(/\s+/g, "~");
}
