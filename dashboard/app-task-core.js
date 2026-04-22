import {
  TARGET_KIND_TEXT,
  sortByTimestampAsc,
  truncateText
} from "./app-utils.js?v=dashboard-live-20260422-4";
import { chooseCanonicalFlowFragment, getFlowFragmentTimestamp } from "./dashboard-flow-canonical.js";

function getRunTimestamp(run) {
  return getFlowFragmentTimestamp(run);
}

function parsePromptTimestamp(value) {
  const text = String(value || "");
  const metadataMatch = text.match(/"timestamp"\s*:\s*"([^"]+)"/i);
  if (metadataMatch?.[1]) {
    const parsed = parseLooseTimestamp(metadataMatch[1]);
    if (parsed) return parsed;
  }
  const inlineMatch = text.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})? GMT[+-]\d+)\]/i);
  if (inlineMatch?.[1]) {
    const parsed = parseLooseTimestamp(inlineMatch[1]);
    if (parsed) return parsed;
  }
  return "";
}

function parseLooseTimestamp(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  let normalized = text
    .replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+/i, "")
    .replace(/\s+GMT([+-]\d{1,2})$/i, (_, offset) => {
      const sign = offset.startsWith("-") ? "-" : "+";
      const hours = String(Math.abs(Number(offset))).padStart(2, "0");
      return ` ${sign}${hours}:00`;
    });
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(normalized)) normalized = `${normalized}:00`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/.test(normalized)) {
    normalized = normalized.replace(" ", "T").replace(" ", "");
  }
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function getUserAskedAt(sortedRuns) {
  for (const run of sortedRuns) {
    if (String(run?.userAskedAt || "").trim()) return String(run.userAskedAt);
  }
  for (const run of sortedRuns) {
    const promptText = String(run?.initialUserPrompt || run?.promptText || "");
    const parsed = parsePromptTimestamp(promptText);
    if (parsed) return parsed;
  }
  for (const run of sortedRuns) {
    const userEvent = (Array.isArray(run?.timelineEvents) ? run.timelineEvents : [])
      .find((item) => item?.role === "用户发起" && String(item?.timestamp || "").trim());
    if (userEvent?.timestamp) return String(userEvent.timestamp);
  }
  return "";
}

function isHeartbeatRun(run) {
  const promptText = String(run?.promptText || "").toLowerCase();
  const lastExternalMessage = String(run?.lastExternalMessage || "").toLowerCase();
  return (
    lastExternalMessage === "heartbeat_ok" ||
    promptText.includes("heartbeat.md") ||
    promptText.includes("reply heartbeat_ok") ||
    promptText.includes("if nothing needs attention, reply heartbeat_ok") ||
    promptText.includes("read heartbeat.md if it exists")
  );
}

function isSystemPromptText(value) {
  const promptText = String(value || "").toLowerCase();
  return (
    promptText.includes("<<<begin_openclaw_internal_context>>>") ||
    promptText.includes("[internal task completion event]") ||
    promptText.includes("system (untrusted):") ||
    promptText.includes("[subagent context]") ||
    promptText.includes("openclaw runtime context (internal)")
  );
}

function isGhostSystemFlow(run) {
  const promptText = String(run?.promptText || "").trim().toLowerCase();
  if (!/^system-untrusted-.*-exec-$/.test(promptText)) return false;
  return (
    !String(run?.flowCurrentStep || "").trim() &&
    !String(run?.lastExternalMessage || "").trim() &&
    !String(run?.lastBlockReason || "").trim() &&
    (!Array.isArray(run?.childTasks) || run.childTasks.length === 0) &&
    (!Array.isArray(run?.timelineEvents) || run.timelineEvents.length === 0)
  );
}

function looksLikeSystemSlug(value) {
  return /^system-untrusted-.*-exec-$/.test(String(value || "").trim().toLowerCase());
}

function hasMeaningfulUserPrompt(run) {
  const promptText = String(run?.initialUserPrompt || run?.promptText || "").trim();
  return Boolean(promptText) && !isSystemPromptText(promptText) && !looksLikeSystemSlug(promptText);
}

function isInternalOnlyCompletionText(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return false;
  return text.includes("handled internally") ||
    text.includes("handle the result internally") ||
    text.includes("no further action needed from this subtask") ||
    text.includes("no blocker surfaced from the result");
}

