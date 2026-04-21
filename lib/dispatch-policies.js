import { DEFAULT_DISCOVERY_TOOL_NAMES, DEFAULT_ENTRYPOINT_PATTERNS } from "./contracts.js";
import { getMessageText, hasNonEmptyString, normalizeString, sanitizeTaskPrompt, toFlatText } from "./text-helpers.js";

function toLowerSet(values) {
  return new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => normalizeString(value).toLowerCase())
      .filter(Boolean)
  );
}

function describeSessionKey(sessionKey) {
  const normalized = normalizeString(sessionKey);
  if (!normalized) {
    return {
      sessionScope: "",
      targetKind: ""
    };
  }
  const parts = normalized.split(":");
  const sessionScope = parts[2] || "";
  let targetKind = sessionScope || "session";
  if (sessionScope === "feishu" || sessionScope === "openclaw-weixin" || sessionScope === "telegram") {
    targetKind = "persistent-channel-session";
  } else if (sessionScope === "subagent") {
    targetKind = "subagent-session";
  } else if (sessionScope === "cron") {
    targetKind = "cron-session";
  }
  return { sessionScope, targetKind };
}

function extractAgentIdFromSessionKey(sessionKey) {
  const normalized = normalizeString(sessionKey);
  const match = normalized.match(/^agent:([^:]+):/);
  return normalizeString(match?.[1]);
}

function readToolResultDetails(event) {
  const candidates = [
    event?.result,
    event?.result?.details,
    event?.details,
    event?.message?.details
  ];
  const merged = {};
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    Object.assign(merged, candidate);
  }
  return merged;
}

function extractDispatchTarget(toolName, params, details) {
  const normalizedToolName = normalizeString(toolName).toLowerCase();
  if (normalizedToolName === "sessions_spawn") {
    const childSessionKey = normalizeString(details?.childSessionKey);
    const sessionMeta = describeSessionKey(childSessionKey);
    return {
      agentId: normalizeString(params?.agentId) || extractAgentIdFromSessionKey(childSessionKey),
      childSessionKey,
      runId: normalizeString(details?.runId),
      label: normalizeString(params?.label),
      task: sanitizeTaskPrompt(params?.task),
      routeType: "spawn",
      sessionScope: sessionMeta.sessionScope,
      targetKind: sessionMeta.targetKind || "spawned-run"
    };
  }
  if (normalizedToolName === "sessions_send") {
    const childSessionKey = normalizeString(details?.sessionKey) || normalizeString(params?.sessionKey);
    const sessionMeta = describeSessionKey(childSessionKey);
    return {
      agentId: normalizeString(params?.agentId) || extractAgentIdFromSessionKey(childSessionKey),
      childSessionKey,
      runId: normalizeString(details?.runId),
      label: normalizeString(params?.label),
      task: sanitizeTaskPrompt(normalizeString(params?.task) || getMessageText(params)),
      routeType: "send",
      sessionScope: sessionMeta.sessionScope,
      targetKind: sessionMeta.targetKind || "existing-session"
    };
  }
  return null;
}

function classifyDispatchResult(toolName, details, dispatch = null) {
  const normalizedToolName = normalizeString(toolName).toLowerCase();
  const status = normalizeString(details?.status).toLowerCase();
  const error = normalizeString(details?.error);
  const failureStatuses = new Set(["error", "failed", "forbidden", "rejected", "denied", "cancelled"]);
  if (normalizedToolName === "sessions_spawn") {
    if (status === "accepted") return { track: true, phase: "accepted", failed: false };
    if (!status && (dispatch?.childSessionKey || dispatch?.runId)) return { track: true, phase: "accepted", failed: false };
    if (failureStatuses.has(status)) {
      return { track: false, phase: status, failed: true, reason: error || status };
    }
    return { track: false, phase: status || "unknown", failed: false };
  }
  if (normalizedToolName === "sessions_send") {
    if (["ok", "pending", "accepted"].includes(status)) return { track: true, phase: status, failed: false };
    if (!status && dispatch?.childSessionKey) return { track: true, phase: "sent", failed: false };
    if (status === "timeout") {
      return {
        track: false,
        phase: status,
        failed: false,
        reason: "sessions_send timed out before traceable delivery was confirmed"
      };
    }
    if (failureStatuses.has(status)) return { track: false, phase: status, failed: true, reason: error || status };
    return { track: false, phase: status || "unknown", failed: false };
  }
  if (failureStatuses.has(status)) return { track: false, phase: status, failed: true, reason: error || status };
  return { track: false, phase: status || "unknown", failed: false };
}

function inferTaskRuntime(toolName) {
  return normalizeString(toolName).toLowerCase() === "sessions_spawn" ? "subagent" : "acp";
}

function looksLikeEntrypointEscalation(params, pluginConfig) {
  const flat = toFlatText(params).toLowerCase();
  if (!flat) return false;
  const patterns = Array.isArray(pluginConfig?.entrypointPatterns) && pluginConfig.entrypointPatterns.length > 0
    ? pluginConfig.entrypointPatterns
    : DEFAULT_ENTRYPOINT_PATTERNS;
  return patterns.some((pattern) => flat.includes(normalizeString(pattern).toLowerCase()));
}

function looksLikeWorkspaceDiscoveryTool(toolName, params, workspaceRoots, pluginConfig) {
  const allowedNames = toLowerSet(
    Array.isArray(pluginConfig?.discoveryToolNames) && pluginConfig.discoveryToolNames.length > 0
      ? pluginConfig.discoveryToolNames
      : DEFAULT_DISCOVERY_TOOL_NAMES
  );
  const normalizedToolName = normalizeString(toolName).toLowerCase();
  if (!allowedNames.has(normalizedToolName)) return false;
  const flat = toFlatText(params).toLowerCase();
  return workspaceRoots.some((root) => flat.includes(root.toLowerCase()));
}

function shouldForceSpawnInsteadOfSend(currentAgentId, params) {
  const targetAgentId = normalizeString(params?.agentId);
  const hasSessionKey = hasNonEmptyString(params?.sessionKey);
  const hasLabel = hasNonEmptyString(params?.label);
  if (!targetAgentId || targetAgentId === currentAgentId) return false;
  if (hasSessionKey) return false;
  return hasLabel;
}

function looksLikeExplicitIsolationNeed(params, prompt = "") {
  const runtime = normalizeString(params?.runtime).toLowerCase();
  const mode = normalizeString(params?.mode).toLowerCase();
  const flat = `${toFlatText(params)} ${sanitizeTaskPrompt(prompt)}`.toLowerCase();
  if (runtime === "acp") return true;
  if (["run", "session"].includes(mode) && /(acp|worker|subagent|后台|background)/i.test(flat)) return true;
  return /(parallel|isolate|isolated|background|worker|subagent|sandbox|独立|隔离|并行|后台|专项|专线|子任务|子线程)/i.test(flat);
}

export {
  classifyDispatchResult,
  describeSessionKey,
  extractDispatchTarget,
  inferTaskRuntime,
  looksLikeEntrypointEscalation,
  looksLikeExplicitIsolationNeed,
  looksLikeWorkspaceDiscoveryTool,
  readToolResultDetails,
  shouldForceSpawnInsteadOfSend
};
