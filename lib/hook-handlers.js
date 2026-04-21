import {
  FLOW_STATES,
  appendTimelineEvent,
  buildSupervisorIntervention,
  getRuntimeTaskFlow,
  isoNow,
  setRunTelemetry
} from "./orchestrator-helpers.js";
import { createBeforePromptBuildHandler } from "./prompt-build-handler.js";
import { createBeforeToolCallHandler } from "./tool-call-handler.js";
import { flushRun, runBackground } from "./hook-handler-utils.js";

export function createHookHandlers(deps) {
  const {
    api,
    dashboard,
    runtimeRuns,
    enabledAgents,
    supervisorConfig,
    supervisorAgentId,
    supervisorIntervalMs,
    interventionIdleMinutes,
    supervisorMaxConcurrent,
    missingHostPrereqs,
    touchRun,
    transitionFlow
  } = deps;

  let supervisorTimer = null;

  async function runSupervisorSweep(nowMs = Date.now()) {
    if (supervisorConfig?.enabled !== true) return;
    if (!supervisorAgentId || !enabledAgents.includes(supervisorAgentId)) return;
    const activeSupervisions = Array.from(runtimeRuns.values()).filter((state) => Boolean(state?.supervisorPending)).length;
    const availableSlots = Math.max(0, supervisorMaxConcurrent - activeSupervisions);
    if (availableSlots <= 0) return;
    const candidates = Array.from(runtimeRuns.entries())
      .map(([runId, state]) => ({
        runId,
        state,
        intervention: buildSupervisorIntervention(state, {
          interventionIdleMinutes,
          supervisorAgentId
        }, nowMs)
      }))
      .filter((entry) => entry.intervention)
      .sort((a, b) => String(a.state?.dashboardUpdatedAt || "").localeCompare(String(b.state?.dashboardUpdatedAt || "")))
      .slice(0, availableSlots);

    for (const entry of candidates) {
      const { runId, state, intervention } = entry;
      state.supervisorPending = true;
      state.supervisorAgentId = supervisorAgentId;
      state.supervisorReason = intervention.reason;
      state.supervisorLastInterventionAt = new Date(nowMs).toISOString();
      state.supervisorInterventionCount = Number(state.supervisorInterventionCount || 0) + 1;
      setRunTelemetry(state, "supervisor_intervention", {
        toolName: "taskflow_supervisor",
        toolStatus: "accepted",
        blockReason: intervention.reason
      });
      appendTimelineEvent(state, {
        role: "督办介入",
        owner: supervisorAgentId,
        text: `${supervisorAgentId} 已接手督办；任务已空转 ${intervention.idleMinutes} 分钟，原因：${intervention.reason}`
      });
      const taskFlow = getRuntimeTaskFlow(api, { sessionKey: state.sessionKey });
      transitionFlow(taskFlow, state, "setWaiting", {
        currentStep: FLOW_STATES.BLOCKED,
        blockedSummary: intervention.reason,
        waitJson: {
          kind: "supervisor_intervention",
          supervisorAgentId,
          reason: intervention.reason,
          idleMinutes: intervention.idleMinutes,
          interventionCount: state.supervisorInterventionCount
        },
        stateJson: {
          state: FLOW_STATES.BLOCKED,
          supervisorPending: true
        }
      }, {
        eventType: "supervisor_intervention",
        timestamp: isoNow()
      }, "supervisor intervention");
      await dashboard.pushBlocker({
        timestamp: isoNow(),
        runId,
        agentId: state.agentId,
        reason: `taskflow supervisor assigned ${supervisorAgentId}: ${intervention.reason}`,
        toolName: "taskflow_supervisor"
      });
      touchRun(runId, state.agentId, state);
    }

    if (candidates.length > 0) await dashboard.flush();
  }

  async function onGatewayStart() {
    if (missingHostPrereqs.length > 0) {
      api.logger.warn?.(
        `[mission-deck] host prerequisites missing: ${missingHostPrereqs.join(", ")}`
      );
    }
    api.logger.info(
      `[mission-deck] loaded enabledAgents=${enabledAgents.join(",") || "(none)"} coordinator=${deps.coordinatorAgentId || "(none)"}`
    );
    await dashboard.flush();
    if (supervisorConfig?.enabled === true && !supervisorTimer) {
      supervisorTimer = setInterval(() => {
        runSupervisorSweep().catch((error) => {
          api.logger.warn?.(`[mission-deck] supervisor sweep failed: ${error?.message || error}`);
        });
      }, supervisorIntervalMs);
    }
  }

  return {
    onGatewayStart,
    onBeforePromptBuild: createBeforePromptBuildHandler(deps),
    onBeforeToolCall: createBeforeToolCallHandler(deps),
    runBackground: (promise, label) => runBackground(api, promise, label),
    flushRun: (runId, agentId, state) => flushRun(touchRun, dashboard, runId, agentId, state)
  };
}
