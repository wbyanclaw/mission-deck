import {
  EXECUTION_LANE_TOOL_NAMES,
  INTERNAL_COORDINATION_TOOL_NAMES,
  MESSAGE_TOOL_NAME,
  looksLikeWorkspaceDiscoveryTool
} from "./orchestrator-helpers.js";
import { isPlanningSafeTool } from "./hook-handler-utils.js";
import { blockToolCall, markRoutingProgress } from "./tool-call-shared.js";

async function handleRoutingPrerequisites({
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
}) {
  if (looksLikeWorkspaceDiscoveryTool(event.toolName, event.params, workspaceRoots, pluginConfig)) {
    state.workspaceDiscoverySeen = true;
    await markRoutingProgress({
      dashboard,
      touchRun,
      transitionFlow,
      taskFlow,
      state,
      canonicalEvent,
      runId,
      agentId,
      toolName: event.toolName,
      telemetryEvent: "workspace_discovery",
      role: "资料检查",
      text: "正在检查相关文件、工作区或台账。"
    });
    return { handled: true };
  }

  if (INTERNAL_COORDINATION_TOOL_NAMES.has(toolName)) {
    state.internalCoordinationSeen = true;
    await markRoutingProgress({
      dashboard,
      touchRun,
      transitionFlow,
      taskFlow,
      state,
      canonicalEvent,
      runId,
      agentId,
      toolName: event.toolName,
      telemetryEvent: "internal_coordination",
      role: "内部查询",
      text: "正在查看现有会话和团队分工情况。"
    });
    return { handled: true };
  }

  if (
    state.orchestrationMode !== "solo" &&
    !state.internalCoordinationSeen &&
    !state.workspaceDiscoverySeen &&
    !isPlanningSafeTool(event.toolName, event.params, workspaceRoots) &&
    !EXECUTION_LANE_TOOL_NAMES.has(toolName) &&
    toolName !== MESSAGE_TOOL_NAME
  ) {
    return {
      handled: true,
      result: await blockToolCall({
        dashboard,
        touchRun,
        transitionFlow,
        taskFlow,
        state,
        canonicalEvent,
        runId,
        agentId,
        toolName,
        telemetryEvent: "blocked_before_plan_routing",
        blockReason: `This task requires routing first. Follow the orchestration plan before using ${toolName}.`,
        auditSummary: "routing required",
        pushDashboardBlocker: true
      })
    };
  }

  return { handled: false };
}

export { handleRoutingPrerequisites };
