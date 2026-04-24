import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { normalizeString } from "./orchestrator-helpers.js";

const AGENTS_ROOT = "/root/.openclaw/agents";
const MAX_DIRECT_SESSIONS = 50;

const PLACEHOLDER_ASSISTANT_TEXT = new Set(["NO_REPLY", "REPLY_SKIP", "HEARTBEAT_OK"]);

function truncateText(value, max = 64) {
  const text = normalizeString(value);
  if (!text || text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function extractText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => normalizeString(item?.text))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function looksLikeSystemPrompt(text) {
  const normalized = normalizeString(text).toLowerCase();
  return (
    !normalized ||
    normalized.includes("[cron:") ||
    normalized.includes("heartbeat.md") ||
    normalized.includes("reply heartbeat_ok") ||
    normalized.includes("if nothing needs attention, reply heartbeat_ok") ||
    normalized.includes("read heartbeat.md if it exists") ||
    normalized.includes("system (untrusted):") ||
    normalized.includes("[subagent context]") ||
    normalized.includes("<<<begin_openclaw_internal_context>>>") ||
    normalized.includes("[internal task completion event]") ||
    normalized.includes("openclaw runtime context (internal)")
  );
}

function classifySessionKind(text) {
  const normalized = normalizeString(text).toLowerCase();
  if (!normalized) return "empty";
  if (normalized.includes("[cron:")) return "cron";
  if (
    normalized.includes("heartbeat.md") ||
    normalized.includes("reply heartbeat_ok") ||
    normalized.includes("if nothing needs attention, reply heartbeat_ok") ||
    normalized.includes("read heartbeat.md if it exists")
  ) return "heartbeat";
  if (
    normalized.includes("system (untrusted):") ||
    normalized.includes("[subagent context]") ||
    normalized.includes("<<<begin_openclaw_internal_context>>>") ||
    normalized.includes("[internal task completion event]") ||
    normalized.includes("openclaw runtime context (internal)")
  ) return "system";
  return "direct";
}

function mergeSessionKind(currentKind, nextKind) {
  if (nextKind === "direct") return "direct";
  if (currentKind === "direct") return "direct";
  if (currentKind === "empty") return nextKind;
  return currentKind || nextKind || "empty";
}

function stripPromptEnvelope(text) {
  const normalized = normalizeString(text);
  if (!normalized) return "";
  const metadataAnchor = normalized.search(/Conversation info \(untrusted metadata\):|Sender \(untrusted metadata\):/i);
  if (metadataAnchor < 0) return normalized;
  return normalized
    .slice(metadataAnchor)
    .replace(/^Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/i, "")
    .replace(/^Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/i, "")
    .replace(/^\[message_id:[^\]]+\]\s*/i, "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/^[^\[:\n]{2,128}:\s*/u, "")
    .replace(/\n*\[Bootstrap truncation warning\][\s\S]*$/i, "")
    .trim();
}

function normalizeVisiblePrompt(text) {
  const stripped = stripPromptEnvelope(text);
  return normalizeString(stripped || text);
}

function deriveCronTitle(text) {
  const normalized = normalizeVisiblePrompt(text);
  const match = normalized.match(/^\[cron:[^\]]+\s+([^\]]+)\]\s*/i);
  if (match?.[1]) return `定时任务 · ${normalizeString(match[1])}`;
  return "定时任务";
}

function looksLikeStructuredTitleNoise(text) {
  const normalized = normalizeVisiblePrompt(text);
  return (
    !normalized ||
    normalized.startsWith("```") ||
    normalized.startsWith("{") ||
    normalized.startsWith("[") ||
    normalized.includes("\"body\"") ||
    normalized.includes("\\n") ||
    normalized.includes("conversation info (untrusted metadata)")
  );
}

