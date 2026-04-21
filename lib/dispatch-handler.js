import {
  EXECUTION_LANE_TOOL_NAMES,
  FLOW_STATES,
  appendTimelineEvent,
  buildCanonicalEvent,
  classifyDispatchResult,
  extractDispatchTarget,
  inferTaskRuntime,
  isoNow,
  normalizeString,
  readToolResultDetails,
  setRunTelemetry
} from "./orchestrator-helpers.js";

export function createDispatchHandler(deps) {
  const {
    dashboard,
    runtimeRuns,
    enabledAgents,
    isSyntheticAnnounceRun,
    getBestEffortParentLink,
    ensureFlowBound,
    syncFlowSnapshot,
    transitionFlow,
    updateDurableChildTask,
    setBestEffortChildLink,
    countEvidence,
    flushRun
  } = deps;

  return async function onAfterToolCall(event, ctx) {
    const agentId = normalizeString(ctx?.agentId);
    const runId = normalizeString(ctx?.runId);
    if (!agentId || !runId || !enabledAgents.includes(agentId)) return;
    if (isSyntheticAnnounceRun(runId)) return;

    const state = runtimeRuns.get(runId);
    if (!state || state.entryMode === "plain") return;
    const parentLink = getBestEffortParentLink(runId, ctx?.sessionKey);
    const canonicalEvent = buildCanonicalEvent({
      hookName: "after_tool_call",
      event,
      ctx,
      runState: state,
      parentLink
    });
    const taskFlow = state.entryMode === "mission-flow" ? ensureFlowBound(ctx, state, canonicalEvent, FLOW_STATES.ROUTING) : null;
    syncFlowSnapshot(taskFlow, state);
    const toolName = normalizeString(event.toolName).toLowerCase();
    if (!EXECUTION_LANE_TOOL_NAMES.has(toolName)) return;

    const pendingDispatch = event.toolCallId ? state.pendingDispatches.get(event.toolCallId) : null;
    if (event.toolCallId) state.pendingDispatches.delete(event.toolCallId);
    const details = readToolResultDetails(event);
    const dispatchParams = event.params ?? pendingDispatch?.params ?? {};
    const dispatch = extractDispatchTarget(toolName, dispatchParams, details);
    const classification = classifyDispatchResult(toolName, details, dispatch);
    setRunTelemetry(state, "dispatch_result", {
      toolName: event.toolName,
      toolStatus: classification.phase
    });

    if (!classification.track) {
      if (classification.failed) {
        const hasDeliveredChildren = (Array.isArray(state?.childTasks) ? state.childTasks : []).some((task) =>
          ["completed", "succeeded", "success", "done", "reported", "delivered"].includes(normalizeString(task?.phase).toLowerCase())
        );
        state.lastBlockReason = normalizeString(classification.reason);
        appendTimelineEvent(state, {
          role: "异常摘要",
          owner: agentId,
          text: state.lastBlockReason,
          tone: "blocked"
        });
        if (taskFlow) {
          transitionFlow(taskFlow, state, "setWaiting", {
            currentStep: hasDeliveredChildren ? FLOW_STATES.REVIEWING : FLOW_STATES.BLOCKED,
            blockedSummary: hasDeliveredChildren ? "" : state.lastBlockReason,
            waitJson: {
              kind: hasDeliveredChildren ? "partial_dispatch_failure" : "dispatch_failure",
              summary: state.lastBlockReason,
              targetAgentId: dispatch?.agentId || ""
            },
            stateJson: {
              state: hasDeliveredChildren ? FLOW_STATES.REVIEWING : FLOW_STATES.BLOCKED,
              lastFailureKind: "dispatch_failure",
              lastFailureReason: state.lastBlockReason
            }
          }, canonicalEvent, "dispatch failed");
        }
        await dashboard.pushBlocker({
          timestamp: isoNow(),
          runId,
          agentId,
          reason: state.lastBlockReason,
          toolName
        });
      }
      await flushRun(runId, agentId, state);
      return;
    }

    if (!taskFlow || !dispatch?.task) {
      await flushRun(runId, agentId, state);
      return;
    }

    const created = taskFlow.runTask({
      flowId: state.flowId,
      runtime: inferTaskRuntime(toolName),
      childSessionKey: dispatch.childSessionKey || undefined,
      agentId: dispatch.agentId || undefined,
      runId: dispatch.runId || undefined,
      label: dispatch.label || undefined,
      task: dispatch.task,
      status: "running",
      progressSummary: `Delegated via ${toolName}`
    });
    if (!created?.created || !created?.task?.taskId) {
      await flushRun(runId, agentId, state);
      return;
    }

    state.executionLaneSeen = true;
    updateDurableChildTask(state, {
      taskId: created.task.taskId,
      agentId: dispatch.agentId,
      childSessionKey: dispatch.childSessionKey,
      childRunId: dispatch.runId,
      label: dispatch.label,
      phase: "running",
      progressSummary: `Delegated via ${toolName}`,
      updatedAt: isoNow()
    });
    appendTimelineEvent(state, {
      role: "安排跟进",
      owner: agentId,
      text: dispatch.agentId ? `已交给 ${dispatch.agentId} 继续处理。` : "已建立新的协作链路。"
    });
    const childLink = {
      parentRunId: runId,
      parentFlowId: state.flowId,
      parentAgentId: agentId,
      parentSessionKey: normalizeString(ctx?.sessionKey),
      childTaskId: created.task.taskId,
      childRunId: normalizeString(dispatch.runId),
      childSessionKey: normalizeString(dispatch.childSessionKey),
      childAgentId: normalizeString(dispatch.agentId)
    };
    setBestEffortChildLink(childLink);
    transitionFlow(taskFlow, state, "resume", {
      status: "running",
      currentStep: FLOW_STATES.DELEGATED,
      stateJson: {
        state: FLOW_STATES.DELEGATED,
        childTasks: state.childTasks,
        childSessions: state.childTasks.map((task) => task.childSessionKey).filter(Boolean),
        receivedEvidenceCount: countEvidence(state)
      }
    }, canonicalEvent, "child task registered");
    await dashboard.pushDispatch({
      timestamp: isoNow(),
      runId,
      agentId,
      toolName,
      status: classification.phase,
      target: dispatch,
      taskflow: {
        flowId: state.flowId,
        childTaskId: created.task.taskId
      }
    });
    await flushRun(runId, agentId, state);
  };
}
