import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  hasAnyInternalExecutionStep,
  isoNow,
  normalizeString,
  looksLikeAwaitingUserInputReply,
  sanitizeTaskPrompt,
  shouldTreatVisibleReplyAsFinalDelivery
} from "./orchestrator-helpers.js";

const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DASHBOARD_DIR = join(PLUGIN_ROOT, "dashboard");
const DASHBOARD_STATUS_PATH = join(DASHBOARD_DIR, "status.json");
const DASHBOARD_DATA_DIR = join(DASHBOARD_DIR, "data");
const MAX_RECENT_RUNS = 200;
const MAX_RECENT_DISPATCHES = 30;
const MAX_RECENT_BLOCKERS = 20;
const DEFAULT_RETENTION_DAYS = 14;

function stableHash(value) {
  return createHash("sha256").update(normalizeString(value)).digest("hex").slice(0, 12);
}

function redactSessionKey(value, enabled) {
  const normalized = normalizeString(value);
  if (!normalized) return "";
  if (!enabled) return normalized;
  const parts = normalized.split(":");
  const agentId = normalizeString(parts[1]) || "unknown";
  const scope = normalizeString(parts[2]) || "session";
  return `redacted:${agentId}:${scope}:${stableHash(normalized)}`;
}

function stripPromptMetadata(value, enabled) {
  const normalized = normalizeString(value);
  if (!normalized) return "";
  if (!enabled) return normalized;
  const stripped = sanitizeTaskPrompt(normalized)
    .replace(/chat_id\s*[:=]\s*["'][^"'\n]+["']/gi, 'chat_id:"[redacted]"')
    .replace(/message_id\s*[:=]\s*["'][^"'\n]+["']/gi, 'message_id:"[redacted]"');
  return stripped;
}

