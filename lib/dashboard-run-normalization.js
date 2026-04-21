import {
  looksLikeAwaitingUserInputReply,
  normalizeString,
  shouldTreatVisibleReplyAsFinalDelivery
} from "./orchestrator-helpers.js";
import {
  sanitizeChildTasks,
  sanitizeDashboardText,
  sanitizeTimelineEvents
} from "./dashboard-text-sanitize.js";

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
  if (canTreatWaitingRunAsCompleted(state)) return "completed";
  if (
    normalizeString(state?.entryMode) === "mission-lite" &&
    normalizeString(state?.lastExternalMessage) &&
    shouldTreatVisibleReplyAsFinalDelivery(state?.lastExternalMessage)
  ) {
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
    entryMode: normalizeString(state?.entryMode),
    orchestrationMode: normalizeString(state?.orchestrationMode),
    orchestrationPlan: state?.orchestrationPlan ? {
      mode: normalizeString(state.orchestrationPlan.mode),
      targetAgentIds: Array.isArray(state.orchestrationPlan.targetAgentIds) ? state.orchestrationPlan.targetAgentIds.slice(0, 8) : [],
      requiredEvidenceCount: Number(state.orchestrationPlan.requiredEvidenceCount || 0),
      routeHint: sanitizeDashboardText(state.orchestrationPlan.routeHint, options),
      finishCondition: sanitizeDashboardText(state.orchestrationPlan.finishCondition, options),
      summary: sanitizeDashboardText(state.orchestrationPlan.summary, options)
    } : null,
    chainAssessment: state?.chainAssessment ? {
      code: normalizeString(state.chainAssessment.code),
      summary: sanitizeDashboardText(state.chainAssessment.summary, options),
      missing: sanitizeDashboardText(state.chainAssessment.missing, options),
      nextAction: sanitizeDashboardText(state.chainAssessment.nextAction, options),
      correct: Boolean(state.chainAssessment.correct)
    } : null,
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
    supervisorPending: Boolean(state?.supervisorPending),
    supervisorAgentId: normalizeString(state?.supervisorAgentId),
    supervisorReason: sanitizeDashboardText(state?.supervisorReason, options),
    supervisorLastInterventionAt: normalizeString(state?.supervisorLastInterventionAt),
    supervisorInterventionCount: Number(state?.supervisorInterventionCount || 0),
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
  if (normalizeString(state?.entryMode) === "mission-lite") return true;
  return Boolean(state?.taskFlowSeen && normalizeString(state?.flowId));
}

function updateRunWithChildOutcome(run, outcome, isoNowFn) {
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
    updatedAt: normalizeString(outcome.updatedAt) || normalizeString(existing.updatedAt) || isoNowFn(),
    childRunId: normalizeString(outcome.childRunId) || normalizeString(existing.childRunId),
    agentId: normalizeString(outcome.childAgentId) || normalizeString(existing.agentId)
  };
  run.childTasks = childTasks;
  if (normalizeString(outcome.phase).toLowerCase() === "blocked") {
    run.lastBlockReason = normalizeString(outcome.summary) || normalizeString(run.lastBlockReason);
  }
  run.updatedAt = normalizeString(outcome.updatedAt) || normalizeString(run.updatedAt) || isoNowFn();
  return true;
}

export {
  canTreatWaitingRunAsCompleted,
  normalizeHistoricalRunStatus,
  serializeRunState,
  shouldSurfaceRunInDashboard,
  updateRunWithChildOutcome
};
