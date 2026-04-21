import { EVENT_TYPES, FLOW_STATES } from "./contracts.js";
import {
  extractAssistantText,
  getMessageText,
  hasNonEmptyString,
  isoNow,
  looksLikeAwaitingUserInputReply,
  normalizeString,
  sanitizeTaskPrompt,
  shouldTreatVisibleReplyAsFinalDelivery
} from "./text-helpers.js";

function cloneSimple(value) {
  return JSON.parse(JSON.stringify(value));
}

export function getRuntimeTaskFlow(api, ctx) {
  const sessionKey = normalizeString(ctx?.sessionKey);
  if (!sessionKey) return null;
  const runtime = api.runtime?.tasks?.flow ?? api.runtime?.taskFlow;
  if (!runtime || typeof runtime.bindSession !== "function") return null;
  return runtime.bindSession({ sessionKey });
}

export function hasAnyInternalExecutionStep(state) {
  return Boolean(
    state?.internalCoordinationSeen ||
    state?.workspaceDiscoverySeen ||
    state?.dispatchAttempted ||
    state?.executionLaneSeen
  );
}

export function appendTimelineEvent(state, entry = {}) {
  if (!state) return;
  const timestamp = normalizeString(entry.timestamp) || isoNow();
  const role = normalizeString(entry.role);
  const owner = normalizeString(entry.owner);
  const text = normalizeString(entry.text);
  if (!role || !text) return;
  state.timelineEvents = Array.isArray(state.timelineEvents) ? state.timelineEvents : [];
  const nextEvent = {
    timestamp,
    role,
    owner,
    text: text.slice(0, 2000),
    tone: normalizeString(entry.tone)
  };
  const last = state.timelineEvents.at(-1);
  if (last && last.role === nextEvent.role && last.owner === nextEvent.owner && last.text === nextEvent.text) return;
  state.timelineEvents.push(nextEvent);
  state.timelineEvents = state.timelineEvents.slice(-40);
}

export function setRunTelemetry(state, eventName, extra = {}) {
  if (!state.dashboardStartedAt) state.dashboardStartedAt = isoNow();
  state.dashboardUpdatedAt = isoNow();
  state.lastEvent = normalizeString(eventName);
  if (normalizeString(eventName) !== "supervisor_intervention") state.supervisorPending = false;
  if (hasNonEmptyString(extra.toolName)) state.lastToolName = normalizeString(extra.toolName);
  if (hasNonEmptyString(extra.toolStatus)) state.lastToolStatus = normalizeString(extra.toolStatus);
  if (hasNonEmptyString(extra.externalMessage)) state.lastExternalMessage = normalizeString(extra.externalMessage).slice(0, 280);
  if (hasNonEmptyString(extra.blockReason)) state.lastBlockReason = normalizeString(extra.blockReason).slice(0, 280);
  state.activityTrail = Array.isArray(state.activityTrail) ? state.activityTrail : [];
  state.activityTrail.push({
    timestamp: state.dashboardUpdatedAt,
    event: normalizeString(eventName),
    toolName: normalizeString(extra.toolName),
    toolStatus: normalizeString(extra.toolStatus),
    externalMessage: normalizeString(extra.externalMessage).slice(0, 280),
    blockReason: normalizeString(extra.blockReason).slice(0, 280)
  });
  state.activityTrail = state.activityTrail.slice(-16);
}

export function buildSupervisorIntervention(state, options = {}, nowMs = Date.now()) {
  const idleMinutes = Math.max(1, Number(options.interventionIdleMinutes) || 30);
  const supervisorAgentId = normalizeString(options.supervisorAgentId);
  if (!state?.engineeringTask) return null;
  if (!normalizeString(state?.flowId)) return null;
  if (normalizeString(state?.parentRunId)) return null;
  const flowStatus = normalizeString(state?.flowStatus).toLowerCase();
  const waitingLike = flowStatus === "waiting" || flowStatus === "blocked" || hasNonEmptyString(state?.lastBlockReason);
  if (!waitingLike) return null;
  if (looksLikeAwaitingUserInputReply(state?.lastExternalMessage)) return null;
  const lastUpdateMs = Date.parse(normalizeString(state?.dashboardUpdatedAt) || normalizeString(state?.dashboardStartedAt));
  if (!Number.isFinite(lastUpdateMs)) return null;
  const idleMs = Math.max(0, nowMs - lastUpdateMs);
  if (idleMs < idleMinutes * 60_000) return null;
  const lastInterventionMs = Date.parse(normalizeString(state?.supervisorLastInterventionAt));
  if (Number.isFinite(lastInterventionMs) && nowMs - lastInterventionMs < idleMinutes * 60_000) return null;
  const reason = normalizeString(state?.lastBlockReason) ||
    normalizeString(state?.flowWaitSummary) ||
    (flowStatus === "blocked" ? "flow is blocked without follow-up" : "flow has been waiting without progress");
  return {
    supervisorAgentId,
    idleMinutes: Number((idleMs / 60_000).toFixed(1)),
    reason
  };
}

