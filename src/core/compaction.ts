import { chat } from "../providers/llm.js";
import type { AgentConfig, Message } from "./types.js";

export interface CompactionResult {
  messages: Message[];
  summary: string;
  compacted: boolean;
}

export async function maybeCompactMessages(config: AgentConfig, messages: Message[], existingSummary: string): Promise<CompactionResult> {
  if (messages.length <= config.maxContextMessages) {
    return { messages, summary: existingSummary, compacted: false };
  }

  const system = messages[0];
  const recent = messages.slice(-(Math.floor(config.maxContextMessages / 2)));
  const old = messages.slice(1, -recent.length);
  const deterministic = deterministicSummary(old, existingSummary);

  let summary = deterministic;
  if (config.apiKey) {
    try {
      summary = await chat({
        provider: config.provider,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "Summarize this coding-agent conversation for future context. Include user goal, files read, files changed, commands run, blockers, and next step. Be concise."
          },
          { role: "user", content: deterministic }
        ]
      });
    } catch {
      summary = deterministic;
    }
  }

  return {
    messages: [
      system,
      {
        role: "system",
        content: `Conversation summary so far:\n${summary}`
      },
      ...recent
    ],
    summary,
    compacted: true
  };
}

function deterministicSummary(messages: Message[], existingSummary: string): string {
  const userGoals = messages.filter((message) => message.role === "user").map((message) => clip(message.content, 500));
  const toolOutputs = messages
    .filter((message) => message.role === "tool")
    .map((message) => {
      try {
        const parsed = JSON.parse(message.content) as { tool?: string; output?: string };
        return `${parsed.tool ?? "tool"}: ${clip(parsed.output ?? "", 500)}`;
      } catch {
        return clip(message.content, 500);
      }
    });
  return [
    existingSummary ? `Previous summary:\n${existingSummary}` : "",
    userGoals.length ? `User goals:\n${userGoals.join("\n")}` : "",
    toolOutputs.length ? `Tool activity:\n${toolOutputs.join("\n")}` : "",
    "Next step: continue from the latest visible messages."
  ]
    .filter(Boolean)
    .join("\n\n");
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}
