import {
  FLOW_STATES,
  applyDurableFlowToRun,
  buildCanonicalFlowState,
  buildChainAssessment,
  buildDurableFlowStatePayload,
  getRuntimeTaskFlow,
  looksLikeAwaitingUserInputReply,
  normalizeString,
  shouldTreatVisibleReplyAsFinalDelivery
} from "./orchestrator-helpers.js";

function countOpenChildTasks(state) {
  return (Array.isArray(state?.childTasks) ? state.childTasks : []).filter((task) => {
    const phase = normalizeString(task?.phase).toLowerCase();
    return !["reported", "succeeded", "success", "completed", "done", "failed", "blocked", "cancelled", "timed_out", "timeout", "delivered"].includes(phase);
  }).length;
}

function countEvidence(state) {
  if (state?.durable && Number.isFinite(state.durable.receivedEvidenceCount)) {
    return Number(state.durable.receivedEvidenceCount || 0);
  }
  const keys = new Set();
  for (const task of (Array.isArray(state?.childTasks) ? state.childTasks : [])) {
    const phase = normalizeString(task?.phase).toLowerCase();
    if (!["reported", "succeeded", "success", "completed", "done", "delivered", "blocked", "failed"].includes(phase)) continue;
    const taskId = normalizeString(task?.taskId);
    const sessionKey = normalizeString(task?.childSessionKey);
    const agentId = normalizeString(task?.agentId);
    if (taskId) keys.add(`task:${taskId}`);
    else if (sessionKey) keys.add(`session:${sessionKey}`);
    else if (agentId) keys.add(`agent:${agentId}`);
  }
  return keys.size;
}

function buildCollaborationRequirementReason(state) {
  const mode = normalizeString(state?.orchestrationMode) || "solo";
  if (mode === "multi_party_required") return "multi-party task requested but no independent teammate evidence was recorded";
  if (mode === "delegate_once") return "delegation-required task finished without any child-task evidence";
  return "";
}

function lacksRequiredCollaborationEvidence(state) {
  const mode = normalizeString(state?.orchestrationMode) || "solo";
  const evidenceCount = countEvidence(state);
  if (mode === "multi_party_required") return evidenceCount < Math.max(2, Number(state?.orchestrationPlan?.requiredEvidenceCount || 0) || 2);
  if (mode === "delegate_once") return evidenceCount < 1;
  return false;
}

function isSpawnedExecutionRun(state, ctx) {
  if (normalizeString(state?.parentRunId)) return true;
  return normalizeString(ctx?.sessionKey).includes(":subagent:");
}

function applyTaskSummary(taskFlow, state) {
  if (!taskFlow || !state?.flowId || typeof taskFlow.getTaskSummary !== "function") return;
  state.flowTaskSummary = taskFlow.getTaskSummary(state.flowId);
}

function inferTransitionStatus(action, payload, state) {
  const requestedStatus = normalizeString(payload?.status);
  if (action === "finish") return "succeeded";
  if (action === "fail") return "failed";
  if (action === "setWaiting") return normalizeString(payload?.blockedSummary) ? "blocked" : "waiting";
  if (action === "resume") return requestedStatus || "running";
  return requestedStatus || normalizeString(state?.flowStatus) || "running";
}

function buildOptimisticFlowSnapshot(state, action, payload, durable) {
  return {
    flowId: state.flowId,
    revision: Number(state?.flowRevision || 0) + 1,
    status: inferTransitionStatus(action, payload, state),
    currentStep: normalizeString(payload?.currentStep) || normalizeString(state?.flowCurrentStep),
    blockedSummary: normalizeString(payload?.blockedSummary),
    waitJson: payload?.waitJson ?? null,
    stateJson: durable
  };
}

function syncFlowSnapshot(taskFlow, state) {
  if (!taskFlow || !state?.flowId) return;
  const flow = taskFlow.get(state.flowId);
  if (flow) applyDurableFlowToRun(state, flow);
  applyTaskSummary(taskFlow, state);
  if (state?.durable) {
    state.durable.receivedEvidenceCount = countEvidence(state);
  }
  state.chainAssessment = buildChainAssessment(state);
}

