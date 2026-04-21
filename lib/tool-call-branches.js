import {
  FLOW_STATES,
  MESSAGE_TOOL_NAME,
  SESSIONS_SEND_TOOL_NAME,
  appendTimelineEvent,
  getMessageText,
  hasAnyInternalExecutionStep,
  normalizeString,
  looksLikeEntrypointEscalation,
  looksLikeExplicitIsolationNeed,
  setRunTelemetry,
  shouldForceSpawnInsteadOfSend
} from "./orchestrator-helpers.js";
import { flushRun } from "./hook-handler-utils.js";
import { blockToolCall, getSendTargetFlags } from "./tool-call-shared.js";

async function handleExecutionLaneTool({
  api,
  pluginConfig,
  dashboard,
  touchRun,
  canDelegateToOtherAgents,
  coordinatorAgentId,
  transitionFlow,
  taskFlow,
  state,
  canonicalEvent,
  event,
  runId,
  agentId,
  toolName
}) {
  const targetAgentId = normalizeString(event.params?.agentId) || "";
  const isChildRun = Boolean(state.parentRunId);
  if (!isChildRun && coordinatorAgentId && agentId !== coordinatorAgentId && targetAgentId && targetAgentId !== agentId) {
    return blockToolCall({
      dashboard,
      touchRun,
      transitionFlow,
      taskFlow,
      state,
      canonicalEvent,
      runId,
      agentId,
      toolName,
      telemetryEvent: "blocked_non_coordinator_root_orchestration",
      blockReason: `This root orchestration lane is reserved for coordinator ${coordinatorAgentId}.`,
      waitJson: {
        kind: "coordinator_required",
        coordinatorAgentId,
        requestedTargetAgentId: targetAgentId,
        summary: `This root orchestration lane is reserved for coordinator ${coordinatorAgentId}.`
      },
      auditSummary: "coordinator required"
    });
  }
  if (isChildRun && targetAgentId && targetAgentId !== agentId && !canDelegateToOtherAgents(api.config, agentId)) {
    return blockToolCall({
      dashboard,
      touchRun,
      transitionFlow,
      taskFlow,
      state,
      canonicalEvent,
      runId,
      agentId,
      toolName,
      telemetryEvent: "blocked_secondary_delegation",
      blockReason: "This agent is execution-only and cannot delegate onward.",
      currentStep: FLOW_STATES.BLOCKED,
      waitJson: {
        kind: "delegation_policy",
        summary: "This agent is execution-only and cannot delegate onward."
      },
      stateJson: {
        state: FLOW_STATES.BLOCKED
      },
      auditSummary: "secondary delegation denied"
    });
  }
  if (toolName === "sessions_spawn" && pluginConfig?.blockPrematureSpawn !== false && !looksLikeExplicitIsolationNeed(event.params, state.promptText) && !state.internalCoordinationSeen) {
    return blockToolCall({
      dashboard,
      touchRun,
      transitionFlow,
      taskFlow,
      state,
      canonicalEvent,
      runId,
      agentId,
      toolName,
      telemetryEvent: "blocked_premature_spawn",
      blockReason: "First inspect visible teammate sessions before opening a fresh isolated lane.",
      auditSummary: "premature spawn"
    });
  }
  if (toolName === SESSIONS_SEND_TOOL_NAME) {
    const { hasSessionKey, hasLabel, hasAgentId } = getSendTargetFlags(event.params);
    if ((hasSessionKey || hasLabel) && shouldForceSpawnInsteadOfSend(agentId, event.params)) {
      return blockToolCall({
        dashboard,
        touchRun,
        transitionFlow,
        taskFlow,
        state,
        canonicalEvent,
        runId,
        agentId,
        toolName,
        telemetryEvent: "blocked_cross_agent_label_send",
        blockReason: `Cross-agent sessions_send using only label is unreliable for ${targetAgentId}.`,
        auditSummary: "cross-agent label send blocked"
      });
    }
    if (pluginConfig?.blockInvalidSessionsSend !== false && hasAgentId && !hasSessionKey && !hasLabel) {
      return blockToolCall({
        dashboard,
        touchRun,
        transitionFlow,
        taskFlow,
        state,
        canonicalEvent,
        runId,
        agentId,
        toolName,
        telemetryEvent: "blocked_invalid_sessions_send",
        blockReason: "sessions_send cannot target by agentId alone. Reuse a known session via sessionKey/label, or create an execution lane with sessions_spawn first.",
        auditSummary: "invalid sessions_send"
      });
    }
  }
  state.dispatchAttempted = true;
  if (event.toolCallId) {
    state.pendingDispatches.set(event.toolCallId, {
      params: event.params ?? null,
      toolName
    });
  }
  appendTimelineEvent(state, {
    role: "安排跟进",
    owner: agentId,
    text: "正在建立协作链路。"
  });
  if (taskFlow) {
    transitionFlow(taskFlow, state, "resume", {
      status: "running",
      currentStep: FLOW_STATES.ROUTING,
      stateJson: {
        state: FLOW_STATES.ROUTING
      }
    }, canonicalEvent, "dispatch requested");
  }
  await flushRun(touchRun, dashboard, runId, agentId, state);
  return undefined;
}

async function handleMessageTool({
  pluginConfig,
  dashboard,
  touchRun,
  state,
  event,
  runId,
  agentId,
  toolName
}) {
  if (pluginConfig?.blockPrematureUserEscalation !== false && looksLikeEntrypointEscalation(event.params, pluginConfig) && !state.workspaceDiscoverySeen) {
    setRunTelemetry(state, "blocked_premature_user_escalation", {
      toolName: event.toolName,
      blockReason: "Use internal-first coordination before asking the user for repo paths, project directories, git URLs, or session entrypoints."
    });
    await flushRun(touchRun, dashboard, runId, agentId, state);
    return {
      block: true,
      blockReason: "Use internal-first coordination before asking the user for repo paths, project directories, git URLs, or session entrypoints."
    };
  }
  if (state.engineeringTask && !hasAnyInternalExecutionStep(state)) {
    setRunTelemetry(state, "blocked_external_message_before_internal_action", {
      toolName: event.toolName,
      blockReason: "Execution-first rule: do at least one internal action before any external progress message on engineering work."
    });
    await flushRun(touchRun, dashboard, runId, agentId, state);
    return {
      block: true,
      blockReason: "Execution-first rule: do at least one internal action before any external progress message on engineering work."
    };
  }
  state.userVisibleMessageSent = true;
  state.lastBlockReason = "";
  setRunTelemetry(state, "external_message", {
    toolName: event.toolName,
    externalMessage: getMessageText(event.params)
  });
  appendTimelineEvent(state, {
    role: "对外同步",
    owner: agentId,
    text: getMessageText(event.params)
  });
  await flushRun(touchRun, dashboard, runId, agentId, state);
  return undefined;
}

export {
  handleExecutionLaneTool,
  handleMessageTool
};
