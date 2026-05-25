import path from "node:path";
import type { AgentConfig, AgentEvent, ApprovalDecision, ModelStreamEvent, PendingApproval, PermissionMode, PlanRecord, SkillInfo, TaskTodo, ToolErrorType, ToolMetadata } from "../core/types.js";

export type TimelineKind = "user" | "assistant_text" | "plan" | "plan_record" | "thinking" | "tool_request" | "permission" | "code_change" | "tool_result" | "final" | "error" | "session" | "compact";
export type TimelineSeverity = "muted" | "neutral" | "active" | "success" | "warning" | "danger";
export type DetailType = "message" | "plan" | "tool" | "code_change" | "permission" | "final" | "error" | "session" | "compact" | "thinking";
export type CodeChangeStatus = "planned" | "checked" | "applied";

export type TimelineItem =
  | { kind: "user"; text: string }
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

export interface PlanSummaryRow {
  label: string;
  value: string;
}

export type MarkdownLineKind = "heading" | "paragraph" | "bullet" | "ordered" | "task" | "quote" | "code" | "hr" | "blank";

export interface MarkdownLine {
  kind: MarkdownLineKind;
  text: string;
  level?: number;
  checked?: boolean;
  language?: string;
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
  { title: "Session", commands: ["/help", "/status", "/memory", "/init", "/sessions", "/new", "/resume <id>", "/rename <title>", "/export-session <path>"] },
  { title: "Work", commands: ["/plan <request>", "/execute <plan-id>", "/tools", "/permissions", "/skills", "/skill:<name> <args>"] },
  { title: "View", commands: ["/details", "/expand", "/history", "/clear"] },
  { title: "Context", commands: ["/compact", "/summary"] },
  { title: "Config", commands: ["/model (configure with --model)", "/pi (use --pi-pass-through -- ...)"] },
  { title: "Exit", commands: ["/exit"] }
];

