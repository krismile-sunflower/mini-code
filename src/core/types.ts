export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
}

export type ToolRisk = "read" | "write" | "shell" | "dangerous";
export type PermissionMode = "risk-based";
export type ApprovalDecision = "allow_once" | "deny" | "always_allow";
export type LlmProvider = "openai" | "anthropic";

export interface AgentConfig {
  cwd: string;
  provider: LlmProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
  maxTurns: number;
  allowDangerousCommands: boolean;
  sessionId?: string;
  sessionDir: string;
  permissionMode: PermissionMode;
  maxContextMessages: number;
  maxToolOutputChars: number;
  plain: boolean;
}

export interface ToolCall {
  tool: string;
  input?: Record<string, unknown>;
}

export interface AgentDecision {
  thought?: string;
  action: "tool" | "final";
  tool?: string;
  input?: Record<string, unknown>;
  answer?: string;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface ApprovalContext {
  cwd: string;
  allowedTools: Set<string>;
  allowedCommandPrefixes: Set<string>;
}

export interface ApprovalRequirement {
  required: boolean;
  risk: ToolRisk;
  reason: string;
  allowAlwaysKey?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, string>;
  risk: ToolRisk;
  describe(input: Record<string, unknown>): string;
  requiresApproval(input: Record<string, unknown>, context: ApprovalContext): ApprovalRequirement;
  run(input: Record<string, unknown>): Promise<ToolResult>;
}

export type AgentEvent =
  | { type: "model_response"; raw: string }
  | { type: "tool_request"; turn: number; tool: string; input: Record<string, unknown>; thought?: string; description: string }
  | { type: "permission_request"; id: string; tool: string; input: Record<string, unknown>; description: string; requirement: ApprovalRequirement }
  | { type: "tool_result"; turn: number; tool: string; ok: boolean; output: string }
  | { type: "compaction"; summary: string }
  | { type: "final"; answer: string }
  | { type: "error"; error: string };

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
  cwd: string;
  provider: LlmProvider;
  model: string;
  baseUrl: string;
  messages: Message[];
  events: AgentEvent[];
  summary: string;
}
