import React, { useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { AgentSession } from "../core/agent.js";
import { SessionStore } from "../storage/sessionStore.js";
import type { AgentConfig, AgentEvent, ApprovalDecision, PendingApproval, PlanRecord, SkillInfo } from "../core/types.js";
import {
  approvalRows,
  asciiArt,
  blockedApprovalText,
  decisionText,
  detailForItem,
  emptyStates,
  eventToTimelineItems,
  filterCommandsAndSkills,
  markdownPreview,
  nextPermissionMode,
  planSummaryRows,
  permissionModeColor,
  permissionModeLabel,
  renderDiffLines,
  slashCommands,
  stateColor,
  statusModel,
  timelineLabel,
  timelineMarkdownLines,
  timelineRenderBlocks,
  truncateEnd,
  truncateMiddle,
  welcomeTips,
  type StatusModel,
  type TimelineItem,
  type TimelineRenderBlock,
  type MarkdownLine
} from "./renderModel.js";

export function App({ config, warnings = [], skills = [] }: { config: AgentConfig; warnings?: string[]; skills?: SkillInfo[] }) {
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
  const [streamingText, setStreamingText] = useState("");
  const [aborting, setAborting] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const sessionRef = useRef<AgentSession | undefined>();

  const pushItems = (...items: TimelineItem[]) => {
    setTimeline((current) => [...current, ...items].slice(-240));
  };

  const handleEvent = (event: AgentEvent) => {
    if (event.type === "model_stream_delta") {
      setStreamingText((prev) => prev + event.text);
      return;
    }
    if (event.type === "model_response") setStreamingText("");
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
    setAborting(false);
    try {
      const session = await startSession();
      if (trimmed === "/clear") {
        setTimeline([]);
      } else if (trimmed === "/" || trimmed === "/help") {
        pushItems({ kind: "session", text: slashCommands.join("\n") });
      } else if (trimmed === "/memory") {
        const { loadProjectMemory } = await import("../core/memory.js");
        const mem = await loadProjectMemory(activeConfig.cwd);
        pushItems({ kind: "session", text: mem || "No CLAUDE.md files found." });
      } else if (trimmed === "/init") {
        pushItems({ kind: "session", text: "Analysing repository to generate CLAUDE.md..." });
        const outPath = await session.initProjectMemory();
        pushItems({ kind: "session", text: `CLAUDE.md written to ${outPath}\nRestart or run /new to pick it up in the next session.` });
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
        pushItems({ kind: "plan_record", plan });
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
      setAborting(false);
      setStreamingText("");
    }
  };

  const commandEntries = useMemo(() => input.startsWith("/") && !input.includes(" ") ? filterCommandsAndSkills(input, skills) : [], [input, skills]);
  const selectedCommandIndex = commandEntries.length > 0 ? Math.min(commandIndex, commandEntries.length - 1) : 0;

  useInput((inputChar, key) => {
    if (key.escape && busy) {
      setAborting(true);
      sessionRef.current?.abort();
      return;
    }
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
      } else if (inputChar.toLowerCase() === "d") {
        setDetailsVisible(true);
      }
      return;
    }
    if (input.startsWith("/") && !input.includes(" ") && commandEntries.length > 0) {
      if (key.upArrow) {
        setCommandIndex((value) => (value <= 0 ? commandEntries.length - 1 : value - 1));
        return;
      }
      if (key.downArrow || (key.tab && !key.shift)) {
        setCommandIndex((value) => (value + 1) % commandEntries.length);
        return;
      }
    }
    if (key.return) {
      const selected = input.startsWith("/") && !input.includes(" ") && commandEntries.length > 0 ? commandEntries[selectedCommandIndex]?.command : undefined;
      void submit(selected && input !== selected ? selected : input);
    } else if (key.shift && key.tab) {
      cyclePermissionMode();
    } else if (key.backspace || key.delete) {
      setInput((value) => value.slice(0, -1));
    } else if (key.ctrl && inputChar === "c") {
      exit();
    } else if (inputChar && !key.ctrl && !key.meta) {
      setInput((value) => value + inputChar);
      setCommandIndex(0);
    }
  });

  const visibleItems = useMemo(() => timeline.slice(historyMode ? -90 : -28), [historyMode, timeline]);
  const status = statusModel({ config: activeConfig, sessionId, turn, busy, approval, messageCount, hasSummary, permissionMode, aborting });
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
      {timeline.length === 0 && !streamingText ? <WelcomeScreen status={status} /> : <TimelinePanel items={visibleItems} streamingText={streamingText} expanded={expanded} detailsVisible={detailsVisible} historyMode={historyMode} />}
      {warnings.length > 0 ? <ConfigWarnings warnings={warnings} /> : null}
      {detailsVisible && timeline.length > 0 ? <DetailPanel detail={latestDetail} /> : null}
      {approval ? <ApprovalPanel approval={approval} /> : pendingPlan ? <PlanApprovalPanel plan={pendingPlan} expanded={expanded} /> : <InputBar busy={busy} input={input} permissionMode={permissionMode} detailsVisible={detailsVisible} expanded={expanded} aborting={aborting} />}
      {!approval && !pendingPlan && commandEntries.length > 0 ? <EnhancedCommandMenu entries={commandEntries} selectedIndex={selectedCommandIndex} /> : null}
    </Box>
  );
}