function sanitizeDashboardText(value, options = {}) {
  const normalized = normalizeString(value);
  if (!normalized) return "";
  if (options.redactDashboardContent === false) return normalized;
  const withPromptRedaction = stripPromptMetadata(normalized, options.redactPromptMetadata !== false);
  return withPromptRedaction
    .replace(/agent:[a-z0-9_-]+:[a-z0-9_-]+:[^\s"'`]+/gi, `[session:${stableHash("$&")}]`)
    .replace(/\b(?:openclaw-weixin|feishu|telegram):[^\s"'`]+/gi, "[channel-message:redacted]")
    .replace(/\bou_[a-z0-9]+\b/gi, "[peer:redacted]")
    .replace(/\bchat_id\b[^\n]*/gi, "chat_id: [redacted]")
    .replace(/\bmessage_id\b[^\n]*/gi, "message_id: [redacted]")
    .trim();
}

function sanitizeTimelineEvents(events, options = {}) {
  return (Array.isArray(events) ? events : [])
    .map((entry) => ({
      ...entry,
      owner: normalizeString(entry?.owner),
      role: normalizeString(entry?.role),
      text: sanitizeDashboardText(entry?.text, options),
      tone: normalizeString(entry?.tone)
    }))
    .filter((entry) => entry.role && entry.text)
    .slice(-40);
}

function sanitizeChildTasks(tasks, options = {}) {
  return (Array.isArray(tasks) ? tasks : []).map((task) => ({
    ...task,
    label: sanitizeDashboardText(task?.label, options),
    progressSummary: sanitizeDashboardText(task?.progressSummary, options),
    childSessionKey: redactSessionKey(task?.childSessionKey, options.redactSessionKeys !== false)
  }));
}

function sanitizeDispatchEntry(entry, options = {}) {
  if (!entry || typeof entry !== "object") return entry;
  const target = entry.target && typeof entry.target === "object"
    ? {
        ...entry.target,
        childSessionKey: redactSessionKey(entry.target.childSessionKey, options.redactSessionKeys !== false),
        task: sanitizeDashboardText(entry.target.task, options),
        label: sanitizeDashboardText(entry.target.label, options)
      }
    : entry.target;
  return {
    ...entry,
    reason: sanitizeDashboardText(entry.reason, options),
    target
  };
}

function sanitizeBlockerEntry(entry, options = {}) {
  if (!entry || typeof entry !== "object") return entry;
  return {
    ...entry,
    reason: sanitizeDashboardText(entry.reason, options)
  };
}

function sanitizeChildOutcome(outcome, options = {}) {
  if (!outcome || typeof outcome !== "object") return outcome;
  return {
    ...outcome,
    childSessionKey: redactSessionKey(outcome.childSessionKey, options.redactSessionKeys !== false),
    summary: sanitizeDashboardText(outcome.summary, options)
  };
}

function looksLikeHeartbeatRun(state) {
  const promptText = normalizeString(state?.promptText).toLowerCase();
  const externalMessage = normalizeString(state?.lastExternalMessage).toLowerCase();
  if (!promptText && !externalMessage) return false;
  if (externalMessage === "heartbeat_ok") return true;
  return (
    promptText.includes("heartbeat.md") ||
    promptText.includes("reply heartbeat_ok") ||
    promptText.includes("if nothing needs attention, reply heartbeat_ok") ||
    promptText.includes("read heartbeat.md if it exists")
  );
}

function looksLikeInternalRelayRun(state) {
  const promptText = normalizeString(state?.promptText).toLowerCase();
  const externalMessage = normalizeString(state?.lastExternalMessage).toLowerCase();
  if (!promptText && !externalMessage) return false;
  return (
    promptText.includes("agent-to-agent announce step") ||
    externalMessage === "announce_skip" ||
    externalMessage === "reply_skip" ||
    promptText.startsWith("[sat ") ||
    promptText.startsWith("[sun ") ||
    promptText.startsWith("[mon ") ||
    promptText.startsWith("[tue ") ||
    promptText.startsWith("[wed ") ||
    promptText.startsWith("[thu ") ||
    promptText.startsWith("[fri ")
  );
}

function dayStamp(value = new Date()) {
  return new Date(value).toISOString().slice(0, 10);
}

function isTerminalChildPhase(phase) {
  return ["reported", "succeeded", "success", "completed", "done", "failed", "blocked", "cancelled", "timed_out", "timeout"]
    .includes(normalizeString(phase).toLowerCase());
}

function hasOpenChildTasks(run) {
  const childTasks = Array.isArray(run?.childTasks) ? run.childTasks : [];
  if (childTasks.some((task) => !isTerminalChildPhase(task?.phase))) return true;
  return Math.max(0, Number(run?.flowTaskSummary?.active) || 0) > 0;
}

function canTreatWaitingRunAsCompleted(run) {
  const flowStatus = normalizeString(run?.flowStatus).toLowerCase();
  const visibleReply = normalizeString(run?.lastExternalMessage);
  if (flowStatus !== "waiting") return false;
  if (!visibleReply) return false;
  if (looksLikeAwaitingUserInputReply(visibleReply)) return false;
  if (!shouldTreatVisibleReplyAsFinalDelivery(visibleReply)) return false;
  return !hasOpenChildTasks(run);
}

function summarizeRunStatus(state) {
  const flowStatus = normalizeString(state?.flowStatus).toLowerCase();
  if (flowStatus === "blocked") return "blocked";
  if (canTreatWaitingRunAsCompleted(state)) {
    return "completed";
  }
  if (flowStatus === "waiting") return "waiting";
  if (["succeeded", "completed"].includes(flowStatus)) return "completed";
  if (["failed", "cancelled"].includes(flowStatus)) return "blocked";
  if (!state?.engineeringTask) return "non_engineering";
  if (state.lastBlockReason) return "blocked";
  if (state.executionLaneSeen && state.childTaskIds.length > 0) return "delegated";
  if (state.executionLaneSeen) return "lane_open";
  if (state.workspaceDiscoverySeen || state.internalCoordinationSeen) return "coordinating";
  return "triaging";
}

function serializeRunState(runId, agentId, state, options = {}) {
  const childTasks = sanitizeChildTasks(Array.isArray(state?.childTasks) ? state.childTasks.slice(-8) : [], options);
  return {
    runId,
    agentId,
    engineeringTask: Boolean(state?.engineeringTask),
    status: summarizeRunStatus(state),
    promptText: sanitizeDashboardText(normalizeString(state?.promptText).slice(0, 280), options),
    flowId: normalizeString(state?.flowId),
    flowRevision: Number(state?.flowRevision ?? 0),
    flowStatus: normalizeString(state?.flowStatus),
    flowCurrentStep: sanitizeDashboardText(state?.flowCurrentStep, options),
    flowWaitSummary: sanitizeDashboardText(state?.flowWaitSummary, options),
    flowTaskSummary: state?.flowTaskSummary ?? null,
    suggestedSpawn: state?.suggestedSpawn ? {
      ...state.suggestedSpawn,
      label: sanitizeDashboardText(state.suggestedSpawn.label, options),
      task: sanitizeDashboardText(state.suggestedSpawn.task, options)
    } : null,
    internalCoordinationSeen: Boolean(state?.internalCoordinationSeen),
    workspaceDiscoverySeen: Boolean(state?.workspaceDiscoverySeen),
    executionLaneSeen: Boolean(state?.executionLaneSeen),
    taskFlowSeen: Boolean(state?.taskFlowSeen),
    childTaskIds: Array.isArray(state?.childTaskIds) ? state.childTaskIds.slice(-8) : [],
    childTasks,
    timelineEvents: sanitizeTimelineEvents(Array.isArray(state?.timelineEvents) ? state.timelineEvents.slice(-40) : [], options),
    activityTrail: Array.isArray(state?.activityTrail) ? state.activityTrail.slice(-16).map((entry) => ({
      ...entry,
      externalMessage: sanitizeDashboardText(entry?.externalMessage, options),
      blockReason: sanitizeDashboardText(entry?.blockReason, options)
    })) : [],
    lastToolName: normalizeString(state?.lastToolName),
    lastToolStatus: normalizeString(state?.lastToolStatus),
    lastEvent: normalizeString(state?.lastEvent),
    lastExternalMessage: sanitizeDashboardText(state?.lastExternalMessage, options),
    lastBlockReason: sanitizeDashboardText(state?.lastBlockReason, options),
    promptLength: Number(state?.normalizedPromptText?.length || state?.promptText?.length || 0),
    startedAt: normalizeString(state?.dashboardStartedAt),
    updatedAt: normalizeString(state?.dashboardUpdatedAt)
  };
}

function normalizeHistoricalRunStatus(run) {
  if (!run || typeof run !== "object") return run;
  if (canTreatWaitingRunAsCompleted(run)) {
    return {
      ...run,
      status: "completed",
      flowStatus: "succeeded"
    };
  }
  return run;
}

function shouldSurfaceRunInDashboard(state) {
  if (looksLikeHeartbeatRun(state)) return false;
  if (looksLikeInternalRelayRun(state)) return false;
  return Boolean(
    state?.taskFlowSeen &&
    normalizeString(state?.flowId)
  );
}

async function writeDashboardStatus(statusPath, snapshot) {
  await mkdir(dirname(statusPath), { recursive: true });
  const tempPath = `${statusPath}.tmp`;
  await writeFile(tempPath, JSON.stringify(snapshot, null, 2), "utf8");
  await rename(tempPath, statusPath);
}

async function appendDailyEvent(dataDir, type, payload) {
  await mkdir(dataDir, { recursive: true });
  const event = {
    timestamp: isoNow(),
    type,
    ...payload
  };
  const targetPath = join(dataDir, `${dayStamp(event.timestamp)}.jsonl`);
  await appendFile(targetPath, `${JSON.stringify(event)}\n`, "utf8");
}

function isLiveRun(entry) {
  const flowStatus = normalizeString(entry?.flowStatus).toLowerCase();
  const status = normalizeString(entry?.status).toLowerCase();
  if (["running", "waiting"].includes(flowStatus)) return true;
  if (["triaging", "coordinating", "delegated", "lane_open", "waiting"].includes(status)) return true;
  return hasOpenChildTasks(entry);
}

function mergeLiveRuns(activeRuns, recentRuns) {
  const merged = new Map();
  for (const entry of [...activeRuns, ...recentRuns.filter((run) => isLiveRun(run))]) {
    const runId = normalizeString(entry?.runId);
    if (!runId) continue;
    const existing = merged.get(runId);
    if (!existing || String(entry?.updatedAt || entry?.startedAt || "") > String(existing?.updatedAt || existing?.startedAt || "")) {
      merged.set(runId, entry);
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => String(b.updatedAt || b.startedAt || "").localeCompare(String(a.updatedAt || a.startedAt || "")));
}

function summarizeAgentLoad(activeRuns) {
  const byAgent = new Map();
  const ensureEntry = (agentId) => {
    const normalized = normalizeString(agentId) || "unknown";
    const existing = byAgent.get(normalized);
    if (existing) return existing;
    const created = {
      agentId: normalized,
      activeRuns: 0,
      delegatedRuns: 0,
      blockedRuns: 0,
      childTasks: 0,
      taskflowRuns: 0,
      updatedAt: ""
    };
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

    for (const task of (Array.isArray(run.childTasks) ? run.childTasks : [])) {
      if (isTerminalChildPhase(task?.phase)) continue;
      const childOwner = ensureEntry(task.agentId);
      childOwner.activeRuns += 1;
      childOwner.childTasks += 1;
      if (run.taskFlowSeen) childOwner.taskflowRuns += 1;
      if (String(task?.updatedAt || run.updatedAt) > String(childOwner.updatedAt)) {
        childOwner.updatedAt = normalizeString(task?.updatedAt) || normalizeString(run.updatedAt);
      }
    }
  }

  return Array.from(byAgent.values()).sort((a, b) =>
    b.activeRuns - a.activeRuns || String(b.updatedAt).localeCompare(String(a.updatedAt))
  );
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
  return safePoints.map((value, index) => ({
    x: index,
    y: Number(value) || 0
  }));
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
  for (const run of activeRuns.filter((entry) => entry.agentId === agentId)) {
    mark(run.updatedAt, 2);
  }
  for (const entry of recentDispatches.filter((item) => item.agentId === agentId)) {
    mark(entry.timestamp, 2);
  }
  for (const entry of recentBlockers.filter((item) => item.agentId === agentId)) {
    mark(entry.timestamp, 1);
  }
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
  return configuredAgents.map((agentMeta) => {
    const agentId = normalizeString(agentMeta?.agentId || agentMeta);
    const load = loadMap.get(agentId);
    const ownedRuns = activeRuns.filter((entry) => entry.agentId === agentId);
    const latestRun = ownedRuns.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] || null;
    const queueDepth = (load?.activeRuns ?? 0) + Math.max(0, (load?.childTasks ?? 0) - (load?.delegatedRuns ?? 0));
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
      state: load && load.activeRuns > 0 ? "busy" : "idle",
      activeRuns: load?.activeRuns ?? 0,
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

function deriveChildTaskPhase(task, run) {
  if (normalizeString(task?.phase)) return normalizeString(task.phase);
  if (normalizeString(run?.lastBlockReason)) return "blocked";
  if (run?.status === "delegated") return "running";
  if (run?.status === "lane_open") return "assigned";
  return "queued";
}

function summarizeChildTasks(activeRuns) {
  return activeRuns
    .flatMap((run) => (Array.isArray(run.childTasks) ? run.childTasks.map((task) => ({
      taskId: task.taskId,
      flowId: run.flowId,
      ownerAgentId: normalizeString(task.agentId) || "unknown",
      parentAgentId: run.agentId,
      phase: deriveChildTaskPhase(task, run),
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
      summary: normalizeString(run.lastExternalMessage) ||
        normalizeString(run.childTasks?.at?.(-1)?.progressSummary) ||
        "已生成新的处理结果",
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

function updateRunWithChildOutcome(run, outcome) {
  if (!run || !outcome) return false;
  const childTasks = Array.isArray(run.childTasks) ? run.childTasks : [];
  const matchIndex = childTasks.findIndex((task) =>
    normalizeString(task?.taskId) === normalizeString(outcome.childTaskId) ||
    normalizeString(task?.childSessionKey) === normalizeString(outcome.childSessionKey)
  );
  if (matchIndex < 0) return false;

  const existing = childTasks[matchIndex] || {};
  childTasks[matchIndex] = {
    ...existing,
    phase: normalizeString(outcome.phase) || normalizeString(existing.phase) || "reported",
    progressSummary: normalizeString(outcome.summary) || normalizeString(existing.progressSummary) || "已收到最新进展",
    updatedAt: normalizeString(outcome.updatedAt) || normalizeString(existing.updatedAt) || isoNow(),
    childRunId: normalizeString(outcome.childRunId) || normalizeString(existing.childRunId),
    agentId: normalizeString(outcome.childAgentId) || normalizeString(existing.agentId)
  };
  run.childTasks = childTasks;
  if (normalizeString(outcome.phase).toLowerCase() === "blocked") {
    run.lastBlockReason = normalizeString(outcome.summary) || normalizeString(run.lastBlockReason);
  }
  run.updatedAt = normalizeString(outcome.updatedAt) || normalizeString(run.updatedAt) || isoNow();
  return true;
}

async function pruneDailyLogs(dataDir, retentionDays) {
  await mkdir(dataDir, { recursive: true });
  const effectiveRetention = Math.max(1, Number(retentionDays) || DEFAULT_RETENTION_DAYS);
  const threshold = new Date();
  threshold.setUTCDate(threshold.getUTCDate() - effectiveRetention);
  const cutoffStamp = threshold.toISOString().slice(0, 10);
  const files = await readdir(dataDir, { withFileTypes: true });
  await Promise.all(files
    .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
    .filter((entry) => entry.name.slice(0, 10) < cutoffStamp)
    .map((entry) => rm(join(dataDir, entry.name), { force: true })));
}

async function restoreFromDailyLogs(dataDir, retentionDays) {
  const effectiveRetention = Math.max(1, Number(retentionDays) || DEFAULT_RETENTION_DAYS);
  const threshold = new Date();
  threshold.setUTCDate(threshold.getUTCDate() - effectiveRetention);
  const cutoffStamp = threshold.toISOString().slice(0, 10);
  const files = (await readdir(dataDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
    .filter((entry) => entry.name.slice(0, 10) >= cutoffStamp)
    .sort((a, b) => b.name.localeCompare(a.name));

  const recentRuns = [];
  const recentDispatches = [];
  const recentBlockers = [];

  for (const entry of files) {
    const raw = await readFile(join(dataDir, entry.name), "utf8");
    const lines = raw.split(/\n+/).filter(Boolean).reverse();
    for (const line of lines) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed?.type === "run-ended" && recentRuns.length < MAX_RECENT_RUNS) {
        recentRuns.push(parsed);
      } else if (parsed?.type === "dispatch" && recentDispatches.length < MAX_RECENT_DISPATCHES) {
        recentDispatches.push(parsed);
      } else if (parsed?.type === "blocker" && recentBlockers.length < MAX_RECENT_BLOCKERS) {
        recentBlockers.push(parsed);
      }
      if (
        recentRuns.length >= MAX_RECENT_RUNS &&
        recentDispatches.length >= MAX_RECENT_DISPATCHES &&
        recentBlockers.length >= MAX_RECENT_BLOCKERS
      ) {
        break;
      }
    }
  }

  return { recentRuns, recentDispatches, recentBlockers };
}

function createDashboardStore(logger, options = {}) {
  const statusPath = normalizeString(options.statusPath) || DASHBOARD_STATUS_PATH;
  const dataDir = normalizeString(options.dataDir) || DASHBOARD_DATA_DIR;
  const state = {
    activeRuns: new Map(),
    recentRuns: [],
    recentDispatches: [],
    recentBlockers: []
  };
  let initialized = false;

  function mergeRecentRuns(entries = []) {
    const merged = new Map();
    for (const entry of [...entries, ...state.recentRuns].map((item) => normalizeHistoricalRunStatus(item))) {
      const runId = normalizeString(entry?.runId);
      if (!runId) continue;
      const existing = merged.get(runId);
      if (!existing || String(entry?.updatedAt || entry?.startedAt || "") > String(existing?.updatedAt || existing?.startedAt || "")) {
        merged.set(runId, entry);
      }
    }
    state.recentRuns = Array.from(merged.values())
      .sort((a, b) => String(b.updatedAt || b.startedAt || "").localeCompare(String(a.updatedAt || a.startedAt || "")))
      .slice(0, MAX_RECENT_RUNS);
  }

  function mergeRecentEntries(key, entries = [], max = MAX_RECENT_RUNS) {
    const merged = new Map();
    for (const entry of [...entries, ...state[key]]) {
      const entryKey = JSON.stringify(entry);
      if (!merged.has(entryKey)) merged.set(entryKey, entry);
    }
    state[key] = Array.from(merged.values())
      .sort((a, b) => String(b.timestamp || b.updatedAt || "").localeCompare(String(a.timestamp || a.updatedAt || "")))
      .slice(0, max);
  }

  async function ensureInitialized() {
    if (initialized) return;
    initialized = true;
    try {
      const raw = await readFile(statusPath, "utf8");
      const snapshot = JSON.parse(raw);
      mergeRecentRuns([
        ...(Array.isArray(snapshot?.recentRuns) ? snapshot.recentRuns : []),
        ...(Array.isArray(snapshot?.activeRuns) ? snapshot.activeRuns : [])
      ]);
      mergeRecentEntries("recentDispatches", Array.isArray(snapshot?.recentDispatches) ? snapshot.recentDispatches : [], MAX_RECENT_DISPATCHES);
      mergeRecentEntries("recentBlockers", Array.isArray(snapshot?.recentBlockers) ? snapshot.recentBlockers : [], MAX_RECENT_BLOCKERS);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        logger?.warn?.(`[mission-deck] failed to restore dashboard snapshot: ${error?.message || error}`);
      }
    }
    if (state.recentRuns.length === 0 || state.recentDispatches.length === 0 || state.recentBlockers.length === 0) {
      try {
        const restored = await restoreFromDailyLogs(dataDir, options.retentionDays);
        if (state.recentRuns.length === 0) mergeRecentRuns(restored.recentRuns);
        if (state.recentDispatches.length === 0) mergeRecentEntries("recentDispatches", restored.recentDispatches, MAX_RECENT_DISPATCHES);
        if (state.recentBlockers.length === 0) mergeRecentEntries("recentBlockers", restored.recentBlockers, MAX_RECENT_BLOCKERS);
      } catch (error) {
        logger?.warn?.(`[mission-deck] failed to restore dashboard logs: ${error?.message || error}`);
      }
    }
  }

  async function flush() {
    await ensureInitialized();
    await prune();
    const activeRuns = Array.from(state.activeRuns.values())
      .map((entry) => normalizeHistoricalRunStatus(entry))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const recentRuns = state.recentRuns
      .map((entry) => normalizeHistoricalRunStatus(entry))
      .filter((entry) =>
      Boolean(
        entry?.engineeringTask ||
        entry?.taskFlowSeen ||
        entry?.childTaskIds?.length ||
        entry?.lastBlockReason ||
        entry?.internalCoordinationSeen ||
        entry?.workspaceDiscoverySeen ||
        entry?.executionLaneSeen
      )
      ).slice(0, MAX_RECENT_RUNS);
    state.recentRuns = recentRuns;
    const liveRuns = mergeLiveRuns(activeRuns, recentRuns);
    const engineeringRuns = liveRuns.filter((entry) => entry.engineeringTask);
    const agentLoad = summarizeAgentLoad(liveRuns);
    const flowHealth = summarizeFlowHealth(liveRuns);
    const childTaskBoard = summarizeChildTasks(liveRuns);
    const autonomyScore = calculateAutonomyScore(engineeringRuns);
    const configuredAgents = Array.isArray(options.configuredAgents) ? options.configuredAgents : [];
    const agentRoster = buildAgentRoster(
      configuredAgents,
      agentLoad,
      liveRuns,
      state.recentDispatches,
      state.recentBlockers,
      {
        fsEnabled: Boolean(options.fsEnabled),
        webEnabled: Boolean(options.webEnabled),
        mcpServers: Array.isArray(options.mcpServers) ? options.mcpServers : []
      }
    );
    const recentSuccessRate = calculateSuccessRate(recentRuns);
    const tokenProxy = agentRoster.reduce((sum, entry) => sum + (entry.tokenProxy || 0), 0);
    const deliveryHub = buildDeliveryHub(recentRuns, liveRuns);
    const consoleFeed = buildConsoleFeed(state.recentDispatches, state.recentBlockers, recentRuns);

    const snapshot = {
      meta: {
        pluginId: "mission-deck",
        generatedAt: isoNow(),
        version: 5,
        retentionDays: Math.max(1, Number(options.retentionDays) || DEFAULT_RETENTION_DAYS)
      },
      summary: {
        activeRuns: liveRuns.length,
        engineeringRuns: engineeringRuns.length,
        delegatedRuns: engineeringRuns.filter((entry) => entry.status === "delegated").length,
        blockedRuns: engineeringRuns.filter((entry) => entry.status === "blocked").length,
        taskflowRuns: engineeringRuns.filter((entry) => entry.taskFlowSeen).length,
        activeChildTasks: engineeringRuns.reduce((sum, entry) => sum + (entry.childTaskIds?.length || 0), 0),
        autonomyScore,
        successRate: recentSuccessRate,
        tokenProxy,
        busyAgents: agentRoster.filter((entry) => entry.state === "busy").length,
        idleAgents: agentRoster.filter((entry) => entry.state === "idle").length
      },
      agentRoster,
      agentLoad,
      flowHealth,
      childTaskBoard,
      deliveryHub,
      consoleFeed,
      activeRuns: liveRuns,
      recentRuns,
      recentDispatches: state.recentDispatches,
      recentBlockers: state.recentBlockers
    };

    try {
      await writeDashboardStatus(statusPath, snapshot);
    } catch (error) {
      logger?.warn?.(`[mission-deck] failed to write dashboard status: ${error?.message || error}`);
    }
  }

  function trackActiveRun(runId, agentId, runState) {
    if (!runId || !agentId) return;
    if (!shouldSurfaceRunInDashboard(runState)) {
      state.activeRuns.delete(runId);
      return;
    }
    state.activeRuns.set(runId, serializeRunState(runId, agentId, runState, options));
  }

  async function archiveRun(runId, agentId, runState) {
    await ensureInitialized();
    if (!runId || !agentId) return;
    state.activeRuns.delete(runId);
    if (!shouldSurfaceRunInDashboard(runState)) return;
    const serialized = serializeRunState(runId, agentId, runState, options);
    mergeRecentRuns([serialized]);
    await append("run-ended", serialized);
  }

  async function pushDispatch(entry) {
    await ensureInitialized();
    const sanitized = sanitizeDispatchEntry(entry, options);
    mergeRecentEntries("recentDispatches", [sanitized], MAX_RECENT_DISPATCHES);
    await append("dispatch", sanitized);
  }

  async function pushBlocker(entry) {
    await ensureInitialized();
    const sanitized = sanitizeBlockerEntry(entry, options);
    mergeRecentEntries("recentBlockers", [sanitized], MAX_RECENT_BLOCKERS);
    await append("blocker", sanitized);
  }

  async function attachChildOutcome(outcome) {
    await ensureInitialized();
    let updated = false;
    const parentRunId = normalizeString(outcome?.parentRunId);
    if (!parentRunId) return;

    const activeRun = state.activeRuns.get(parentRunId);
    if (activeRun) {
      updated = updateRunWithChildOutcome(activeRun, outcome) || updated;
      if (updated) state.activeRuns.set(parentRunId, activeRun);
    }

    state.recentRuns = state.recentRuns.map((run) => {
      if (normalizeString(run?.runId) !== parentRunId) return run;
      const nextRun = { ...run };
      if (updateRunWithChildOutcome(nextRun, outcome)) {
        updated = true;
        return nextRun;
      }
      return run;
    });

    if (updated) {
      await append("child-outcome", sanitizeChildOutcome({
        parentRunId,
        childTaskId: normalizeString(outcome.childTaskId),
        childSessionKey: normalizeString(outcome.childSessionKey),
        childRunId: normalizeString(outcome.childRunId),
        childAgentId: normalizeString(outcome.childAgentId),
        phase: normalizeString(outcome.phase),
        summary: normalizeString(outcome.summary),
        updatedAt: normalizeString(outcome.updatedAt) || isoNow()
      }, options));
    }
  }

  async function append(type, payload) {
    try {
      await appendDailyEvent(dataDir, type, payload);
    } catch (error) {
      logger?.warn?.(`[mission-deck] failed to append dashboard event: ${error?.message || error}`);
    }
  }

  async function prune() {
    try {
      await pruneDailyLogs(dataDir, options.retentionDays);
    } catch (error) {
      logger?.warn?.(`[mission-deck] failed to prune dashboard history: ${error?.message || error}`);
    }
  }

  return {
    flush,
    trackActiveRun,
    archiveRun,
    pushDispatch,
    pushBlocker,
    attachChildOutcome
  };
}

export {
  canTreatWaitingRunAsCompleted,
  createDashboardStore,
  DASHBOARD_DATA_DIR,
  DASHBOARD_DIR,
  DASHBOARD_STATUS_PATH
};
