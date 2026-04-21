import {
  FLOW_STATES,
  appendTimelineEvent,
  buildCanonicalEvent,
  buildChainAssessment,
  buildCoordinationGuidance,
  buildExecutionMandate,
  isoNow,
  normalizeString
} from "./orchestrator-helpers.js";
import { flushRun, updateRunMetadata } from "./hook-handler-utils.js";
import { buildHostPrereqMessage } from "./runtime-registry.js";

export function createBeforePromptBuildHandler(deps) {
  const {
    api,
    pluginConfig,
    dashboard,
    enabledAgents,
    missingHostPrereqs,
    getRun,
    findContinuableRootRun,
    rebindRunState,
    getBestEffortParentLink,
    isSyntheticAnnounceRun,
    touchRun,
    isSpawnedExecutionRun,
    transitionFlow,
    ensureFlowBound
  } = deps;

  return async function onBeforePromptBuild(event, ctx) {
    const agentId = normalizeString(ctx?.agentId);
    const runId = normalizeString(ctx?.runId);
    if (!agentId || !runId) return;
    if (!enabledAgents.includes(agentId)) return;
    if (isSyntheticAnnounceRun(runId)) {
      api.logger.info(`[mission-deck] before_prompt_build agent=${agentId} run=${runId} synthetic_announce=true bypass=true`);
      return;
    }
    if (missingHostPrereqs.length > 0) {
      return {
        appendSystemContext: `MISSION DECK prerequisite failure.\n${buildHostPrereqMessage(missingHostPrereqs)}`
      };
    }

    const resumable = findContinuableRootRun(agentId, ctx?.sessionKey, runId);
    const state = resumable
      ? rebindRunState(resumable.runId, runId, resumable.state, agentId)
      : getRun(runId, agentId);
    const resumableSnapshot = resumable
      ? {
          entryMode: state.entryMode,
          orchestrationMode: state.orchestrationMode,
          orchestrationPlan: state.orchestrationPlan,
          chainAssessment: state.chainAssessment,
          flowId: state.flowId,
          flowRevision: state.flowRevision,
          flowStatus: state.flowStatus,
          flowCurrentStep: state.flowCurrentStep,
          flowWaitSummary: state.flowWaitSummary,
          durable: state.durable
        }
      : null;
    const parentLink = getBestEffortParentLink(runId, ctx?.sessionKey);
    const canonicalEvent = buildCanonicalEvent({
      hookName: "before_prompt_build",
      event,
      ctx,
      runState: state,
      parentLink
    });

    updateRunMetadata({
      state,
      agentId,
      event,
      ctx,
      canonicalEvent,
      parentLink,
      apiConfig: api.config,
      pluginConfig,
      isSpawnedExecutionRun
    });
    if (resumable) {
      state.entryMode = resumableSnapshot.entryMode;
      state.orchestrationMode = resumableSnapshot.orchestrationMode;
      state.orchestrationPlan = resumableSnapshot.orchestrationPlan;
      state.chainAssessment = resumableSnapshot.chainAssessment;
      state.flowId = resumableSnapshot.flowId;
      state.flowRevision = resumableSnapshot.flowRevision;
      state.flowStatus = resumableSnapshot.flowStatus;
      state.flowCurrentStep = resumableSnapshot.flowCurrentStep;
      state.flowWaitSummary = resumableSnapshot.flowWaitSummary;
      state.durable = resumableSnapshot.durable;
      appendTimelineEvent(state, {
        role: "链路续跑",
        owner: agentId,
        text: "检测到同 session 的待收口主链路，已继续附着到既有 flow。"
      });
    }
    if (state.entryMode === "plain") {
      api.logger.info(`[mission-deck] before_prompt_build agent=${agentId} run=${runId} entry=plain bypass=true`);
      return;
    }

    appendTimelineEvent(state, {
      role: "用户发起",
      owner: "用户",
      text: state.normalizedPromptText || state.promptText || "收到新任务"
    });
    if (state.orchestrationPlan?.summary) {
      appendTimelineEvent(state, {
        role: "链路规划",
        owner: agentId,
        text: state.orchestrationPlan.summary
      });
    }
    if (state.chainAssessment?.summary) {
      appendTimelineEvent(state, {
        role: "链路体检",
        owner: agentId,
        text: `${state.chainAssessment.summary}${state.chainAssessment.missing ? `；缺口：${state.chainAssessment.missing}` : ""}${state.chainAssessment.nextAction ? `；下一步：${state.chainAssessment.nextAction}` : ""}`,
        tone: state.chainAssessment.correct ? "" : "blocked"
      });
    }

    const taskFlow = state.entryMode === "mission-flow"
      ? ensureFlowBound(ctx, state, canonicalEvent, FLOW_STATES.PLANNED)
      : null;
    if (taskFlow && state.durable) {
      transitionFlow(taskFlow, state, "resume", {
        status: "running",
        currentStep: FLOW_STATES.PLANNED,
        waitJson: null,
        stateJson: {
          state: FLOW_STATES.PLANNED,
          entryMode: state.entryMode,
          orchestrationMode: state.orchestrationMode,
          orchestrationPlan: state.orchestrationPlan
        }
      }, canonicalEvent, "new task planned");
    }
    await flushRun(touchRun, dashboard, runId, agentId, state);
    api.logger.info(
      `[mission-deck] before_prompt_build agent=${agentId} run=${runId} entry=${state.entryMode} event=${canonicalEvent.eventType} mode=${state.orchestrationMode} flow=${state.flowId || "(none)"}`
    );

    const appendSystemContext = buildCoordinationGuidance({
      agentId,
      cfg: api.config,
      pluginConfig,
      prompt: event.prompt,
      entryMode: state.entryMode,
      orchestrationPlan: state.orchestrationPlan
    });
    const executionMandate = buildExecutionMandate(
      api.config,
      agentId,
      event.prompt,
      state.flowId,
      pluginConfig,
      {
        entryMode: state.entryMode,
        orchestrationPlan: state.orchestrationPlan
      }
    );
    return {
      appendSystemContext: `${appendSystemContext}\n\n${executionMandate}`
    };
  };
}
