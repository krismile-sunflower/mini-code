import path from "node:path";
import type { AgentConfig, AgentEvent, ApprovalDecision, ModelStreamEvent, PendingApproval, PermissionMode, SkillInfo, TaskTodo, ToolErrorType, ToolMetadata } from "../core/types.js";

export type TimelineKind = "user" | "assistant_text" | "plan" | "thinking" | "tool_request" | "permission" | "code_change" | "tool_result" | "final" | "error" | "session" | "compact";
export type TimelineSeverity = "muted" | "neutral" | "active" | "success" | "warning" | "danger";
export type DetailType = "message" | "plan" | "tool" | "code_change" | "permission" | "final" | "error" | "session" | "compact" | "thinking";
export type CodeChangeStatus = "planned" | "checked" | "applied";

export type TimelineItem =
  | { kind: "user"; text: string }
  | { kind: "assistant_text"; text: string }
  | { kind: "plan"; turn: number; todos: TaskTodo[] }
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
  if (item.kind === "assistant_text") return { marker: "assistant", color: "cyan", text: truncateEnd(item.text, 180), severity: "neutral" };
  if (item.kind === "plan") return { marker: "plan", color: "cyan", text: `${item.todos.filter((todo) => todo.status === "completed").length}/${item.todos.length} done`, severity: "active" };
  if (item.kind === "thinking") return { marker: "think", color: "gray", text: truncateEnd(item.text, 120), severity: "muted" };
  if (item.kind === "tool_request") return { marker: "tool", color: "blue", text: toolRequestLabel(item), severity: "active" };
  if (item.kind === "code_change") return { marker: "edit", color: item.status === "checked" ? "cyan" : "yellow", text: item.summary, severity: "active" };
  if (item.kind === "tool_result") return { marker: item.status, color: toolResultColor(item.status), text: `${item.tool}${item.metadata ? metadataSummary(item.metadata) : ""}`, severity: toolResultSeverity(item.status) };
  if (item.kind === "permission") return { marker: item.blocked ? "blocked" : "perm", color: item.blocked || item.risk === "dangerous" ? "red" : "yellow", text: item.text, severity: item.blocked || item.risk === "dangerous" ? "danger" : "warning" };
  if (item.kind === "compact") return { marker: "summary", color: "magenta", text: "context compacted", severity: "muted" };
  if (item.kind === "final") return { marker: "done", color: "green", text: truncateEnd(item.text, 180), severity: "success" };
  if (item.kind === "session") return { marker: "session", color: "cyan", text: truncateEnd(item.text, 180), severity: "neutral" };
  return { marker: item.category ? `err:${item.category}` : "error", color: "red", text: item.text, severity: "danger" };
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

export function outputPreview(output: string, expanded: boolean): string {
  const maxChars = expanded ? 4000 : 700;
  const maxLines = expanded ? 80 : 8;
  const clippedLines = output.split(/\r?\n/).slice(0, maxLines).join("\n");
  const clipped = clippedLines.length > maxChars ? clippedLines.slice(0, maxChars) : clippedLines;
  if (clipped.length < output.length || clippedLines.length < output.length) return `${clipped}\n[truncated, type /expand]`;
  return clipped || "[no output]";
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
  return "[y] allow once  [n] deny  [a] always allow this exact scope";
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
  "  ╭───────────╮  ",
  "  │  ◉     ◉  │  ",
  "  │    ─────  │  ",
  "  ╰─────┬─────╯  ",
  "   ╔════╧════╗   ",
  "   ║         ║   ",
  "   ╚═════════╝   ",
];

export const welcomeTips = {
  gettingStarted: {
    title: "Tips for getting started",
    items: [
      "Ask a question or describe a coding task",
      "Run /help to see all available commands",
      "Use /skills to list available project skills",
      "Press Shift+Tab to cycle permission mode",
      "Use /plan <request> to plan before executing",
    ],
  },
  whatsNew: {
    title: "What's new",
    items: [
      "Check README.md for the latest updates",
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
  return all.filter((entry) => entry.command.startsWith(query)).slice(0, 12);
}