function summarizeSessionTitleText(text) {
  const normalized = normalizeVisiblePrompt(text)
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .replace(/\\"/g, "\"")
    .replace(/\\n/g, "\n");
  const lines = normalized
    .split(/\n+/)
    .map((line) => normalizeString(line).replace(/^[-*]\s*/, ""))
    .filter((line) => line && !/^[\[{]/.test(line) && !/^"[\w-]+":/.test(line) && !/^[}\]]/.test(line));
  const preferred = lines.find((line) => line.length >= 4) || lines[0] || normalized;
  return truncateText(preferred, 64);
}

function chooseStableUserText(firstMeaningfulUserText, latestMeaningfulUserText, latestUserText, firstUserText) {
  if (firstMeaningfulUserText && !looksLikeStructuredTitleNoise(firstMeaningfulUserText)) return firstMeaningfulUserText;
  if (latestMeaningfulUserText) return latestMeaningfulUserText;
  if (firstMeaningfulUserText) return firstMeaningfulUserText;
  return latestUserText || firstUserText;
}

function deriveSessionTitle(kind, promptText, assistantText) {
  const prompt = normalizeVisiblePrompt(promptText);
  if (kind === "heartbeat") return "静默心跳检查";
  if (kind === "cron") return deriveCronTitle(prompt);
  if (kind === "empty") return "仅回执会话";
  const cleaned = summarizeSessionTitleText(
    prompt.replace(/^\[(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2} [^\]]+\]\s*/i, "").trim()
  );
  if (cleaned) return cleaned;
  return summarizeSessionTitleText(assistantText) || "会话记录";
}

function looksLikeUserPrompt(text) {
  const normalized = normalizeVisiblePrompt(text);
  return Boolean(normalized) && !looksLikeSystemPrompt(normalized);
}

function isWeakFollowUpText(text) {
  const normalized = normalizeVisiblePrompt(text);
  if (!normalized) return true;
  if (normalized.length >= 8) return false;
  return [
    "继续",
    "好",
    "好的",
    "ok",
    "okay",
    "收到",
    "可以",
    "嗯",
    "hello",
    "hi"
  ].includes(normalized.toLowerCase());
}

function extractFinalAssistantText(entry) {
  const message = entry?.message;
  if (message?.role !== "assistant") return "";
  return extractText(message?.content);
}

function extractUserText(entry) {
  const message = entry?.message;
  if (message?.role !== "user") return "";
  return extractText(message?.content);
}

async function listSessionFiles(rootDir = AGENTS_ROOT) {
  const files = [];
  const agents = await readdir(rootDir, { withFileTypes: true });
  for (const agentEntry of agents) {
    if (!agentEntry.isDirectory()) continue;
    const sessionsDir = join(rootDir, agentEntry.name, "sessions");
    let entries = [];
    try {
      entries = await readdir(sessionsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".jsonl")) continue;
      if (entry.name.includes(".checkpoint.")) continue;
      files.push({
        agentId: agentEntry.name,
        path: join(sessionsDir, entry.name),
        sessionId: entry.name.replace(/\.jsonl$/, "")
      });
    }
  }
  return files;
}

