import { EVENT_TYPES } from "./contracts.js";
import {
  extractAssistantText,
  getMessageText,
  isoNow,
  normalizeString,
  sanitizeTaskPrompt,
  shouldTreatVisibleReplyAsFinalDelivery
} from "./text-helpers.js";

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
