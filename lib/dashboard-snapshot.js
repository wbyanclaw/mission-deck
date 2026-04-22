import { isoNow } from "./orchestrator-helpers.js";
import { DEFAULT_RETENTION_DAYS } from "./dashboard-persistence.js";
import {
  buildAgentRoster,
  buildConsoleFeed,
  buildDeliveryHub,
  calculateAutonomyScore,
  calculateSuccessRate,
  mergeLiveRuns,
  summarizeAgentLoad,
  summarizeChildTasks,
  summarizeFlowHealth
} from "./dashboard-summary.js";

export function buildDashboardSnapshot(state, options = {}) {
  const runtimeActiveRuns = Array.from(state.activeRuns.values())
    .map((entry) => options.normalizeHistoricalRunStatus(entry))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const taskflowActiveRuns = Array.isArray(state.taskflowActiveRuns) ? state.taskflowActiveRuns : [];
  const activeRuns = [...runtimeActiveRuns, ...taskflowActiveRuns]
    .map((entry) => options.normalizeHistoricalRunStatus(entry))
    .sort((a, b) => String(b.updatedAt || b.startedAt || "").localeCompare(String(a.updatedAt || a.startedAt || "")));
  const runtimeRecentRuns = state.recentRuns
    .map((entry) => options.normalizeHistoricalRunStatus(entry))
    .filter((entry) =>
      Boolean(
        entry?.engineeringTask ||
        entry?.taskFlowSeen ||
        entry?.childTaskIds?.length ||
        entry?.lastBlockReason ||
        entry?.internalCoordinationSeen ||
        entry?.workspaceDiscoverySeen ||
        entry?.executionLaneSeen
      )
    )
    .slice(0, options.maxRecentRuns);
  const taskflowRecentRuns = Array.isArray(state.taskflowRecentRuns) ? state.taskflowRecentRuns : [];
  const recentRuns = [...runtimeRecentRuns, ...taskflowRecentRuns]
    .map((entry) => options.normalizeHistoricalRunStatus(entry))
    .sort((a, b) => String(b.updatedAt || b.startedAt || "").localeCompare(String(a.updatedAt || a.startedAt || "")))
    .slice(0, options.maxRecentRuns);
  const liveRuns = mergeLiveRuns(activeRuns, recentRuns);
  const runtimeLiveRuns = mergeLiveRuns(runtimeActiveRuns, runtimeRecentRuns);
  const engineeringRuns = liveRuns.filter((entry) => entry.engineeringTask);
  const agentLoad = summarizeAgentLoad(runtimeLiveRuns);
  const flowHealth = summarizeFlowHealth(liveRuns);
  const childTaskBoard = summarizeChildTasks(liveRuns);
  const autonomyScore = calculateAutonomyScore(engineeringRuns);
  const configuredAgents = Array.isArray(options.configuredAgents) ? options.configuredAgents : [];
  const agentRoster = buildAgentRoster(
    configuredAgents,
    agentLoad,
    runtimeLiveRuns,
    state.recentDispatches,
    state.recentBlockers,
    {
      fsEnabled: Boolean(options.fsEnabled),
      webEnabled: Boolean(options.webEnabled),
      mcpServers: Array.isArray(options.mcpServers) ? options.mcpServers : []
    }
  );
  const recentSuccessRate = calculateSuccessRate(recentRuns);
  const tokenProxy = agentRoster.reduce((sum, entry) => sum + (entry.tokenProxy || 0), 0);
  const deliveryHub = buildDeliveryHub(recentRuns, liveRuns);
  const consoleFeed = buildConsoleFeed(state.recentDispatches, state.recentBlockers, recentRuns);

  state.recentRuns = recentRuns;

  return {
    meta: {
      pluginId: "mission-deck",
      generatedAt: isoNow(),
      version: 5,
      retentionDays: Math.max(1, Number(options.retentionDays) || DEFAULT_RETENTION_DAYS)
    },
    summary: {
      activeRuns: liveRuns.length,
      engineeringRuns: engineeringRuns.length,
      delegatedRuns: engineeringRuns.filter((entry) => entry.status === "delegated").length,
      blockedRuns: engineeringRuns.filter((entry) => entry.status === "blocked").length,
      taskflowRuns: engineeringRuns.filter((entry) => entry.taskFlowSeen).length,
      activeChildTasks: engineeringRuns.reduce((sum, entry) => sum + (entry.childTaskIds?.length || 0), 0),
      autonomyScore,
      successRate: recentSuccessRate,
      tokenProxy,
      busyAgents: agentRoster.filter((entry) => entry.state === "busy").length,
      idleAgents: agentRoster.filter((entry) => entry.state === "idle").length
    },
    agentRoster,
    agentLoad,
    flowHealth,
    childTaskBoard,
    deliveryHub,
    consoleFeed,
    activeRuns: liveRuns,
    recentRuns,
    recentDispatches: state.recentDispatches,
    recentBlockers: state.recentBlockers
  };
}