function shouldHideSystemContinuationCard(run) {
  if (hasMeaningfulUserPrompt(run)) return false;
  const lastExternalMessage = String(run?.lastExternalMessage || "").trim();
  if (lastExternalMessage && !isInternalOnlyCompletionText(lastExternalMessage)) return false;
  if (String(run?.lastBlockReason || "").trim()) return false;
  if (String(run?.flowWaitSummary || "").trim()) return false;
  if (String(run?.chainAssessment?.summary || "").trim()) return false;
  const promptText = String(run?.promptText || "").trim();
  if (!(isSystemPromptText(promptText) || looksLikeSystemSlug(promptText))) return false;
  return true;
}

function isTerminalChildPhase(phase) {
  return ["reported", "succeeded", "success", "completed", "done", "delivered", "failed", "blocked", "cancelled", "timed_out", "timeout"]
    .includes(String(phase || "").toLowerCase());
}

function choosePreferredPromptRun(runs) {
  const sorted = [...runs].sort((a, b) => getRunTimestamp(a).localeCompare(getRunTimestamp(b)));
  const firstMeaningful = sorted.find((run) => {
    const promptText = String(run?.initialUserPrompt || run?.promptText || "").trim();
    return promptText && !isSystemPromptText(promptText);
  });
  if (firstMeaningful) return firstMeaningful;
  return sorted.find((run) => String(run?.promptText || "").trim()) || sorted.at(-1) || null;
}

