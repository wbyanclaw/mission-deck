import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeString } from "./orchestrator-helpers.js";

const DEFAULT_SESSIONS_ROOT = "/root/.openclaw/agents";

function parseAgentIdFromSessionKey(sessionKey) {
  const normalized = normalizeString(sessionKey);
  if (!normalized) return "";
  const parts = normalized.split(":");
  return normalizeString(parts[1]);
}

function extractTextContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text")
    .map((item) => normalizeString(item?.text))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function stripUserMessageEnvelope(text) {
  const normalized = normalizeString(text);
  if (!normalized) return "";
  const metadataAnchor = normalized.search(/Conversation info \(untrusted metadata\):|Sender \(untrusted metadata\):/i);
  const anchored = metadataAnchor >= 0 ? normalized.slice(metadataAnchor) : normalized;
  return anchored
    .replace(/^Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/i, "")
    .replace(/^Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/i, "")
    .replace(/^Recipient \(untrusted metadata\):\s*```json[\s\S]*?```\s*/i, "")
    .replace(/^\[message_id:[^\]]+\]\s*/i, "")
    .replace(/^(?!\[)[^:\n]{2,128}:\s*/u, "")
    .replace(/^\[[^\]]+\]\s*/u, "")
    .replace(/\n*\[Bootstrap truncation warning\][\s\S]*$/i, "")
    .trim();
}

function isVisibleUserText(text) {
  const normalized = normalizeString(stripUserMessageEnvelope(text));
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  return (
    !lower.includes("heartbeat.md") &&
    !lower.includes("reply heartbeat_ok") &&
    !lower.includes("if nothing needs attention, reply heartbeat_ok") &&
    !lower.includes("read heartbeat.md if it exists") &&
    !lower.includes("system (untrusted):") &&
    !lower.includes("<<<begin_openclaw_internal_context>>>") &&
    !lower.includes("[internal task completion event]") &&
    !lower.startsWith("[cron:")
  );
}

function isVisibleAssistantText(text) {
  const normalized = normalizeString(text);
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  return (
    lower !== "no_reply" &&
    lower !== "heartbeat_ok" &&
    !lower.includes("<<<begin_openclaw_internal_context>>>") &&
    !lower.includes("[internal task completion event]")
  );
}

function loadSessionTranscriptForRun(runState = {}, options = {}) {
  const rootRunId = normalizeString(runState?.durable?.rootRunId || runState?.runId);
  const agentId = parseAgentIdFromSessionKey(runState?.durable?.rootSessionKey) ||
    normalizeString(runState?.agentId);
  const sessionsRoot = normalizeString(options.sessionsRoot) || DEFAULT_SESSIONS_ROOT;
  if (!rootRunId || !agentId) return { timelineEvents: [], lastExternalMessage: "", firstVisibleUserText: "" };
  const sessionPath = join(sessionsRoot, agentId, "sessions", `${rootRunId}.jsonl`);
  if (!existsSync(sessionPath)) return { timelineEvents: [], lastExternalMessage: "", firstVisibleUserText: "" };

  const timelineEvents = [];
  let lastExternalMessage = "";
  let firstVisibleUserText = "";
  const lines = readFileSync(sessionPath, "utf8").split(/\n+/).filter(Boolean);
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry?.message;
    if (!message) continue;
    const text = extractTextContent(message.content);
    if (message.role === "user") {
      if (!isVisibleUserText(text)) continue;
      const visibleText = stripUserMessageEnvelope(text);
      if (!firstVisibleUserText) {
        firstVisibleUserText = visibleText;
        continue;
      }
      timelineEvents.push({
        timestamp: normalizeString(entry?.timestamp),
        role: "用户追问",
        owner: "用户",
        text: visibleText,
        tone: ""
      });
      continue;
    }
    if (message.role !== "assistant") continue;
    if (!isVisibleAssistantText(text)) continue;
    timelineEvents.push({
      timestamp: normalizeString(entry?.timestamp),
      role: "对外同步",
      owner: agentId,
      text,
      tone: ""
    });
    lastExternalMessage = text;
  }
  return {
    timelineEvents,
    lastExternalMessage,
    firstVisibleUserText
  };
}

export {
  loadSessionTranscriptForRun
};
