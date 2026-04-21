import {
  EVENT_TYPES,
  FLOW_STATES,
  SILENT_REPLY_TOKEN,
  appendTimelineEvent,
  buildCanonicalEvent,
  extractAssistantText,
  getRuntimeTaskFlow,
  hasAnyInternalExecutionStep,
  isSilentReply,
  isoNow,
  looksLikeAwaitingUserInputReply,
  looksLikeUnverifiedExecutionClaim,
  normalizeString,
  rewriteAssistantTextMessage,
  setRunTelemetry,
  shouldTreatVisibleReplyAsFinalDelivery
} from "./orchestrator-helpers.js";

export function createReplyHandlers(deps) {
  const {
    api,
    dashboard,
    runtimeRuns,
    enabledAgents,
    isSyntheticAnnounceRun,
    parseSyntheticAnnounceRun,
    getBestEffortParentLinkFromRegistry,
    findParentRunByChildLink,
    reviveParentRun,
    findParentRunByChildOutcome,
    applyChildOutcomeToParent,
    countEvidence,
    countOpenChildTasks,
    buildCollaborationRequirementReason,
    lacksRequiredCollaborationEvidence,
    shouldFinishParent,
    shouldRetainRuntimeState,
    syncFlowSnapshot,
    transitionFlow,
    ensureFlowBound,
    deleteBestEffortChildLink,
    runBackground,
    flushRun
  } = deps;

  async function onBeforeAgentReply(event, ctx) {
    const agentId = normalizeString(ctx?.agentId);
    if (!agentId || !enabledAgents.includes(agentId)) return;
    const runId = normalizeString(ctx?.runId);
    const state = runId ? runtimeRuns.get(runId) : null;
    if (!state?.engineeringTask || state.entryMode === "plain") return;
    if (!isSilentReply(event?.cleanedBody)) return;
    if (hasAnyInternalExecutionStep(state)) return;
    return {
      handled: true,
      reply: {
        text: "This run will not end silently. No internal execution step has happened yet; inspect sessions, inspect workspaces, or open an execution lane first."
      }
    };
  }

  function onBeforeMessageWrite(event, ctx) {
    const agentId = normalizeString(ctx?.agentId);
    const runId = normalizeString(ctx?.runId);
    if (!agentId || !runId || !enabledAgents.includes(agentId)) return;

    if (isSyntheticAnnounceRun(runId)) {
      const synthetic = parseSyntheticAnnounceRun(runId);
      const assistantText = extractAssistantText(event?.message);
      if (!synthetic?.childRunId || !assistantText || isSilentReply(assistantText)) {
        return {
          message: rewriteAssistantTextMessage(event.message, SILENT_REPLY_TOKEN)
        };
      }
      const childOutcome = {
        childRunId: synthetic.childRunId,
        childSessionKey: `agent:${synthetic.childAgentId}:${synthetic.childScope}:${synthetic.childSessionId}`,
        childAgentId: synthetic.childAgentId,
        phase: looksLikeAwaitingUserInputReply(assistantText) ? "blocked" : "completed",
        summary: assistantText,
        updatedAt: isoNow(),
        finalReplyText: assistantText
      };
      const parentLink = getBestEffortParentLinkFromRegistry(synthetic.childRunId, childOutcome.childSessionKey);
      const parentState = findParentRunByChildLink(parentLink) || findParentRunByChildOutcome({
        childTaskId: normalizeString(parentLink?.childTaskId),
        childRunId: childOutcome.childRunId,
        childSessionKey: childOutcome.childSessionKey
      }) || reviveParentRun(parentLink, ctx);
      if (!parentState) {
        return {
          message: rewriteAssistantTextMessage(event.message, SILENT_REPLY_TOKEN)
        };
      }
      const reconciliation = applyChildOutcomeToParent(parentState, normalizeString(parentLink?.parentAgentId) || normalizeString(parentState.agentId), {
        parentRunId: normalizeString(parentLink?.parentRunId) || normalizeString(parentState.flowId),
        childTaskId: normalizeString(parentLink?.childTaskId),
        childSessionKey: normalizeString(parentLink?.childSessionKey) || childOutcome.childSessionKey,
        childRunId: childOutcome.childRunId,
        childAgentId: normalizeString(parentLink?.childAgentId) || childOutcome.childAgentId,
        phase: childOutcome.phase,
        summary: childOutcome.summary,
        updatedAt: childOutcome.updatedAt,
        finalReplyText: childOutcome.finalReplyText
      }, ctx);
      runBackground(
        dashboard.attachChildOutcome(childOutcome).then(() => dashboard.flush()),
        "synthetic announce reconciliation"
      );
      if (!reconciliation?.completed) {
        return {
          message: rewriteAssistantTextMessage(event.message, SILENT_REPLY_TOKEN)
        };
      }
      return {
        message: rewriteAssistantTextMessage(event.message, reconciliation.deliveryText || assistantText)
      };
    }

    const state = runtimeRuns.get(runId);
    if (!state?.engineeringTask || state.entryMode === "plain") return;
    const parentLink = getBestEffortParentLinkFromRegistry(runId, ctx?.sessionKey);
    const canonicalEvent = buildCanonicalEvent({
      hookName: "before_message_write",
      event,
      ctx,
      runState: state,
      parentLink
    });
    const taskFlow = state.entryMode === "mission-flow" ? ensureFlowBound(ctx, state, canonicalEvent, FLOW_STATES.REVIEWING) : null;
    syncFlowSnapshot(taskFlow, state);

    const assistantText = extractAssistantText(event?.message);
    if (!assistantText || isSilentReply(assistantText)) {
      if (hasAnyInternalExecutionStep(state)) return;
      return {
        message: rewriteAssistantTextMessage(
          event.message,
          "The run is still in internal progress and no valid internal action has completed yet. It will not end silently; the next step is to establish a traceable execution path."
        )
      };
    }

    const evidenceCount = countEvidence(state);
    const unverifiedExecutionClaim =
      state.entryMode === "mission-flow" &&
      state.orchestrationMode === "delegate_once" &&
      evidenceCount < 1 &&
      looksLikeUnverifiedExecutionClaim(assistantText);
    const missingDelegation =
      unverifiedExecutionClaim ||
      (
        state.entryMode === "mission-flow" &&
        state.orchestrationMode === "delegate_once" &&
        evidenceCount < 1 &&
        shouldTreatVisibleReplyAsFinalDelivery(assistantText)
      );
    if (missingDelegation) {
      const continuationReason = unverifiedExecutionClaim
        ? "delegate-once task claimed active execution before any real delegated evidence"
        : "delegate-once task produced a result-style reply before any real delegated evidence";
      state.lastBlockReason = continuationReason;
      state.userVisibleMessageSent = false;
      setRunTelemetry(state, "awaiting_first_delegation", {
        toolName: "assistant_reply",
        blockReason: continuationReason
      });
      appendTimelineEvent(state, {
        role: "流程纠偏",
        owner: agentId,
        text: "检测到结果性回复缺少真实委派证据，已转回首次委派阶段。",
        tone: "blocked"
      });
      if (taskFlow) {
        transitionFlow(taskFlow, state, "setWaiting", {
          currentStep: FLOW_STATES.ROUTING,
          blockedSummary: continuationReason,
          waitJson: {
            kind: "delegation_required",
            summary: continuationReason
          },
          stateJson: {
            state: FLOW_STATES.ROUTING,
            finalizeCandidate: null
          }
        }, canonicalEvent, "finalize candidate rejected");
      }
      runBackground(flushRun(runId, agentId, state), "before_message_write flush");
      return {
        message: rewriteAssistantTextMessage(
          event.message,
          "继续内部执行中：尚未形成可验证的委派证据，下一步会先发起真实协同，再在拿到子任务结果后汇总。"
        )
      };
    }

    state.userVisibleMessageSent = true;
    state.lastBlockReason = "";
    setRunTelemetry(state, canonicalEvent.eventType === EVENT_TYPES.FINALIZE_CANDIDATE ? "finalize_candidate" : "progress_update", {
      toolName: "assistant_reply",
      externalMessage: assistantText
    });
    appendTimelineEvent(state, {
      role: canonicalEvent.eventType === EVENT_TYPES.FINALIZE_CANDIDATE ? "最终回复" : "进度更新",
      owner: agentId,
      text: assistantText
    });

    if (taskFlow) {
      transitionFlow(taskFlow, state, "resume", {
        status: "running",
        currentStep: canonicalEvent.eventType === EVENT_TYPES.FINALIZE_CANDIDATE ? FLOW_STATES.FINALIZING : FLOW_STATES.REVIEWING,
        stateJson: {
          state: canonicalEvent.eventType === EVENT_TYPES.FINALIZE_CANDIDATE ? FLOW_STATES.FINALIZING : FLOW_STATES.REVIEWING,
          finalizeCandidate: canonicalEvent.eventType === EVENT_TYPES.FINALIZE_CANDIDATE ? {
            text: assistantText,
            createdAt: isoNow(),
            evidenceCount
          } : state.durable?.finalizeCandidate || null
        }
      }, canonicalEvent, canonicalEvent.eventType === EVENT_TYPES.FINALIZE_CANDIDATE ? "finalize candidate stored" : "progress update stored");
    }
    runBackground(flushRun(runId, agentId, state), "before_message_write flush");
  }

  async function onAgentEnd(_event, ctx) {
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
        transitionFlow(taskFlow, state, "setWaiting", {
          currentStep: FLOW_STATES.REVIEWING,
          waitJson: {
            kind: "response_pending",
            summary: "no user-visible update recorded"
          },
          stateJson: {
            state: FLOW_STATES.REVIEWING
          }
        }, canonicalEvent, "awaiting visible update");
      }
    }

    if (state.parentRunId && state.parentTaskId) {
      const link = getBestEffortParentLinkFromRegistry(runId, ctx?.sessionKey) || {
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
        applyChildOutcomeToParent(parentState, normalizeString(link.parentAgentId), {
          parentRunId: normalizeString(link.parentRunId),
          childTaskId: normalizeString(link.childTaskId),
          childSessionKey: normalizeString(link.childSessionKey),
          childRunId: runId,
          childAgentId: agentId,
          phase: state.lastBlockReason ? "blocked" : "completed",
          summary: normalizeString(state.lastExternalMessage) || normalizeString(state.lastBlockReason) || "已收到最新进展",
          updatedAt: isoNow()
        }, ctx);
        await dashboard.attachChildOutcome({
          parentRunId: normalizeString(link.parentRunId),
          childTaskId: normalizeString(link.childTaskId),
          childSessionKey: normalizeString(link.childSessionKey),
          childRunId: runId,
          childAgentId: agentId,
          phase: state.lastBlockReason ? "blocked" : "completed",
          summary: normalizeString(state.lastExternalMessage) || normalizeString(state.lastBlockReason) || "已收到最新进展",
          updatedAt: isoNow()
        });
      }
      deleteBestEffortChildLink(link);
    }

    if (!archived) {
      dashboard.trackActiveRun(runId, agentId, state);
    }
    if (!shouldRetainRuntimeState(state, archived)) {
      runtimeRuns.delete(runId);
    }
    await dashboard.flush();
  }

  return {
    onBeforeAgentReply,
    onBeforeMessageWrite,
    onAgentEnd
  };
}