export function defaultRunState() {
  return {
    agentId: "",
    ownerAgentId: "",
    sessionKey: "",
    promptText: "",
    normalizedPromptText: "",
    engineeringTask: false,
    entryMode: "plain",
    orchestrationMode: "solo",
    orchestrationPlan: null,
    normalizedEvent: null,
    durable: null,
    chainAssessment: null,
    internalCoordinationSeen: false,
    workspaceDiscoverySeen: false,
    executionLaneSeen: false,
    dispatchAttempted: false,
    taskFlowSeen: false,
    userVisibleMessageSent: false,
    flowId: "",
    flowRevision: 0,
    flowStatus: "",
    flowCurrentStep: "",
    flowWaitSummary: "",
    flowTaskSummary: null,
    childTaskIds: [],
    childTasks: [],
    supervisorPending: false,
    supervisorAgentId: "",
    supervisorReason: "",
    supervisorLastInterventionAt: "",
    supervisorInterventionCount: 0,
    parentRunId: "",
    parentFlowId: "",
    parentTaskId: "",
    parentSessionKey: "",
    parentAgentId: "",
    lastToolName: "",
    lastToolStatus: "",
    lastEvent: "",
    lastExternalMessage: "",
    lastBlockReason: "",
    pendingDispatches: new Map(),
    activityTrail: [],
    timelineEvents: [],
    dashboardStartedAt: "",
    dashboardUpdatedAt: ""
  };
}

function detectPromptDirective(prompt) {
  const normalized = normalizeString(prompt).toLowerCase();
  if (normalized.startsWith("/reset") || normalized.startsWith("reset ")) return EVENT_TYPES.RESET_TASK;
  if (normalized.startsWith("/new") || normalized.startsWith("new task")) return EVENT_TYPES.NEW_TASK;
  return "";
}

export function classifyIncomingEvent({ hookName, event = {}, ctx = {}, runState = null, parentLink = null }) {
  const runId = normalizeString(ctx?.runId);
  const synthetic = runId.startsWith("announce:v1:");
  if (synthetic) return EVENT_TYPES.SYSTEM_ANNOUNCE;
  if (hookName === "before_prompt_build") {
    const directive = detectPromptDirective(event.prompt);
    if (directive) return directive;
    if (normalizeString(runState?.flowId)) return EVENT_TYPES.RESUME_TASK;
    return EVENT_TYPES.NEW_TASK;
  }
  if (hookName === "before_tool_call") return EVENT_TYPES.TOOL_REQUEST;
  if (hookName === "after_tool_call") return EVENT_TYPES.TOOL_RESULT;
  if (hookName === "before_message_write") {
    const text = extractAssistantText(event?.message);
    if (parentLink) return EVENT_TYPES.CHILD_REPORT;
    if (shouldTreatVisibleReplyAsFinalDelivery(text)) return EVENT_TYPES.FINALIZE_CANDIDATE;
    return EVENT_TYPES.PROGRESS_UPDATE;
  }
  if (hookName === "agent_end") return EVENT_TYPES.AGENT_ENDED;
  return EVENT_TYPES.PROGRESS_UPDATE;
}

export function buildCanonicalEvent({ hookName, event = {}, ctx = {}, runState = null, parentLink = null }) {
  const eventType = classifyIncomingEvent({ hookName, event, ctx, runState, parentLink });
  const runId = normalizeString(ctx?.runId);
  const agentId = normalizeString(ctx?.agentId);
  const sessionKey = normalizeString(ctx?.sessionKey);
  const promptText = sanitizeTaskPrompt(event?.prompt);
  const assistantText = extractAssistantText(event?.message);
  const details = event?.details && typeof event.details === "object" ? event.details : {};
  return {
    eventType,
    runId,
    agentId,
    sessionKey,
    sourceKind:
      eventType === EVENT_TYPES.SYSTEM_ANNOUNCE ? "system" :
      eventType === EVENT_TYPES.TOOL_REQUEST || eventType === EVENT_TYPES.TOOL_RESULT ? "tool" :
      parentLink ? "child" : "user",
    isSynthetic: eventType === EVENT_TYPES.SYSTEM_ANNOUNCE,
    parentRunId: normalizeString(parentLink?.parentRunId) || normalizeString(runState?.parentRunId) || null,
    parentFlowId: normalizeString(parentLink?.parentFlowId) || normalizeString(runState?.parentFlowId) || null,
    timestamp: isoNow(),
    payload: {
      promptText,
      toolName: normalizeString(event?.toolName),
      toolCallId: normalizeString(event?.toolCallId),
      params: event?.params ?? null,
      result: event?.result ?? null,
      details,
      assistantText,
      messageText: getMessageText(event?.params),
      parentTaskId: normalizeString(parentLink?.childTaskId) || normalizeString(runState?.parentTaskId) || null,
      childRunId: normalizeString(parentLink?.childRunId),
      childSessionKey: normalizeString(parentLink?.childSessionKey)
    }
  };
}

