import {
  FLOW_STATES,
  buildCanonicalEvent,
  isoNow,
  normalizeString,
  setRunTelemetry
} from "./orchestrator-helpers.js";

export function createAgentEndHandler(deps) {
  const {
    dashboard,
    runtimeRuns,
    isSyntheticAnnounceRun,
    getBestEffortParentLinkFromRegistry,
    findParentRunByChildLink,
    reviveParentRun,
    applyChildOutcomeToParent,
    countOpenChildTasks,
    buildCollaborationRequirementReason,
    lacksRequiredCollaborationEvidence,
    shouldFinishParent,
    shouldRetainRuntimeState,
    syncFlowSnapshot,
    transitionFlow,
    ensureFlowBound,
    deleteBestEffortChildLink
  } = deps;

  function buildMissingVisibleReplyReason(state) {
    if (state?.lastBlockReason) return normalizeString(state.lastBlockReason);
    const evidenceCount = Array.isArray(state?.childTasks)
      ? state.childTasks.filter((task) => {
        const phase = normalizeString(task?.phase).toLowerCase();
        return ["reported", "succeeded", "success", "completed", "done", "delivered", "blocked", "failed"].includes(phase);
      }).length
      : 0;
    if (evidenceCount > 0) return "agent run ended after collecting evidence but before sending a visible reply";
    return "agent run ended without sending a visible reply";
  }

  return async function onAgentEnd(_event, ctx) {
    const agentId = normalizeString(ctx?.agentId);
    const runId = normalizeString(ctx?.runId);
    if (!runId) return;
    if (isSyntheticAnnounceRun(runId)) {
      runtimeRuns.delete(runId);
      return;
    }

    const state = runtimeRuns.get(runId);
    if (!state) return;
    if (state.entryMode === "plain") {
      runtimeRuns.delete(runId);
      return;
    }

    const canonicalEvent = buildCanonicalEvent({
      hookName: "agent_end",
      event: {},
      ctx,
      runState: state,
      parentLink: getBestEffortParentLinkFromRegistry(runId, ctx?.sessionKey)
    });
    const taskFlow = state.entryMode === "mission-flow" ? ensureFlowBound(ctx, state, canonicalEvent, FLOW_STATES.REVIEWING) : null;
    syncFlowSnapshot(taskFlow, state);
    setRunTelemetry(state, "agent_end");

    let archived = false;
    if (state.entryMode === "mission-flow" && taskFlow) {
      if (state.lastBlockReason) {
        transitionFlow(taskFlow, state, "setWaiting", {
          currentStep: FLOW_STATES.BLOCKED,
          blockedSummary: state.lastBlockReason,
          waitJson: {
            kind: "blocked",
            summary: state.lastBlockReason
          },
          stateJson: {
            state: FLOW_STATES.BLOCKED,
            lastFailureKind: "blocked",
            lastFailureReason: state.lastBlockReason
          }
        }, canonicalEvent, "run blocked");
      } else if (countOpenChildTasks(state) > 0) {
        transitionFlow(taskFlow, state, "setWaiting", {
          currentStep: FLOW_STATES.WAITING_CHILD,
          waitJson: {
            kind: "child_progress",
            summary: "awaiting child completion"
          },
          stateJson: {
            state: FLOW_STATES.WAITING_CHILD
          }
        }, canonicalEvent, "awaiting child completion");
      } else if (lacksRequiredCollaborationEvidence(state)) {
        const collaborationReason = buildCollaborationRequirementReason(state);
        transitionFlow(taskFlow, state, "setWaiting", {
          currentStep: FLOW_STATES.BLOCKED,
          blockedSummary: collaborationReason,
          waitJson: {
            kind: "collaboration_required",
            summary: collaborationReason
          },
          stateJson: {
            state: FLOW_STATES.BLOCKED
          }
        }, canonicalEvent, "collaboration evidence missing");
      } else if (state.userVisibleMessageSent || shouldFinishParent(state)) {
        transitionFlow(taskFlow, state, "finish", {
          currentStep: FLOW_STATES.COMPLETED,
          stateJson: {
            state: FLOW_STATES.COMPLETED,
            finalOutput: {
              text: normalizeString(state.lastExternalMessage),
              deliveredAt: isoNow()
            }
          }
        }, canonicalEvent, "flow completed");
        await dashboard.archiveRun(runId, agentId, state);
        archived = true;
      } else {
        const missingVisibleReplyReason = buildMissingVisibleReplyReason(state);
        state.lastBlockReason = missingVisibleReplyReason;
        transitionFlow(taskFlow, state, "setWaiting", {
          currentStep: FLOW_STATES.BLOCKED,
          blockedSummary: missingVisibleReplyReason,
          waitJson: {
            kind: "visible_reply_missing",
            summary: missingVisibleReplyReason
          },
          stateJson: {
            state: FLOW_STATES.BLOCKED,
            lastFailureKind: "missing_visible_reply",
            lastFailureReason: missingVisibleReplyReason
          }
        }, canonicalEvent, "run ended without visible reply");
      }
    }

    const resolvedParentLink = getBestEffortParentLinkFromRegistry(runId, ctx?.sessionKey);
    const isDirectMissionLiteRun =
      state.entryMode === "mission-lite" &&
      !normalizeString(state.parentRunId) &&
      !normalizeString(state.parentFlowId) &&
      !normalizeString(state.parentTaskId) &&
      !resolvedParentLink?.childTaskId &&
      !resolvedParentLink?.parentFlowId;
    if (!archived && isDirectMissionLiteRun) {
      await dashboard.archiveRun(runId, agentId, state);
      archived = true;
    }

    if ((state.parentRunId && state.parentTaskId) || resolvedParentLink?.childTaskId || resolvedParentLink?.parentFlowId) {
      const link = resolvedParentLink || {
        parentRunId: state.parentRunId,
        parentFlowId: state.parentFlowId,
        childTaskId: state.parentTaskId,
        childSessionKey: normalizeString(ctx?.sessionKey),
        childRunId: runId,
        childAgentId: agentId,
        parentAgentId: state.parentAgentId
      };
      const parentState = findParentRunByChildLink(link) || reviveParentRun(link, ctx);
      if (parentState) {
        const summary = normalizeString(state.lastExternalMessage) || normalizeString(state.lastBlockReason) || "已收到最新进展";
        const reconciliation = applyChildOutcomeToParent(parentState, normalizeString(link.parentAgentId), {
          parentRunId: normalizeString(link.parentRunId) || normalizeString(parentState.flowId),
          childTaskId: normalizeString(link.childTaskId),
          childSessionKey: normalizeString(link.childSessionKey),
          childRunId: runId,
          childAgentId: agentId,
          phase: state.lastBlockReason ? "blocked" : "completed",
          summary,
          updatedAt: isoNow()
        }, ctx);
        if (!reconciliation?.duplicate) {
          await dashboard.attachChildOutcome({
            parentRunId: normalizeString(link.parentRunId) || normalizeString(parentState.flowId),
            childTaskId: normalizeString(link.childTaskId),
            childSessionKey: normalizeString(link.childSessionKey),
            childRunId: runId,
            childAgentId: agentId,
            phase: state.lastBlockReason ? "blocked" : "completed",
            summary,
            updatedAt: isoNow()
          });
        }
      }
      deleteBestEffortChildLink(link);
    }

    const retainRuntimeState = shouldRetainRuntimeState(state, archived);
    if (!archived && retainRuntimeState) {
      dashboard.trackActiveRun(runId, agentId, state);
    }
    if (!retainRuntimeState) {
      runtimeRuns.delete(runId);
    }
    await dashboard.flush();
  };
}
