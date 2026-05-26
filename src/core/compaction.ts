import { chat } from "../providers/llm.js";
import type { AgentConfig, Message } from "./types.js";

export interface CompactionResult {
  messages: Message[];
  summary: string;
  compacted: boolean;
}

/** Estimate token count for a message using Pi SDK's chars/4 heuristic (conservative). */
function estimateTokens(message: Message): number {
  return Math.ceil(message.content.length / 4);
}

/** Estimate total tokens for a message array. */
function estimateTotalTokens(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
}

/**
 * Find the best cut point that keeps approximately `keepRecentTokens` worth of
 * messages. Mirrors the Pi SDK cut-point algorithm: walk backwards accumulating
 * tokens, stop when we've kept enough, then cut at the nearest turn boundary
 * (user message) so we never split a turn.
 */
function findCutPoint(messages: Message[], keepRecentTokens: number): number {
  let accumulated = 0;
  let cutIndex = messages.length; // default: keep everything

  // Walk backwards through non-system messages
  for (let i = messages.length - 1; i >= 1; i--) {
    accumulated += estimateTokens(messages[i]);
    if (accumulated >= keepRecentTokens) {
      // Snap forward to the next user-role boundary so we start at a clean turn
      let snap = i;
      while (snap < messages.length && messages[snap].role !== "user") snap += 1;
      cutIndex = snap;
      break;
    }
  }

  return cutIndex;
}

export async function maybeCompactMessages(
  config: AgentConfig,
  messages: Message[],
  existingSummary: string
): Promise<CompactionResult> {
  if (!shouldCompactMessages(config, messages)) {
    return { messages, summary: existingSummary, compacted: false };
  }

  const system = messages[0];
  const tokenThreshold = compactionTokenThreshold(config);
  // Keep the most recent ~40% of the token budget as a clean-turn window
  const keepRecentTokens = Math.floor(tokenThreshold * 0.4);
  const cutIndex = findCutPoint(messages, keepRecentTokens);

  const old = messages.slice(1, cutIndex);
  const recent = messages.slice(cutIndex);

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
              "You are summarizing a coding-agent conversation for future context. Produce a structured summary using these exact headings: Current goal, Completed work, Key files modified, Pending work, User constraints and preferences. Be concise, preserve concrete facts (file names, error messages, decisions made). Omit pleasantries and repetition."
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

export function shouldCompactMessages(config: AgentConfig, messages: Message[]): boolean {
  const totalTokens = estimateTotalTokens(messages);
  return totalTokens > compactionTokenThreshold(config) || messages.length > config.maxContextMessages;
}

function compactionTokenThreshold(config: AgentConfig): number {
  return config.maxContextMessages * 150;
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
    [existingSummary ? `Prior summary exists. ${clip(existingSummary, 800)}` : "", ...toolActivity].filter(Boolean).join("\n") ||
      "No completed tool work has been summarized yet.",
    "",
    "Key files:",
    keyFiles.length ? keyFiles.join("\n") : "No specific files identified yet.",
    "",
    "Pending work:",
    "Continue from the latest visible messages and verify changes when practical.",
    "",
    "User constraints:",
    "Preserve unrelated user changes; use workspace facts and tool results only."
  ].join("\n\n");
}

function extractKeyFiles(value: string): string[] {
  const matches =
    value.match(/(?:[\w.-]+\/)+[\w.-]+|[\w.-]+\.(?:ts|tsx|js|jsx|json|md|toml|yaml|yml|css|html|py|go|rs)/g) ?? [];
  return Array.from(new Set(matches)).slice(0, 12);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}
