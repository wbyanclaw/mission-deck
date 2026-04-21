import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isoNow } from "./orchestrator-helpers.js";

const MAX_RECENT_RUNS = 200;
const MAX_RECENT_DISPATCHES = 30;
const MAX_RECENT_BLOCKERS = 20;
const DEFAULT_RETENTION_DAYS = 14;
let dashboardStatusWriteSequence = 0;

function dayStamp(value = new Date()) {
  return new Date(value).toISOString().slice(0, 10);
}

async function writeDashboardStatus(statusPath, snapshot) {
  await mkdir(dirname(statusPath), { recursive: true });
  dashboardStatusWriteSequence += 1;
  const tempPath = `${statusPath}.${process.pid}.${Date.now()}.${dashboardStatusWriteSequence}.tmp`;
  await writeFile(tempPath, JSON.stringify(snapshot, null, 2), "utf8");
  await rename(tempPath, statusPath);
}

async function appendDailyEvent(dataDir, type, payload) {
  await mkdir(dataDir, { recursive: true });
  const event = {
    timestamp: isoNow(),
    type,
    ...payload
  };
  const targetPath = join(dataDir, `${dayStamp(event.timestamp)}.jsonl`);
  await appendFile(targetPath, `${JSON.stringify(event)}\n`, "utf8");
}

async function pruneDailyLogs(dataDir, retentionDays) {
  await mkdir(dataDir, { recursive: true });
  const effectiveRetention = Math.max(1, Number(retentionDays) || DEFAULT_RETENTION_DAYS);
  const threshold = new Date();
  threshold.setUTCDate(threshold.getUTCDate() - effectiveRetention);
  const cutoffStamp = threshold.toISOString().slice(0, 10);
  const files = await readdir(dataDir, { withFileTypes: true });
  await Promise.all(files
    .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
    .filter((entry) => entry.name.slice(0, 10) < cutoffStamp)
    .map((entry) => rm(join(dataDir, entry.name), { force: true })));
}

async function restoreFromDailyLogs(dataDir, retentionDays) {
  const effectiveRetention = Math.max(1, Number(retentionDays) || DEFAULT_RETENTION_DAYS);
  const threshold = new Date();
  threshold.setUTCDate(threshold.getUTCDate() - effectiveRetention);
  const cutoffStamp = threshold.toISOString().slice(0, 10);
  const files = (await readdir(dataDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
    .filter((entry) => entry.name.slice(0, 10) >= cutoffStamp)
    .sort((a, b) => b.name.localeCompare(a.name));

  const recentRuns = [];
  const recentDispatches = [];
  const recentBlockers = [];

  for (const entry of files) {
    const raw = await readFile(join(dataDir, entry.name), "utf8");
    const lines = raw.split(/\n+/).filter(Boolean).reverse();
    for (const line of lines) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed?.type === "run-ended" && recentRuns.length < MAX_RECENT_RUNS) {
        recentRuns.push(parsed);
      } else if (parsed?.type === "dispatch" && recentDispatches.length < MAX_RECENT_DISPATCHES) {
        recentDispatches.push(parsed);
      } else if (parsed?.type === "blocker" && recentBlockers.length < MAX_RECENT_BLOCKERS) {
        recentBlockers.push(parsed);
      }
      if (
        recentRuns.length >= MAX_RECENT_RUNS &&
        recentDispatches.length >= MAX_RECENT_DISPATCHES &&
        recentBlockers.length >= MAX_RECENT_BLOCKERS
      ) {
        break;
      }
    }
  }

  return { recentRuns, recentDispatches, recentBlockers };
}

export {
  DEFAULT_RETENTION_DAYS,
  MAX_RECENT_BLOCKERS,
  MAX_RECENT_DISPATCHES,
  MAX_RECENT_RUNS,
  appendDailyEvent,
  dashboardStatusWriteSequence,
  pruneDailyLogs,
  restoreFromDailyLogs,
  writeDashboardStatus
};
