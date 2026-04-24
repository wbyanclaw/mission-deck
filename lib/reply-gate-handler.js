import {
  EVENT_TYPES,
  FLOW_STATES,
  SILENT_REPLY_TOKEN,
  appendTimelineEvent,
  buildCanonicalEvent,
  extractAssistantText,
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

export function createReplyGateHandlers(deps) {
  const {
    enabledAgents,
    runtimeRuns,
    dashboard,
    isSyntheticAnnounceRun,
    parseSyntheticAnnounceRun,
    getBestEffortParentLinkFromRegistry,
    findParentRunByChildLink,
    reviveParentRun,
    findParentRunByChildOutcome,
    applyChildOutcomeToParent,
    countEvidence,
    ensureFlowBound,
    syncFlowSnapshot,
    transitionFlow,
    flushRun,
    runBackground
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
      if (!reconciliation?.duplicate) {
        runBackground(
          dashboard.attachChildOutcome(childOutcome).then(() => dashboard.flush()),
          "synthetic announce reconciliation"
        );
      }
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
    const childExecutionRun = Boolean(
      normalizeString(state.parentRunId) ||
      normalizeString(state.parentTaskId) ||
      normalizeString(parentLink?.parentRunId) ||
      normalizeString(parentLink?.childTaskId)
    );
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

    if (childExecutionRun) {
      state.userVisibleMessageSent = false;
      state.lastExternalMessage = assistantText;
      setRunTelemetry(state, "child_report_hidden", {
        toolName: "assistant_reply",
        externalMessage: assistantText
      });
      appendTimelineEvent(state, {
        role: "子任务回执",
        owner: agentId,
        text: assistantText
      });
      runBackground(flushRun(runId, agentId, state), "before_message_write child flush");
      return {
        message: rewriteAssistantTextMessage(event.message, SILENT_REPLY_TOKEN)
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
      if (canonicalEvent.eventType === EVENT_TYPES.FINALIZE_CANDIDATE && shouldTreatVisibleReplyAsFinalDelivery(assistantText)) {
        transitionFlow(taskFlow, state, "finish", {
          currentStep: FLOW_STATES.COMPLETED,
          stateJson: {
            state: FLOW_STATES.COMPLETED,
            finalizeCandidate: {
              text: assistantText,
              createdAt: isoNow(),
              evidenceCount
            },
            finalOutput: {
              text: assistantText,
              deliveredAt: isoNow()
            }
          }
        }, canonicalEvent, "final reply delivered");
      } else {
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
    }
    runBackground(flushRun(runId, agentId, state), "before_message_write flush");
  }

  return {
    onBeforeAgentReply,
    onBeforeMessageWrite
  };
}
