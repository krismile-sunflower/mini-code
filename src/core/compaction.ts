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
              "Summarize this coding-agent conversation for future context. Use these headings exactly: Current goal, Completed work, Key files, Pending work, User constraints. Be concise and preserve facts only."
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
  const toolActivity = messages
    .filter((message) => message.role === "tool")
    .map((message) => {
      try {
        const parsed = JSON.parse(message.content) as { tool?: string; ok?: boolean; output?: string };
        return `${parsed.tool ?? "tool"} ${parsed.ok === false ? "failed" : "completed"}: ${clip(parsed.output ?? "", 500)}`;
      } catch {
        return clip(message.content, 500);
      }
    });
  const keyFiles = extractKeyFiles(toolActivity.join("\n"));
  return [
    "Current goal:",
    userGoals.at(-1) ?? "Continue the user's latest coding request.",
    "",
    "Completed work:",
    [existingSummary ? `Prior summary exists. ${clip(existingSummary, 800)}` : "", ...toolActivity].filter(Boolean).join("\n") || "No completed tool work has been summarized yet.",
    "",
    "Key files:",
    keyFiles.length ? keyFiles.join("\n") : "No specific files identified yet.",
    "",
    "Pending work:",
    "Continue from the latest visible messages and verify changes when practical.",
    "",
    "User constraints:",
    "Preserve unrelated user changes; use workspace facts and tool results only."
  ]
    .join("\n\n");
}

function extractKeyFiles(value: string): string[] {
  const matches = value.match(/(?:[\w.-]+\/)+[\w.-]+|[\w.-]+\.(?:ts|tsx|js|jsx|json|md|toml|yaml|yml|css|html|py|go|rs)/g) ?? [];
  return Array.from(new Set(matches)).slice(0, 12);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}