function PlanApprovalPanel({ plan, expanded }: { plan: PlanRecord; expanded: boolean }) {
  const rows = planSummaryRows(plan);
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column" marginTop={1}>
      <Box justifyContent="space-between">
        <Text color="cyan" bold>Plan ready</Text>
        <Text color="cyan">{plan.status}</Text>
      </Box>
      <Text color="white">{truncateEnd(plan.summary, 110)}</Text>
      <Box flexDirection="column">
        {rows.slice(0, 8).map((row) => (
          <Text key={row.label}><Text color="gray">{row.label}</Text> {truncateEnd(row.value, 96)}</Text>
        ))}
      </Box>
      {expanded ? <MarkdownBlock lines={markdownPreview(plan.answer, true)} accentColor="cyan" /> : null}
      <Text color="cyan">[y] execute  [n] cancel  [e] edit  [d] details</Text>
    </Box>
  );
}

function WelcomeScreen({ status }: { status: StatusModel }) {
  return (
    <Box borderStyle="single" borderColor="#c87943" paddingX={1} flexDirection="row" minHeight={8}>
      <Box flexDirection="column" width={33} alignItems="center" marginRight={2}>
        <Text color="#c87943">Mini Code v0.1.0</Text>
        <Text color="white" bold>Welcome back!</Text>
        <Text> </Text>
        {asciiArt.map((line, index) => (
          <Text key={index} color="#d98255">{line}</Text>
        ))}
        <Text color="gray">{truncateEnd(status.model, 20)} · API Usage Billing</Text>
        <Text color="gray">{status.cwd}</Text>
      </Box>
      <Box borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor="#7b4a34" paddingLeft={1} flexDirection="column" flexGrow={1}>
        <Text color="#d98255" bold>{welcomeTips.gettingStarted.title}</Text>
        {welcomeTips.gettingStarted.items.map((tip, index) => (
          <Text key={index} color="white">{truncateEnd(tip, 49)}</Text>
        ))}
        <Text> </Text>
        <Text color="#d98255" bold>{welcomeTips.whatsNew.title}</Text>
        {welcomeTips.whatsNew.items.map((item, index) => (
          <Text key={index} color="gray">{truncateEnd(item, 49)}</Text>
        ))}
      </Box>
    </Box>
  );
}