function mergeChildTasks(runs) {
  const merged = new Map();
  const sorted = [...runs].sort((a, b) => getRunTimestamp(a).localeCompare(getRunTimestamp(b)));
  for (const run of sorted) {
    for (const task of (Array.isArray(run?.childTasks) ? run.childTasks : [])) {
      const taskId = String(task?.taskId || "").trim();
      const sessionKey = String(task?.childSessionKey || "").trim();
      const dedupeKey = taskId || sessionKey;
      if (!dedupeKey) continue;
      const existing = merged.get(dedupeKey);
      const next = { ...(existing || {}), ...task };
      if (existing) {
        const existingTerminal = isTerminalChildPhase(existing.phase);
        const nextTerminal = isTerminalChildPhase(task?.phase);
        if (existingTerminal && !nextTerminal) {
          next.phase = existing.phase;
          next.progressSummary = existing.progressSummary || next.progressSummary;
          next.updatedAt = existing.updatedAt || next.updatedAt;
        }
      }
      merged.set(dedupeKey, next);
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => String(a.updatedAt || "").localeCompare(String(b.updatedAt || "")));
}

function mergeTimelineEvents(runs) {
  const seen = new Set();
  const items = [];
  for (const run of runs) {
    for (const event of (Array.isArray(run?.timelineEvents) ? run.timelineEvents : [])) {
      const key = [
        String(event?.timestamp || ""),
        String(event?.role || ""),
        String(event?.owner || ""),
        String(event?.text || "")
      ].join("\u0000");
      if (!event?.text || seen.has(key)) continue;
      seen.add(key);
      items.push(event);
    }
  }
  return items.sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
}

function summarizeMergedChildTasks(childTasks) {
  const byStatus = {};
  let active = 0;
  for (const task of childTasks) {
    const phase = String(task?.phase || "").toLowerCase() || "unknown";
    byStatus[phase] = (byStatus[phase] || 0) + 1;
    if (!isTerminalChildPhase(phase)) active += 1;
  }
  return {
    total: childTasks.length,
    active,
    terminal: Math.max(0, childTasks.length - active),
    failures: (byStatus.failed || 0) + (byStatus.blocked || 0) + (byStatus.cancelled || 0) + (byStatus.timeout || 0) + (byStatus.timed_out || 0),
    byStatus,
    byRuntime: {}
  };
}

function buildFlowCentricRun(groupRuns) {
  const sorted = [...groupRuns].sort((a, b) => getRunTimestamp(a).localeCompare(getRunTimestamp(b)));
  const primary = chooseCanonicalFlowFragment(sorted);
  if (!primary) return null;
  const promptSource = choosePreferredPromptRun(sorted);
  const userAskedAt = getUserAskedAt(sorted);
  const childTasks = mergeChildTasks(sorted);
  const timelineEvents = mergeTimelineEvents(sorted);
  return {
    ...primary,
    runId: String(primary.runId || primary.flowId || ""),
    flowRunIds: sorted.map((run) => String(run.runId || "").trim()).filter(Boolean),
    promptText: String(promptSource?.promptText || primary.promptText || ""),
    normalizedPromptText: String(promptSource?.normalizedPromptText || promptSource?.promptText || primary.normalizedPromptText || primary.promptText || ""),
    initialUserPrompt: hasMeaningfulUserPrompt(promptSource)
      ? String(promptSource?.initialUserPrompt || promptSource?.promptText || "")
      : "",
    childTasks,
    childTaskIds: childTasks.map((task) => String(task.taskId || "").trim()).filter(Boolean),
    flowTaskSummary: summarizeMergedChildTasks(childTasks),
    timelineEvents,
    userAskedAt,
    startedAt: String(sorted[0]?.startedAt || sorted[0]?.updatedAt || primary.startedAt || ""),
    updatedAt: getRunTimestamp(primary),
    lastExternalMessage: String(primary.lastExternalMessage || ""),
    lastBlockReason: String(primary.lastBlockReason || "")
  };
}

function getRunIdsForFlow(run) {
  const runIds = Array.isArray(run?.flowRunIds) ? run.flowRunIds : [run?.runId];
  return new Set(runIds.map((item) => String(item || "").trim()).filter(Boolean));
}

export function getDispatchesForRun(run, data) {
  const flowId = String(run?.flowId || "").trim();
  const runIds = getRunIdsForFlow(run);
  return (data.recentDispatches || []).filter((entry) => {
    const entryRunId = String(entry?.runId || "").trim();
    const entryFlowId = String(entry?.taskflow?.flowId || "").trim();
    if (flowId && entryFlowId && entryFlowId === flowId) return true;
    return entryRunId && runIds.has(entryRunId);
  });
}

export function getBlockersForRun(run, data) {
  const runIds = getRunIdsForFlow(run);
  return (data.recentBlockers || []).filter((entry) => {
    const entryRunId = String(entry?.runId || "").trim();
    return entryRunId && runIds.has(entryRunId);
  });
}

export function getEffectiveStatus(run) {
  const status = String(run?.status || "").toLowerCase();
  if (status === "completed" || status === "blocked") return status;
  const step = String(run?.flowCurrentStep || "").toLowerCase();
  if (step === "reviewing") return "reviewing";
  if (step === "blocked" || step === "failed" || step === "cancelled") return "blocked";
  if (step === "waiting_child" || step === "awaiting_user_input") return "waiting";
  if (step === "delegated") return "delegated";
  if (step === "routing" || step === "planned" || step === "intake" || step === "finalizing") return "coordinating";
  if (status) return status;
  return String(run?.flowStatus || "").toLowerCase();
}

export function getLatestDispatch(run, data) {
  return getDispatchesForRun(run, data)
    .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))[0] || null;
}

