import { normalizeString, sanitizeTaskPrompt } from "./orchestrator-helpers.js";

function stableHash(value) {
  let hash = 0;
  const text = normalizeString(value);
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(16).slice(0, 12);
}

function redactSessionKey(value, enabled) {
  const normalized = normalizeString(value);
  if (!normalized) return "";
  if (!enabled) return normalized;
  const parts = normalized.split(":");
  const agentId = normalizeString(parts[1]) || "unknown";
  const scope = normalizeString(parts[2]) || "session";
  return `redacted:${agentId}:${scope}:${stableHash(normalized)}`;
}

function stripPromptMetadata(value, enabled) {
  const normalized = normalizeString(value);
  if (!normalized) return "";
  if (!enabled) return normalized;
  const stripped = sanitizeTaskPrompt(normalized)
    .replace(/chat_id\s*[:=]\s*["'][^"'\n]+["']/gi, 'chat_id:"[redacted]"')
    .replace(/message_id\s*[:=]\s*["'][^"'\n]+["']/gi, 'message_id:"[redacted]"');
  return stripped;
}

function sanitizeDashboardText(value, options = {}) {
  const normalized = normalizeString(value);
  if (!normalized) return "";
  if (options.redactDashboardContent === false) return normalized;
  const withPromptRedaction = stripPromptMetadata(normalized, options.redactPromptMetadata !== false);
  return withPromptRedaction
    .replace(/agent:[a-z0-9_-]+:[a-z0-9_-]+:[^\s"'`]+/gi, `[session:${stableHash("$&")}]`)
    .replace(/\b(?:openclaw-weixin|feishu|telegram):[^\s"'`]+/gi, "[channel-message:redacted]")
    .replace(/\bou_[a-z0-9]+\b/gi, "[peer:redacted]")
    .replace(/\bchat_id\b[^\n]*/gi, "chat_id: [redacted]")
    .replace(/\bmessage_id\b[^\n]*/gi, "message_id: [redacted]")
    .trim();
}

function sanitizeTimelineEvents(events, options = {}) {
  return (Array.isArray(events) ? events : [])
    .map((entry) => ({
      ...entry,
      owner: normalizeString(entry?.owner),
      role: normalizeString(entry?.role),
      text: sanitizeDashboardText(entry?.text, options),
      tone: normalizeString(entry?.tone)
    }))
    .filter((entry) => entry.role && entry.text)
    .slice(-40);
}

function sanitizeChildTasks(tasks, options = {}) {
  return (Array.isArray(tasks) ? tasks : []).map((task) => ({
    ...task,
    label: sanitizeDashboardText(task?.label, options),
    progressSummary: sanitizeDashboardText(task?.progressSummary, options),
    childSessionKey: redactSessionKey(task?.childSessionKey, options.redactSessionKeys !== false)
  }));
}

function sanitizeDispatchEntry(entry, options = {}) {
  if (!entry || typeof entry !== "object") return entry;
  const target = entry.target && typeof entry.target === "object"
    ? {
        ...entry.target,
        childSessionKey: redactSessionKey(entry.target.childSessionKey, options.redactSessionKeys !== false),
        task: sanitizeDashboardText(entry.target.task, options),
        label: sanitizeDashboardText(entry.target.label, options)
      }
    : entry.target;
  return {
    ...entry,
    reason: sanitizeDashboardText(entry.reason, options),
    target
  };
}

function sanitizeBlockerEntry(entry, options = {}) {
  if (!entry || typeof entry !== "object") return entry;
  return {
    ...entry,
    reason: sanitizeDashboardText(entry.reason, options)
  };
}

function sanitizeChildOutcome(outcome, options = {}) {
  if (!outcome || typeof outcome !== "object") return outcome;
  return {
    ...outcome,
    childSessionKey: redactSessionKey(outcome.childSessionKey, options.redactSessionKeys !== false),
    summary: sanitizeDashboardText(outcome.summary, options)
  };
}

export {
  redactSessionKey,
  sanitizeBlockerEntry,
  sanitizeChildOutcome,
  sanitizeChildTasks,
  sanitizeDashboardText,
  sanitizeDispatchEntry,
  sanitizeTimelineEvents
};
