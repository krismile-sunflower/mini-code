import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { AgentSession } from "../core/agent.js";
import { SessionStore } from "../storage/sessionStore.js";
import type { AgentConfig, AgentEvent, ApprovalDecision, PendingApproval, PlanRecord, SkillInfo } from "../core/types.js";
import {
  approvalCardRows,
  asciiArt,
  blockedApprovalText,
  claudeActivityLines,
  claudeDisplay,
  decisionText,
  detailForItem,
  emptyStates,
  estimateRunUsage,
  eventToTimelineItems,
  filterCommandsAndSkills,
  inputStatusModel,
  markdownPreview,
  nextPermissionMode,
  planSummaryRows,
  permissionModeColor,
  permissionModeLabel,
  renderDiffLines,
  renderCommandHelp,
  skillPickerRows,
  stateColor,
  statusModel,
  timelineLabel,
  timelineRenderBlocks,
  tokenizeCodeLine,
  truncateEnd,
  truncateMiddle,
  welcomeTips,
  type StatusModel,
  type TimelineItem,
  type TimelineRenderBlock,
  type MarkdownLine,
  type CodeToken,
  type SkillPickerRow,
  type ActivityDisplayState,
  type RunUsageEstimate
} from "./renderModel.js";

interface QueuedRequest {
  id: string;
  text: string;
  createdAt: string;
}

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
  const [availableSkills, setAvailableSkills] = useState(skills);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [skillSearch, setSkillSearch] = useState("");
  const [skillIndex, setSkillIndex] = useState(0);
  const [turnStartedAt, setTurnStartedAt] = useState<number | undefined>();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [queuedRequests, setQueuedRequests] = useState<QueuedRequest[]>([]);
  const sessionRef = useRef<AgentSession | undefined>();
  const runningRef = useRef(false);
  const queueRef = useRef<QueuedRequest[]>([]);
  const queueIdRef = useRef(0);

  useEffect(() => {
    if (!busy || !turnStartedAt) return undefined;
    const updateElapsed = () => setElapsedSeconds(Math.max(1, Math.floor((Date.now() - turnStartedAt) / 1000)));
    updateElapsed();
    const timer = setInterval(updateElapsed, 1000);
    return () => clearInterval(timer);
  }, [busy, turnStartedAt]);

  const pushItems = (...items: TimelineItem[]) => {
    setTimeline((current) => [...current, ...items].slice(-240));
  };

  const setQueue = (next: QueuedRequest[]) => {
    queueRef.current = next;
    setQueuedRequests(next);
  };

  const enqueueRequest = (text: string) => {
    const item = { id: `q${++queueIdRef.current}`, text, createdAt: new Date().toISOString() };
    setQueue([...queueRef.current, item]);
    pushItems({ kind: "user", text, queued: true }, { kind: "session", text: `Queued ${item.id}: ${truncateEnd(text, 90)}` });
  };

  const takeQueuedRequest = (): QueuedRequest | undefined => {
    const [next, ...rest] = queueRef.current;
    setQueue(rest);
    return next;
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
    setAvailableSkills(session.getSkills());
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
    setAvailableSkills(session.getSkills());
    pushItems({ kind: "session", text: `${clearTimeline ? "New" : "Resumed"} session ${session.id}` });
    const capabilityChange = session.getCapabilityChangeSummary();
    if (capabilityChange) pushItems({ kind: "session", text: capabilityChange });
  };

  const submit = async (request: string) => {
    const trimmed = request.trim();
    if (!trimmed) return;
    setInput("");
    if (trimmed === "/exit" || trimmed === "/quit") {
      exit();
      return;
    }
    if (busy || runningRef.current) {
      enqueueRequest(trimmed);
      return;
    }
    await runRequest(trimmed);
  };

  const runRequest = async (trimmed: string, queued = false) => {
    runningRef.current = true;
    setBusy(true);
    setAborting(false);
    setTurnStartedAt(Date.now());
    setElapsedSeconds(0);
    try {
      const session = await startSession();
      if (queued) pushItems({ kind: "session", text: `Running queued request: ${truncateEnd(trimmed, 90)}` });
      if (trimmed === "/clear") {
        setTimeline([]);
      } else if (trimmed === "/" || trimmed === "/help") {
        pushItems({ kind: "session", text: renderCommandHelp() });
      } else if (trimmed === "/memory") {
        const { loadProjectMemory } = await import("../core/memory.js");
        const mem = await loadProjectMemory(activeConfig.cwd);
        pushItems({ kind: "session", text: mem || "No CLAUDE.md files found." });
      } else if (trimmed === "/init") {
        pushItems({ kind: "session", text: "Analysing repository to generate CLAUDE.md..." });
        const outPath = await session.initProjectMemory();
        pushItems({ kind: "session", text: `CLAUDE.md written to ${outPath}\nRestart or run /new to pick it up in the next session.` });
      } else if (trimmed === "/status") {
        pushItems({ kind: "session", text: session.describeStatus() });
      } else if (trimmed === "/model") {
        pushItems({ kind: "session", text: session.describeModel() });
      } else if (trimmed === "/config") {
        pushItems({ kind: "session", text: session.describeConfig() });
      } else if (trimmed === "/doctor") {
        pushItems({ kind: "session", text: session.describeDoctor() });
      } else if (trimmed === "/features") {
        pushItems({ kind: "session", text: session.describeFeatures() });
      } else if (trimmed === "/login") {
        pushItems({ kind: "session", text: session.describeLogin() });
      } else if (trimmed === "/tools") {
        pushItems({ kind: "session", text: session.describeTools() });
      } else if (trimmed === "/capabilities") {
        pushItems({ kind: "session", text: session.describeCapabilities() });
      } else if (trimmed === "/mcp") {
        pushItems({ kind: "session", text: await session.describeMcp("servers") });
      } else if (trimmed === "/mcp tools") {
        pushItems({ kind: "session", text: await session.describeMcp("tools") });
      } else if (trimmed === "/mcp resources") {
        pushItems({ kind: "session", text: await session.describeMcp("resources") });
      } else if (trimmed === "/mcp prompts") {
        pushItems({ kind: "session", text: await session.describeMcp("prompts") });
      } else if (trimmed.startsWith("/mcp reconnect ")) {
        pushItems({ kind: "session", text: session.reconnectMcp(trimmed.slice("/mcp reconnect ".length).trim()) });
      } else if (trimmed === "/permissions") {
        pushItems({ kind: "session", text: session.describePermissions() });
      } else if (trimmed === "/skills") {
        setAvailableSkills(session.getSkills());
        setSkillSearch("");
        setSkillIndex(0);
        setSkillPickerOpen(true);
      } else if (trimmed === "/queue") {
        const queued = queueRef.current;
        pushItems({ kind: "session", text: queued.length ? queued.map((item, index) => `${index + 1}. ${item.id} ${truncateEnd(item.text, 110)}`).join("\n") : "Queue is empty." });
      } else if (trimmed === "/queue clear") {
        const count = queueRef.current.length;
        setQueue([]);
        pushItems({ kind: "session", text: `Cleared ${count} queued request${count === 1 ? "" : "s"}.` });
      } else if (trimmed.startsWith("/skill inspect ")) {
        pushItems({ kind: "session", text: session.inspectSkill(trimmed.slice("/skill inspect ".length).trim()) });
      } else if (trimmed === "/skill reload") {
        const reloadSummary = await session.reloadSkills();
        setAvailableSkills(session.getSkills());
        pushItems({ kind: "session", text: reloadSummary });
      } else if (trimmed.startsWith("/skill create ")) {
        const { name, description } = parseSkillCreateRequest(trimmed.slice("/skill create ".length));
        const created = await session.createSkill(name, description);
        setAvailableSkills(session.getSkills());
        pushItems({ kind: "session", text: created });
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
      runningRef.current = false;
      setBusy(false);
      setAborting(false);
      setStreamingText("");
      const next = takeQueuedRequest();
      if (next) void runRequest(next.text, true);
    }
  };

  const commandEntries = useMemo(() => input.startsWith("/") ? filterCommandsAndSkills(input, availableSkills) : [], [input, availableSkills]);
  const selectedCommandIndex = commandEntries.length > 0 ? Math.min(commandIndex, commandEntries.length - 1) : 0;
  const skillRows = useMemo(() => skillPickerRows(availableSkills, skillSearch), [availableSkills, skillSearch]);
  const selectedSkillIndex = skillRows.length > 0 ? Math.min(skillIndex, skillRows.length - 1) : 0;

  useInput((inputChar, key) => {
    if (key.escape && busy) {
      setAborting(true);
      sessionRef.current?.abort();
      return;
    }
    if (key.ctrl && inputChar?.toLowerCase() === "o" && !approval && !pendingPlan && !skillPickerOpen) {
      setExpanded((value) => !value);
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
    if (skillPickerOpen) {
      if (key.escape) {
        if (skillSearch) {
          setSkillSearch("");
          setSkillIndex(0);
        } else {
          setSkillPickerOpen(false);
        }
        return;
      }
      if (key.upArrow) {
        setSkillIndex((value) => skillRows.length === 0 ? 0 : value <= 0 ? skillRows.length - 1 : value - 1);
        return;
      }
      if (key.downArrow || (key.tab && !key.shift)) {
        setSkillIndex((value) => skillRows.length === 0 ? 0 : (value + 1) % skillRows.length);
        return;
      }
      if (key.return) {
        const selected = skillRows[selectedSkillIndex];
        if (selected) {
          setSkillPickerOpen(false);
          setBusy(true);
          void startSession()
            .then((session) => session.useSkill(selected.skill.id, ""))
            .then((loaded) => pushItems({ kind: "session", text: loaded }))
            .catch((error) => pushItems({ kind: "error", category: "runtime", text: error instanceof Error ? error.message : String(error) }))
            .finally(() => setBusy(false));
        }
        return;
      }
      if (key.backspace || key.delete) {
        setSkillSearch((value) => value.slice(0, -1));
        setSkillIndex(0);
        return;
      }
      if (key.ctrl && inputChar === "c") {
        exit();
        return;
      }
      if (inputChar && !key.ctrl && !key.meta) {
        setSkillSearch((value) => value + inputChar);
        setSkillIndex(0);
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
  const hasConversation = visibleItems.length > 0 || Boolean(streamingText.trim());
  const showWelcome = !hasConversation && !skillPickerOpen;
  const usage = useMemo(() => estimateRunUsage(visibleItems, streamingText, elapsedSeconds), [elapsedSeconds, streamingText, visibleItems]);
  const activityState = useMemo<ActivityDisplayState>(() => ({
    running: busy,
    elapsedSeconds: usage.elapsedSeconds,
    outputTokens: usage.outputTokens,
    thoughtTokens: usage.thoughtTokens
  }), [busy, usage.elapsedSeconds, usage.outputTokens, usage.thoughtTokens]);

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
      {showWelcome ? <WelcomeScreen status={status} /> : null}
      {hasConversation ? <ClaudeTimelinePanel items={visibleItems} streamingText={streamingText} expanded={expanded} activityState={activityState} /> : null}
      {warnings.length > 0 ? <ConfigWarnings warnings={warnings} /> : null}
      {detailsVisible && timeline.length > 0 ? <DetailPanel detail={latestDetail} /> : null}
      {skillPickerOpen && !approval && !pendingPlan ? <SkillPickerPanel rows={skillRows} selectedIndex={selectedSkillIndex} query={skillSearch} total={availableSkills.length} /> : null}
      {approval ? <ApprovalPanel approval={approval} /> : pendingPlan ? <PlanApprovalPanel plan={pendingPlan} expanded={expanded} /> : skillPickerOpen ? null : <ClaudeInputBar status={status} usage={usage} input={input} detailsVisible={detailsVisible} expanded={expanded} aborting={aborting} hasConversation={hasConversation} queueCount={queuedRequests.length} />}
      {!approval && !pendingPlan && !skillPickerOpen && commandEntries.length > 0 ? <EnhancedCommandMenu entries={commandEntries} selectedIndex={selectedCommandIndex} /> : null}
    </Box>
  );
}

function parseSkillCreateRequest(value: string): { name: string; description: string } {
  const trimmed = value.trim();
  const [name = "", ...rest] = trimmed.split(/\s+/);
  return { name, description: rest.join(" ") };
}

function SkillPickerPanel({ rows, selectedIndex, query, total }: { rows: SkillPickerRow[]; selectedIndex: number; query: string; total: number }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="single" borderLeft={false} borderRight={false} borderTop={false} borderColor="#bfc1ff">
        <Text> </Text>
      </Box>
      <Box flexDirection="column" paddingX={2} marginTop={1}>
        <Text color="#bfc1ff" bold>Skills</Text>
        <Text color="gray">{total} skills  *  type to filter  *  up/down/enter to select  *  esc to clear</Text>
      </Box>
      <Box borderStyle="single" borderColor="#bfc1ff" paddingX={1} marginX={2} marginTop={1}>
        <Text color={query ? "white" : "gray"}>{query ? `Search skills... ${query}` : "Search skills..."}</Text>
      </Box>
      <Box flexDirection="column" marginX={2} marginTop={1}>
        {rows.length === 0 ? (
          <Text color="gray">No matching skills</Text>
        ) : rows.slice(0, 18).map((row, index) => (
          <SkillPickerRowView key={row.skill.id} row={row} selected={index === selectedIndex} />
        ))}
      </Box>
    </Box>
  );
}

function SkillPickerRowView({ row, selected }: { row: SkillPickerRow; selected: boolean }) {
  return (
    <Box>
      <Box width={2}>
        <Text color={selected ? "#bfc1ff" : "gray"}>{selected ? ">" : " "}</Text>
      </Box>
      <Box width={9}>
        <Text color={row.status === "on" ? "green" : "gray"}>{row.status === "on" ? "[x] on" : "[ ] off"}</Text>
      </Box>
      <Box width={30}>
        <Text color={selected ? "white" : "#d7d7ff"} bold={selected}>{truncateEnd(row.name, 28)}</Text>
      </Box>
      <Text color="gray">* {row.source} * ~{row.tokens} tok{row.detail ? ` * ${truncateEnd(row.detail, 44)}` : ""}</Text>
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
        {rows.map((row) => (
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
    <Box borderStyle="single" borderColor="#c87943" paddingX={1} flexDirection="row" minHeight={8} marginBottom={1}>
      <Box flexDirection="column" width={38} alignItems="center" marginRight={2}>
        <Text color="#ff7a45">Mini Code <Text color="gray">v0.1.0</Text></Text>
        <Text color="white" bold>Welcome back!</Text>
        <Box flexDirection="column" marginY={1}>
          {asciiArt.map((line, index) => (
            <Text key={index} color="#d98255">{line}</Text>
          ))}
        </Box>
        <Text color="gray">{truncateEnd(status.model, 22)} · API Usage Billing</Text>
        <Text color="gray">{status.cwd}</Text>
      </Box>
      <Box borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor="#7b4a34" paddingLeft={1} flexDirection="column" flexGrow={1}>
        <Text color="#ff7a45" bold>{welcomeTips.gettingStarted.title}</Text>
        {welcomeTips.gettingStarted.items.slice(0, 2).map((tip, index) => (
          <Text key={index} color="white">{truncateEnd(tip, 34)}</Text>
        ))}
        <Text color="#7b4a34">--------------------------------</Text>
        <Text color="#ff7a45" bold>{welcomeTips.whatsNew.title}</Text>
        {welcomeTips.whatsNew.items.slice(0, 4).map((item, index) => (
          <Text key={index} color="white">{truncateEnd(item, 34)}</Text>
        ))}
        <Text color="gray">/release-notes for more</Text>
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
        <Text color="gray">up/down select | enter run</Text>
      </Box>
      {entries.length === 0 ? (
        <Text color="gray">No matching commands</Text>
      ) : (
        entries.map((entry, index) => (
          <Box key={entry.command}>
            <Box width={2}>
              <Text color={index === selectedIndex ? "#d98255" : "gray"}>{index === selectedIndex ? ">" : " "}</Text>
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
        <Text color={stateColor(status.state)}>* {status.state}</Text>
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

function ClaudeTimelinePanel({ items, streamingText, expanded, activityState }: { items: TimelineItem[]; streamingText: string; expanded: boolean; activityState: ActivityDisplayState }) {
  const blocks = timelineRenderBlocks(items.slice(-24), streamingText, expanded);
  let activeActivityIndex = -1;
  if (activityState.running) {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      if (blocks[index]?.kind === "activity") {
        activeActivityIndex = index;
        break;
      }
    }
  }
  return (
    <Box flexDirection="column" minHeight={18}>
      {blocks.length === 0 ? <Text color="gray">{emptyStates.timeline}</Text> : blocks.map((block, index) => <ClaudeTimelineBlockRow key={`${index}-${block.kind}`} block={block} expanded={expanded} activityState={index === activeActivityIndex ? activityState : undefined} />)}
    </Box>
  );
}

function ClaudeTimelineBlockRow({ block, expanded, activityState }: { block: TimelineRenderBlock; expanded: boolean; activityState?: ActivityDisplayState }) {
  if (block.kind === "activity") return <ClaudeActivityRow block={block} expanded={expanded} activityState={activityState} />;
  return <ClaudeMessageRow item={block.item} markdown={block.markdown} expanded={expanded} />;
}

function ClaudeMessageRow({ item, markdown, expanded }: { item: TimelineItem; markdown?: MarkdownLine[]; expanded: boolean }) {
  const display = claudeDisplay(item);
  const diffPreview = item.kind === "code_change" && expanded ? renderDiffLines(item.diff, expanded).slice(0, 14) : [];
  if (item.kind === "user") {
    return (
      <Box marginTop={1} width="100%">
        <Text backgroundColor={display.background} color={display.markerColor}>{display.marker} </Text>
        <Text backgroundColor={display.background} color={display.textColor} bold>{item.text}</Text>
        {item.queued ? <Text backgroundColor={display.background} color="gray">  queued</Text> : null}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {display.marker ? <Text color={display.markerColor}>{display.marker} </Text> : null}
        {markdown ? null : <Text color={display.textColor}>{truncateEnd(timelineLabel(item).text.replace(/\s+/g, " "), 126)}</Text>}
      </Box>
      {markdown ? (
        <Box marginLeft={display.role === "assistant" ? 2 : 0} flexDirection="column">
          <ClaudeMarkdownBlock lines={markdown} accentColor={display.markerColor} />
        </Box>
      ) : null}
      {diffPreview.length > 0 ? (
        <Box marginLeft={2} flexDirection="column">
          {diffPreview.map((line, index) => (
            <Text key={`${index}-${line.text}`} color={line.color}>{truncateEnd(line.text, 126)}</Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function ClaudeActivityRow({ block, expanded, activityState }: { block: Extract<TimelineRenderBlock, { kind: "activity" }>; expanded: boolean; activityState?: ActivityDisplayState }) {
  const lines = claudeActivityLines(block.items, expanded, activityState);
  return (
    <Box flexDirection="column" marginTop={1}>
      {lines.map((line, index) => (
        <Box key={`${index}-${line.text}`}>
          <Text color={line.markerColor}>{line.marker} </Text>
          <Text color={line.textColor}>{line.text}</Text>
        </Box>
      ))}
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
  const rows = approvalCardRows(approval);
  return (
    <Box borderStyle="round" borderColor={blocked ? "red" : "yellow"} paddingX={1} flexDirection="column" marginTop={1}>
      <Box justifyContent="space-between">
        <Text color={blocked ? "red" : "yellow"} bold>{blocked ? "Permission blocked" : "Permission required"}</Text>
        <Text color={blocked ? "red" : "yellow"}>{approval.tool}</Text>
      </Box>
      <Text color="white">{approval.description}</Text>
      <Text> </Text>
      <Box flexDirection="column">
        {rows.map((row) => (
          <Text key={row.label}>
            <Text color="gray">{row.label.padEnd(8)}</Text>
            <Text color={approvalRowColor(row.tone, blocked)}>{truncateEnd(row.value, 110)}</Text>
          </Text>
        ))}
      </Box>
      <Text> </Text>
      <Text color={blocked ? "red" : "yellow"}>{blockedApprovalText(approval)}</Text>
    </Box>
  );
}

function approvalRowColor(tone: ReturnType<typeof approvalCardRows>[number]["tone"], blocked: boolean): string {
  if (blocked || tone === "danger") return "red";
  if (tone === "warning") return "yellow";
  if (tone === "accent") return "#bfc1ff";
  if (tone === "muted") return "gray";
  return "white";
}

function ClaudeInputBar({ status, usage, input, detailsVisible, expanded, aborting, hasConversation, queueCount }: { status: StatusModel; usage: RunUsageEstimate; input: string; detailsVisible: boolean; expanded: boolean; aborting: boolean; hasConversation: boolean; queueCount: number }) {
  const model = inputStatusModel({ status, promptInput: input, usage, hasConversation, expanded, detailsVisible, aborting, queueCount });
  return (
    <Box flexDirection="column" marginTop={hasConversation ? 1 : 2}>
      <Box borderStyle="single" borderLeft={false} borderRight={false} borderBottom={false} borderColor="gray">
        <Text> </Text>
      </Box>
      {model.runningLine ? <Text color={model.runningColor}>{model.runningLine}</Text> : <Text color={model.promptColor}>{model.prompt}</Text>}
      <Text color="gray">{model.usageLine}</Text>
      {model.hintLine ? <Text color="gray">{model.hintLine}</Text> : null}
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

function ClaudeMarkdownBlock({ lines, accentColor = "white" }: { lines: MarkdownLine[]; accentColor?: string }) {
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <ClaudeMarkdownRow key={`${index}-${line.kind}-${line.text}`} line={line} accentColor={accentColor} />
      ))}
    </Box>
  );
}

function ClaudeMarkdownRow({ line, accentColor }: { line: MarkdownLine; accentColor: string }) {
  if (line.kind === "blank") return <Text> </Text>;
  if (line.kind === "heading") return <Text color="white" bold>{line.text}</Text>;
  if (line.kind === "bullet") return <IndentedText level={line.level}><Text color="white">- </Text><InlineMarkdown text={line.text} /></IndentedText>;
  if (line.kind === "ordered") return <IndentedText level={line.level}><Text color="gray">{line.text.replace(/\s.+$/, " ")} </Text><InlineMarkdown text={line.text.replace(/^\d+[.)]\s+/, "")} /></IndentedText>;
  if (line.kind === "task") return <IndentedText level={line.level}><Text color={line.checked ? "green" : "gray"}>{line.checked ? "[x] " : "[ ] "}</Text><InlineMarkdown text={line.text} /></IndentedText>;
  if (line.kind === "quote") return <Text color="gray">| {line.text}</Text>;
  if (line.kind === "code") {
    if (line.text.startsWith("```")) return null;
    return <CodeLine line={line} />;
  }
  if (line.kind === "hr") return <Text color="gray">------------------------------------------------</Text>;
  return <InlineMarkdown text={line.text} accentColor={accentColor} />;
}

function CodeLine({ line }: { line: MarkdownLine }) {
  const tokens = tokenizeCodeLine(line.text, line.language);
  return (
    <Text>
      {tokens.map((token, index) => (
        <Text key={`${index}-${token.text}`} color={codeTokenColor(token)}>{token.text}</Text>
      ))}
    </Text>
  );
}

function codeTokenColor(token: CodeToken): string {
  if (token.kind === "key") return "#00bfff";
  if (token.kind === "string") return "#ff5f57";
  if (token.kind === "number" || token.kind === "boolean" || token.kind === "null") return "#ff9f43";
  if (token.kind === "punctuation") return "white";
  return "white";
}

function MarkdownRow({ line, accentColor }: { line: MarkdownLine; accentColor: string }) {
  if (line.kind === "blank") return <Text> </Text>;
  if (line.kind === "heading") {
    const prefix = line.level && line.level > 2 ? "### " : line.level === 2 ? "## " : "# ";
    return <Text color={accentColor} bold>{prefix}{line.text}</Text>;
  }
  if (line.kind === "bullet") {
    return <IndentedText level={line.level}><Text color="gray">- </Text><InlineMarkdown text={line.text} /></IndentedText>;
  }
  if (line.kind === "ordered") {
    return <IndentedText level={line.level}><Text color="gray">{line.text.replace(/\s.+$/, " ")} </Text><InlineMarkdown text={line.text.replace(/^\d+[.)]\s+/, "")} /></IndentedText>;
  }
  if (line.kind === "task") {
    return <IndentedText level={line.level}><Text color={line.checked ? "green" : "gray"}>{line.checked ? "[x] " : "[ ] "}</Text><InlineMarkdown text={line.text} /></IndentedText>;
  }
  if (line.kind === "quote") {
    return <Text color="gray">| {line.text}</Text>;
  }
  if (line.kind === "code") {
    return <Text color="#bfc1ff">{line.text}</Text>;
  }
  if (line.kind === "hr") {
    return <Text color="gray">------------------------------------------------</Text>;
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
function InlineMarkdown({ text, accentColor = "#bfc1ff" }: { text: string; accentColor?: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return (
    <Text color="white">
      {parts.map((part, index) => {
        if (part.startsWith("`") && part.endsWith("`")) return <Text key={index} color={accentColor}>{part.slice(1, -1)}</Text>;
        if (part.startsWith("**") && part.endsWith("**")) return <Text key={index} bold>{part.slice(2, -2)}</Text>;
        return <Text key={index}>{part}</Text>;
      })}
    </Text>
  );
}
