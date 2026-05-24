import type { LlmProvider, Message } from "../core/types.js";

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

export async function chat(options: ChatOptions): Promise<string> {
  if (options.provider === "anthropic") return anthropicChat(options);
  return openAIChat(options);
}

async function openAIChat(options: ChatOptions): Promise<string> {
  const endpoint = `${options.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`
    },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      temperature: options.temperature ?? 0.2
    })
  });

  const body = (await response.json().catch(() => ({}))) as OpenAIChatResponse;
  if (!response.ok) {
    throw new Error(body.error?.message ?? `OpenAI request failed: ${response.status}`);
  }

  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI response did not include message content.");
  return content;
}

async function anthropicChat(options: ChatOptions): Promise<string> {
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
  return content;
}

function toAnthropicMessages(messages: Message[]): { system: string; messages: Array<{ role: "user" | "assistant"; content: string }> } {
  const systemParts: string[] = [];
  const converted: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
    } else if (message.role === "assistant") {
      pushMerged(converted, "assistant", message.content);
    } else if (message.role === "tool") {
      pushMerged(converted, "user", `Tool result:\n${message.content}`);
    } else {
      pushMerged(converted, "user", message.content);
    }
  }

  return { system: systemParts.join("\n\n"), messages: converted };
}

function pushMerged(messages: Array<{ role: "user" | "assistant"; content: string }>, role: "user" | "assistant", content: string): void {
  const last = messages[messages.length - 1];
  if (last?.role === role) {
    last.content = `${last.content}\n\n${content}`;
  } else {
    messages.push({ role, content });
  }
}
