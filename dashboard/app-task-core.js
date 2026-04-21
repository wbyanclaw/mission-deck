import {
  TARGET_KIND_TEXT,
  sortByTimestampAsc,
  truncateText
} from "./app-utils.js";

export function getEffectiveStatus(run) {
  return String(run?.status || run?.flowStatus || "").toLowerCase();
}

export function getLatestDispatch(run, data) {
  return (data.recentDispatches || [])
    .filter((entry) => entry.runId === run.runId)
    .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))[0] || null;
}

export function getLatestBlocker(run, data) {
  return (data.recentBlockers || [])
    .filter((entry) => entry.runId === run.runId)
    .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))[0] || null;
}

export function getRouteLabel(target) {
  return TARGET_KIND_TEXT[target?.targetKind] || "正在进行内部协作";
}

export function humanizeLatestDetail(run, latestBlocker) {
  if (run.flowWaitSummary) return run.flowWaitSummary;
  if (latestBlocker?.reason) return latestBlocker.reason;
  if (run.lastExternalMessage) return run.lastExternalMessage;

  const status = String(run.lastToolStatus || "").toLowerCase();
  if (status === "sent" || status === "succeeded" || status === "success" || status === "accepted") {
    return "交接已完成，后续动作正在推进。";
  }
  if (status === "running" || status === "in_progress" || status === "pending") {
    return "相关 Agent 正在处理中。";
  }
  if (status === "timeout" || status === "timed_out") {
    return "等待时间较长，可能需要新的输入或继续跟进。";
  }
  if (status === "failed" || status === "error") {
    return "当前处理链路遇到异常，需要重新跟进。";
  }
  if (status === "unknown") {
    return "已发出跟进动作，正在等待结果。";
  }

  if (run.status === "blocked") return "任务当前被阻塞，需要决策或新的输入。";
  if (run.lastEvent) return "任务仍在推进，最新步骤已记录。";
  return "任务仍在处理中。";
}

