import {
  FLOW_STATES,
  appendTimelineEvent,
  buildChainAssessment,
  hasNonEmptyString,
  isoNow,
  setRunTelemetry
} from "./orchestrator-helpers.js";
import { flushRun } from "./hook-handler-utils.js";

async function blockToolCall({
  dashboard,
  touchRun,
  transitionFlow,
  taskFlow,
  state,
  canonicalEvent,
  runId,
  agentId,
  toolName,
  telemetryEvent,
  blockReason,
  currentStep = FLOW_STATES.ROUTING,
  waitJson = null,
  stateJson = null,
  auditSummary = "tool blocked",
  pushDashboardBlocker = false
}) {
  setRunTelemetry(state, telemetryEvent, {
    toolName,
    blockReason
  });
  if (taskFlow) {
    transitionFlow(taskFlow, state, "setWaiting", {
      currentStep,
      blockedSummary: blockReason,
      waitJson: waitJson ?? {
        kind: currentStep === FLOW_STATES.BLOCKED ? "blocked" : "routing_required",
        summary: blockReason
      },
      stateJson: stateJson ?? {
        state: currentStep
      }
    }, canonicalEvent, auditSummary);
  }
  if (pushDashboardBlocker) {
    await dashboard.pushBlocker({
      timestamp: isoNow(),
      runId,
      agentId,
      reason: blockReason,
      toolName
    });
  }
  await flushRun(touchRun, dashboard, runId, agentId, state);
  return {
    block: true,
    blockReason
  };
}

async function markRoutingProgress({
  dashboard,
  touchRun,
  transitionFlow,
  taskFlow,
  state,
  canonicalEvent,
  runId,
  agentId,
  toolName,
  telemetryEvent,
  role,
  text
}) {
  state.chainAssessment = buildChainAssessment(state);
  setRunTelemetry(state, telemetryEvent, { toolName });
  appendTimelineEvent(state, {
    role,
    owner: agentId,
    text
  });
  if (taskFlow) {
    transitionFlow(taskFlow, state, "resume", {
      status: "running",
      currentStep: FLOW_STATES.ROUTING,
      stateJson: {
        state: FLOW_STATES.ROUTING
      }
    }, canonicalEvent, telemetryEvent);
  }
  await flushRun(touchRun, dashboard, runId, agentId, state);
}

function getSendTargetFlags(params) {
  return {
    hasSessionKey: hasNonEmptyString(params?.sessionKey),
    hasLabel: hasNonEmptyString(params?.label),
    hasAgentId: hasNonEmptyString(params?.agentId)
  };
}

export {
  blockToolCall,
  getSendTargetFlags,
  markRoutingProgress
};
