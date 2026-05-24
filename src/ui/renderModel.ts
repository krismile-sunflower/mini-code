import path from "node:path";
import type { AgentConfig, AgentEvent, ApprovalDecision, PendingApproval, PermissionMode, TaskTodo, ToolErrorType, ToolMetadata } from "../core/types.js";

export type TimelineKind = "user" | "plan" | "thinking" | "tool_request" | "permission" | "tool_result" | "final" | "error" | "session" | "compact";

export type TimelineItem =
  | { kind: "user"; text: string }
  | { kind: "plan"; turn: number; todos: TaskTodo[] }
  | { kind: "thinking"; turn: number; text: string }
  | { kind: "tool_request"; turn: number; tool: string; description: string; input: Record<string, unknown> }
  | { kind: "permission"; tool?: string; text: string; decision?: ApprovalDecision; risk?: string; details?: Array<{ label: string; value: string }>; blocked?: boolean; rememberable?: boolean }
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
  session: string;
  turn: number;
  state: "idle" | "running" | "permission";
  taskStatus?: string;
  permissionMode: PermissionMode;
  messages: number;
  summary: boolean;
}

export interface DetailModel {
  title: string;
  body: string;
  color: string;
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
}): StatusModel {
  return {
    title: "Mini Code Agent",
    cwd: shortPath(input.config.cwd, 40),
    provider: input.config.provider,
    model: input.config.model,
    session: truncateMiddle(input.sessionId, 22),
    turn: input.turn,
    state: input.approval ? "permission" : input.busy ? "running" : "idle",
    permissionMode: input.permissionMode ?? input.config.permissionMode,
    messages: input.messageCount,
    summary: input.hasSummary
  };
}

export const slashCommands = [
  "/help",
  "/status",
  "/tools",
  "/permissions",
  "/skills",
  "/skill:<name> <args>",
  "/model (configure with --model)",
  "/pi (use --pi-pass-through -- ...)",
  "/plan <request>",
  "/execute <plan-id>",
  "/sessions",
  "/new",
  "/resume <id>",
  "/rename <title>",
  "/export-session <path>",
  "/compact",
  "/summary",
  "/expand",
  "/history",
  "/clear",
  "/exit"
];

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

export function eventToTimelineItems(event: AgentEvent): TimelineItem[] {
  if (event.type === "model_response") return [];
  if (event.type === "plan") return [{ kind: "plan", turn: event.turn, todos: event.todos }];
  if (event.type === "error" && event.category === "protocol" && /Asking the model/i.test(event.error)) return [];
  if (event.type === "tool_request") {
    const items: TimelineItem[] = [];
    if (event.thought?.trim()) items.push({ kind: "thinking", turn: event.turn, text: event.thought.trim() });
    items.push({ kind: "tool_request", turn: event.turn, tool: event.tool, description: event.description, input: event.input });
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
    return [{ kind: "tool_result", turn: event.turn, tool: event.tool, ok: event.ok, output: event.output, status: toolStatus(event.ok, event.output, event.errorType), errorType: event.errorType, metadata: event.metadata }];
  }
  if (event.type === "compaction") return [{ kind: "compact", text: event.summary || "[no summary]" }];
  if (event.type === "final") return [{ kind: "final", text: event.answer }];
  return [{ kind: "error", text: event.error, category: event.category }];
}

export function todoLabel(todo: TaskTodo): string {
  const marker = todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[>]" : "[ ]";
  return `${marker} ${todo.content}`;
}

export function toolRequestLabel(item: Extract<TimelineItem, { kind: "tool_request" }>): string {
  const target = toolTarget(item.tool, item.input) || item.description;
  return target ? `${item.tool} ${target}` : item.tool;
}

export function timelineLabel(item: TimelineItem): { marker: string; color: string; text: string } {
  if (item.kind === "user") return { marker: ">", color: "white", text: item.text };
  if (item.kind === "plan") return { marker: "plan", color: "cyan", text: `${item.todos.filter((todo) => todo.status === "completed").length}/${item.todos.length} done` };
  if (item.kind === "thinking") return { marker: "think", color: "magenta", text: truncateEnd(item.text, 120) };
  if (item.kind === "tool_request") return { marker: "tool", color: "blue", text: toolRequestLabel(item) };
  if (item.kind === "tool_result") return { marker: item.status, color: item.ok ? "green" : "red", text: `${item.tool}${item.metadata ? metadataSummary(item.metadata) : ""}` };
  if (item.kind === "permission") return { marker: item.blocked ? "blocked" : "perm", color: item.blocked || item.risk === "dangerous" ? "red" : "yellow", text: item.text };
  if (item.kind === "compact") return { marker: "summary", color: "magenta", text: "context compacted" };
  if (item.kind === "final") return { marker: "done", color: "green", text: truncateEnd(item.text, 180) };
  if (item.kind === "session") return { marker: "session", color: "cyan", text: truncateEnd(item.text, 180) };
  return { marker: item.category ? `err:${item.category}` : "error", color: "red", text: item.text };
}

export function detailForItem(item: TimelineItem | undefined, expanded: boolean): DetailModel | undefined {
  if (!item) return undefined;
  if (item.kind === "tool_request") {
    return { title: `Tool request: ${item.tool}`, color: "blue", body: JSON.stringify(item.input, null, 2) };
  }
  if (item.kind === "tool_result") {
    const metadata = item.metadata ? `\n\nmetadata:\n${JSON.stringify(item.metadata, null, 2)}` : "";
    return { title: `${item.status}: ${item.tool}`, color: item.ok ? "green" : "red", body: `${outputPreview(item.output, expanded)}${metadata}` };
  }
  if (item.kind === "permission") {
    const details = item.details?.map((row) => `${row.label}: ${row.value}`).join("\n") ?? "";
    return { title: item.blocked ? "Permission blocked" : "Permission required", color: item.blocked || item.risk === "dangerous" ? "red" : "yellow", body: [item.text, details].filter(Boolean).join("\n\n") };
  }
  if (item.kind === "plan") return { title: "Plan", color: "cyan", body: item.todos.map(todoLabel).join("\n") };
  if (item.kind === "final") return { title: "Final", color: "green", body: item.text };
  if (item.kind === "error") return { title: item.category ? `Error ${item.category}` : "Error", color: "red", body: errorDetail(item) };
  if (item.kind === "compact") return { title: "Summary", color: "magenta", body: outputPreview(item.text, expanded) };
  if (item.kind === "session") return { title: "Session", color: "cyan", body: outputPreview(item.text, expanded) };
  if (item.kind === "thinking") return { title: "Thinking", color: "magenta", body: item.text };
  return { title: "User", color: "white", body: item.text };
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
  const files = patch
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+++ "))
    .map((line) => line.slice(4).trim().replace(/^[ab]\//, ""))
    .filter((file) => file !== "/dev/null");
  return files.length > 0 ? truncateEnd(files.join(", "), 90) : "patch";
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
