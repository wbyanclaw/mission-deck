import { normalizeString } from "./orchestrator-helpers.js";
import { MAX_RECENT_DISPATCHES, MAX_RECENT_RUNS } from "./dashboard-persistence.js";
import {
  chooseCanonicalFlowFragment,
  getFlowFragmentTimestamp
} from "../dashboard/dashboard-flow-canonical.js";

function isLiveRun(entry) {
  const flowStatus = normalizeString(entry?.flowStatus).toLowerCase();
  const status = normalizeString(entry?.status).toLowerCase();
  if (["running", "waiting"].includes(flowStatus)) return true;
  if (["triaging", "coordinating", "delegated", "lane_open", "waiting"].includes(status)) return true;
  const childTasks = Array.isArray(entry?.childTasks) ? entry.childTasks : [];
  if (childTasks.some((task) => !["reported", "succeeded", "success", "completed", "done", "failed", "blocked", "cancelled", "timed_out", "timeout"].includes(normalizeString(task?.phase).toLowerCase()))) return true;
  return Math.max(0, Number(entry?.flowTaskSummary?.active) || 0) > 0;
}

function mergeLiveRuns(activeRuns, recentRuns) {
  const merged = new Map();
  const appendEntry = (entry) => {
    const flowKey = normalizeString(entry?.flowId);
    const runId = normalizeString(entry?.runId);
    const dedupeKey = flowKey || runId;
    if (!dedupeKey) return;
    const bucket = merged.get(dedupeKey) || [];
    bucket.push(entry);
    merged.set(dedupeKey, bucket);
  };

  for (const entry of activeRuns) {
    appendEntry(entry);
  }
  for (const entry of recentRuns) {
    const flowKey = normalizeString(entry?.flowId);
    const runId = normalizeString(entry?.runId);
    const dedupeKey = flowKey || runId;
    if (!dedupeKey) continue;
    if (isLiveRun(entry) || merged.has(dedupeKey)) {
      appendEntry(entry);
    }
  }
  return Array.from(merged.values())
    .map((entries) => chooseCanonicalFlowFragment(entries))
    .filter(Boolean)
    .sort((a, b) => getFlowFragmentTimestamp(b).localeCompare(getFlowFragmentTimestamp(a)));
}