export function getFlowStepText(run) {
  const step = String(run.flowCurrentStep || "").trim();
  if (!step) return "";
  return step
    .replaceAll(/[:_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildTaskCards(data) {
  const active = Array.isArray(data.activeRuns) ? data.activeRuns : [];
  const recent = Array.isArray(data.recentRuns) ? data.recentRuns : [];
  const unique = new Map();
  for (const run of [...active, ...recent]) {
    if (!run.taskFlowSeen || !String(run.flowId || "").trim()) continue;
    const promptText = String(run.promptText || "").toLowerCase();
    const lastExternalMessage = String(run.lastExternalMessage || "").toLowerCase();
    const isHeartbeat =
      lastExternalMessage === "heartbeat_ok" ||
      promptText.includes("heartbeat.md") ||
      promptText.includes("reply heartbeat_ok") ||
      promptText.includes("if nothing needs attention, reply heartbeat_ok") ||
      promptText.includes("read heartbeat.md if it exists");
    const isSystemRun =
      promptText.includes("<<<begin_openclaw_internal_context>>>") ||
      promptText.includes("[internal task completion event]") ||
      promptText.includes("system (untrusted):") ||
      promptText.includes("[subagent context]") ||
      promptText.includes("openclaw runtime context (internal)");
    if (isHeartbeat || isSystemRun) continue;
    const runId = run.runId || `${run.agentId || "unknown"}:${run.startedAt || ""}`;
    const existing = unique.get(runId);
    if (!existing || String(run.updatedAt || run.startedAt || "") > String(existing.updatedAt || existing.startedAt || "")) {
      unique.set(runId, run);
    }
  }
  return Array.from(unique.values())
    .sort((a, b) => String(b.updatedAt || b.startedAt || "").localeCompare(String(a.updatedAt || a.startedAt || "")));
}

export function stripPromptMetadata(value) {
  return String(value || "")
    .replace(/Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```/gi, "")
    .replace(/Sender \(untrusted metadata\):\s*```json[\s\S]*?```/gi, "")
    .replace(/Recipient \(untrusted metadata\):\s*```json[\s\S]*?```/gi, "")
    .replace(/System \(untrusted\):[\s\S]*$/gi, "")
    .replace(/<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*$/gi, "")
    .replace(/\[Internal task completion event][\s\S]*$/gi, "")
    .replace(/\[Subagent Context][\s\S]*?\[Subagent Task]:/gi, "")
    .replace(/\[message_id:[^\]]+\]/gi, "")
    .replace(/Current time:[^\n]*\n?/gi, "")
    .replace(/Return your response as plain text[^\n]*\n?/gi, "")
    .replace(/\[(Sat|Sun|Mon|Tue|Wed|Thu|Fri) .*?\]\s*/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .trim();
}

export function deriveTaskSummary(run) {
  const raw = stripPromptMetadata(run.promptText);
  const firstMeaningfulLine = raw
    .split(/\n+/)
    .map((line) => line.trim())
    .find((line) =>
      line &&
      !/^```/.test(line) &&
      !/^[{\[]/.test(line) &&
      !/^(conversation info|sender|recipient|system)/i.test(line)
    );
  return truncateText(firstMeaningfulLine || raw || run.lastExternalMessage || "任务处理中", 52);
}

export function getAgentDisplayName(data, agentId) {
  if (!agentId) return "相关 Agent";
  const match = (data.agentRoster || []).find((agent) => agent.agentId === agentId);
  return match?.displayName || agentId;
}

export function buildTaskChain(run, data) {
  const nodes = [];
  const seen = new Set();
  const addNode = (id, title, note = "") => {
    const normalizedId = String(id || "").trim() || title;
    if (!normalizedId || seen.has(normalizedId)) return;
    seen.add(normalizedId);
    nodes.push({ id: normalizedId, title, note });
  };

  addNode("user-request", "用户问句", deriveTaskSummary(run));
  addNode(`agent:${run.agentId}`, getAgentDisplayName(data, run.agentId), "Coordinator");

  const dispatches = sortByTimestampAsc(
    (data.recentDispatches || []).filter((entry) => entry.runId === run.runId),
    (entry) => entry.timestamp
  );
  for (const entry of dispatches) {
    const targetAgentId = String(entry.target?.agentId || "").trim();
    if (!targetAgentId) continue;
    addNode(
      `agent:${targetAgentId}`,
      getAgentDisplayName(data, targetAgentId),
      entry.target?.routeType === "spawn" ? "Spawn 通道" : "复用 Session"
    );
  }

  const childTasks = sortByTimestampAsc(Array.isArray(run.childTasks) ? run.childTasks : [], (task) => task.updatedAt);
  for (const task of childTasks) {
    const taskAgentId = String(task.agentId || "").trim();
    if (!taskAgentId) continue;
    addNode(`agent:${taskAgentId}`, getAgentDisplayName(data, taskAgentId), `Child Task: ${task.phase || "progress"}`);
  }

  if (run.lastExternalMessage) {
    addNode("user-delivery", "用户交付", getEffectiveStatus(run) === "completed" ? "已交付" : "最近一次对外更新");
  }

  return nodes;
}

export function getCurrentOwner(run, data) {
  const latestDispatch = getLatestDispatch(run, data);
  return run.childTasks?.at?.(-1)?.agentId ||
    latestDispatch?.target?.agentId ||
    run.agentId ||
    "待分配";
}

export function getCurrentProgress(run, data) {
  if (run.flowWaitSummary) return run.flowWaitSummary;
  if (getFlowStepText(run)) return `当前阶段：${getFlowStepText(run)}`;
  return run.childTasks?.at?.(-1)?.progressSummary ||
    run.lastExternalMessage ||
    humanizeLatestDetail(run, getLatestBlocker(run, data));
}

export function buildTaskChainFacts(run, data) {
  const latestDispatch = getLatestDispatch(run, data);
  const facts = [
    { label: "用户问句", value: deriveTaskSummary(run) },
    { label: "Coordinator", value: getAgentDisplayName(data, run.agentId) },
    { label: "当前处理人", value: getAgentDisplayName(data, getCurrentOwner(run, data)) },
    { label: "Task Route", value: getRouteLabel(latestDispatch?.target) },
    { label: "Current Step", value: getCurrentProgress(run, data) }
  ];
  if (run.chainAssessment?.summary) {
    facts.push({ label: "链路体检", value: run.chainAssessment.summary });
  }
  if (run.chainAssessment?.missing) {
    facts.push({ label: "当前缺口", value: run.chainAssessment.missing });
  }
  if (run.chainAssessment?.nextAction) {
    facts.push({ label: "下一步", value: run.chainAssessment.nextAction });
  }
  return facts;
}
