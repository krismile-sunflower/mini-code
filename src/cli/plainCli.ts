import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { AgentSession } from "../core/agent.js";
import { loadProjectMemory } from "../core/memory.js";
import { SessionStore } from "../storage/sessionStore.js";
import { renderCommandHelp } from "../ui/renderModel.js";
import type { AgentConfig, AgentEvent, ApprovalDecision, PendingApproval, PlanRecord } from "../core/types.js";
import type { CliArgs } from "./config.js";

export async function runPlainCli(config: AgentConfig, args: CliArgs = { listSessions: false, newSession: false, legacy: false, piPassThrough: false, piArgs: [] }): Promise<void> {
  output.write(`Mini Code Agent\n`);
  output.write(`cwd: ${config.cwd}\n`);
  output.write(`provider: ${config.provider}\n`);
  output.write(`model: ${config.model}\n`);
  output.write(`Type /exit to quit. Type /compact to compact context.\n\n`);

  const rl = createInterface({ input, output });
  let currentConfig = config;
  let session = await AgentSession.create(currentConfig, renderEvent, (approval) => askApproval(rl, approval));
  output.write(`session: ${session.id}\n\n`);

  if (args.planRequest) {
    const plan = await session.createPlan(args.planRequest);
    output.write(`${formatPlanSummary(plan)}\n\n${plan.answer}\n`);
    rl.close();
    return;
  }
  if (args.executePlanId) {
    await session.executePlan(args.executePlanId);
    rl.close();
    return;
  }

  while (true) {
    const request = (await rl.question("> ")).trim();
    if (!request) continue;
    if (request === "/exit" || request === "/quit") break;
    if (request === "/compact") {
      await session.forceCompact();
      continue;
    }
    if (request === "/help") {
      output.write(`${renderCommandHelp()}\n`);
      continue;
    }
    if (request === "/memory") {
      const mem = await loadProjectMemory(currentConfig.cwd);
      output.write(mem ? `${mem}\n` : "No CLAUDE.md files found.\n");
      continue;
    }
    if (request === "/init") {
      output.write("Analysing repository to generate CLAUDE.md...\n");
      try {
        const outPath = await session.initProjectMemory();
        output.write(`CLAUDE.md written to ${outPath}\nRestart or /new to pick it up in the next session.\n`);
      } catch (error) {
        output.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      continue;
    }
    if (request === "/status") {
      output.write(`${session.describeStatus()}\n`);
      continue;
    }
    if (request === "/model") {
      output.write(`${session.describeModel()}\n`);
      continue;
    }
    if (request === "/config") {
      output.write(`${session.describeConfig()}\n`);
      continue;
    }
    if (request === "/doctor") {
      output.write(`${session.describeDoctor()}\n`);
      continue;
    }
    if (request === "/features") {
      output.write(`${session.describeFeatures()}\n`);
      continue;
    }
    if (request === "/login") {
      output.write(`${session.describeLogin()}\n`);
      continue;
    }
    if (request === "/tools") {
      output.write(`${session.describeTools()}\n`);
      continue;
    }
    if (request === "/capabilities") {
      output.write(`${session.describeCapabilities()}\n`);
      continue;
    }
    if (request === "/mcp") {
      output.write(`${await session.describeMcp("servers")}\n`);
      continue;
    }
    if (request === "/mcp tools") {
      output.write(`${await session.describeMcp("tools")}\n`);
      continue;
    }
    if (request === "/mcp resources") {
      output.write(`${await session.describeMcp("resources")}\n`);
      continue;
    }
    if (request === "/mcp prompts") {
      output.write(`${await session.describeMcp("prompts")}\n`);
      continue;
    }
    if (request.startsWith("/mcp reconnect ")) {
      output.write(`${session.reconnectMcp(request.slice("/mcp reconnect ".length).trim())}\n`);
      continue;
    }
    if (request === "/permissions") {
      output.write(`${session.describePermissions()}\n`);
      continue;
    }
    if (request === "/skills") {
      output.write(`${session.describeSkills()}\n`);
      continue;
    }
    if (request.startsWith("/skill inspect ")) {
      output.write(`${session.inspectSkill(request.slice("/skill inspect ".length).trim())}\n`);
      continue;
    }
    if (request === "/skill reload") {
      output.write(`${await session.reloadSkills()}\n`);
      continue;
    }
    if (request.startsWith("/skill create ")) {
      const { name, description } = parseSkillCreateRequest(request.slice("/skill create ".length));
      output.write(`${await session.createSkill(name, description)}\n`);
      continue;
    }
    if (request.startsWith("/skill:")) {
      const body = request.slice("/skill:".length).trim();
      const [name = "", ...rest] = body.split(/\s+/);
      output.write(`${await session.useSkill(name, rest.join(" "))}\n`);
      continue;
    }
    if (request === "/summary") {
      output.write(`${session.getSummary() || "[no summary]"}\n`);
      continue;
    }
    if (request === "/sessions") {
      await printSessions(currentConfig.sessionDir);
      continue;
    }
    if (request.startsWith("/rename ")) {
      const title = request.slice("/rename ".length).trim();
      const renamed = await new SessionStore(currentConfig.sessionDir).rename(session.id, title);
      output.write(`renamed session: ${renamed.title}\n`);
      continue;
    }
    if (request.startsWith("/export-session ")) {
      const exportPath = request.slice("/export-session ".length).trim();
      const written = await new SessionStore(currentConfig.sessionDir).export(session.id, exportPath);
      output.write(`exported session: ${written}\n`);
      continue;
    }
    if (request.startsWith("/plan ")) {
      const plan = await session.createPlan(request.slice("/plan ".length).trim());
      output.write(`${formatPlanSummary(plan)}\nRun /execute ${plan.id} to execute.\n\n${plan.answer}\n`);
      continue;
    }
    if (request.startsWith("/execute ")) {
      await session.executePlan(request.slice("/execute ".length).trim());
      continue;
    }
    if (request === "/new") {
      currentConfig = { ...currentConfig, sessionId: undefined };
      session = await AgentSession.create(currentConfig, renderEvent, (approval) => askApproval(rl, approval));
      output.write(`new session: ${session.id}\n`);
      continue;
    }
    if (request.startsWith("/resume ")) {
      const id = request.slice("/resume ".length).trim();
      currentConfig = { ...currentConfig, sessionId: id };
      session = await AgentSession.create(currentConfig, renderEvent, (approval) => askApproval(rl, approval));
      output.write(`resumed session: ${session.id}\n`);
      const capabilityChange = session.getCapabilityChangeSummary();
      if (capabilityChange) output.write(`${capabilityChange}\n`);
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

function formatPlanSummary(plan: PlanRecord): string {
  return [
    `Plan ${plan.id} ready with ${plan.model}`,
    `status=${plan.status}${plan.statusReason ? ` (${plan.statusReason})` : ""}`,
    `summary=${plan.summary}`,
    `files=${plan.files.length ? plan.files.slice(0, 3).join(", ") : "none listed"}`,
    `steps=${plan.steps.length} risks=${plan.risks.length} acceptance=${plan.acceptanceCriteria.length}`
  ].join("\n");
}

async function printSessions(sessionDir: string): Promise<void> {
  const sessions = await new SessionStore(sessionDir).list();
  if (sessions.length === 0) {
    output.write("No sessions\n");
    return;
  }
  for (const session of sessions) {
    output.write(`${session.id}\t${session.updatedAt}\t${session.model}\t${session.title}\t${session.summary.slice(0, 80)}\n`);
  }
}

function parseSkillCreateRequest(value: string): { name: string; description: string } {
  const trimmed = value.trim();
  const [name = "", ...rest] = trimmed.split(/\s+/);
  return { name, description: rest.join(" ") };
}

function renderEvent(event: AgentEvent): void {
  if (event.type === "model_stream_delta") {
    process.stdout.write(event.text);
    return;
  }
  if (event.type === "model_response") {
    // Ensure a newline after streaming output
    if (process.stdout.isTTY) process.stdout.write("\n");
    return;
  }
  if (event.type === "plan") {
    output.write(`\nPlan\n`);
    for (const todo of event.todos) {
      const marker = todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[>]" : "[ ]";
      output.write(`${marker} ${todo.content}\n`);
    }
  } else if (event.type === "tool_request") {
    output.write(`\n[${event.turn}] ${event.tool}: ${event.description}\n`);
    if (event.thought) output.write(`    ${event.thought}\n`);
  } else if (event.type === "tool_result") {
    output.write(`${event.ok ? "ok" : event.errorType ?? "failed"} ${event.tool}\n${event.output}\n`);
  } else if (event.type === "permission_request") {
    output.write(`permission: ${event.requirement.reason}\n`);
    for (const detail of event.requirement.details ?? []) output.write(`  ${detail.label}: ${detail.value}\n`);
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
  for (const detail of approval.requirement.details ?? []) output.write(`${detail.label}: ${detail.value}\n`);
  output.write(`${approval.description}\n`);
  if (approval.requirement.blocked || approval.requirement.denied) return "deny";
  const prompt = approval.requirement.rememberable === false ? "Allow? [y] once / [n] deny: " : "Allow? [y] once / [n] deny / [a] always exact scope: ";
  const answer = (await rl.question(prompt)).trim().toLowerCase();
  if (answer === "a" && approval.requirement.rememberable !== false) return "always_allow";
  if (answer === "y" || answer === "yes" || answer === "") return "allow_once";
  return "deny";
}
