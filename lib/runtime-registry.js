import { FLOW_STATES, defaultRunState, normalizeString } from "./orchestrator-helpers.js";

export function buildHostPrereqMessage(missingHostPrereqs = []) {
  return `MISSION DECK requires host support for ${missingHostPrereqs.join(" and ")}. Install or enable OpenClaw with both TaskFlow and agent-to-agent support before enabling mission-deck.`;
}

export function createRuntimeRegistry({
  runtimeRuns,
  latestRunByAgent,
  bestEffortChildLinksByRun,
  bestEffortChildLinksBySession,
  dashboard
}) {
  function sameParentLink(left, right) {
    return (
      normalizeString(left?.parentFlowId) === normalizeString(right?.parentFlowId) &&
      normalizeString(left?.parentRunId) === normalizeString(right?.parentRunId) &&
      normalizeString(left?.parentAgentId) === normalizeString(right?.parentAgentId)
    );
  }

  function isSyntheticAnnounceRun(runId) {
    return normalizeString(runId).startsWith("announce:v1:");
  }

  function parseSyntheticAnnounceRun(runId) {
    const normalized = normalizeString(runId);
    if (!normalized.startsWith("announce:v1:")) return null;
    const parts = normalized.split(":");
    if (parts.length < 7) return null;
    return {
      childAgentId: normalizeString(parts[3]),
      childScope: normalizeString(parts[4]),
      childSessionId: normalizeString(parts[5]),
      childRunId: normalizeString(parts.slice(6).join(":"))
    };
  }

  function getRun(runId, agentId = "") {
    const normalizedRunId = normalizeString(runId);
    if (!normalizedRunId) return null;
    const existing = runtimeRuns.get(normalizedRunId);
    if (existing) return existing;
    const created = defaultRunState();
    created.agentId = normalizeString(agentId);
    created.ownerAgentId = normalizeString(agentId);
    runtimeRuns.set(normalizedRunId, created);
    return created;
  }

  function findContinuableRootRun(agentId, sessionKey, runId) {
    const normalizedAgentId = normalizeString(agentId);
    const normalizedSessionKey = normalizeString(sessionKey);
    const normalizedRunId = normalizeString(runId);
    if (!normalizedAgentId || !normalizedSessionKey) return null;
    for (const [candidateRunId, state] of runtimeRuns.entries()) {
      if (candidateRunId === normalizedRunId) continue;
      if (normalizeString(state?.agentId) !== normalizedAgentId) continue;
      if (normalizeString(state?.sessionKey) !== normalizedSessionKey) continue;
      if (normalizeString(state?.entryMode) !== "mission-flow") continue;
      if (normalizeString(state?.parentRunId)) continue;
      const currentStep = normalizeString(state?.flowCurrentStep || state?.durable?.state);
      if (currentStep !== FLOW_STATES.WAITING_CHILD && currentStep !== FLOW_STATES.REVIEWING) continue;
      return { runId: candidateRunId, state };
    }
    return null;
  }

  function rebindRunState(fromRunId, toRunId, state, agentId) {
    const normalizedFromRunId = normalizeString(fromRunId);
    const normalizedToRunId = normalizeString(toRunId);
    if (!normalizedToRunId || !state) return state;
    if (normalizedFromRunId && normalizedFromRunId !== normalizedToRunId) {
      runtimeRuns.delete(normalizedFromRunId);
    }
    runtimeRuns.set(normalizedToRunId, state);
    latestRunByAgent.set(normalizeString(agentId), normalizedToRunId);
    return state;
  }

  function getBestEffortParentLink(runId, sessionKey) {
    return (
      bestEffortChildLinksByRun.get(normalizeString(runId)) ||
      bestEffortChildLinksBySession.get(normalizeString(sessionKey)) ||
      null
    );
  }

  function findConflictingChildLink(link) {
    if (!link) return null;
    const candidates = [
      link.childRunId ? bestEffortChildLinksByRun.get(normalizeString(link.childRunId)) : null,
      link.childSessionKey ? bestEffortChildLinksBySession.get(normalizeString(link.childSessionKey)) : null
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (!sameParentLink(candidate, link)) return candidate;
    }
    return null;
  }

  function setBestEffortChildLink(link) {
    if (!link || !link.childTaskId) return;
    const conflict = findConflictingChildLink(link);
    if (conflict) return { ok: false, conflict };
    if (link.childRunId) bestEffortChildLinksByRun.set(link.childRunId, link);
    if (link.childSessionKey) bestEffortChildLinksBySession.set(link.childSessionKey, link);
    return { ok: true, conflict: null };
  }

  function deleteBestEffortChildLink(link) {
    if (!link) return;
    if (link.childRunId) bestEffortChildLinksByRun.delete(link.childRunId);
    if (link.childSessionKey) bestEffortChildLinksBySession.delete(link.childSessionKey);
  }

  function touchRun(runId, agentId, state) {
    runtimeRuns.set(runId, state);
    latestRunByAgent.set(agentId, runId);
    dashboard.trackActiveRun(runId, agentId, state);
  }

  return {
    isSyntheticAnnounceRun,
    parseSyntheticAnnounceRun,
    getRun,
    findContinuableRootRun,
    rebindRunState,
    getBestEffortParentLink,
    findConflictingChildLink,
    setBestEffortChildLink,
    deleteBestEffortChildLink,
    touchRun
  };
}