function summarizeAgentLoad(activeRuns) {
  const byAgent = new Map();
  const ensureEntry = (agentId) => {
    const normalized = normalizeString(agentId) || "unknown";
    const existing = byAgent.get(normalized);
    if (existing) return existing;
    const created = { agentId: normalized, activeRuns: 0, delegatedRuns: 0, blockedRuns: 0, childTasks: 0, taskflowRuns: 0, updatedAt: "" };
    byAgent.set(normalized, created);
    return created;
  };

  for (const run of activeRuns) {
    const owner = ensureEntry(run.agentId);
    owner.activeRuns += 1;
    owner.childTasks += Array.isArray(run.childTaskIds) ? run.childTaskIds.length : 0;
    if (run.status === "delegated") owner.delegatedRuns += 1;
    if (run.status === "blocked") owner.blockedRuns += 1;
    if (run.taskFlowSeen) owner.taskflowRuns += 1;
    if (String(run.updatedAt) > String(owner.updatedAt)) owner.updatedAt = run.updatedAt;
  }

  return Array.from(byAgent.values()).sort((a, b) => b.activeRuns - a.activeRuns || String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function summarizeResourceSignals(run) {
  const promptLoad = Math.max(0, Number(run?.promptLength) || 0);
  const taskCount = Array.isArray(run?.childTaskIds) ? run.childTaskIds.length : 0;
  const activityCount = Array.isArray(run?.activityTrail) ? run.activityTrail.length : 0;
  const contextPressure = Math.min(100, Math.round(promptLoad / 40 + taskCount * 12 + activityCount * 4));
  const tokenProxy = promptLoad * 3 + activityCount * 180 + taskCount * 320;
  return { contextPressure, tokenProxy };
}

function buildActivitySparkline(points) {
  const safePoints = Array.isArray(points) && points.length ? points : [0, 0, 0, 0, 0, 0];
  return safePoints.map((value, index) => ({ x: index, y: Number(value) || 0 }));
}

function isRecentDispatchActive(entry, nowMs = Date.now()) {
  const timestamp = new Date(entry?.timestamp || "").getTime();
  if (!Number.isFinite(timestamp)) return false;
  return nowMs - timestamp < 15 * 60 * 1000;
}

function isVisibleRootTaskflowRun(run) {
  const promptText = normalizeString(run?.initialUserPrompt || run?.promptText).toLowerCase();
  if (
    promptText.includes("[subagent context]") ||
    promptText.includes("you are running as a subagent")
  ) {
    return false;
  }
  return Boolean(
    normalizeString(run?.flowId) &&
    run?.taskFlowSeen &&
    !run?.hiddenInDashboard &&
    !normalizeString(run?.parentFlowId)
  );
}

function isVisibleExecutingTaskflowRun(run) {
  if (!isVisibleRootTaskflowRun(run)) return false;
  const flowStep = normalizeString(run?.flowCurrentStep).toLowerCase();
  const flowStatus = normalizeString(run?.flowStatus).toLowerCase();
  const status = normalizeString(run?.status).toLowerCase();
  return (
    ["waiting_child", "awaiting_user_input", "reviewing", "delegated", "routing", "planned", "intake", "finalizing"].includes(flowStep) ||
    ["running", "waiting"].includes(flowStatus) ||
    ["waiting", "reviewing", "delegated", "lane_open", "coordinating", "triaging"].includes(status)
  );
}

function buildActivityBuckets(agentId, activeRuns, recentDispatches, recentBlockers) {
  const buckets = [0, 0, 0, 0, 0, 0];
  const now = Date.now();
  const mark = (timestamp, weight = 1) => {
    const time = new Date(timestamp).getTime();
    if (!Number.isFinite(time)) return;
    const ageMinutes = Math.max(0, Math.floor((now - time) / 60000));
    const bucketIndex = Math.min(5, Math.floor(ageMinutes / 10));
    buckets[5 - bucketIndex] += weight;
  };
  for (const run of activeRuns.filter((entry) => entry.agentId === agentId)) mark(run.updatedAt, 2);
  for (const entry of recentDispatches.filter((item) => item.agentId === agentId)) mark(entry.timestamp, 2);
  for (const entry of recentBlockers.filter((item) => item.agentId === agentId)) mark(entry.timestamp, 1);
  return buildActivitySparkline(buckets);
}

function buildAgentCapabilities(meta, options) {
  const caps = [];
  if (meta?.profile === "coding") caps.push({ icon: "💻", label: "代码" });
  if (meta?.profile === "messaging") caps.push({ icon: "💬", label: "沟通" });
  if (options?.webEnabled) caps.push({ icon: "🌐", label: "网页" });
  if (options?.fsEnabled && meta?.profile === "coding") caps.push({ icon: "📁", label: "文件" });
  if ((meta?.allowAgents || []).length > 0) caps.push({ icon: "🤝", label: "协同" });
  return caps.slice(0, 5);
}

function buildAgentRoster(configuredAgents, agentLoad, activeRuns, recentDispatches, recentBlockers, options = {}) {
  const loadMap = new Map(agentLoad.map((entry) => [entry.agentId, entry]));
  const nowMs = Date.now();
  return configuredAgents.map((agentMeta) => {
    const agentId = normalizeString(agentMeta?.agentId || agentMeta);
    const load = loadMap.get(agentId);
    const ownedRuns = activeRuns.filter((entry) => entry.agentId === agentId);
    const visibleExecutingRuns = ownedRuns.filter((entry) => isVisibleExecutingTaskflowRun(entry));
    const hasRecentActiveDispatch = recentDispatches.some((entry) =>
      entry?.agentId === agentId && isRecentDispatchActive(entry, nowMs)
    );
    const latestRun = ownedRuns.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] || null;
    const queueDepth = visibleExecutingRuns.length + (hasRecentActiveDispatch ? 1 : 0);
    const { contextPressure, tokenProxy } = summarizeResourceSignals(latestRun);
    return {
      agentId,
      displayName: normalizeString(agentMeta?.displayName) || agentId,
      emoji: normalizeString(agentMeta?.emoji),
      theme: normalizeString(agentMeta?.theme),
      profile: normalizeString(agentMeta?.profile),
      isDefault: Boolean(agentMeta?.isDefault),
      orderIndex: Number(agentMeta?.orderIndex ?? 0),
      allowAgents: Array.isArray(agentMeta?.allowAgents) ? agentMeta.allowAgents : [],
      capabilities: buildAgentCapabilities({ ...agentMeta, agentId }, options),
      state: visibleExecutingRuns.length > 0 || hasRecentActiveDispatch ? "busy" : "idle",
      activeRuns: visibleExecutingRuns.length,
      delegatedRuns: load?.delegatedRuns ?? 0,
      blockedRuns: load?.blockedRuns ?? 0,
      childTasks: load?.childTasks ?? 0,
      queueDepth,
      heartbeatAt: load?.updatedAt ?? "",
      updatedAt: load?.updatedAt ?? "",
      contextPressure,
      tokenProxy,
      activitySparkline: buildActivityBuckets(agentId, activeRuns, recentDispatches, recentBlockers)
    };
  });
}

function summarizeFlowHealth(activeRuns) {
  return activeRuns
    .filter((run) => normalizeString(run.flowId))
    .map((run) => ({
      flowId: run.flowId,
      agentId: run.agentId,
      status: run.status,
      childTasks: Array.isArray(run.childTaskIds) ? run.childTaskIds.length : 0,
      taskflowSeen: Boolean(run.taskFlowSeen),
      lastEvent: run.lastEvent,
      updatedAt: run.updatedAt
    }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, MAX_RECENT_RUNS);
}

function summarizeChildTasks(activeRuns) {
  return activeRuns
    .flatMap((run) => (Array.isArray(run.childTasks) ? run.childTasks.map((task) => ({
      taskId: task.taskId,
      flowId: run.flowId,
      ownerAgentId: normalizeString(task.agentId) || "unknown",
      parentAgentId: run.agentId,
      phase: normalizeString(task.phase) || "queued",
      progressSummary: normalizeString(task.progressSummary) || normalizeString(run.lastToolStatus) || normalizeString(run.lastEvent) || "awaiting update",
      updatedAt: normalizeString(task.updatedAt) || normalizeString(run.updatedAt),
      label: normalizeString(task.label),
      childSessionKey: normalizeString(task.childSessionKey),
      targetKind: normalizeString(task.targetKind),
      sessionScope: normalizeString(task.sessionScope)
    })) : []))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, MAX_RECENT_DISPATCHES);
}

function calculateAutonomyScore(engineeringRuns) {
  if (engineeringRuns.length === 0) return 0;
  let score = 0;
  for (const run of engineeringRuns) {
    if (run.internalCoordinationSeen) score += 20;
    if (run.workspaceDiscoverySeen) score += 20;
    if (run.executionLaneSeen) score += 25;
    if (run.taskFlowSeen) score += 20;
    if ((run.childTaskIds || []).length > 0) score += 15;
  }
  return Math.max(0, Math.min(100, Math.round(score / engineeringRuns.length)));
}

function calculateSuccessRate(recentRuns) {
  const visible = recentRuns.filter((entry) => entry.engineeringTask);
  if (!visible.length) return 0;
  const successful = visible.filter((entry) => entry.status !== "blocked").length;
  return Math.round((successful / visible.length) * 100);
}

function buildDeliveryHub(recentRuns, activeRuns) {
  return [...activeRuns, ...recentRuns]
    .filter((run) => normalizeString(run.lastExternalMessage) || (Array.isArray(run.childTasks) && run.childTasks.length > 0))
    .map((run) => ({
      runId: run.runId,
      agentId: run.agentId,
      title: normalizeString(run.promptText) || "未命名任务",
      status: run.status,
      summary: normalizeString(run.lastExternalMessage) || normalizeString(run.childTasks?.at?.(-1)?.progressSummary) || "已生成新的处理结果",
      updatedAt: normalizeString(run.updatedAt),
      flowId: normalizeString(run.flowId)
    }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 10);
}

function buildConsoleFeed(recentDispatches, recentBlockers, recentRuns) {
  const items = [
    ...recentDispatches.map((entry) => ({
      timestamp: entry.timestamp,
      level: "info",
      agentId: entry.agentId,
      message: `${entry.agentId} 发起协作 -> ${entry.target?.agentId || entry.target?.childSessionKey || "unknown"} (${entry.status || "unknown"})`
    })),
    ...recentBlockers.map((entry) => ({
      timestamp: entry.timestamp,
      level: "warn",
      agentId: entry.agentId,
      message: `${entry.agentId} 遇到阻塞: ${entry.reason}`
    })),
    ...recentRuns.map((entry) => ({
      timestamp: entry.updatedAt || entry.startedAt,
      level: entry.status === "blocked" ? "warn" : "info",
      agentId: entry.agentId,
      message: `${entry.agentId} 当前状态: ${entry.status}`
    }))
  ];
  return items
    .filter((entry) => normalizeString(entry.timestamp))
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, 30);
}

export {
  buildAgentRoster,
  buildConsoleFeed,
  buildDeliveryHub,
  isRecentDispatchActive,
  calculateAutonomyScore,
  calculateSuccessRate,
  mergeLiveRuns,
  summarizeAgentLoad,
  summarizeChildTasks,
  summarizeFlowHealth
};