function transitionFlow(taskFlow, state, action, payload = {}, canonicalEvent = null, auditSummary = "") {
  if (!taskFlow || !state?.flowId) return null;
  const call = taskFlow[action];
  if (typeof call !== "function") return null;
  const expectedRevision = Number(state.flowRevision || 0);
  const durable = buildDurableFlowStatePayload(state.durable || {}, payload.stateJson || {}, canonicalEvent, auditSummary);
  const optimisticFlow = buildOptimisticFlowSnapshot(state, action, payload, durable);
  applyDurableFlowToRun(state, optimisticFlow);
  const result = call({
    flowId: state.flowId,
    expectedRevision,
    ...payload,
    stateJson: durable
  });
  const optimisticRevision = Number(optimisticFlow.revision || 0);
  const candidates = [result?.current, result?.flow, taskFlow.get(state.flowId)]
    .filter((candidate) => candidate && typeof candidate === "object");
  const freshest = candidates.reduce((best, candidate) => {
    const bestRevision = Number(best?.revision || 0);
    const candidateRevision = Number(candidate?.revision || 0);
    return candidateRevision > bestRevision ? candidate : best;
  }, null);
  if (freshest && Number(freshest.revision || 0) >= optimisticRevision) {
    applyDurableFlowToRun(state, freshest);
  }
  applyTaskSummary(taskFlow, state);
  state.durable = durable;
  state.chainAssessment = buildChainAssessment(state);
  return result;
}

function ensureFlowBound({ api, state, canonicalEvent, initialStep = FLOW_STATES.PLANNED }) {
  const taskFlow = getRuntimeTaskFlow(api, { sessionKey: canonicalEvent.sessionKey });
  if (!taskFlow) return null;
  let flow = state.flowId ? taskFlow.get(state.flowId) : null;
  if (!flow) {
    flow = taskFlow.createManaged({
      controllerId: "mission-deck",
      goal: state.promptText || "Handle the requested task.",
      status: "running",
      currentStep: FLOW_STATES.INTAKE
    });
    state.flowId = normalizeString(flow?.flowId);
    state.flowRevision = Number(flow?.revision || 0);
    state.taskFlowSeen = Boolean(state.flowId);
    state.durable = buildCanonicalFlowState({
      runId: canonicalEvent.runId,
      sessionKey: canonicalEvent.sessionKey,
      parentLink: {
        parentRunId: state.parentRunId,
        parentFlowId: state.parentFlowId,
        childTaskId: state.parentTaskId,
        parentSessionKey: state.parentSessionKey
      },
      entryMode: state.entryMode,
      orchestrationMode: state.orchestrationMode,
      orchestrationPlan: state.orchestrationPlan
    });
    transitionFlow(taskFlow, state, "resume", {
      status: "running",
      currentStep: initialStep,
      waitJson: null
    }, canonicalEvent, `flow initialized at ${initialStep}`);
  } else {
    applyDurableFlowToRun(state, flow);
  }
  state.taskFlowSeen = Boolean(state.flowId);
  return taskFlow;
}

function shouldRetainRuntimeState(state, archived) {
  if (!state || archived) return false;
  if (state.entryMode !== "mission-flow") return false;
  const currentStep = normalizeString(state.flowCurrentStep || state.durable?.state);
  return currentStep === FLOW_STATES.WAITING_CHILD || currentStep === FLOW_STATES.REVIEWING || currentStep === FLOW_STATES.BLOCKED;
}

function shouldFinishParent(state) {
  const visibleReply = normalizeString(state?.lastExternalMessage);
  if (!visibleReply) return false;
  if (looksLikeAwaitingUserInputReply(visibleReply)) return false;
  if (countOpenChildTasks(state) > 0) return false;
  return shouldTreatVisibleReplyAsFinalDelivery(visibleReply);
}

function updateDurableChildTask(state, taskPatch) {
  const durable = state.durable || buildCanonicalFlowState({
    runId: state.flowId,
    sessionKey: state.sessionKey,
    entryMode: state.entryMode,
    orchestrationMode: state.orchestrationMode,
    orchestrationPlan: state.orchestrationPlan
  });
  const childTasks = Array.isArray(durable.childTasks) ? durable.childTasks.slice() : [];
  const taskId = normalizeString(taskPatch?.taskId);
  const childSessionKey = normalizeString(taskPatch?.childSessionKey);
  const matchIndex = childTasks.findIndex((task) =>
    (taskId && normalizeString(task?.taskId) === taskId) ||
    (childSessionKey && normalizeString(task?.childSessionKey) === childSessionKey)
  );
  if (matchIndex >= 0) childTasks[matchIndex] = { ...childTasks[matchIndex], ...taskPatch };
  else childTasks.push(taskPatch);
  durable.childTasks = childTasks;
  durable.childSessions = childTasks.map((task) => normalizeString(task?.childSessionKey)).filter(Boolean);
  durable.receivedEvidenceCount = countEvidence({ durable, childTasks });
  state.durable = durable;
  state.childTasks = childTasks;
  state.childTaskIds = childTasks.map((task) => normalizeString(task?.taskId)).filter(Boolean);
  return durable;
}

export {
  buildCollaborationRequirementReason,
  countEvidence,
  countOpenChildTasks,
  ensureFlowBound,
  isSpawnedExecutionRun,
  lacksRequiredCollaborationEvidence,
  shouldFinishParent,
  shouldRetainRuntimeState,
  syncFlowSnapshot,
  transitionFlow,
  updateDurableChildTask
};