async function parseDirectSession(file) {
  const raw = await readFile(file.path, "utf8");
  const lines = raw.split(/\n+/).filter(Boolean);
  let firstUserText = "";
  let firstUserAt = "";
  let firstMeaningfulUserText = "";
  let latestUserText = "";
  let latestUserAt = "";
  let latestMeaningfulUserText = "";
  let firstAssistantText = "";
  let firstAssistantAt = "";
  let finalAssistantText = "";
  let lastAssistantAt = "";
  let lastSeenAt = "";
  const timelineEvents = [];
  let sessionKind = "empty";

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    lastSeenAt = normalizeString(entry?.timestamp) || lastSeenAt;
    if (!firstUserText) {
      const userText = extractUserText(entry);
      if (userText) {
        const visibleUserText = normalizeVisiblePrompt(userText);
        const nextKind = classifySessionKind(userText);
        sessionKind = mergeSessionKind(sessionKind, looksLikeUserPrompt(userText) ? "direct" : nextKind);
        firstUserText = visibleUserText;
        firstUserAt = normalizeString(entry?.timestamp) || firstUserAt;
        if (looksLikeUserPrompt(userText) && !isWeakFollowUpText(visibleUserText)) {
          firstMeaningfulUserText = visibleUserText;
          latestMeaningfulUserText = visibleUserText;
        }
        timelineEvents.push({
          timestamp: normalizeString(entry?.timestamp),
          role: "用户发起",
          owner: "用户",
          text: visibleUserText,
          tone: ""
        });
        latestUserText = firstUserText;
        latestUserAt = normalizeString(entry?.timestamp) || latestUserAt;
        continue;
      }
    }
    const userText = extractUserText(entry);
    if (userText) {
      const visibleUserText = normalizeVisiblePrompt(userText);
      const nextKind = classifySessionKind(userText);
      sessionKind = mergeSessionKind(sessionKind, looksLikeUserPrompt(userText) ? "direct" : nextKind);
      latestUserText = visibleUserText;
      latestUserAt = normalizeString(entry?.timestamp) || latestUserAt;
      if (looksLikeUserPrompt(userText) && !isWeakFollowUpText(visibleUserText)) {
        if (!firstMeaningfulUserText) firstMeaningfulUserText = visibleUserText;
        latestMeaningfulUserText = visibleUserText;
      }
      timelineEvents.push({
        timestamp: normalizeString(entry?.timestamp),
        role: "用户追问",
        owner: "用户",
        text: visibleUserText,
        tone: ""
      });
      continue;
    }
    const assistantText = extractFinalAssistantText(entry);
    if (assistantText) {
      if (PLACEHOLDER_ASSISTANT_TEXT.has(assistantText.trim())) continue;
      if (!firstAssistantText) {
        firstAssistantText = assistantText;
        firstAssistantAt = normalizeString(entry?.timestamp) || firstAssistantAt;
      }
      finalAssistantText = assistantText;
      lastAssistantAt = normalizeString(entry?.timestamp) || lastAssistantAt;
      timelineEvents.push({
        timestamp: normalizeString(entry?.timestamp),
        role: "对外同步",
        owner: file.agentId,
        text: assistantText,
        tone: ""
      });
    }
  }

  if (!firstUserText && !firstAssistantText) return null;
  const fileStat = await stat(file.path);
  const updatedAt = lastAssistantAt || latestUserAt || firstUserAt || lastSeenAt || fileStat.mtime.toISOString();
  const stableUserText = chooseStableUserText(firstMeaningfulUserText, latestMeaningfulUserText, latestUserText, firstUserText);
  const promptText = stableUserText || firstAssistantText || "空会话";
  const startedAt = firstUserAt || firstAssistantAt || latestUserAt || updatedAt;
  const sessionTitle = deriveSessionTitle(sessionKind, promptText, firstAssistantText);
  return {
    runId: `session:${file.sessionId}`,
    sessionKey: `agent:${file.agentId}:session:${file.sessionId}`,
    agentId: file.agentId,
    engineeringTask: true,
    entryMode: "mission-lite",
    orchestrationMode: "solo",
    status: finalAssistantText ? "completed" : "triaging",
    sessionKind,
    sessionTitle: sessionTitle.slice(0, 280),
    promptText: promptText.slice(0, 280),
    initialUserPrompt: promptText.slice(0, 1200),
    originUserPrompt: (firstMeaningfulUserText || firstUserText).slice(0, 1200),
    lastExternalMessage: finalAssistantText.slice(0, 1200),
    timelineEvents,
    userAskedAt: latestUserAt || firstUserAt || firstAssistantAt || updatedAt,
    startedAt,
    updatedAt
  };
}

async function loadDashboardDirectSessions(options = {}) {
  const rootDir = normalizeString(options.sessionsRoot) || AGENTS_ROOT;
  const files = await listSessionFiles(rootDir);
  const parsed = [];
  for (const file of files) {
    const item = await parseDirectSession(file);
    if (item) parsed.push(item);
  }
  return parsed
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, MAX_DIRECT_SESSIONS);
}

export {
  loadDashboardDirectSessions
};