export const slashCommands = commandGroups.flatMap((group) => group.commands);

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
  if (event.type === "final") return [{ kind: "final", text: event.answer }];
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
  if (text && !looksLikeDecisionJson(text)) items.push({ kind: "assistant_text", text });
  return items;
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
      lines.push({ text: "[diff truncated, type /expand]", color: "gray" });
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
    blocks.push({
      kind: "activity",
      summary: activitySummary(activity),
      details: expanded ? activityDetails(activity) : [],
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
    blocks.push({ kind: "message", item, markdown: timelineMarkdownLines(item, expanded) });
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

function activitySummary(items: TimelineItem[]): string {
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
  if (explored > 0) parts.push(`已探索 ${explored} 次`);
  if (commands > 0) parts.push(`已运行 ${commands} 条命令`);
  if (edits > 0) parts.push(`已编辑 ${edits} 处`);
  if (approvals > 0) parts.push(`需批准 ${approvals} 项`);
  return parts.length > 0 ? parts.join("，") : `已处理 ${items.length} 项活动`;
}

function activityDetails(items: TimelineItem[]): string[] {
  const details: string[] = [];
  for (const item of items) {
    if (item.kind === "thinking") {
      details.push(`思考 ${truncateEnd(item.text.replace(/\s+/g, " "), 120)}`);
    } else if (item.kind === "tool_request") {
      details.push(`调用 ${toolRequestLabel(item)}`);
    } else if (item.kind === "tool_result") {
      const output = firstLine(item.output);
      details.push(`${item.status} ${item.tool}${item.metadata ? metadataSummary(item.metadata) : ""}${output ? ` — ${truncateEnd(output, 100)}` : ""}`);
    } else if (item.kind === "code_change") {
      details.push(`${item.status} ${item.summary}`);
    } else if (item.kind === "permission") {
      details.push(`${item.blocked ? "阻止" : "权限"} ${truncateEnd(item.text.replace(/\s+/g, " "), 120)}`);
    }
  }
  return details;
}

function isExplorationTool(tool: string): boolean {
  return ["read_file", "read_many_files", "read_tree", "show_file_outline", "search", "list_files", "git_diff", "list_changed_files"].includes(tool);
}

export function planSummaryRows(plan: PlanRecord): PlanSummaryRow[] {
  return [
    { label: "id", value: plan.id },
    { label: "status", value: plan.status },
    { label: "model", value: plan.model },
    { label: "files", value: plan.files.length ? plan.files.slice(0, 3).join(", ") : "none listed" },
    { label: "steps", value: String(plan.steps.length) },
    { label: "risks", value: String(plan.risks.length) },
    { label: "accept", value: plan.acceptanceCriteria.length ? plan.acceptanceCriteria.slice(0, 2).join("; ") : "none listed" },
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
  if (clipped.length < output.length || clippedLines.length < output.length) return `${clipped}\n[truncated, type /expand]`;
  return clipped || "[no output]";
}

export function markdownPreview(markdown: string, expanded: boolean): MarkdownLine[] {
  const preview = outputPreview(markdown, expanded);
  return parseMarkdown(preview);
}

export function parseMarkdown(markdown: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let inCode = false;
  let language = "";
  for (const rawLine of markdown.replace(/\t/g, "  ").split(/\r?\n/)) {
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
      lines.push({ kind: "hr", text: "─".repeat(48) });
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
  return /^\s*\{/.test(text) && /"action"\s*:/.test(text);
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

// ── Welcome screen & command completion ──────────────────────────────────────

export const asciiArt: string[] = [
  "   ▄▄▄▄▄   ",
  " ▄███████▄ ",
  "██ ▀█ █▀ ██",
  "██▄▄███▄▄██",
  "  ▀▀ ▀ ▀▀  ",
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
    items: [
      "Check the Mini Code changelog for updates",
    ],
  },
};

export interface CommandEntry {
  command: string;
  description: string;
}

export const commandDescriptions: Record<string, string> = {
  "/help": "Show all available commands",
  "/status": "Show session status and configuration",
  "/memory": "Show loaded CLAUDE.md project memory",
  "/init": "Generate CLAUDE.md by analysing this repository",
  "/sessions": "List all saved sessions",
  "/new": "Start a new session",
  "/resume": "Resume a previous session by ID",
  "/rename": "Rename the current session",
  "/export-session": "Export session history to a file",
  "/plan": "Create a step-by-step plan before coding",
  "/execute": "Execute a previously created plan",
  "/tools": "List all available tools",
  "/permissions": "Show current permission settings",
  "/skills": "List discovered project skills",
  "/skill:": "Run a named skill with optional args",
  "/details": "Toggle the detailed view panel on/off",
  "/expand": "Toggle expanded diff output",
  "/history": "Toggle extended history view",
  "/clear": "Clear the conversation display",
  "/compact": "Summarize and compact context history",
  "/summary": "Show current context summary",
  "/exit": "Exit Mini Code Agent",
};

export function filterCommandsAndSkills(prefix: string, skills: SkillInfo[]): CommandEntry[] {
  const query = prefix.toLowerCase();
  const cmdEntries: CommandEntry[] = Object.entries(commandDescriptions).map(([command, description]) => ({
    command,
    description,
  }));
  const skillEntries: CommandEntry[] = skills.map((skill) => ({
    command: `/skill:${skill.name}`,
    description: skill.description,
  }));
  const all = [...cmdEntries, ...skillEntries];
  if (query === "/") return all.slice(0, 12);
  return all
    .filter((entry) => entry.command.toLowerCase().startsWith(query))
    .sort((left, right) => {
      const leftExact = left.command.toLowerCase() === query ? 0 : 1;
      const rightExact = right.command.toLowerCase() === query ? 0 : 1;
      if (leftExact !== rightExact) return leftExact - rightExact;
      const leftSkill = left.command.startsWith("/skill:") ? 1 : 0;
      const rightSkill = right.command.startsWith("/skill:") ? 1 : 0;
      if (leftSkill !== rightSkill) return leftSkill - rightSkill;
      return left.command.localeCompare(right.command);
    })
    .slice(0, 12);
}
