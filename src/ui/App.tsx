import React, { useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { AgentSession } from "../core/agent.js";
import { SessionStore } from "../storage/sessionStore.js";
import type { AgentConfig, AgentEvent, ApprovalDecision, PendingApproval, PlanRecord } from "../core/types.js";
import {
  approvalRows,
  blockedApprovalText,
  commandGroups,
  detailForItem,
  decisionText,
  emptyStates,
  eventToTimelineItems,
  headerFields,
  nextPermissionMode,
  permissionModeLabel,
  renderDiffLines,
  slashCommands,
  stateColor,
  statusModel,
  timelineLabel,
  truncateEnd,
  type StatusModel,
  type TimelineItem
} from "./renderModel.js";

export function App({ config }: { config: AgentConfig }) {
  const { exit } = useApp();
  const [activeConfig, setActiveConfig] = useState(config);
  const [input, setInput] = useState("");
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState(config.sessionId ?? "starting");
  const [turn, setTurn] = useState(0);
  const [messageCount, setMessageCount] = useState(0);
  const [hasSummary, setHasSummary] = useState(false);
  const [approval, setApproval] = useState<PendingApproval | undefined>();
  const [pendingPlan, setPendingPlan] = useState<PlanRecord | undefined>();
  const [expanded, setExpanded] = useState(false);
  const [historyMode, setHistoryMode] = useState(false);
  const [detailsVisible, setDetailsVisible] = useState(false);
  const [permissionMode, setPermissionMode] = useState(activeConfig.permissionMode);
  const sessionRef = useRef<AgentSession | undefined>();

  const pushItems = (...items: TimelineItem[]) => {
    setTimeline((current) => [...current, ...items].slice(-240));
  };

  const handleEvent = (event: AgentEvent) => {
    if (event.type === "tool_request") setTurn(event.turn);
    if (event.type !== "permission_request" || event.id === "blocked") {
      pushItems(...eventToTimelineItems(event));
    }
    setMessageCount(sessionRef.current?.getMessageCount() ?? 0);
    setHasSummary(Boolean(sessionRef.current?.getSummary()));
  };

  const approvalPromise = (pending: PendingApproval) =>
    new Promise<ApprovalDecision>((resolve) => {
      setApproval({ ...pending, resolve });
      pushItems({ kind: "permission", tool: pending.tool, text: pending.requirement.reason, risk: pending.requirement.risk, details: pending.requirement.details });
    });

  const startSession = async () => {
    if (sessionRef.current) return sessionRef.current;
    const session = await AgentSession.create(activeConfig, handleEvent, approvalPromise);
    sessionRef.current = session;
    session.setPermissionMode(permissionMode);
    setSessionId(session.id);
    setMessageCount(session.getMessageCount());
    setHasSummary(Boolean(session.getSummary()));
    return session;
  };

  const switchSession = async (nextConfig: AgentConfig, clearTimeline: boolean) => {
    sessionRef.current = undefined;
    setApproval(undefined);
    setActiveConfig(nextConfig);
    setTurn(0);
    setMessageCount(0);
    setHasSummary(false);
    setPermissionMode(nextConfig.permissionMode);
    if (clearTimeline) setTimeline([]);
    const session = await AgentSession.create(nextConfig, handleEvent, approvalPromise);
    sessionRef.current = session;
    session.setPermissionMode(nextConfig.permissionMode);
    setSessionId(session.id);
    setMessageCount(session.getMessageCount());
    setHasSummary(Boolean(session.getSummary()));
    pushItems({ kind: "session", text: `${clearTimeline ? "New" : "Resumed"} session ${session.id}` });
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
        setTimeline([]);
      } else if (trimmed === "/" || trimmed === "/help") {
        pushItems({ kind: "session", text: slashCommands.join("\n") });
      } else if (trimmed === "/status") {
        const record = session.getRecord();
        const task = record.tasks?.at(-1);
        const plan = record.plans?.at(-1);
        const skills = session.describeSkills();
        const skillCount = skills === "No skills discovered." ? 0 : skills.split("\n").filter(Boolean).length;
        pushItems({ kind: "session", text: `session=${session.id}\nmessages=${session.getMessageCount()}\nsummary=${session.getSummary() ? "yes" : "no"}\ntask=${task?.status ?? "none"}\ntools=${task?.toolCalls.length ?? 0}\nlastError=${task?.error ?? "none"}\nplan=${plan ? `${plan.id} ${plan.status}` : "none"}\nplanModel=${activeConfig.planModel}\npermissionMode=${permissionMode}\nskills=${skillCount}` });
      } else if (trimmed === "/tools") {
        pushItems({ kind: "session", text: session.describeTools() });
      } else if (trimmed === "/permissions") {
        pushItems({ kind: "session", text: session.describePermissions() });
      } else if (trimmed === "/skills") {
        pushItems({ kind: "session", text: session.describeSkills() });
      } else if (trimmed.startsWith("/skill:")) {
        const body = trimmed.slice("/skill:".length).trim();
        const [name = "", ...rest] = body.split(/\s+/);
        const loaded = await session.useSkill(name, rest.join(" "));
        pushItems({ kind: "session", text: loaded });
      } else if (trimmed === "/compact") {
        await session.forceCompact();
        setMessageCount(session.getMessageCount());
        setHasSummary(Boolean(session.getSummary()));
      } else if (trimmed === "/summary") {
        pushItems({ kind: "compact", text: session.getSummary() || "[no summary]" });
      } else if (trimmed === "/sessions") {
        const sessions = await new SessionStore(activeConfig.sessionDir).list();
        pushItems({
          kind: "session",
          text: sessions.map((item) => `${item.id} ${item.updatedAt} ${item.model} ${item.title} ${item.summary.slice(0, 80)}`).join("\n") || "No sessions"
        });
      } else if (trimmed.startsWith("/rename ")) {
        const title = trimmed.slice("/rename ".length).trim();
        const renamed = await new SessionStore(activeConfig.sessionDir).rename(session.id, title);
        pushItems({ kind: "session", text: `Renamed session ${renamed.id}: ${renamed.title ?? "Untitled session"}` });
      } else if (trimmed.startsWith("/export-session ")) {
        const exportPath = trimmed.slice("/export-session ".length).trim();
        const written = await new SessionStore(activeConfig.sessionDir).export(session.id, exportPath);
        pushItems({ kind: "session", text: `Exported session to ${written}` });
      } else if (trimmed === "/expand") {
        setExpanded((value) => !value);
        pushItems({ kind: "session", text: `Output ${expanded ? "collapsed" : "expanded"}` });
      } else if (trimmed === "/history") {
        setHistoryMode((value) => !value);
        pushItems({ kind: "session", text: `History ${historyMode ? "normal" : "extended"}` });
      } else if (trimmed === "/details") {
        setDetailsVisible((value) => !value);
        pushItems({ kind: "session", text: `Details ${detailsVisible ? "hidden" : "visible"}` });
      } else if (trimmed.startsWith("/plan ")) {
        const request = trimmed.slice("/plan ".length).trim();
        const plan = await session.createPlan(request);
        setPendingPlan(plan);
        pushItems({ kind: "session", text: `Plan ${plan.id} ready. Press y to execute, n to cancel, or e to edit request.\n\n${plan.answer}` });
      } else if (trimmed.startsWith("/execute ")) {
        const id = trimmed.slice("/execute ".length).trim();
        pushItems({ kind: "session", text: `Executing plan ${id}` });
        await session.executePlan(id);
      } else if (trimmed === "/new") {
        await switchSession({ ...activeConfig, sessionId: undefined }, true);
      } else if (trimmed.startsWith("/resume ")) {
        const id = trimmed.slice("/resume ".length).trim();
        await switchSession({ ...activeConfig, sessionId: id }, false);
      } else {
        pushItems({ kind: "user", text: trimmed });
        await session.run(trimmed);
        setMessageCount(session.getMessageCount());
        setHasSummary(Boolean(session.getSummary()));
      }
    } catch (error) {
      pushItems({ kind: "error", category: "runtime", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  useInput((inputChar, key) => {
    if (approval) {
      if (approval.requirement.blocked || approval.requirement.denied) {
        if (inputChar.toLowerCase() === "n" || key.return) finishApproval("deny");
      } else if (inputChar.toLowerCase() === "y") finishApproval("allow_once");
      else if (inputChar.toLowerCase() === "n") finishApproval("deny");
      else if (inputChar.toLowerCase() === "a" && approval.requirement.rememberable !== false) finishApproval("always_allow");
      return;
    }
    if (pendingPlan) {
      if (inputChar.toLowerCase() === "y") {
        const plan = pendingPlan;
        setPendingPlan(undefined);
        setBusy(true);
        void startSession().then((session) => session.executePlan(plan.id)).catch((error) => pushItems({ kind: "error", category: "runtime", text: error instanceof Error ? error.message : String(error) })).finally(() => setBusy(false));
      } else if (inputChar.toLowerCase() === "n") {
        const plan = pendingPlan;
        setPendingPlan(undefined);
        void startSession().then((session) => session.cancelPlan(plan.id));
        pushItems({ kind: "session", text: `Cancelled plan ${plan.id}` });
      } else if (inputChar.toLowerCase() === "e") {
        setInput(`/plan ${pendingPlan.request} `);
        setPendingPlan(undefined);
      }
      return;
    }
    if (key.return) {
      void submit(input);
    } else if (key.shift && key.tab) {
      cyclePermissionMode();
    } else if (key.backspace || key.delete) {
      setInput((value) => value.slice(0, -1));
    } else if (key.ctrl && inputChar === "c") {
      exit();
    } else if (inputChar && !key.ctrl && !key.meta) {
      setInput((value) => value + inputChar);
    }
  });

  const visibleItems = useMemo(() => timeline.slice(historyMode ? -90 : -28), [historyMode, timeline]);
  const status = statusModel({ config: activeConfig, sessionId, turn, busy, approval, messageCount, hasSummary, permissionMode });
  const latestDetail = useMemo(() => detailForItem([...visibleItems].reverse()[0], expanded), [expanded, visibleItems]);

  function finishApproval(decision: ApprovalDecision) {
    approval?.resolve(decision);
    pushItems({ kind: "permission", tool: approval?.tool, decision, text: decisionText(decision), risk: approval?.requirement.risk, details: approval?.requirement.details });
    setApproval(undefined);
  }

  function cyclePermissionMode() {
    const next = nextPermissionMode(permissionMode);
    setPermissionMode(next);
    setActiveConfig((current) => ({ ...current, permissionMode: next }));
    sessionRef.current?.setPermissionMode(next);
    pushItems({ kind: "session", text: `Permission mode: ${permissionModeLabel(next)}` });
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <HeaderBar status={status} />
      <TimelinePanel items={visibleItems} expanded={expanded} detailsVisible={detailsVisible} historyMode={historyMode} />
      {detailsVisible ? <DetailPanel detail={latestDetail} /> : null}
      {input === "/" ? <CommandMenu /> : null}
      {approval ? <ApprovalPanel approval={approval} /> : pendingPlan ? <PlanApprovalPanel plan={pendingPlan} /> : <InputBar busy={busy} input={input} permissionMode={permissionMode} detailsVisible={detailsVisible} expanded={expanded} />}
    </Box>
  );
}

function PlanApprovalPanel({ plan }: { plan: PlanRecord }) {
  return (
    <Box borderStyle="double" borderColor="cyan" paddingX={1} flexDirection="column" marginTop={1}>
      <Text color="cyan">Plan Ready</Text>
      <Text>id: {plan.id}</Text>
      <Text>model: {plan.model}</Text>
      <Text>{truncateEnd(plan.answer.replace(/\s+/g, " "), 500)}</Text>
      <Text color="cyan">[y] execute  [n] cancel  [e] edit request</Text>
    </Box>
  );
}

function HeaderBar({ status }: { status: StatusModel }) {
  const fields = headerFields(status);
  return (
    <Box borderStyle="single" borderColor={stateColor(status.state)} paddingX={1}>
      <Box width={12}>
        <Text color="cyan" bold>Mini Code</Text>
      </Box>
      {fields.map((field) => (
        <Box key={field.label} marginRight={2}>
          <Text color="gray">{field.label}</Text>
          <Text color="gray">=</Text>
          <Text color={field.color ?? "white"}>{field.value}</Text>
        </Box>
      ))}
    </Box>
  );
}

function CommandMenu() {
  return (
    <Box borderStyle="single" borderColor="cyan" paddingX={1} flexDirection="column" marginTop={1}>
      <Box justifyContent="space-between">
        <Text color="cyan" bold>Commands</Text>
        <Text color="gray">type a command and press enter</Text>
      </Box>
      <Box gap={3} flexWrap="wrap">
        {commandGroups.map((group) => (
          <Box key={group.title} flexDirection="column" minWidth={24}>
            <Text color="gray">{group.title}</Text>
            {group.commands.map((command) => (
              <Text key={command}>{command}</Text>
            ))}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function TimelinePanel({ items, expanded, detailsVisible, historyMode }: { items: TimelineItem[]; expanded: boolean; detailsVisible: boolean; historyMode: boolean }) {
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column" minHeight={18} marginTop={1}>
      <Box justifyContent="space-between">
        <Text color="cyan" bold>Conversation</Text>
        <Text color="gray">latest {items.length}  details {detailsVisible ? "on" : "off"}  history {historyMode ? "extended" : "normal"}  diff {expanded ? "expanded" : "compact"}</Text>
      </Box>
      {items.length === 0 ? <Text color="gray">{emptyStates.timeline}</Text> : items.slice(-24).map((item, index) => <TimelineRow key={`${index}-${item.kind}`} item={item} expanded={expanded} />)}
    </Box>
  );
}

function TimelineRow({ item, expanded }: { item: TimelineItem; expanded: boolean }) {
  const label = timelineLabel(item);
  const diffPreview = item.kind === "code_change" ? renderDiffLines(item.diff, expanded).slice(0, expanded ? 14 : 6) : [];
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={12}>
          <Text color={label.color}>{truncateEnd(label.marker, 10)}</Text>
        </Box>
        <Text color={label.severity === "muted" ? "gray" : "white"}>{truncateEnd(label.text.replace(/\s+/g, " "), 126)}</Text>
      </Box>
      {diffPreview.length > 0 ? (
        <Box marginLeft={12} flexDirection="column">
          {diffPreview.map((line, index) => (
            <Text key={`${index}-${line.text}`} color={line.color}>{truncateEnd(line.text, 126)}</Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function DetailPanel({ detail }: { detail: ReturnType<typeof detailForItem> }) {
  return (
    <Box borderStyle="single" borderColor={detail?.color ?? "gray"} paddingX={1} flexDirection="column" marginTop={1} minHeight={5}>
      <Box justifyContent="space-between">
        <Text color={detail?.color ?? "gray"} bold>{detail?.title ?? "Detail"}</Text>
        <Text color="gray">{detail?.type ?? "empty"}</Text>
      </Box>
      <Text color={detail ? "white" : "gray"}>{detail ? truncateEnd(detail.body, 2200) : emptyStates.detail}</Text>
      {detail?.diffLines?.map((line, index) => (
        <Text key={`${index}-${line.text}`} color={line.color}>{line.text}</Text>
      ))}
    </Box>
  );
}

function ApprovalPanel({ approval }: { approval: PendingApproval }) {
  const blocked = Boolean(approval.requirement.denied || approval.requirement.blocked);
  return (
    <Box borderStyle="double" borderColor={blocked ? "red" : "yellow"} paddingX={1} flexDirection="column" marginTop={1}>
      <Box justifyContent="space-between">
        <Text color={blocked ? "red" : "yellow"} bold>{blocked ? "Permission Blocked" : "Permission Required"}</Text>
        <Text color={blocked ? "red" : "yellow"}>{approval.tool}</Text>
      </Box>
      <Text>{approval.requirement.reason}</Text>
      {approvalRows(approval).map((row) => (
        <Text key={`${row.label}-${row.value}`}>
          <Text color="gray">{row.label}</Text>: {row.value}
        </Text>
      ))}
      <Text color={blocked ? "red" : "yellow"}>{blockedApprovalText(approval)}</Text>
    </Box>
  );
}

function InputBar({ busy, input, permissionMode, detailsVisible, expanded }: { busy: boolean; input: string; permissionMode: StatusModel["permissionMode"]; detailsVisible: boolean; expanded: boolean }) {
  return (
    <Box borderStyle="single" borderColor={busy ? "blue" : "gray"} paddingX={1} flexDirection="column" marginTop={1}>
      <Text color={busy ? "blue" : "cyan"}>{busy ? "running" : ">"} {input || (busy ? "waiting for model" : "Ask, or type / for commands")}</Text>
      <Text color="gray">shift+tab {permissionModeLabel(permissionMode)}  |  /details {detailsVisible ? "on" : "off"}  |  /expand {expanded ? "on" : "off"}  |  / commands</Text>
    </Box>
  );
}
