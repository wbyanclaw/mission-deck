import {
  EVENT_TYPES,
  FLOW_STATES,
  appendTimelineEvent,
  applyDurableFlowToRun,
  getRuntimeTaskFlow,
  hasNonEmptyString,
  isoNow,
  normalizeString,
  setRunTelemetry,
  shouldTreatVisibleReplyAsFinalDelivery
} from "./orchestrator-helpers.js";

function findParentRunByChildLink(runtimeRuns, link) {
  const parentRunId = normalizeString(link?.parentRunId);
  if (!parentRunId) return null;
  return runtimeRuns.get(parentRunId) || null;
}

function reviveParentRun({ api, runtimeRuns, coordinatorAgentId, getRun, touchRun }, parentLink, ctx = {}) {
  const parentFlowId = normalizeString(parentLink?.parentFlowId);
  if (!parentFlowId) return null;
  const parentSessionKey = normalizeString(parentLink?.parentSessionKey);
  const taskFlow = getRuntimeTaskFlow(api, { ...ctx, sessionKey: parentSessionKey });
  const flow = taskFlow?.get?.(parentFlowId);
  if (!flow) return null;
  const revivedRunId = normalizeString(parentLink?.parentRunId) || normalizeString(flow?.stateJson?.rootRunId) || parentFlowId;
  const revivedAgentId = normalizeString(parentLink?.parentAgentId) || coordinatorAgentId || "main";
  const revived = getRun(revivedRunId, revivedAgentId);
  revived.agentId = revivedAgentId;
  revived.ownerAgentId = revivedAgentId;
  revived.sessionKey = parentSessionKey || normalizeString(flow?.stateJson?.rootSessionKey);
  revived.flowId = parentFlowId;
  revived.taskFlowSeen = true;
  revived.entryMode = normalizeString(flow?.stateJson?.entryMode) || "mission-flow";
  revived.orchestrationMode = normalizeString(flow?.stateJson?.orchestrationMode) || "solo";
  revived.orchestrationPlan = flow?.stateJson?.orchestrationPlan || revived.orchestrationPlan || null;
  revived.parentRunId = normalizeString(flow?.stateJson?.parentRunId);
  revived.parentFlowId = normalizeString(flow?.stateJson?.parentFlowId);
  revived.parentTaskId = normalizeString(flow?.stateJson?.parentTaskId);
  revived.parentSessionKey = normalizeString(flow?.stateJson?.parentSessionKey);
  revived.parentAgentId = normalizeString(parentLink?.parentAgentId) || revived.parentAgentId;
  applyDurableFlowToRun(revived, flow);
  touchRun(revivedRunId, revivedAgentId, revived);
  return revived;
}

function findParentRunByChildOutcome(runtimeRuns, childOutcome = {}) {
  const childTaskId = normalizeString(childOutcome.childTaskId);
  const childRunId = normalizeString(childOutcome.childRunId);
  const childSessionKey = normalizeString(childOutcome.childSessionKey);
  for (const state of runtimeRuns.values()) {
    const childTasks = Array.isArray(state?.childTasks) ? state.childTasks : [];
    const matched = childTasks.some((task) =>
      (childTaskId && normalizeString(task?.taskId) === childTaskId) ||
      (childRunId && normalizeString(task?.childRunId) === childRunId) ||
      (childSessionKey && normalizeString(task?.childSessionKey) === childSessionKey)
    );
    if (matched) return state;
  }
  return null;
}

function summarizeChildOutcome(task) {
  const agentId = normalizeString(task?.agentId) || "teammate";
  const summary = normalizeString(task?.progressSummary);
  return summary ? `${agentId}: ${summary}` : `${agentId}: 已完成。`;
}

function buildParentDeliveryText(state) {
  const visibleReply = normalizeString(state?.lastExternalMessage);
  if (shouldTreatVisibleReplyAsFinalDelivery(visibleReply)) return visibleReply;
  const childTasks = Array.isArray(state?.childTasks) ? state.childTasks : [];
  const completed = childTasks.filter((task) => ["completed", "succeeded", "success", "done", "reported", "delivered"].includes(normalizeString(task?.phase).toLowerCase()));
  const blocked = childTasks.filter((task) => ["blocked", "failed", "timeout", "timed_out", "cancelled"].includes(normalizeString(task?.phase).toLowerCase()));
  if (completed.length === 0 && blocked.length === 0) return "";
  const lines = ["已完成，汇总如下。", ""];
  for (const task of completed) lines.push(summarizeChildOutcome(task));
  if (blocked.length > 0) {
    lines.push("", "未完成部分：");
    for (const task of blocked) lines.push(summarizeChildOutcome(task));
  }
  return lines.join("\n").trim();
}

function cloneParentStateSnapshot(parentState) {
  return {
    ...parentState,
    durable: parentState?.durable ? JSON.parse(JSON.stringify(parentState.durable)) : null,
    childTasks: Array.isArray(parentState?.childTasks) ? JSON.parse(JSON.stringify(parentState.childTasks)) : [],
    childTaskIds: Array.isArray(parentState?.childTaskIds) ? parentState.childTaskIds.slice() : [],
    timelineEvents: Array.isArray(parentState?.timelineEvents) ? parentState.timelineEvents.slice() : [],
    activityTrail: Array.isArray(parentState?.activityTrail) ? parentState.activityTrail.slice() : []
  };
}

