import React, { useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { AgentSession } from "../core/agent.js";
import { SessionStore } from "../storage/sessionStore.js";
import type { AgentConfig, AgentEvent, ApprovalDecision, PendingApproval } from "../core/types.js";

interface LogLine {
  kind: string;
  text: string;
}

export function App({ config }: { config: AgentConfig }) {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState(config.sessionId ?? "starting");
  const [turn, setTurn] = useState(0);
  const [approval, setApproval] = useState<PendingApproval | undefined>();
  const [expanded, setExpanded] = useState(false);
  const sessionRef = useRef<AgentSession | undefined>();

  const addLog = (kind: string, text: string) => {
    setLogs((current) => [...current, { kind, text }].slice(-200));
  };

  const approvalPromise = (pending: PendingApproval) =>
    new Promise<ApprovalDecision>((resolve) => {
      setApproval({ ...pending, resolve });
      addLog("permission", pending.requirement.reason);
    });

  const startSession = async () => {
    if (sessionRef.current) return sessionRef.current;
    const session = await AgentSession.create(
      config,
      (event) => {
        renderEvent(event, addLog);
        if (event.type === "tool_request") setTurn(event.turn);
      },
      approvalPromise
    );
    sessionRef.current = session;
    setSessionId(session.id);
    return session;
  };

  const submit = async (request: string) => {
    const trimmed = request.trim();
    if (!trimmed || busy) return;
    setInput("");
    if (trimmed === "/exit" || trimmed === "/quit") {
      exit();
      return;
    }
    setBusy(true);
    try {
      const session = await startSession();
      if (trimmed === "/clear") {
        setLogs([]);
      } else if (trimmed === "/compact") {
        await session.forceCompact();
      } else if (trimmed === "/sessions") {
        const sessions = await new SessionStore(config.sessionDir).list();
        addLog("sessions", sessions.map((item) => `${item.id} ${item.updatedAt} ${item.model}`).join("\n") || "No sessions");
      } else if (trimmed === "/expand") {
        setExpanded((value) => !value);
      } else {
        addLog("user", trimmed);
        await session.run(trimmed);
      }
    } catch (error) {
      addLog("error", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  useInput((inputChar, key) => {
    if (approval) {
      if (inputChar.toLowerCase() === "y") finishApproval("allow_once");
      else if (inputChar.toLowerCase() === "n") finishApproval("deny");
      else if (inputChar.toLowerCase() === "a") finishApproval("always_allow");
      return;
    }
    if (key.return) {
      void submit(input);
    } else if (key.backspace || key.delete) {
      setInput((value) => value.slice(0, -1));
    } else if (key.ctrl && inputChar === "c") {
      exit();
    } else if (inputChar && !key.ctrl && !key.meta) {
      setInput((value) => value + inputChar);
    }
  });

  const visibleLogs = useMemo(() => logs.slice(-20), [logs]);

  function finishApproval(decision: ApprovalDecision) {
    approval?.resolve(decision);
    addLog("permission", `permission ${decision}`);
    setApproval(undefined);
  }

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1}>
        <Text color="cyan">Mini Code Agent</Text>
        <Text> cwd={config.cwd} provider={config.provider} model={config.model} session={sessionId} turn={turn} permission=risk-based</Text>
      </Box>
      <Box flexDirection="column" minHeight={20}>
        {visibleLogs.map((line, index) => (
          <Text key={`${index}-${line.kind}`} color={colorFor(line.kind)}>
            {formatLine(line, expanded)}
          </Text>
        ))}
      </Box>
      <Box borderStyle="single" paddingX={1}>
        {approval ? (
          <Text color="yellow">Permission: {approval.description}  [y] once  [n] deny  [a] always</Text>
        ) : (
          <Text>
            {busy ? "running" : ">"} {input}
          </Text>
        )}
      </Box>
    </Box>
  );
}

function renderEvent(event: AgentEvent, addLog: (kind: string, text: string) => void): void {
  if (event.type === "model_response") return;
  if (event.type === "tool_request") {
    addLog("tool", `[${event.turn}] ${event.tool}: ${event.description}${event.thought ? `\n${event.thought}` : ""}`);
  } else if (event.type === "tool_result") {
    addLog(event.ok ? "ok" : "error", `${event.tool} ${event.ok ? "ok" : "failed"}\n${event.output}`);
  } else if (event.type === "compaction") {
    addLog("compact", `Context compacted\n${event.summary}`);
  } else if (event.type === "final") {
    addLog("final", event.answer);
  } else if (event.type === "error") {
    addLog("error", event.error);
  }
}

function formatLine(line: LogLine, expanded: boolean): string {
  const prefix = line.kind === "user" ? "you" : line.kind;
  const max = expanded ? 4000 : 800;
  const text = line.text.length > max ? `${line.text.slice(0, max)}\n[truncated, type /expand]` : line.text;
  return `${prefix}: ${text}`;
}

function colorFor(kind: string): string {
  if (kind === "error") return "red";
  if (kind === "ok" || kind === "final") return "green";
  if (kind === "tool") return "blue";
  if (kind === "permission") return "yellow";
  if (kind === "compact") return "magenta";
  return "white";
}
