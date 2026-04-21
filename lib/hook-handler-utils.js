import {
  buildChainAssessment,
  buildOrchestrationPlan,
  buildSpawnSuggestion,
  classifyMissionEntryMode,
  classifyOrchestrationMode,
  isEngineeringPrompt,
  normalizeString,
  sanitizeTaskPrompt
} from "./orchestrator-helpers.js";

function isPlanningSafeRead(toolName, params, workspaceRoots) {
  if (normalizeString(toolName).toLowerCase() !== "read") return false;
  const path = normalizeString(params?.path);
  if (!path) return false;
  const lowerPath = path.toLowerCase();
  if (workspaceRoots.some((root) => lowerPath.includes(normalizeString(root).toLowerCase()))) {
    return false;
  }
  return (
    lowerPath.includes("/lib/node_modules/openclaw/skills/") ||
    lowerPath.includes("/lib/node_modules/openclaw/dist/") ||
    lowerPath.includes("/.openclaw/extensions/mission-deck/") ||
    lowerPath.includes("/.openclaw/workspace-coder/mission-deck/")
  );
}

function isPlanningSafeTool(toolName, params, workspaceRoots) {
  const normalizedToolName = normalizeString(toolName).toLowerCase();
  if (normalizedToolName === "update_plan") return true;
  return isPlanningSafeRead(toolName, params, workspaceRoots);
}

function updateRunMetadata({ state, agentId, event, ctx, canonicalEvent, parentLink, apiConfig, pluginConfig, isSpawnedExecutionRun }) {
  state.agentId = agentId;
  state.ownerAgentId = agentId;
  state.sessionKey = normalizeString(ctx?.sessionKey);
  state.promptText = normalizeString(event?.prompt);
  state.normalizedPromptText = sanitizeTaskPrompt(event?.prompt);
  state.engineeringTask = isEngineeringPrompt(event?.prompt, pluginConfig);
  state.entryMode = classifyMissionEntryMode(apiConfig, agentId, event?.prompt, pluginConfig);
  state.orchestrationPlan = buildOrchestrationPlan(apiConfig, agentId, event?.prompt, pluginConfig);
  state.orchestrationMode = normalizeString(state.orchestrationPlan?.mode) || classifyOrchestrationMode(apiConfig, agentId, event?.prompt, pluginConfig);
  state.normalizedEvent = canonicalEvent;
  if (parentLink) {
    state.parentRunId = normalizeString(parentLink.parentRunId);
    state.parentFlowId = normalizeString(parentLink.parentFlowId);
    state.parentTaskId = normalizeString(parentLink.childTaskId);
    state.parentSessionKey = normalizeString(parentLink.parentSessionKey);
    state.parentAgentId = normalizeString(parentLink.parentAgentId);
  }
  if (isSpawnedExecutionRun(state, ctx) && state.orchestrationMode !== "multi_party_required") {
    state.entryMode = state.engineeringTask ? "mission-lite" : "plain";
    state.orchestrationMode = "solo";
    state.orchestrationPlan = {
      mode: "solo",
      targetAgentIds: [],
      requiredEvidenceCount: 0,
      routeHint: "这是已派发的执行子任务，先直接完成并回报父任务。",
      finishCondition: "完成本地执行或明确报告阻塞后即可回传父任务。",
      summary: "链路规划：执行子任务，自主完成并回报父任务。"
    };
  }
  state.chainAssessment = buildChainAssessment(state);
  state.suggestedSpawn = buildSpawnSuggestion(apiConfig, agentId, event?.prompt, pluginConfig);
}

function runBackground(api, promise, label) {
  Promise.resolve(promise).catch((error) => {
    api.logger.warn?.(`[mission-deck] ${label} failed: ${error?.message || error}`);
  });
}

async function flushRun(touchRun, dashboard, runId, agentId, state) {
  touchRun(runId, agentId, state);
  await dashboard.flush();
}

export {
  flushRun,
  isPlanningSafeRead,
  isPlanningSafeTool,
  runBackground,
  updateRunMetadata
};
