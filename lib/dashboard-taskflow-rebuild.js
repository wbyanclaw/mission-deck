import { DatabaseSync } from "node:sqlite";

import {
  applyDurableFlowToRun,
  defaultRunState,
  normalizeString
} from "./orchestrator-helpers.js";
import { serializeRunState } from "./dashboard-run-normalization.js";

function parseAgentIdFromSessionKey(sessionKey) {
  const normalized = normalizeString(sessionKey);
  if (!normalized) return "";
  const parts = normalized.split(":");
  return normalizeString(parts[1]);
}

function summarizeTaskflowChildren(childTasks = []) {
  const byStatus = {};
  let active = 0;
  for (const task of childTasks) {
    const phase = normalizeString(task?.phase).toLowerCase() || "unknown";
    byStatus[phase] = (byStatus[phase] || 0) + 1;
    if (!["reported", "succeeded", "success", "completed", "done", "delivered", "failed", "blocked", "cancelled", "timed_out", "timeout"].includes(phase)) {
      active += 1;
    }
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

function buildTimelineEvents(auditTrail = []) {
  return (Array.isArray(auditTrail) ? auditTrail : [])
    .map((entry) => ({
      timestamp: normalizeString(entry?.timestamp),
      role: "TaskFlow",
      owner: "",
      text: normalizeString(entry?.summary),
      tone: ""
    }))
    .filter((entry) => entry.timestamp && entry.text)
    .slice(-40);
}

function buildTaskflowRunEntry(flowRow, options = {}) {
  const flow = {
    flowId: normalizeString(flowRow?.flow_id),
    revision: Number(flowRow?.revision || 0),
    status: normalizeString(flowRow?.status),
    currentStep: normalizeString(flowRow?.current_step),
    blockedSummary: normalizeString(flowRow?.blocked_summary),
    waitJson: flowRow?.wait_json ? JSON.parse(flowRow.wait_json) : null,
    stateJson: flowRow?.state_json ? JSON.parse(flowRow.state_json) : null
  };
  const state = defaultRunState();
  applyDurableFlowToRun(state, flow);
  state.engineeringTask = true;
  state.entryMode = normalizeString(state?.durable?.entryMode) || "mission-flow";
  state.orchestrationMode = normalizeString(state?.durable?.orchestrationMode) || "solo";
  state.orchestrationPlan = state?.durable?.orchestrationPlan || null;
  state.agentId = parseAgentIdFromSessionKey(state?.durable?.rootSessionKey) || options.defaultAgentId || "main";
  state.ownerAgentId = state.agentId;
  state.sessionKey = normalizeString(state?.durable?.rootSessionKey);
  state.initialUserPrompt = normalizeString(state?.durable?.initialUserPrompt) || normalizeString(flowRow?.goal);
  state.promptText = state.initialUserPrompt;
  state.normalizedPromptText = state.promptText;
  state.userAskedAt = normalizeString(state?.durable?.userAskedAt) || normalizeString(flowRow?.goal);
  state.flowTaskSummary = summarizeTaskflowChildren(state.childTasks);
  state.lastBlockReason = normalizeString(state?.durable?.lastFailureReason || flowRow?.blocked_summary);
  state.lastExternalMessage = normalizeString(state?.durable?.finalOutput?.text);
  state.lastEvent = normalizeString(state?.durable?.auditTrail?.at?.(-1)?.eventType);
  state.dashboardStartedAt = Number(flowRow?.created_at) > 0 ? new Date(Number(flowRow.created_at)).toISOString() : "";
  state.dashboardUpdatedAt = Number(flowRow?.updated_at) > 0 ? new Date(Number(flowRow.updated_at)).toISOString() : state.dashboardStartedAt;
  state.timelineEvents = buildTimelineEvents(state?.durable?.auditTrail);
  const runId = normalizeString(state?.durable?.rootRunId) || flow.flowId;
  const serialized = serializeRunState(runId, state.agentId, state, options);
  serialized.flowSource = "taskflow";
  return serialized;
}

function loadDashboardTaskflowRuns(options = {}) {
  const flowRegistryPath = normalizeString(options.flowRegistryPath);
  if (!flowRegistryPath) return { activeRuns: [], recentRuns: [] };
  const db = new DatabaseSync(flowRegistryPath, { readonly: true });
  try {
    const maxRecentRuns = Math.max(1, Number(options.maxRecentRuns || 20));
    const rows = db.prepare(`
      SELECT flow_id, revision, status, goal, current_step, blocked_summary, state_json, wait_json, created_at, updated_at, ended_at
      FROM flow_runs
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(maxRecentRuns);
    const mapped = rows.map((row) => buildTaskflowRunEntry(row, options));
    const activeRuns = mapped.filter((entry) => {
      const flowStatus = normalizeString(entry?.flowStatus).toLowerCase();
      return ["running", "waiting", "blocked"].includes(flowStatus);
    });
    return { activeRuns, recentRuns: mapped };
  } finally {
    db.close();
  }
}

export {
  loadDashboardTaskflowRuns
};
