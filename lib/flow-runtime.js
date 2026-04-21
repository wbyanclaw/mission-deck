import {
  buildCanonicalFlowState
} from "./orchestrator-helpers.js";
import {
  buildCollaborationRequirementReason,
  countEvidence,
  countOpenChildTasks,
  ensureFlowBound as ensureBound,
  isSpawnedExecutionRun,
  lacksRequiredCollaborationEvidence,
  shouldFinishParent,
  shouldRetainRuntimeState,
  syncFlowSnapshot,
  transitionFlow,
  updateDurableChildTask
} from "./flow-transition-helpers.js";
import {
  applyChildOutcomeToParent as applyChildOutcome,
  findParentRunByChildLink,
  findParentRunByChildOutcome,
  reviveParentRun
} from "./parent-reconciliation.js";

export function createFlowRuntimeHelpers({
  api,
  dashboard,
  runtimeRuns,
  coordinatorAgentId,
  getRun,
  touchRun
}) {
  return {
    countOpenChildTasks,
    countEvidence,
    buildCollaborationRequirementReason,
    lacksRequiredCollaborationEvidence,
    isSpawnedExecutionRun,
    syncFlowSnapshot,
    transitionFlow,
    ensureFlowBound(apiCtx, state, canonicalEvent, initialStep) {
      return ensureBound({
        api,
        state,
        canonicalEvent,
        initialStep
      });
    },
    shouldRetainRuntimeState,
    shouldFinishParent,
    updateDurableChildTask,
    findParentRunByChildLink(link) {
      return findParentRunByChildLink(runtimeRuns, link);
    },
    reviveParentRun(parentLink, ctx = {}) {
      return reviveParentRun({ api, runtimeRuns, coordinatorAgentId, getRun, touchRun }, parentLink, ctx);
    },
    findParentRunByChildOutcome(childOutcome = {}) {
      return findParentRunByChildOutcome(runtimeRuns, childOutcome);
    },
    applyChildOutcomeToParent(parentState, parentAgentId, childOutcome, ctx) {
      return applyChildOutcome({
        api,
        dashboard,
        countOpenChildTasks,
        shouldFinishParent,
        syncFlowSnapshot,
        transitionFlow,
        updateDurableChildTask
      }, parentState, parentAgentId, childOutcome, ctx);
    },
    buildCanonicalFlowState
  };
}
