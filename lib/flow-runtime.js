import {
  EVENT_TYPES,
  FLOW_STATES,
  appendTimelineEvent,
  applyDurableFlowToRun,
  buildCanonicalFlowState,
  buildChainAssessment,
  buildDurableFlowStatePayload,
  getRuntimeTaskFlow,
  hasNonEmptyString,
  isoNow,
  looksLikeAwaitingUserInputReply,
  normalizeString,
  setRunTelemetry,
  shouldTreatVisibleReplyAsFinalDelivery
} from "./orchestrator-helpers.js";

export function createFlowRuntimeHelpers({
  api,
  dashboard,
  runtimeRuns,
  coordinatorAgentId,
  getRun,
  touchRun
}) {
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
      if (!["reported", "succeeded", "success", "completed", "done", "delivered", "blocked", "failed"].includes(phase)) {
        continue;
      }
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

  function ensureFlowBound(apiCtx, state, canonicalEvent, initialStep = FLOW_STATES.PLANNED) {
    const taskFlow = getRuntimeTaskFlow(api, apiCtx);
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

  function findParentRunByChildLink(link) {
    const parentRunId = normalizeString(link?.parentRunId);
    if (!parentRunId) return null;
    return runtimeRuns.get(parentRunId) || null;
  }

  function reviveParentRun(parentLink, ctx = {}) {
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

  function findParentRunByChildOutcome(childOutcome = {}) {
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

  function applyChildOutcomeToParent(parentState, parentAgentId, childOutcome, ctx) {
    if (!parentState || !parentAgentId) return null;
    updateDurableChildTask(parentState, {
      taskId: childOutcome.childTaskId,
      childSessionKey: childOutcome.childSessionKey,
      agentId: childOutcome.childAgentId,
      phase: childOutcome.phase,
      progressSummary: childOutcome.summary,
      updatedAt: childOutcome.updatedAt
    });
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
    const parentTaskFlow = getRuntimeTaskFlow(api, { ...ctx, sessionKey: parentState.sessionKey });
    syncFlowSnapshot(parentTaskFlow, parentState);
    const nextState = childOutcome.phase === "blocked"
      ? FLOW_STATES.BLOCKED
      : countOpenChildTasks(parentState) > 0
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

  return {
    countOpenChildTasks,
    countEvidence,
    buildCollaborationRequirementReason,
    lacksRequiredCollaborationEvidence,
    isSpawnedExecutionRun,
    syncFlowSnapshot,
    transitionFlow,
    ensureFlowBound,
    shouldRetainRuntimeState,
    shouldFinishParent,
    updateDurableChildTask,
    findParentRunByChildLink,
    reviveParentRun,
    findParentRunByChildOutcome,
    applyChildOutcomeToParent
  };
}
