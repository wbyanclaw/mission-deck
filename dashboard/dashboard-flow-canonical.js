function normalizeText(value) {
  return String(value || "").trim();
}

export function getFlowFragmentTimestamp(entry) {
  return String(entry?.updatedAt || entry?.startedAt || "");
}

function getFlowProgressRank(entry) {
  const status = normalizeText(entry?.status).toLowerCase();
  const flowStatus = normalizeText(entry?.flowStatus).toLowerCase();
  const step = normalizeText(entry?.flowCurrentStep).toLowerCase();

  if (["blocked"].includes(status) || ["failed", "cancelled", "blocked"].includes(flowStatus) || ["blocked", "failed", "cancelled"].includes(step)) {
    return 60;
  }
  if (["completed"].includes(status) || ["succeeded", "completed"].includes(flowStatus) || ["completed"].includes(step)) {
    return 50;
  }
  if (step === "reviewing" || status === "reviewing") return 40;
  if (step === "waiting_child" || step === "awaiting_user_input" || status === "waiting" || flowStatus === "waiting") return 30;
  if (step === "delegated" || status === "delegated" || status === "lane_open") return 20;
  if (step === "routing" || step === "planned" || step === "intake" || step === "finalizing" || status === "coordinating" || status === "triaging") return 10;
  return 0;
}

function isTerminalProgressRank(rank) {
  return rank >= 50;
}

function getSignalRank(entry) {
  let score = 0;
  if (normalizeText(entry?.lastExternalMessage)) score += 20;
  if (normalizeText(entry?.lastBlockReason)) score += 20;
  if (Array.isArray(entry?.childTasks) && entry.childTasks.length > 0) score += 10;
  if (Array.isArray(entry?.timelineEvents) && entry.timelineEvents.length > 0) score += 10;
  if ((entry?.flowTaskSummary?.total || 0) > 0) score += 5;
  if (normalizeText(entry?.flowSource) === "taskflow") score += 5;
  if (entry?.taskFlowSeen) score += 5;
  return score;
}

export function compareFlowFragments(a, b) {
  return getFlowProgressRank(b) - getFlowProgressRank(a) ||
    getSignalRank(b) - getSignalRank(a) ||
    getFlowFragmentTimestamp(b).localeCompare(getFlowFragmentTimestamp(a));
}

function firstNonEmpty(entries, selector) {
  for (const entry of entries) {
    const value = selector(entry);
    if (typeof value === "string") {
      if (normalizeText(value)) return value;
      continue;
    }
    if (Array.isArray(value) && value.length > 0) return value;
    if (value && typeof value === "object") return value;
  }
  return "";
}

function earliestTimestamp(entries) {
  return entries
    .map((entry) => String(entry?.startedAt || entry?.updatedAt || ""))
    .filter(Boolean)
    .sort()[0] || "";
}

export function chooseCanonicalFlowFragment(entries) {
  const sorted = (Array.isArray(entries) ? entries : [])
    .filter(Boolean)
    .sort(compareFlowFragments);
  const primary = sorted[0] || null;
  if (!primary) return null;
  const primaryProgressRank = getFlowProgressRank(primary);
  return {
    ...primary,
    startedAt: earliestTimestamp(sorted) || getFlowFragmentTimestamp(primary),
    updatedAt: getFlowFragmentTimestamp(primary),
    lastExternalMessage: firstNonEmpty(sorted, (entry) => entry?.lastExternalMessage) || "",
    lastBlockReason: firstNonEmpty(sorted, (entry) => entry?.lastBlockReason) || "",
    flowWaitSummary: isTerminalProgressRank(primaryProgressRank)
      ? normalizeText(primary?.flowWaitSummary)
      : (firstNonEmpty(sorted, (entry) => entry?.flowWaitSummary) || ""),
    chainAssessment: isTerminalProgressRank(primaryProgressRank)
      ? (primary?.chainAssessment || null)
      : (firstNonEmpty(sorted, (entry) => entry?.chainAssessment) || primary.chainAssessment),
    childTasks: firstNonEmpty(sorted, (entry) => Array.isArray(entry?.childTasks) ? entry.childTasks : []) || [],
    childTaskIds: firstNonEmpty(sorted, (entry) => Array.isArray(entry?.childTaskIds) ? entry.childTaskIds : []) || [],
    timelineEvents: firstNonEmpty(sorted, (entry) => Array.isArray(entry?.timelineEvents) ? entry.timelineEvents : []) || [],
    flowTaskSummary: firstNonEmpty(sorted, (entry) => entry?.flowTaskSummary) || primary.flowTaskSummary
  };
}