export function getLatestBlocker(run, data) {
  return getBlockersForRun(run, data)
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
  const groups = new Map();
  for (const run of [...active, ...recent]) {
    if (!run.taskFlowSeen || !String(run.flowId || "").trim()) continue;
    if (run.hiddenInDashboard) continue;
    if (String(run.parentFlowId || "").trim()) continue;
    if (isHeartbeatRun(run)) continue;
    const flowId = String(run.flowId || "").trim();
    const bucket = groups.get(flowId) || [];
    bucket.push(run);
    groups.set(flowId, bucket);
  }
  return Array.from(groups.values())
    .map((groupRuns) => buildFlowCentricRun(groupRuns))
    .filter(Boolean)
    .filter((run) => !isGhostSystemFlow(run))
    .filter((run) => !shouldHideSystemContinuationCard(run))
    .filter((run) => {
      const promptText = String(run.promptText || "").trim();
      const hasMeaningfulPrompt = promptText && !isSystemPromptText(promptText);
      return hasMeaningfulPrompt || Boolean(run.lastExternalMessage) || (Array.isArray(run.childTasks) && run.childTasks.length > 0);
    })
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
  const promptText = String(run?.initialUserPrompt || run?.promptText || "");
  const raw = stripPromptMetadata(promptText);
  const firstMeaningfulLine = raw
    .split(/\n+/)
    .map((line) => line.trim())
    .find((line) =>
      line &&
      !/^```/.test(line) &&
      !/^[{\[]/.test(line) &&
      !/^(conversation info|sender|recipient|system)/i.test(line)
    );
  const fallback = isSystemPromptText(promptText) ? "异步结果续跑任务" : "";
  return truncateText(firstMeaningfulLine || raw || run.lastExternalMessage || fallback || "任务处理中", 52);
}

export function getAgentDisplayName(data, agentId) {
  if (!agentId) return "相关 Agent";
  const match = (data.agentRoster || []).find((agent) => agent.agentId === agentId);
  return match?.displayName || agentId;
}

export function buildTaskChain(run, data) {
  const nodes = [];
  const seen = new Set();
  const dispatches = sortByTimestampAsc(
    getDispatchesForRun(run, data),
    (entry) => entry.timestamp
  );
  const childTasks = sortByTimestampAsc(Array.isArray(run.childTasks) ? run.childTasks : [], (task) => task.updatedAt);
  const deliveredChildren = childTasks.filter((task) => isTerminalChildPhase(task.phase));
  const activeChildren = childTasks.filter((task) => !isTerminalChildPhase(task.phase));
  const hasVisibleReply =
    Boolean(run.lastExternalMessage) ||
    Array.isArray(run.timelineEvents) && run.timelineEvents.some((item) => item?.role === "最终回复");
  const addNode = (id, title, note = "") => {
    const normalizedId = String(id || "").trim() || title;
    if (!normalizedId || seen.has(normalizedId)) return;
    seen.add(normalizedId);
    nodes.push({ id: normalizedId, title, note });
  };

  addNode("user-request", "用户问句", deriveTaskSummary(run));
  addNode(`stage:intake:${run.flowId}`, "主控接单", getAgentDisplayName(data, run.agentId));

  if (dispatches.length > 0) {
    const latestDispatch = dispatches.at(-1);
    const dispatchTargets = Array.from(new Set(
      dispatches.map((entry) => getAgentDisplayName(data, entry.target?.agentId)).filter(Boolean)
    ));
    addNode(
      `stage:dispatch:${run.flowId}`,
      "任务分派",
      dispatchTargets.length > 0
        ? `${dispatchTargets.join("、")} · ${dispatches.length} 次`
        : getRouteLabel(latestDispatch?.target)
    );
  }

  if (childTasks.length > 0) {
    const ownerNames = Array.from(new Set(
      childTasks.map((task) => getAgentDisplayName(data, task.agentId)).filter(Boolean)
    ));
    const note = activeChildren.length > 0
      ? `${ownerNames.join("、") || "相关 Agent"} · ${activeChildren.length} 处理中`
      : `${ownerNames.join("、") || "相关 Agent"} · ${deliveredChildren.length} 已交付`;
    addNode(`stage:evidence:${run.flowId}`, "子任务反馈", note);
  }

  if (run.flowCurrentStep === "reviewing" || getEffectiveStatus(run) === "reviewing" || hasVisibleReply) {
    addNode(`stage:review:${run.flowId}`, "主控汇总", getAgentDisplayName(data, run.agentId));
  }

  if (hasVisibleReply) {
    addNode(
      "user-delivery",
      "回复用户",
      getEffectiveStatus(run) === "completed" ? "已交付" : "最近一次对外更新"
    );
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
  const flowRuns = Array.isArray(run.flowRunIds) ? run.flowRunIds.length : 1;
  const childTotal = Array.isArray(run.childTasks) ? run.childTasks.length : 0;
  const deliveredCount = (Array.isArray(run.childTasks) ? run.childTasks : []).filter((task) => isTerminalChildPhase(task.phase)).length;
  const facts = [
    { label: "用户问句", value: deriveTaskSummary(run) },
    { label: "Coordinator", value: getAgentDisplayName(data, run.agentId) },
    { label: "当前处理人", value: getAgentDisplayName(data, getCurrentOwner(run, data)) },
    { label: "Task Route", value: getRouteLabel(latestDispatch?.target) },
    { label: "Current Step", value: getCurrentProgress(run, data) },
    { label: "Flow 续跑", value: `${flowRuns} 次` },
    { label: "子任务证据", value: childTotal > 0 ? `${deliveredCount}/${childTotal}` : "-" }
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