function ConfigWarnings({ warnings }: { warnings: string[] }) {
  return (
    <Box flexDirection="column" marginTop={2} marginBottom={1}>
      {warnings.map((warning, index) => {
        const lines = warning.split("\n");
        const [title, ...rest] = lines;
        return (
          <Box key={index} flexDirection="column" marginBottom={index === warnings.length - 1 ? 0 : 1}>
            <Text color="yellow" bold>{title}</Text>
            {rest.map((line, lineIndex) => (
              <Text key={lineIndex} color="yellow">{line}</Text>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}

function EnhancedCommandMenu({ entries, selectedIndex }: { entries: ReturnType<typeof filterCommandsAndSkills>; selectedIndex: number }) {
  return (
    <Box flexDirection="column" marginTop={0} borderStyle="single" borderColor="gray" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color="#d98255" bold>Commands</Text>
        <Text color="gray">↑/↓ select · enter run</Text>
      </Box>
      {entries.length === 0 ? (
        <Text color="gray">No matching commands</Text>
      ) : (
        entries.map((entry, index) => (
          <Box key={entry.command}>
            <Box width={2}>
              <Text color={index === selectedIndex ? "#d98255" : "gray"}>{index === selectedIndex ? "›" : " "}</Text>
            </Box>
            <Box width={27}>
              <Text color={index === selectedIndex ? "white" : "#bfc1ff"} bold={index === selectedIndex}>{truncateEnd(entry.command, 25)}</Text>
            </Box>
            <Text color="gray">{truncateEnd(entry.description, 62)}</Text>
          </Box>
        ))
      )}
    </Box>
  );
}

function HeaderBar({ status }: { status: StatusModel }) {
  return (
    <Box borderStyle="single" borderColor={stateColor(status.state)} paddingX={1} justifyContent="space-between">
      <Box gap={1}>
        <Text color="cyan" bold>Mini Code</Text>
        <Text color="gray">V0.1.0</Text>
      </Box>
      <Box gap={2}>
        <Text color={stateColor(status.state)}>● {status.state}</Text>
        <Text color="gray">{status.provider}:{truncateMiddle(status.model, 22)}</Text>
        <Text color={permissionModeColor(status.permissionMode)}>{permissionModeLabel(status.permissionMode)}</Text>
      </Box>
      <Box gap={2}>
        <Text color="gray">{status.cwd}</Text>
        <Text color="gray">#{truncateEnd(status.session, 10)}</Text>
        <Text color="gray">t{status.turn}</Text>
        <Text color={status.summary ? "cyan" : "gray"}>msg {status.messages}</Text>
      </Box>
    </Box>
  );
}

function CommandMenu() {
  return null;
}

function TimelinePanel({ items, streamingText, expanded, detailsVisible, historyMode }: { items: TimelineItem[]; streamingText: string; expanded: boolean; detailsVisible: boolean; historyMode: boolean }) {
  const blocks = timelineRenderBlocks(items.slice(-24), streamingText, expanded);
  return (
    <Box flexDirection="column" minHeight={18} marginTop={1}>
      <Box justifyContent="space-between">
        <Text color="#d98255" bold>Conversation</Text>
        <Text color="gray">latest {items.length}  details {detailsVisible ? "on" : "off"}  history {historyMode ? "extended" : "normal"}  diff {expanded ? "expanded" : "compact"}</Text>
      </Box>
      {blocks.length === 0 ? <Text color="gray">{emptyStates.timeline}</Text> : blocks.map((block, index) => <TimelineBlockRow key={`${index}-${block.kind}`} block={block} expanded={expanded} />)}
    </Box>
  );
}

function TimelineBlockRow({ block, expanded }: { block: TimelineRenderBlock; expanded: boolean }) {
  if (block.kind === "activity") return <ActivityRow block={block} />;
  return <MessageRow item={block.item} markdown={block.markdown} expanded={expanded} />;
}

function MessageRow({ item, markdown, expanded }: { item: TimelineItem; markdown?: MarkdownLine[]; expanded: boolean }) {
  const label = timelineLabel(item);
  const diffPreview = item.kind === "code_change" && expanded ? renderDiffLines(item.diff, expanded).slice(0, 14) : [];
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Box width={12}>
          <Text color={label.color}>{truncateEnd(label.marker, 10)}</Text>
        </Box>
        <Text color={label.severity === "muted" ? "gray" : "white"}>{truncateEnd(label.text.replace(/\s+/g, " "), 126)}</Text>
      </Box>
      {markdown ? (
        <Box marginLeft={12} flexDirection="column">
          <MarkdownBlock lines={markdown} accentColor={label.color} />
        </Box>
      ) : null}
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

function ActivityRow({ block }: { block: Extract<TimelineRenderBlock, { kind: "activity" }> }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Box width={12}>
          <Text color="gray">▹</Text>
        </Box>
        <Text color="gray">{block.summary}</Text>
      </Box>
      {block.details.length > 0 ? (
        <Box marginLeft={12} flexDirection="column">
          {block.details.map((detail, index) => (
            <Text key={`${index}-${detail}`} color="gray">{detail}</Text>
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
      {detail ? <MarkdownBlock lines={markdownPreview(detail.body, true)} accentColor={detail.color} /> : <Text color="gray">{emptyStates.detail}</Text>}
      {detail?.diffLines?.map((line, index) => (
        <Text key={`${index}-${line.text}`} color={line.color}>{line.text}</Text>
      ))}
    </Box>
  );
}

function ApprovalPanel({ approval }: { approval: PendingApproval }) {
  const blocked = Boolean(approval.requirement.denied || approval.requirement.blocked);
  const rows = approvalRows(approval);
  const scope = rows.find((row) => row.label === "scope")?.value;
  const command = rows.find((row) => row.label === "command")?.value;
  const cwd = rows.find((row) => row.label === "cwd")?.value;
  const riskReason = rows.find((row) => row.label === "riskReason")?.value;
  return (
    <Box borderStyle="round" borderColor={blocked ? "red" : "yellow"} paddingX={1} flexDirection="column" marginTop={1}>
      <Box justifyContent="space-between">
        <Text color={blocked ? "red" : "yellow"} bold>{blocked ? "Permission blocked" : "Permission required"}</Text>
        <Text color={blocked ? "red" : "yellow"}>{approval.tool}</Text>
      </Box>
      <Text color="white">{approval.description}</Text>
      <Text color="gray">{approval.requirement.reason}</Text>
      <Text> </Text>
      <Box flexDirection="column">
        <Text><Text color="gray">risk</Text>    <Text color={blocked ? "red" : "yellow"}>{approval.requirement.risk}</Text></Text>
        {scope ? <Text><Text color="gray">scope</Text>   {scope}</Text> : null}
        {command ? <Text><Text color="gray">command</Text> <Text color="#bfc1ff">{command}</Text></Text> : null}
        {cwd ? <Text><Text color="gray">cwd</Text>     {cwd}</Text> : null}
        {riskReason ? <Text><Text color="gray">why</Text>     {riskReason}</Text> : null}
      </Box>
      <Text> </Text>
      <Text color={blocked ? "red" : "yellow"}>{blockedApprovalText(approval)}</Text>
    </Box>
  );
}

function InputBar({ busy, input, permissionMode, detailsVisible, expanded, aborting }: { busy: boolean; input: string; permissionMode: StatusModel["permissionMode"]; detailsVisible: boolean; expanded: boolean; aborting: boolean }) {
  return (
    <Box borderStyle="single" borderLeft={false} borderRight={false} borderBottom={false} borderColor="gray" flexDirection="column" marginTop={1}>
      <Text color={busy ? (aborting ? "red" : "blue") : "white"}>{busy ? (aborting ? "aborting..." : "running") : "›"} {input || (busy ? "waiting for model" : "Ask, or type / for commands")}</Text>
      {busy ? <Text color="gray">{aborting ? "waiting for current operation to stop" : "esc abort"}</Text> : null}
      {!busy && (detailsVisible || expanded || permissionMode !== "default") ? (
        <Text color="gray">shift+tab {permissionModeLabel(permissionMode)}  |  /details {detailsVisible ? "on" : "off"}  |  /expand {expanded ? "on" : "off"}</Text>
      ) : null}
    </Box>
  );
}

function MarkdownBlock({ lines, accentColor = "cyan" }: { lines: MarkdownLine[]; accentColor?: string }) {
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <MarkdownRow key={`${index}-${line.kind}-${line.text}`} line={line} accentColor={accentColor} />
      ))}
    </Box>
  );
}

function MarkdownRow({ line, accentColor }: { line: MarkdownLine; accentColor: string }) {
  if (line.kind === "blank") return <Text> </Text>;
  if (line.kind === "heading") {
    const prefix = line.level && line.level > 2 ? "### " : line.level === 2 ? "## " : "# ";
    return <Text color={accentColor} bold>{prefix}{line.text}</Text>;
  }
  if (line.kind === "bullet") {
    return <IndentedText level={line.level}><Text color="gray">• </Text><InlineMarkdown text={line.text} /></IndentedText>;
  }
  if (line.kind === "ordered") {
    return <IndentedText level={line.level}><Text color="gray">{line.text.replace(/\s.+$/, " ")} </Text><InlineMarkdown text={line.text.replace(/^\d+[.)]\s+/, "")} /></IndentedText>;
  }
  if (line.kind === "task") {
    return <IndentedText level={line.level}><Text color={line.checked ? "green" : "gray"}>{line.checked ? "[x] " : "[ ] "}</Text><InlineMarkdown text={line.text} /></IndentedText>;
  }
  if (line.kind === "quote") {
    return <Text color="gray">│ {line.text}</Text>;
  }
  if (line.kind === "code") {
    return <Text color="#bfc1ff">{line.text}</Text>;
  }
  if (line.kind === "hr") {
    return <Text color="gray">{line.text}</Text>;
  }
  return <InlineMarkdown text={line.text} />;
}

function IndentedText({ level = 0, children }: { level?: number; children: React.ReactNode }) {
  return (
    <Box marginLeft={level * 2}>
      <Text>{children}</Text>
    </Box>
  );
}

function InlineMarkdown({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return (
    <Text color="white">
      {parts.map((part, index) => {
        if (part.startsWith("`") && part.endsWith("`")) return <Text key={index} color="#bfc1ff">{part.slice(1, -1)}</Text>;
        if (part.startsWith("**") && part.endsWith("**")) return <Text key={index} bold>{part.slice(2, -2)}</Text>;
        return <Text key={index}>{part}</Text>;
      })}
    </Text>
  );
}
