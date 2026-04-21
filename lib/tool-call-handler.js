import {
  FLOW_STATES,
  MESSAGE_TOOL_NAME,
  buildCanonicalEvent,
  EXECUTION_LANE_TOOL_NAMES,
  normalizeString,
  resolveWorkspaceRoots,
  INTERNAL_COORDINATION_TOOL_NAMES
} from "./orchestrator-helpers.js";
import { buildHostPrereqMessage } from "./runtime-registry.js";
import { flushRun } from "./hook-handler-utils.js";
import { handleRoutingPrerequisites } from "./tool-call-routing.js";
import { handleExecutionLaneTool, handleMessageTool } from "./tool-call-branches.js";

export function createBeforeToolCallHandler(deps) {
  const {
    api,
    pluginConfig,
    dashboard,
    runtimeRuns,
    enabledAgents,
    coordinatorAgentId,
    missingHostPrereqs,
    getBestEffortParentLink,
    isSyntheticAnnounceRun,
    touchRun,
    canDelegateToOtherAgents,
    syncFlowSnapshot,
    transitionFlow,
    ensureFlowBound
  } = deps;

  return async function onBeforeToolCall(event, ctx) {
    const agentId = normalizeString(ctx?.agentId);
    const runId = normalizeString(ctx?.runId);
    if (!agentId || !runId || !enabledAgents.includes(agentId)) return;
    if (isSyntheticAnnounceRun(runId)) return;
    if (missingHostPrereqs.length > 0) {
      return {
        block: true,
        blockReason: buildHostPrereqMessage(missingHostPrereqs)
      };
    }

    const state = runtimeRuns.get(runId);
    if (!state || state.entryMode === "plain") return;
    const parentLink = getBestEffortParentLink(runId, ctx?.sessionKey);
    const canonicalEvent = buildCanonicalEvent({
      hookName: "before_tool_call",
      event,
      ctx,
      runState: state,
      parentLink
    });
    const toolName = normalizeString(event.toolName).toLowerCase();
    const workspaceRoots = resolveWorkspaceRoots(api.config, agentId, pluginConfig);
    const taskFlow = state.entryMode === "mission-flow" ? ensureFlowBound(ctx, state, canonicalEvent, FLOW_STATES.PLANNED) : null;
    syncFlowSnapshot(taskFlow, state);

    const routingResult = await handleRoutingPrerequisites({
      dashboard,
      touchRun,
      transitionFlow,
      taskFlow,
      state,
      canonicalEvent,
      event,
      runId,
      agentId,
      toolName,
      workspaceRoots,
      pluginConfig
    });
    if (routingResult.handled) return routingResult.result;

    if (EXECUTION_LANE_TOOL_NAMES.has(toolName)) {
      return handleExecutionLaneTool({
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
      });
    }

    if (toolName === MESSAGE_TOOL_NAME) {
      return handleMessageTool({
        pluginConfig,
        dashboard,
        touchRun,
        state,
        event,
        runId,
        agentId,
        toolName
      });
    }
  };
}
