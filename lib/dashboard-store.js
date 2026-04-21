import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { isoNow, normalizeString } from "./orchestrator-helpers.js";
import { buildDashboardSnapshot } from "./dashboard-snapshot.js";
import {
  DEFAULT_RETENTION_DAYS,
  MAX_RECENT_BLOCKERS,
  MAX_RECENT_DISPATCHES,
  MAX_RECENT_RUNS,
  appendDailyEvent,
  dashboardStatusWriteSequence,
  pruneDailyLogs,
  restoreFromDailyLogs,
  writeDashboardStatus
} from "./dashboard-persistence.js";
import {
  sanitizeBlockerEntry,
  sanitizeChildOutcome,
  sanitizeDispatchEntry
} from "./dashboard-text-sanitize.js";
import {
  canTreatWaitingRunAsCompleted,
  normalizeHistoricalRunStatus,
  serializeRunState,
  shouldSurfaceRunInDashboard,
  updateRunWithChildOutcome
} from "./dashboard-run-normalization.js";

const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DASHBOARD_DIR = join(PLUGIN_ROOT, "dashboard");
const DASHBOARD_STATUS_PATH = join(DASHBOARD_DIR, "status.json");
const DASHBOARD_DATA_DIR = join(DASHBOARD_DIR, "data");

