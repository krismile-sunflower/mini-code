import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { AgentSession } from "../core/agent.js";
import type { AgentConfig, AgentEvent, ApprovalDecision, PendingApproval } from "../core/types.js";

export async function runPlainCli(config: AgentConfig): Promise<void> {
  output.write(`Mini Code Agent\n`);
  output.write(`cwd: ${config.cwd}\n`);
  output.write(`provider: ${config.provider}\n`);
  output.write(`model: ${config.model}\n`);
  output.write(`Type /exit to quit. Type /compact to compact context.\n\n`);

  const rl = createInterface({ input, output });
  const session = await AgentSession.create(config, renderEvent, (approval) => askApproval(rl, approval));
  output.write(`session: ${session.id}\n\n`);

  while (true) {
    const request = (await rl.question("> ")).trim();
    if (!request) continue;
    if (request === "/exit" || request === "/quit") break;
    if (request === "/compact") {
      await session.forceCompact();
      continue;
    }

    try {
      await session.run(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      renderEvent({ type: "error", error: message });
    }
  }

  rl.close();
}

function renderEvent(event: AgentEvent): void {
  if (event.type === "model_response") return;
  if (event.type === "tool_request") {
    output.write(`\n[${event.turn}] ${event.tool}: ${event.description}\n`);
    if (event.thought) output.write(`    ${event.thought}\n`);
  } else if (event.type === "tool_result") {
    output.write(`${event.ok ? "ok" : "failed"} ${event.tool}\n${event.output}\n`);
  } else if (event.type === "permission_request") {
    output.write(`permission: ${event.requirement.reason}\n`);
  } else if (event.type === "compaction") {
    output.write(`\nContext compacted.\n${event.summary}\n`);
  } else if (event.type === "final") {
    output.write(`\n${event.answer}\n\n`);
  } else if (event.type === "error") {
    output.write(`\nError: ${event.error}\n\n`);
  }
}

async function askApproval(rl: ReturnType<typeof createInterface>, approval: PendingApproval): Promise<ApprovalDecision> {
  output.write(`\nPermission required: ${approval.requirement.reason}\n`);
  output.write(`${approval.description}\n`);
  const answer = (await rl.question("Allow? [y] once / [n] deny / [a] always: ")).trim().toLowerCase();
  if (answer === "a") return "always_allow";
  if (answer === "y" || answer === "yes" || answer === "") return "allow_once";
  return "deny";
}
