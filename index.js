import { createDashboardStore } from "./lib/dashboard-store.js";
import {
  DEFAULT_DISCOVERY_TOOL_NAMES,
  DEFAULT_ENGINEERING_KEYWORDS,
  DEFAULT_ENTRYPOINT_PATTERNS,
  EVENT_TYPES,
  EXECUTION_LANE_TOOL_NAMES,
  FLOW_STATES,
  SILENT_REPLY_TOKEN,
  appendTimelineEvent,
  applyDurableFlowToRun,
  buildCanonicalEvent,
  buildCanonicalFlowState,
  buildChainAssessment,
  buildCoordinationGuidance,
  buildOrchestrationPlan,
  buildSpawnSuggestion,
  buildSupervisorIntervention,
  canDelegateToOtherAgents,
  classifyDispatchResult,
  classifyIncomingEvent,
  classifyMissionEntryMode,
  classifyOrchestrationMode,
  defaultRunState,
  extractAssistantText,
  extractDispatchTarget,
  getRuntimeTaskFlow,
  hasAnyInternalExecutionStep,
  hasNonEmptyString,
  inferTaskRuntime,
  isEngineeringPrompt,
  isSilentReply,
  isoNow,
  looksLikeEntrypointEscalation,
  looksLikeAwaitingUserInputReply,
  looksLikeWorkspaceDiscoveryTool,
  looksLikeUnverifiedExecutionClaim,
  normalizeString,
  pluginLikeWorkspaceRoots,
  readToolResultDetails,
  resolveCoordinatorAgentId,
  resolveEnabledAgents,
  resolveWorkspaceRoots,
  rewriteAssistantTextMessage,
  setRunTelemetry,
  shouldTreatVisibleReplyAsFinalDelivery
} from "./lib/orchestrator-helpers.js";
import { createFlowRuntimeHelpers } from "./lib/flow-runtime.js";
import { createRuntimeRegistry } from "./lib/runtime-registry.js";
import { createHookHandlers } from "./lib/hook-handlers.js";
import { createReplyHandlers } from "./lib/reply-handlers.js";
import { createDispatchHandler } from "./lib/dispatch-handler.js";