function createDashboardStore(logger, options = {}) {
  const statusPath = normalizeString(options.statusPath) || DASHBOARD_STATUS_PATH;
  const dataDir = normalizeString(options.dataDir) || DASHBOARD_DATA_DIR;
  const state = {
    activeRuns: new Map(),
    recentRuns: [],
    recentDispatches: [],
    recentBlockers: []
  };
  let initialized = false;

  function mergeRecentRuns(entries = []) {
    const merged = new Map();
    for (const entry of [...entries, ...state.recentRuns].map((item) => normalizeHistoricalRunStatus(item))) {
      const runId = normalizeString(entry?.runId);
      if (!runId) continue;
      const existing = merged.get(runId);
      if (!existing || String(entry?.updatedAt || entry?.startedAt || "") > String(existing?.updatedAt || existing?.startedAt || "")) {
        merged.set(runId, entry);
      }
    }
    state.recentRuns = Array.from(merged.values())
      .sort((a, b) => String(b.updatedAt || b.startedAt || "").localeCompare(String(a.updatedAt || a.startedAt || "")))
      .slice(0, MAX_RECENT_RUNS);
  }

  function mergeRecentEntries(key, entries = [], max = MAX_RECENT_RUNS) {
    const merged = new Map();
    for (const entry of [...entries, ...state[key]]) {
      const entryKey = JSON.stringify(entry);
      if (!merged.has(entryKey)) merged.set(entryKey, entry);
    }
    state[key] = Array.from(merged.values())
      .sort((a, b) => String(b.timestamp || b.updatedAt || "").localeCompare(String(a.timestamp || a.updatedAt || "")))
      .slice(0, max);
  }

  async function ensureInitialized() {
    if (initialized) return;
    initialized = true;
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(statusPath, "utf8");
      const snapshot = JSON.parse(raw);
      mergeRecentRuns([
        ...(Array.isArray(snapshot?.recentRuns) ? snapshot.recentRuns : []),
        ...(Array.isArray(snapshot?.activeRuns) ? snapshot.activeRuns : [])
      ]);
      mergeRecentEntries("recentDispatches", Array.isArray(snapshot?.recentDispatches) ? snapshot.recentDispatches : [], MAX_RECENT_DISPATCHES);
      mergeRecentEntries("recentBlockers", Array.isArray(snapshot?.recentBlockers) ? snapshot.recentBlockers : [], MAX_RECENT_BLOCKERS);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        logger?.warn?.(`[mission-deck] failed to restore dashboard snapshot: ${error?.message || error}`);
      }
    }
    if (state.recentRuns.length === 0 || state.recentDispatches.length === 0 || state.recentBlockers.length === 0) {
      try {
        const restored = await restoreFromDailyLogs(dataDir, options.retentionDays);
        if (state.recentRuns.length === 0) mergeRecentRuns(restored.recentRuns);
        if (state.recentDispatches.length === 0) mergeRecentEntries("recentDispatches", restored.recentDispatches, MAX_RECENT_DISPATCHES);
        if (state.recentBlockers.length === 0) mergeRecentEntries("recentBlockers", restored.recentBlockers, MAX_RECENT_BLOCKERS);
      } catch (error) {
        logger?.warn?.(`[mission-deck] failed to restore dashboard logs: ${error?.message || error}`);
      }
    }
  }

  async function append(type, payload) {
    try {
      await appendDailyEvent(dataDir, type, payload);
    } catch (error) {
      logger?.warn?.(`[mission-deck] failed to append dashboard event: ${error?.message || error}`);
    }
  }

  async function prune() {
    try {
      await pruneDailyLogs(dataDir, options.retentionDays);
    } catch (error) {
      logger?.warn?.(`[mission-deck] failed to prune dashboard history: ${error?.message || error}`);
    }
  }

  async function flush() {
    await ensureInitialized();
    await prune();
    const snapshot = buildDashboardSnapshot(state, {
      configuredAgents: options.configuredAgents,
      fsEnabled: options.fsEnabled,
      webEnabled: options.webEnabled,
      mcpServers: options.mcpServers,
      retentionDays: options.retentionDays,
      maxRecentRuns: MAX_RECENT_RUNS,
      normalizeHistoricalRunStatus
    });

    try {
      await writeDashboardStatus(statusPath, snapshot);
    } catch (error) {
      logger?.warn?.(`[mission-deck] failed to write dashboard status: ${error?.message || error}`);
    }
  }

  function trackActiveRun(runId, agentId, runState) {
    if (!runId || !agentId) return;
    if (!shouldSurfaceRunInDashboard(runState)) {
      state.activeRuns.delete(runId);
      return;
    }
    state.activeRuns.set(runId, serializeRunState(runId, agentId, runState, options));
  }

  async function archiveRun(runId, agentId, runState) {
    await ensureInitialized();
    if (!runId || !agentId) return;
    state.activeRuns.delete(runId);
    if (!shouldSurfaceRunInDashboard(runState)) return;
    const serialized = serializeRunState(runId, agentId, runState, options);
    mergeRecentRuns([serialized]);
    await append("run-ended", serialized);
  }

  async function pushDispatch(entry) {
    await ensureInitialized();
    const sanitized = sanitizeDispatchEntry(entry, options);
    mergeRecentEntries("recentDispatches", [sanitized], MAX_RECENT_DISPATCHES);
    await append("dispatch", sanitized);
  }

  async function pushBlocker(entry) {
    await ensureInitialized();
    const sanitized = sanitizeBlockerEntry(entry, options);
    mergeRecentEntries("recentBlockers", [sanitized], MAX_RECENT_BLOCKERS);
    await append("blocker", sanitized);
  }

  async function attachChildOutcome(outcome) {
    await ensureInitialized();
    let updated = false;
    const parentRunId = normalizeString(outcome?.parentRunId);
    if (!parentRunId) return;

    const activeRun = state.activeRuns.get(parentRunId);
    if (activeRun) {
      updated = updateRunWithChildOutcome(activeRun, outcome, isoNow) || updated;
      if (updated) state.activeRuns.set(parentRunId, activeRun);
    }

    state.recentRuns = state.recentRuns.map((run) => {
      if (normalizeString(run?.runId) !== parentRunId) return run;
      const nextRun = { ...run };
      if (updateRunWithChildOutcome(nextRun, outcome, isoNow)) {
        updated = true;
        return nextRun;
      }
      return run;
    });

    if (updated) {
      await append("child-outcome", sanitizeChildOutcome({
        parentRunId,
        childTaskId: normalizeString(outcome.childTaskId),
        childSessionKey: normalizeString(outcome.childSessionKey),
        childRunId: normalizeString(outcome.childRunId),
        childAgentId: normalizeString(outcome.childAgentId),
        phase: normalizeString(outcome.phase),
        summary: normalizeString(outcome.summary),
        updatedAt: normalizeString(outcome.updatedAt) || isoNow()
      }, options));
    }
  }

  return {
    flush,
    trackActiveRun,
    archiveRun,
    pushDispatch,
    pushBlocker,
    attachChildOutcome
  };
}

export {
  canTreatWaitingRunAsCompleted,
  createDashboardStore,
  dashboardStatusWriteSequence,
  DASHBOARD_DATA_DIR,
  DASHBOARD_DIR,
  DASHBOARD_STATUS_PATH
};
