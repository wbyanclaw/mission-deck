import {
  AWAITING_USER_INPUT_PATTERNS,
  FINAL_DELIVERY_PATTERNS,
  FOLLOWUP_SUMMARY_PATTERNS,
  SILENT_REPLY_TOKEN,
  UNVERIFIED_EXECUTION_PATTERNS
} from "./contracts.js";

export function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function hasNonEmptyString(value) {
  return normalizeString(value).length > 0;
}

export function isoNow() {
  return new Date().toISOString();
}

export function toFlatText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => toFlatText(item)).join(" ");
  if (value && typeof value === "object") {
    return Object.values(value).map((item) => toFlatText(item)).join(" ");
  }
  return "";
}

export function tokenizeText(value) {
  return normalizeString(value)
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function stripPromptScaffolding(prompt) {
  const lines = normalizeString(prompt).split(/\r?\n/);
  const kept = [];
  let skipFence = false;
  let metadataFence = false;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (skipFence) {
      if (trimmed.startsWith("```")) {
        skipFence = false;
        metadataFence = false;
      }
      continue;
    }
    if (/^(Conversation info|Sender \(untrusted metadata\)|Recipient \(untrusted metadata\)|Tool result metadata)/i.test(trimmed)) {
      metadataFence = true;
      continue;
    }
    if (metadataFence && trimmed.startsWith("```")) {
      skipFence = true;
      continue;
    }
    metadataFence = false;
    if (
      /^\[message_id:/i.test(trimmed) ||
      /^Current time:/i.test(trimmed) ||
      /^Return your response as plain text/i.test(trimmed)
    ) {
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

export function sanitizeTaskPrompt(prompt) {
  const stripped = stripPromptScaffolding(prompt)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!stripped) return normalizeString(prompt);
  return stripped;
}

export function looksLikeAwaitingUserInputReply(text) {
  const normalized = normalizeString(text).toLowerCase();
  if (!normalized) return false;
  return AWAITING_USER_INPUT_PATTERNS.some((pattern) => normalized.includes(pattern.toLowerCase()));
}

export function shouldTreatVisibleReplyAsFinalDelivery(text) {
  const normalized = normalizeString(text);
  if (!normalized) return false;
  if (looksLikeAwaitingUserInputReply(normalized)) return false;
  return FINAL_DELIVERY_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export function looksLikeUnverifiedExecutionClaim(text) {
  const normalized = normalizeString(text).toLowerCase();
  if (!normalized) return false;
  const executionSignal = UNVERIFIED_EXECUTION_PATTERNS.some((pattern) => normalized.includes(pattern.toLowerCase()));
  if (!executionSignal) return false;
  return FOLLOWUP_SUMMARY_PATTERNS.some((pattern) => normalized.includes(pattern.toLowerCase()));
}

export function getMessageText(params) {
  if (!params || typeof params !== "object") return "";
  return normalizeString(params.text ?? params.message ?? params.body ?? params.content);
}

export function extractAssistantText(message) {
  if (!message || typeof message !== "object") return "";
  if (message.role !== "assistant") return "";
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .filter((item) => item && typeof item === "object" && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

export function rewriteAssistantTextMessage(message, text) {
  if (!message || typeof message !== "object" || message.role !== "assistant") return message;
  const content = Array.isArray(message.content) ? message.content : [];
  let replaced = false;
  const nextContent = content.map((item) => {
    if (!replaced && item && typeof item === "object" && item.type === "text" && typeof item.text === "string") {
      replaced = true;
      return { ...item, text };
    }
    return item;
  });
  if (!replaced) nextContent.push({ type: "text", text });
  return { ...message, content: nextContent };
}

export function isSilentReply(text) {
  return normalizeString(text).toUpperCase() === SILENT_REPLY_TOKEN;
}
