import type { LlmProvider, Message, ModelResponse } from "../core/types.js";

export interface ChatOptions {
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Message[];
  temperature?: number;
}

interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

interface AnthropicResponse {
  content?: Array<{
    type: string;
    text?: string;
  }>;
  error?: {
    message?: string;
  };
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
    body: JSON.stringify({
      model: options.model,
      messages,
      temperature: options.temperature ?? 0.2
    })
  });

  const body = (await response.json().catch(() => ({}))) as OpenAIChatResponse;
  if (!response.ok) {
    throw new Error(body.error?.message ?? `OpenAI request failed: ${response.status}`);
  }

  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI response did not include message content.");
  return {
    provider: options.provider,
    model: options.model,
    raw: content,
    content,
    streamEvents: []
  };
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
    body: JSON.stringify({
      model: options.model,
      max_tokens: 4096,
      temperature: options.temperature ?? 0.2,
      system: system || undefined,
      messages
    })
  });

  const body = (await response.json().catch(() => ({}))) as AnthropicResponse;
  if (!response.ok) {
    throw new Error(body.error?.message ?? `Anthropic request failed: ${response.status}`);
  }

  const content = body.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
  if (!content) throw new Error("Anthropic response did not include text content.");
  return {
    provider: options.provider,
    model: options.model,
    raw: content,
    content,
    streamEvents: []
  };
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