function applyCanonicalParentState(target, canonical) {
  target.durable = canonical.durable;
  target.childTasks = canonical.childTasks;
  target.childTaskIds = canonical.childTaskIds;
  target.flowStatus = canonical.flowStatus;
  target.flowCurrentStep = canonical.flowCurrentStep;
  target.flowRevision = canonical.flowRevision;
  target.flowWaitSummary = canonical.flowWaitSummary;
  target.flowTaskSummary = canonical.flowTaskSummary;
}

function buildCanonicalParentState(parentTaskFlow, parentState, taskPatch, updateDurableChildTask) {
  const canonical = cloneParentStateSnapshot(parentState);
  const flow = parentTaskFlow?.get?.(normalizeString(parentState?.flowId));
  if (flow) applyDurableFlowToRun(canonical, flow);
  if (taskPatch) updateDurableChildTask(canonical, taskPatch);
  return canonical;
}

function applyChildOutcomeToParent({
  api,
  dashboard,
  countOpenChildTasks,
  shouldFinishParent,
  transitionFlow,
  updateDurableChildTask
}, parentState, parentAgentId, childOutcome, ctx) {
  if (!parentState || !parentAgentId) return null;
  const childTaskPatch = {
    taskId: childOutcome.childTaskId,
    childSessionKey: childOutcome.childSessionKey,
    agentId: childOutcome.childAgentId,
    phase: childOutcome.phase,
    progressSummary: childOutcome.summary,
    updatedAt: childOutcome.updatedAt
  };
  const parentTaskFlow = getRuntimeTaskFlow(api, { ...ctx, sessionKey: parentState.sessionKey });
  const canonicalParentState = buildCanonicalParentState(parentTaskFlow, parentState, childTaskPatch, updateDurableChildTask);
  applyCanonicalParentState(parentState, canonicalParentState);
  appendTimelineEvent(parentState, {
    role: "协同反馈",
    owner: childOutcome.childAgentId || parentAgentId,
    text: childOutcome.summary
  });
  if (hasNonEmptyString(childOutcome.finalReplyText)) {
    const finalReplyText = normalizeString(childOutcome.finalReplyText);
    parentState.userVisibleMessageSent = true;
    setRunTelemetry(parentState, "finalize_candidate", {
      toolName: "synthetic_announce",
      externalMessage: finalReplyText
    });
    appendTimelineEvent(parentState, {
      role: "最终回复",
      owner: parentAgentId,
      text: finalReplyText
    });
  }
  if (childOutcome.phase === "blocked") {
    parentState.lastBlockReason = childOutcome.summary;
  }
  const failureKind = normalizeString(parentState?.durable?.lastFailureKind);
  const dispatchFailure = failureKind === "dispatch_failure" || /gateway timeout/i.test(normalizeString(parentState?.lastBlockReason));
  if (childOutcome.phase !== "blocked" && dispatchFailure) {
    parentState.lastBlockReason = "";
  }
  const syntheticFinalize = hasNonEmptyString(childOutcome.finalReplyText) && childOutcome.phase !== "blocked";
  const nextState = childOutcome.phase === "blocked"
    ? FLOW_STATES.BLOCKED
    : countOpenChildTasks(canonicalParentState) > 0
      ? FLOW_STATES.WAITING_CHILD
      : (syntheticFinalize || shouldFinishParent(parentState))
        ? FLOW_STATES.COMPLETED
        : FLOW_STATES.REVIEWING;
  const deliveryText = nextState === FLOW_STATES.COMPLETED
    ? buildParentDeliveryText(parentState) || normalizeString(childOutcome.finalReplyText) || normalizeString(parentState.lastExternalMessage)
    : "";
  const action = nextState === FLOW_STATES.COMPLETED ? "finish" : "setWaiting";
  transitionFlow(
    parentTaskFlow,
    parentState,
    action,
    {
      currentStep: nextState,
      blockedSummary: nextState === FLOW_STATES.BLOCKED ? childOutcome.summary : "",
      waitJson: nextState === FLOW_STATES.COMPLETED ? null : {
        kind: childOutcome.phase === "blocked" ? "child_blocked" : "child_progress",
        childTaskId: childOutcome.childTaskId,
        childAgentId: childOutcome.childAgentId,
        summary: childOutcome.summary
      },
      stateJson: {
        state: nextState,
        lastFailureKind: nextState === FLOW_STATES.BLOCKED ? "blocked" : "",
        lastFailureReason: nextState === FLOW_STATES.BLOCKED ? normalizeString(childOutcome.summary) : "",
        finalOutput: nextState === FLOW_STATES.COMPLETED ? {
          text: deliveryText,
          deliveredAt: isoNow()
        } : parentState.durable?.finalOutput || null
      }
    },
    {
      eventType: EVENT_TYPES.CHILD_REPORT,
      timestamp: childOutcome.updatedAt
    },
    `child outcome applied: ${childOutcome.phase}`
  );
  dashboard.trackActiveRun(parentState.parentRunId || normalizeString(parentState.flowId), parentAgentId, parentState);
  return {
    nextState,
    completed: nextState === FLOW_STATES.COMPLETED,
    deliveryText
  };
}

export {
  applyChildOutcomeToParent,
  buildParentDeliveryText,
  findParentRunByChildLink,
  findParentRunByChildOutcome,
  reviveParentRun
};
