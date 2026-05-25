export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
}

export type ToolRisk = "read" | "write" | "shell" | "dangerous";
export type PermissionMode = "default" | "accept_edits" | "bypass_permissions" | "risk-based";
export type ToolsPolicy = "default" | "read_only";
export type ApprovalDecision = "allow_once" | "deny" | "always_allow";
export type LlmProvider = "openai" | "anthropic";

export type ConfigSource = "cli" | "env" | ".env.local" | ".env" | "config" | "default";

export interface ConfigSources {
  provider: ConfigSource;
  model: ConfigSource;
  planModel: ConfigSource;
  permissionMode: ConfigSource;
  agentDir: ConfigSource;
  sessionDir: ConfigSource;
  toolsPolicy: ConfigSource;
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  content: string;
  allowedTools: string[];
  disableModelInvocation: boolean;
}

export interface AgentConfig {
  cwd: string;
  provider: LlmProvider;
  model: string;
  planModel: string;
  baseUrl: string;
  apiKey: string;
  maxTurns: number;
  allowDangerousCommands: boolean;
  sessionId?: string;
  sessionDir: string;
  agentDir: string;
  permissionMode: PermissionMode;
  toolsPolicy: ToolsPolicy;
  skills: string[];
  enableSkills: boolean;
  maxContextMessages: number;
  maxToolOutputChars: number;
  plain: boolean;
  configSources?: ConfigSources;
}

export interface ToolCall {
  tool: string;
  input?: Record<string, unknown>;
}

export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_delta"; text: string };

export interface ModelResponse {
  provider: LlmProvider;
  model: string;
  raw: string;
  content: string;
  streamEvents?: ModelStreamEvent[];
}

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TaskTodo {
  id: string;
  content: string;
  status: TodoStatus;
}

export type TaskStatus = "planning" | "running_tool" | "waiting_permission" | "done" | "failed";

export interface TaskToolCall {
  turn: number;
  tool: string;
  input: Record<string, unknown>;
  ok?: boolean;
  output?: string;
  status?: ToolResultStatus;
  errorType?: ToolErrorType;
  metadata?: ToolMetadata;
}

export interface TaskRecord {
  id: string;
  userRequest: string;
  status: TaskStatus;
  todos: TaskTodo[];
  toolCalls: TaskToolCall[];
  approvals: AgentEvent[];
  finalAnswer?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type PlanStatus = "draft" | "approved" | "executed" | "cancelled";

export interface PlanRecord {
  id: string;
  request: string;
  status: PlanStatus;
  model: string;
  answer: string;
  summary: string;
  steps: string[];
  files: string[];
  validations: string[];
  risks: string[];
  openQuestions: string[];
  assumptions: string[];
  acceptanceCriteria: string[];
  statusReason?: string;
  inspectionEvents: string[];
  createdAt: string;
  approvedAt?: string;
  executedAt?: string;
}

export interface AgentDecision {
  thought?: string;
  action: "plan" | "tool" | "final";
  todos?: Array<{ content: string; status?: TodoStatus }>;
  tool?: string;
  input?: Record<string, unknown>;
  answer?: string;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  errorType?: ToolErrorType;
  metadata?: ToolMetadata;
}

export type ToolErrorType = "validation" | "permission_denied" | "permission_blocked" | "runtime" | "protocol";
export type ToolResultStatus = "ok" | "failed" | "denied" | "blocked" | "validation_error";
export type ToolMetadata = Record<string, string | number | boolean | string[] | undefined>;

export interface ApprovalContext {
  cwd: string;
  mode: PermissionMode;
  allowedCommandPrefixes: Set<string>;
  allowedApprovalKeys: Set<string>;
}

export interface ApprovalDetail {
  label: string;
  value: string;
}

export interface ApprovalRequirement {
  required: boolean;
  risk: ToolRisk;
  reason: string;
  allowAlwaysKey?: string;
  approvalKey?: string;
  scope?: string;
  riskReason?: string;
  blocked?: boolean;
  rememberable?: boolean;
  details?: ApprovalDetail[];
  denied?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, string>;
  risk: ToolRisk;
  describe(input: Record<string, unknown>): string;
  validate(input: Record<string, unknown>): ToolResult | undefined;
  requiresApproval(input: Record<string, unknown>, context: ApprovalContext): ApprovalRequirement;
  run(input: Record<string, unknown>): Promise<ToolResult>;
}

export type AgentEvent =
  | { type: "model_response"; raw: string; content?: string; provider?: LlmProvider; model?: string; streamEvents?: ModelStreamEvent[] }
  | { type: "model_stream_delta"; text: string }
  | { type: "plan"; turn: number; todos: TaskTodo[] }
  | { type: "tool_request"; turn: number; tool: string; input: Record<string, unknown>; thought?: string; description: string }
  | { type: "permission_request"; id: string; tool: string; input: Record<string, unknown>; description: string; requirement: ApprovalRequirement }
  | { type: "tool_result"; turn: number; tool: string; ok: boolean; output: string; errorType?: ToolErrorType; metadata?: ToolMetadata }
  | { type: "compaction"; summary: string }
  | { type: "final"; answer: string }
  | { type: "error"; error: string; category?: "model" | "tool" | "permission" | "parse" | "protocol" | "runtime" };

export interface PendingApproval {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  description: string;
  requirement: ApprovalRequirement;
  resolve(decision: ApprovalDecision): void;
}

export type AgentEventHandler = (event: AgentEvent) => void;
export type ApprovalHandler = (approval: PendingApproval) => Promise<ApprovalDecision>;

export interface SessionRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  lastUserMessage?: string;
  cwd: string;
  provider: LlmProvider;
  model: string;
  baseUrl: string;
  messages: Message[];
  events: AgentEvent[];
  tasks?: TaskRecord[];
  plans?: PlanRecord[];
  summary: string;
}