export function buildCanonicalFlowState({ runId, sessionKey, parentLink = null, entryMode = "plain", orchestrationMode = "solo", orchestrationPlan = null }) {
  return {
    schemaVersion: 1,
    state: FLOW_STATES.INTAKE,
    entryMode,
    orchestrationMode,
    orchestrationPlan: orchestrationPlan ? {
      mode: normalizeString(orchestrationPlan.mode),
      targetAgentIds: Array.isArray(orchestrationPlan.targetAgentIds) ? orchestrationPlan.targetAgentIds.slice(0, 8) : [],
      requiredEvidenceCount: Number(orchestrationPlan.requiredEvidenceCount || 0),
      routeHint: normalizeString(orchestrationPlan.routeHint),
      finishCondition: normalizeString(orchestrationPlan.finishCondition),
      summary: normalizeString(orchestrationPlan.summary)
    } : null,
    rootRunId: normalizeString(parentLink?.parentRunId) || normalizeString(runId),
    rootSessionKey: normalizeString(parentLink?.parentSessionKey) || normalizeString(sessionKey),
    parentRunId: normalizeString(parentLink?.parentRunId),
    parentFlowId: normalizeString(parentLink?.parentFlowId),
    parentTaskId: normalizeString(parentLink?.childTaskId),
    parentSessionKey: normalizeString(parentLink?.parentSessionKey),
    childTasks: [],
    childSessions: [],
    requiredEvidenceCount: Number(orchestrationPlan?.requiredEvidenceCount || 0),
    receivedEvidenceCount: 0,
    retryCount: 0,
    maxRetry: 2,
    lastFailureKind: "",
    lastFailureReason: "",
    finalizeCandidate: null,
    finalOutput: null,
    auditTrail: []
  };
}

function recordAuditEntry(flowState, canonicalEvent, summary = "") {
  const durable = flowState && typeof flowState === "object" ? flowState : {};
  const auditTrail = Array.isArray(durable.auditTrail) ? durable.auditTrail.slice(-31) : [];
  auditTrail.push({
    timestamp: normalizeString(canonicalEvent?.timestamp) || isoNow(),
    eventType: normalizeString(canonicalEvent?.eventType),
    summary: normalizeString(summary)
  });
  durable.auditTrail = auditTrail.slice(-32);
  return durable;
}

export function buildDurableFlowStatePayload(existingState, patch = {}, canonicalEvent = null, summary = "") {
  const durable = cloneSimple(existingState || {});
  Object.assign(durable, patch);
  if (canonicalEvent) recordAuditEntry(durable, canonicalEvent, summary);
  return durable;
}

export function applyDurableFlowToRun(state, flow = null) {
  if (!state) return state;
  const durable = flow?.stateJson && typeof flow.stateJson === "object"
    ? cloneSimple(flow.stateJson)
    : (state.durable ? cloneSimple(state.durable) : null);
  state.durable = durable;
  state.flowId = normalizeString(flow?.flowId || state.flowId);
  state.flowRevision = Number(flow?.revision ?? state.flowRevision ?? 0);
  state.flowStatus = normalizeString(flow?.status || state.flowStatus);
  state.flowCurrentStep = normalizeString(flow?.currentStep || state.flowCurrentStep);
  state.flowWaitSummary = normalizeString(flow?.blockedSummary || flow?.waitJson?.summary || state.flowWaitSummary);
  state.taskFlowSeen = Boolean(state.flowId);
  if (durable) {
    state.parentRunId = normalizeString(durable.parentRunId || state.parentRunId);
    state.parentFlowId = normalizeString(durable.parentFlowId || state.parentFlowId);
    state.parentTaskId = normalizeString(durable.parentTaskId || state.parentTaskId);
    state.parentSessionKey = normalizeString(durable.parentSessionKey || state.parentSessionKey);
    state.childTasks = Array.isArray(durable.childTasks) ? cloneSimple(durable.childTasks) : [];
    state.childTaskIds = state.childTasks.map((task) => normalizeString(task?.taskId)).filter(Boolean);
  }
  return state;
}
