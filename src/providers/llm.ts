import type { LlmProvider, Message, ModelResponse, ModelStreamEvent, ToolDefinition, ToolProtocol } from "../core/types.js";

export interface ChatOptions {
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Message[];
  temperature?: number;
  /** AbortSignal to cancel the in-flight request */
  signal?: AbortSignal;
  /** Called for each text token as it streams in */
  onDelta?: (text: string) => void;
  toolProtocol?: ToolProtocol;
  tools?: ToolDefinition[];
}

export async function complete(options: ChatOptions): Promise<ModelResponse> {
  if (options.provider === "anthropic") return anthropicComplete(options);
  return openAIComplete(options);
}

export async function chat(options: ChatOptions): Promise<string> {
  return (await complete(options)).content;
}

async function openAIComplete(options: ChatOptions): Promise<ModelResponse> {
  const endpoint = `${options.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const messages = toProviderMessages(options.messages);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`
    },
    signal: options.signal,
    body: JSON.stringify({
      model: options.model,
      messages,
      temperature: options.temperature ?? 0.2,
      stream: options.toolProtocol === "native" ? false : true,
      ...(options.toolProtocol === "native" ? { tools: toOpenAITools(options.tools ?? []) } : {})
    })
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `OpenAI request failed: ${response.status}`);
  }
  if (!isEventStream(response)) {
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }> };
    const toolCall = body.choices?.[0]?.message?.tool_calls?.[0];
    if (toolCall?.function?.name) {
      const content = JSON.stringify({
        action: "tool",
        tool: toolCall.function.name,
        input: parseJsonObject(toolCall.function.arguments),
        thought: "Provider returned a native tool call."
      });
      return { provider: options.provider, model: options.model, raw: content, content, streamEvents: [{ type: "tool_call_delta", text: content }] };
    }
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI response did not include message content.");
    return { provider: options.provider, model: options.model, raw: content, content, streamEvents: [] };
  }
  if (!response.body) throw new Error("OpenAI response body is empty.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const streamEvents: ModelStreamEvent[] = [];

  try {
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (options.signal?.aborted) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") break outer;
        try {
          const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }> };
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            content += delta;
            streamEvents.push({ type: "text_delta", text: delta });
            options.onDelta?.(delta);
          }
        } catch {
          // ignore malformed SSE lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!content) throw new Error("OpenAI response did not include message content.");
  return { provider: options.provider, model: options.model, raw: content, content, streamEvents };
}

async function anthropicComplete(options: ChatOptions): Promise<ModelResponse> {
  const endpoint = `${options.baseUrl.replace(/\/$/, "")}/messages`;
  const { system, messages } = toAnthropicMessages(options.messages);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": options.apiKey,
      "anthropic-version": "2023-06-01"
    },
    signal: options.signal,
    body: JSON.stringify({
      model: options.model,
      max_tokens: 8096,
      temperature: options.temperature ?? 0.2,
      system: system || undefined,
      messages,
      stream: options.toolProtocol === "native" ? false : true,
      ...(options.toolProtocol === "native" ? { tools: toAnthropicTools(options.tools ?? []) } : {})
    })
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Anthropic request failed: ${response.status}`);
  }
  if (!isEventStream(response)) {
    const body = (await response.json()) as { content?: Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }> };
    const toolUse = body.content?.find((part) => part.type === "tool_use" && typeof part.name === "string");
    if (toolUse?.name) {
      const content = JSON.stringify({
        action: "tool",
        tool: toolUse.name,
        input: typeof toolUse.input === "object" && toolUse.input !== null ? toolUse.input : {},
        thought: "Provider returned a native tool call."
      });
      return { provider: options.provider, model: options.model, raw: content, content, streamEvents: [{ type: "tool_call_delta", text: content }] };
    }
    const content = body.content?.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("") ?? "";
    if (!content) throw new Error("Anthropic response did not include text content.");
    return { provider: options.provider, model: options.model, raw: content, content, streamEvents: [] };
  }
  if (!response.body) throw new Error("Anthropic response body is empty.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const streamEvents: ModelStreamEvent[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (options.signal?.aborted) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        try {
          const parsed = JSON.parse(data) as {
            type?: string;
            content_block?: { type?: string };
            delta?: { type?: string; text?: string; thinking?: string };
          };
          if (parsed.type === "content_block_delta") {
            const delta = parsed.delta;
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              content += delta.text;
              streamEvents.push({ type: "text_delta", text: delta.text });
              options.onDelta?.(delta.text);
            } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
              streamEvents.push({ type: "thinking_delta", text: delta.thinking });
            }
          }
        } catch {
          // ignore malformed SSE lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!content) throw new Error("Anthropic response did not include text content.");
  return { provider: options.provider, model: options.model, raw: content, content, streamEvents };
}

function toOpenAITools(tools: ToolDefinition[]): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toolSchema(tool)
    }
  }));
}

function toAnthropicTools(tools: ToolDefinition[]): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: toolSchema(tool)
  }));
}

function toolSchema(tool: ToolDefinition): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, description] of Object.entries(tool.inputSchema)) {
    properties[key] = { type: "string", description };
  }
  return { type: "object", properties };
}

function parseJsonObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function isEventStream(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
}

export function toProviderMessages(messages: Message[]): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const converted: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  for (const message of messages) {
    if (message.role === "tool") {
      const rendered = renderToolMessage(message.content);
      pushMerged(converted, "user", rendered);
      continue;
    }
    pushMerged(converted, message.role, message.content);
  }
  return converted;
}

function toAnthropicMessages(messages: Message[]): { system: string; messages: Array<{ role: "user" | "assistant"; content: string }> } {
  const systemParts: string[] = [];
  const converted: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const message of toProviderMessages(messages)) {
    if (message.role === "system") {
      systemParts.push(message.content);
    } else if (message.role === "assistant") {
      pushMerged(converted, "assistant", message.content);
    } else {
      pushMerged(converted, "user", message.content);
    }
  }

  return { system: systemParts.join("\n\n"), messages: converted };
}

function pushMerged<RoleName extends string>(messages: Array<{ role: RoleName; content: string }>, role: RoleName, content: string): void {
  const last = messages[messages.length - 1];
  if (last?.role === role) {
    last.content = `${last.content}\n\n${content}`;
  } else {
    messages.push({ role, content });
  }
}

function renderToolMessage(content: string): string {
  try {
    const parsed = JSON.parse(content) as { tool?: unknown; ok?: unknown; output?: unknown; errorType?: unknown; metadata?: unknown };
    const tool = typeof parsed.tool === "string" && parsed.tool ? parsed.tool : "unknown_tool";
    return `Tool result for ${tool}:\n${JSON.stringify({ ok: parsed.ok, output: parsed.output, errorType: parsed.errorType, metadata: parsed.metadata }, null, 2)}`;
  } catch {
    return `Tool result:\n${content}`;
  }
}