const plugin = {
  id: "mission-deck",
  name: "MISSION DECK",
  description: "Event-adapter orchestration for durable multi-agent flows.",
  configSchema: () => ({
    type: "object",
    additionalProperties: false,
    properties: {
      enabledAgents: {
        type: "array",
        items: { type: "string" }
      },
      coordinatorAgentId: {
        type: "string"
      },
      codeExecutorAgentIds: {
        type: "array",
        items: { type: "string" }
      },
      internalFirst: { type: "boolean" },
      interventionIdleMinutes: {
        type: "integer",
        minimum: 1
      },
      blockPrematureUserEscalation: { type: "boolean" },
      blockPrematureSpawn: { type: "boolean" },
      blockInvalidSessionsSend: { type: "boolean" },
      redactDashboardContent: { type: "boolean" },
      redactSessionKeys: { type: "boolean" },
      redactPromptMetadata: { type: "boolean" },
      taskKeywords: {
        type: "array",
        items: { type: "string" }
      },
      agentWorkspaceRoots: {
        type: "object",
        additionalProperties: {
          type: "string"
        }
      },
      entrypointPatterns: {
        type: "array",
        items: { type: "string" }
      },
      discoveryToolNames: {
        type: "array",
        items: { type: "string" }
      },
      dashboardRetentionDays: {
        type: "integer",
        minimum: 1
      },
      dashboardStatusPath: {
        type: "string"
      },
      dashboardDataDir: {
        type: "string"
      },
      taskflowSupervisor: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          agentId: { type: "string" },
          intervalMinutes: {
            type: "integer",
            minimum: 1
          },
          maxConcurrent: {
            type: "integer",
            minimum: 1
          }
        }
      },
      dashboardHttp: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          host: { type: "string" },
          port: {
            type: "integer",
            minimum: 1
          }
        }
      }
    }
  }),
  register(api) {
    const pluginConfig = api.pluginConfig ?? {};
    const runtimeRuns = new Map();
    const latestRunByAgent = new Map();
    const bestEffortChildLinksByRun = new Map();
    const bestEffortChildLinksBySession = new Map();
    const enabledAgents = Array.from(resolveEnabledAgents(api.config, pluginConfig));
    const coordinatorAgentId = resolveCoordinatorAgentId(api.config, pluginConfig);
    const supervisorConfig = pluginConfig?.taskflowSupervisor ?? {};
    const supervisorAgentId = normalizeString(supervisorConfig?.agentId) || coordinatorAgentId;
    const supervisorIntervalMs = Math.max(1, Number(supervisorConfig?.intervalMinutes) || 10) * 60_000;
    const interventionIdleMinutes = Math.max(1, Number(pluginConfig?.interventionIdleMinutes) || 30);
    const supervisorMaxConcurrent = Math.max(1, Number(supervisorConfig?.maxConcurrent) || 1);
    let supervisorTimer = null;

    const taskFlowRuntime = api.runtime?.tasks?.flow ?? api.runtime?.taskFlow;
    const hostSupportsTaskFlow = Boolean(taskFlowRuntime && typeof taskFlowRuntime.bindSession === "function");
    const hostSupportsA2A = Boolean(api.config?.tools?.agentToAgent?.enabled === true);
    const missingHostPrereqs = [
      ...(hostSupportsTaskFlow ? [] : ["TaskFlow"]),
      ...(hostSupportsA2A ? [] : ["agentToAgent"])
    ];

    const configuredAgentMeta = (Array.isArray(api.config?.agents?.list) ? api.config.agents.list : [])
      .map((agent, index) => ({
        agentId: normalizeString(agent?.id),
        displayName: normalizeString(agent?.identity?.name) || normalizeString(agent?.id),
        emoji: normalizeString(agent?.identity?.emoji),
        theme: normalizeString(agent?.identity?.theme),
        profile: normalizeString(agent?.tools?.profile),
        allowAgents: Array.isArray(agent?.subagents?.allowAgents) ? agent.subagents.allowAgents : [],
        isDefault: Boolean(agent?.default),
        orderIndex: index
      }));

    const dashboard = createDashboardStore(api.logger, {
      retentionDays: pluginConfig?.dashboardRetentionDays,
      statusPath: pluginConfig?.dashboardStatusPath,
      dataDir: pluginConfig?.dashboardDataDir,
      redactDashboardContent: pluginConfig?.redactDashboardContent,
      redactSessionKeys: pluginConfig?.redactSessionKeys,
      redactPromptMetadata: pluginConfig?.redactPromptMetadata,
      configuredAgents: configuredAgentMeta,
      fsEnabled: Array.isArray(api.config?.tools?.sandbox?.tools?.allow) && api.config.tools.sandbox.tools.allow.includes("group:fs"),
      webEnabled: Boolean(api.config?.tools?.web?.search?.enabled || api.config?.tools?.web?.fetch?.enabled),
      mcpServers: Object.keys(api.config?.mcp?.servers || {})
    });

    const {
      isSyntheticAnnounceRun,
      parseSyntheticAnnounceRun,
      getRun,
      findContinuableRootRun,
      rebindRunState,
      resolveState,
      getBestEffortParentLink,
      setBestEffortChildLink,
      deleteBestEffortChildLink,
      touchRun
    } = createRuntimeRegistry({
      runtimeRuns,
      latestRunByAgent,
      bestEffortChildLinksByRun,
      bestEffortChildLinksBySession,
      dashboard
    });

    const {
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
      buildParentDeliveryText,
      applyChildOutcomeToParent
    } = createFlowRuntimeHelpers({
      api,
      dashboard,
      runtimeRuns,
      coordinatorAgentId,
      getRun,
      touchRun
    });
    const { onGatewayStart, onBeforePromptBuild, onBeforeToolCall, runBackground, flushRun } = createHookHandlers({
      api,
      pluginConfig,
      dashboard,
      runtimeRuns,
      enabledAgents,
      coordinatorAgentId,
      supervisorConfig,
      supervisorAgentId,
      supervisorIntervalMs,
      interventionIdleMinutes,
      supervisorMaxConcurrent,
      missingHostPrereqs,
      getRun,
      findContinuableRootRun,
      rebindRunState,
      getBestEffortParentLink,
      isSyntheticAnnounceRun,
      touchRun,
      countEvidence,
      buildCollaborationRequirementReason,
      lacksRequiredCollaborationEvidence,
      isSpawnedExecutionRun,
      syncFlowSnapshot,
      transitionFlow,
      ensureFlowBound
    });

    api.on("gateway_start", onGatewayStart);
    api.on("before_prompt_build", onBeforePromptBuild);
    api.on("before_tool_call", onBeforeToolCall);

    const onAfterToolCall = createDispatchHandler({
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
    });

    api.on("after_tool_call", onAfterToolCall);

    const { onBeforeAgentReply, onBeforeMessageWrite, onAgentEnd } = createReplyHandlers({
      api,
      dashboard,
      runtimeRuns,
      enabledAgents,
      isSyntheticAnnounceRun,
      parseSyntheticAnnounceRun,
      getBestEffortParentLinkFromRegistry: getBestEffortParentLink,
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
    });

    api.on("before_agent_reply", onBeforeAgentReply);
    api.on("before_message_write", onBeforeMessageWrite);
    api.on("agent_end", onAgentEnd);
  }
};

export default plugin;
export const __test__ = {
  DEFAULT_ENGINEERING_KEYWORDS,
  DEFAULT_ENTRYPOINT_PATTERNS,
  DEFAULT_DISCOVERY_TOOL_NAMES,
  EVENT_TYPES,
  FLOW_STATES,
  normalizeString,
  hasNonEmptyString,
  pluginLikeWorkspaceRoots,
  resolveWorkspaceRoots,
  isEngineeringPrompt,
  looksLikeEntrypointEscalation,
  looksLikeWorkspaceDiscoveryTool,
  buildSpawnSuggestion,
  classifyMissionEntryMode,
  buildOrchestrationPlan,
  classifyOrchestrationMode,
  buildSupervisorIntervention,
  runSupervisorSweepDecision(state, options = {}, nowMs = Date.now()) {
    return buildSupervisorIntervention(state, options, nowMs);
  },
  buildCoordinationGuidance,
  extractDispatchTarget,
  extractAssistantText,
  readToolResultDetails,
  rewriteAssistantTextMessage,
  isSilentReply,
  defaultRunState,
  canDelegateToOtherAgents,
  buildCanonicalEvent,
  buildCanonicalFlowState,
  applyDurableFlowToRun,
  buildChainAssessment,
  classifyIncomingEvent
};
