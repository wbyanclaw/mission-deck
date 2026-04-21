const el = {
  generatedAt: document.getElementById("generatedAt"),
  heartbeat: document.getElementById("heartbeat"),
  heroSub: document.getElementById("heroSub"),
  summary: document.getElementById("summary"),
  agents: document.getElementById("agents"),
  graph: document.getElementById("graph"),
  timeline: document.getElementById("timeline"),
  taskCount: document.getElementById("task-count")
};

let lastGeneratedAt = "";
let lastGoodData = null;
const uiState = {
  agentOpen: new Set(),
  taskOpen: new Set()
};

const STATUS_TEXT = {
  blocked: "Needs attention",
  waiting: "In progress",
  completed: "Completed",
  delegated: "Delegated",
  lane_open: "Lane opened",
  coordinating: "Coordinating",
  triaging: "Triaging",
  non_engineering: "Other"
};

const TARGET_KIND_TEXT = {
  "persistent-channel-session": "Continue in an existing channel session",
  "subagent-session": "Open a dedicated subagent lane",
  "cron-session": "Continue in a scheduled lane",
  "spawned-run": "Open a separate execution lane",
  "existing-session": "Continue in an existing reusable session"
};

function fmtTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function timeAgo(value) {
  if (!value) return "No heartbeat yet";
  const diff = Math.max(0, Date.now() - new Date(value).getTime());
  const secs = Math.round(diff / 1000);
  if (secs < 1) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return `${hours}h ago`;
}

function refreshHeartbeat() {
  el.heartbeat.textContent = lastGeneratedAt
    ? `Heartbeat: ${timeAgo(lastGeneratedAt)}`
    : "Heartbeat: -";
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderEmpty(target, text) {
  target.innerHTML = `<div class="empty">${esc(text)}</div>`;
}

function isValidSnapshot(data) {
  if (!data || typeof data !== "object") return false;
  if (!data.meta || !data.meta.generatedAt) return false;
  if (!Array.isArray(data.agentRoster)) return false;
  if (!Array.isArray(data.recentRuns)) return false;
  if (!Array.isArray(data.activeRuns)) return false;
  if (!Array.isArray(data.recentDispatches)) return false;
  return true;
}

function shouldIgnoreSnapshot(data) {
  if (!lastGoodData) return false;
  const hadVisibleData =
    (lastGoodData.recentRuns || []).length > 0 ||
    (lastGoodData.activeRuns || []).length > 0 ||
    (lastGoodData.recentDispatches || []).length > 0;
  const hasVisibleData =
    (data.recentRuns || []).length > 0 ||
    (data.activeRuns || []).length > 0 ||
    (data.recentDispatches || []).length > 0;
  return hadVisibleData && !hasVisibleData;
}

function applyDashboard(data) {
  el.generatedAt.textContent = `Updated: ${fmtTime(data.meta?.generatedAt)}`;
  lastGeneratedAt = data.meta?.generatedAt || "";
  refreshHeartbeat();
  renderHero(data);
  renderSummary(data);
  renderAgents(data);
  renderGraph(data);
  renderTimeline(data);
}

function getStatusText(status) {
  return STATUS_TEXT[status] || "Active";
}

function fmtCompactNumber(value) {
  const num = Number(value) || 0;
  if (num >= 1000000) return `${(num / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(num);
}

function getEffectiveStatus(run) {
  return String(run?.status || run?.flowStatus || "").toLowerCase();
}

function getLatestDispatch(run, data) {
  return (data.recentDispatches || [])
    .filter((entry) => entry.runId === run.runId)
    .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))[0] || null;
}

function getLatestBlocker(run, data) {
  return (data.recentBlockers || [])
    .filter((entry) => entry.runId === run.runId)
    .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))[0] || null;
}

function getRouteLabel(target) {
  return TARGET_KIND_TEXT[target?.targetKind] || "Internal collaboration in progress";
}

function getRouteReason(target) {
  if (!target) return "The task owner is still being determined.";
  if (target.routeType === "send") return "The task continues in an existing conversation thread.";
  if (target.routeType === "spawn") return "A separate execution lane was opened for isolated or parallel work.";
  return "The task is currently moving through internal collaboration.";
}

function humanizeLatestDetail(run, latestBlocker) {
  if (run.flowWaitSummary) return run.flowWaitSummary;
  if (latestBlocker?.reason) return latestBlocker.reason;
  if (run.lastExternalMessage) return run.lastExternalMessage;

  const status = String(run.lastToolStatus || "").toLowerCase();
  if (status === "sent" || status === "succeeded" || status === "success" || status === "accepted") {
    return "Handoff completed and follow-up is in progress.";
  }
  if (status === "running" || status === "in_progress" || status === "pending") {
    return "A teammate is actively working on it.";
  }
  if (status === "timeout" || status === "timed_out") {
    return "The task has been waiting for a while and may need fresh input.";
  }
  if (status === "failed" || status === "error") {
    return "The current route hit an error and needs another pass.";
  }
  if (status === "unknown") {
    return "Follow-up was sent and the system is waiting for a result.";
  }

  if (run.status === "blocked") return "The task is blocked and needs a decision or new input.";
  if (run.lastEvent) return "The task is still active and the latest step has been recorded.";
  return "The task is still progressing.";
}

function getFlowStepText(run) {
  const step = String(run.flowCurrentStep || "").trim();
  if (!step) return "";
  return step
    .replaceAll(/[:_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTaskCards(data) {
  const active = Array.isArray(data.activeRuns) ? data.activeRuns : [];
  const recent = Array.isArray(data.recentRuns) ? data.recentRuns : [];
  const unique = new Map();
  for (const run of [...active, ...recent]) {
    if (!run.taskFlowSeen || !String(run.flowId || "").trim()) continue;
    const promptText = String(run.promptText || "").toLowerCase();
    const lastExternalMessage = String(run.lastExternalMessage || "").toLowerCase();
    const isHeartbeat =
      lastExternalMessage === "heartbeat_ok" ||
      promptText.includes("heartbeat.md") ||
      promptText.includes("reply heartbeat_ok") ||
      promptText.includes("if nothing needs attention, reply heartbeat_ok") ||
      promptText.includes("read heartbeat.md if it exists");
    const isSystemRun =
      promptText.includes("<<<begin_openclaw_internal_context>>>") ||
      promptText.includes("[internal task completion event]") ||
      promptText.includes("system (untrusted):") ||
      promptText.includes("[subagent context]") ||
      promptText.includes("openclaw runtime context (internal)");
    if (isHeartbeat || isSystemRun) continue;
    const runId = run.runId || `${run.agentId || "unknown"}:${run.startedAt || ""}`;
    const existing = unique.get(runId);
    if (!existing || String(run.updatedAt || run.startedAt || "") > String(existing.updatedAt || existing.startedAt || "")) {
      unique.set(runId, run);
    }
  }
  return Array.from(unique.values())
    .sort((a, b) => String(b.updatedAt || b.startedAt || "").localeCompare(String(a.updatedAt || a.startedAt || "")));
}

function getDecisionType(item) {
  const event = String(item.event || "");
  if (event === "before_prompt_build") return "thought";
  if (event.includes("blocked") || item.blockReason) return "observation";
  if (event.includes("dispatch") || event.includes("coordination") || event.includes("discovery") || event.includes("message")) {
    return "action";
  }
  return "observation";
}

function describeDecision(item, run) {
  if (item.blockReason) return item.blockReason;
  if (item.externalMessage) return item.externalMessage;
  if (item.event === "before_prompt_build") {
    return run.suggestedSpawn?.agentId
      ? `Selected ${run.suggestedSpawn.agentId} as the likely executor and prepared a lane handoff.`
      : "Classified the request and prepared the next internal coordination step.";
  }
  if (item.event === "workspace_discovery") return "Checked configured workspaces before asking the user for project entrypoints.";
  if (item.event === "internal_coordination") return "Started internal coordination to find the best executor.";
  if (item.event === "execution_lane_request") return "Requested a reusable session or a fresh execution lane.";
  if (item.event === "dispatch_result") return `The collaboration call returned with status: ${item.toolStatus || "unknown"}`;
  if (item.event === "external_message") return "Sent a user-facing update backed by actual progress.";
  if (item.event === "agent_end") return "The current run ended and its state was recorded.";
  return item.event || "Recorded one internal action";
}

function buildDecisionChain(run) {
  const items = Array.isArray(run.activityTrail) ? run.activityTrail : [];
  return items.slice(-8).map((item) => ({
    type: getDecisionType(item),
    label: item.toolName || item.event || "event",
    detail: describeDecision(item, run),
    timestamp: item.timestamp
  }));
}

function buildTaskSteps(run, data) {
  const latestDispatch = getLatestDispatch(run, data);
  const latestBlocker = getLatestBlocker(run, data);
  return [
    {
      label: "任务进入",
      detail: run.promptText || "已收到任务",
      done: true
    },
    {
      label: "跟进安排",
      detail: run.workspaceDiscoverySeen ? "已经找到相关资料或项目位置" : run.internalCoordinationSeen ? "已经安排合适同事跟进" : "正在确认最合适的负责人",
      done: Boolean(run.workspaceDiscoverySeen || run.internalCoordinationSeen || run.executionLaneSeen)
    },
    {
      label: "处理路径",
      detail: getRouteLabel(latestDispatch?.target),
      done: Boolean(latestDispatch)
    },
    {
      label: run.status === "blocked" ? "需要关注" : "最新情况",
      detail: humanizeLatestDetail(run, latestBlocker),
      done: true,
      tone: run.status === "blocked" ? "danger" : "success"
    }
  ];
}

function getAgentStateTone(agent) {
  if (agent.blockedRuns > 0) return "risk";
  return agent.state === "busy" ? "busy" : "idle";
}

function getOrgOrder(agent) {
  return Number(agent?.orderIndex ?? 999);
}

function renderHero(data) {
  const agents = Array.isArray(data.agentRoster) ? data.agentRoster : [];
  const count = agents.length;
  const activeLinks = Array.isArray(data.recentDispatches) ? data.recentDispatches.length : 0;
  el.heroSub.textContent = `Powered by OpenClaw. ${count} agents are configured and ${activeLinks} recent collaboration links are visible in the current snapshot.`;
}

function deriveOrgHierarchy(agents) {
  const byId = new Map(agents.map((agent) => [agent.agentId, agent]));
  const root =
    agents.find((agent) => agent.isDefault) ||
    agents.slice().sort((a, b) => getOrgOrder(a) - getOrgOrder(b))[0] ||
    null;

  const parentById = new Map();
  const levelById = new Map();
  if (!root) return { root: null, parentById, levelById };

  levelById.set(root.agentId, 0);
  const queue = [root.agentId];
  const seen = new Set(queue);

  while (queue.length > 0) {
    const currentId = queue.shift();
    const current = byId.get(currentId);
    const children = (current?.allowAgents || [])
      .map((id) => byId.get(id))
      .filter(Boolean)
      .sort((a, b) => getOrgOrder(a) - getOrgOrder(b));

    for (const child of children) {
      if (seen.has(child.agentId)) continue;
      seen.add(child.agentId);
      parentById.set(child.agentId, currentId);
      levelById.set(child.agentId, (levelById.get(currentId) || 0) + 1);
      queue.push(child.agentId);
    }
  }

  const unassigned = agents
    .filter((agent) => !seen.has(agent.agentId))
    .sort((a, b) => getOrgOrder(a) - getOrgOrder(b));

  for (const agent of unassigned) {
    parentById.set(agent.agentId, root.agentId);
    levelById.set(agent.agentId, 1);
  }

  return { root, parentById, levelById };
}

function renderSummary(data) {
  const summary = data.summary || {};
  const tasks = buildTaskCards(data);
  const blocked = tasks.filter((task) => getEffectiveStatus(task) === "blocked").length;
  const waiting = tasks.filter((task) => getEffectiveStatus(task) === "waiting").length;
  const delegated = tasks.filter((task) => (task.flowTaskSummary?.total || 0) > 0 || (task.childTaskIds || []).length > 0).length;
  const cards = [
    { title: "Open tasks", value: `${tasks.length}`, note: `${delegated} involve multi-agent coordination` },
    { title: "In progress", value: `${waiting}`, note: "Waiting on feedback, confirmation, or the next action" },
    { title: "Needs attention", value: `${blocked}`, note: "Blocked tasks that may need intervention" },
    { title: "Recent success rate", value: `${summary.successRate || 0}%`, note: "Based on recent task closure outcomes" }
  ];
  el.summary.innerHTML = cards.map((item) => `
    <article class="summary-card">
      <div class="summary-title">${esc(item.title)}</div>
      <div class="summary-value">${esc(item.value)}</div>
      <div class="summary-note">${esc(item.note)}</div>
    </article>
  `).join("");
}

function renderAgents(data) {
  const agents = (Array.isArray(data.agentRoster) ? data.agentRoster : [])
    .slice()
    .sort((a, b) =>
      (Number(b.tokenProxy) || 0) - (Number(a.tokenProxy) || 0) ||
      (Number(b.queueDepth) || 0) - (Number(a.queueDepth) || 0) ||
      String(a.displayName || a.agentId || "").localeCompare(String(b.displayName || b.agentId || ""))
    );
  if (!agents.length) return renderEmpty(el.agents, "No agents are available in the current snapshot.");
  el.agents.innerHTML = agents.map((agent) => `
    <article class="agent-card ${esc(getAgentStateTone(agent))}" data-agent-id="${esc(agent.agentId)}">
      <div class="agent-summary">
        <div class="agent-head">
          <div>
            <div class="agent-name">${esc(agent.emoji || "")} ${esc(agent.displayName || agent.agentId)}</div>
            <div class="agent-theme">${esc(agent.theme || agent.agentId)}</div>
          </div>
          <div class="agent-pill">${esc(agent.state === "busy" ? "Busy" : "Idle")}</div>
        </div>
        <div class="agent-metrics compact">
          <span>Tokens ${esc(fmtCompactNumber(agent.tokenProxy || 0))}</span>
        </div>
      </div>
    </article>
  `).join("");
}

function buildGraphModel(data) {
  const agents = Array.isArray(data.agentRoster) ? data.agentRoster : [];
  const dispatches = Array.isArray(data.recentDispatches) ? data.recentDispatches : [];
  const positions = new Map();
  const width = 760;
  const { root, parentById, levelById } = deriveOrgHierarchy(agents);
  const maxLevel = Math.max(0, ...Array.from(levelById.values()));
  const height = Math.max(236, 168 + maxLevel * 92);
  const centerX = width / 2;
  const levels = Array.from({ length: maxLevel + 1 }, () => []);
  const topPadding = 56;
  const bottomPadding = 44;
  const usableHeight = Math.max(96, height - topPadding - bottomPadding);

  for (const agent of agents) {
    const level = levelById.get(agent.agentId) ?? 0;
    levels[level].push(agent);
  }

  levels.forEach((group) => group.sort((a, b) => getOrgOrder(a) - getOrgOrder(b)));
  levels.forEach((group, level) => {
    const y = Math.round(topPadding + (maxLevel === 0 ? usableHeight / 2 : (level * usableHeight) / maxLevel));
    if (level === 0 && group.length === 1) {
      positions.set(group[0].agentId, { x: centerX, y });
      return;
    }
    const spacing = width / (Math.max(group.length, 1) + 1);
    group.forEach((agent, index) => {
      positions.set(agent.agentId, {
        x: Math.round(spacing * (index + 1)),
        y
      });
    });
  });
  const edges = dispatches
    .map((entry) => ({
      from: entry.agentId,
      to: entry.target?.agentId,
      timestamp: entry.timestamp,
      status: entry.status,
      routeType: entry.target?.routeType || ""
    }))
    .filter((edge) => edge.from && edge.to && positions.has(edge.from) && positions.has(edge.to));
  const orgEdges = agents
    .filter((agent) => parentById.has(agent.agentId))
    .map((agent) => ({
    from: parentById.get(agent.agentId),
    to: agent.agentId,
    kind: "org"
  })).filter((edge) => edge.from && edge.to);
  return { width, height, positions, edges, orgEdges, topAgent: root };
}

function renderGraph(data) {
  const agents = Array.isArray(data.agentRoster) ? data.agentRoster : [];
  if (!agents.length) return renderEmpty(el.graph, "暂时没有组织关系可展示。");
  const model = buildGraphModel(data);
  const nodes = agents.map((agent) => {
    const pos = model.positions.get(agent.agentId);
    return { agent, pos };
  }).filter((entry) => entry.pos);
  const edges = model.edges.map((edge) => {
    const from = model.positions.get(edge.from);
    const to = model.positions.get(edge.to);
    const active = Date.now() - new Date(edge.timestamp).getTime() < 15 * 60 * 1000;
    return { ...edge, from, to, active };
  });
  el.graph.innerHTML = `
    <svg viewBox="0 0 ${model.width} ${model.height}" class="graph-svg" role="img" aria-label="OpenClaw coordination graph">
      <defs>
        <marker id="arrow" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto">
          <path d="M0,0 L0,6 L8,3 z" class="graph-arrow" />
        </marker>
      </defs>
      ${model.orgEdges.map((edge) => {
        const from = model.positions.get(edge.from);
        const to = model.positions.get(edge.to);
        const midY = Math.round((from.y + to.y) / 2);
        return `
          <g class="graph-edge org">
            <path d="M${from.x},${from.y + 38} C${from.x},${midY} ${to.x},${midY} ${to.x},${to.y - 38}"></path>
            <text x="${Math.round((from.x + to.x) / 2)}" y="${midY + 14}">dispatch</text>
          </g>
        `;
      }).join("")}
      ${edges.map((edge) => {
        const midY = Math.round((edge.from.y + edge.to.y) / 2);
        return `
          <g class="graph-edge ${edge.active ? "active" : ""}">
            <path d="M${edge.from.x},${edge.from.y + 38} C${edge.from.x},${midY} ${edge.to.x},${midY} ${edge.to.x},${edge.to.y - 38}" marker-end="url(#arrow)"></path>
            <text x="${Math.round((edge.from.x + edge.to.x) / 2)}" y="${midY - 8}">${esc(edge.routeType === "send" ? "reuse" : edge.routeType === "spawn" ? "spawn" : edge.status || "sent")}</text>
          </g>
        `;
      }).join("")}
      ${nodes.map(({ agent, pos }) => `
        <g class="graph-node ${agent.state === "busy" ? "busy" : "idle"}">
          <rect x="${pos.x - 74}" y="${pos.y - 34}" rx="18" ry="18" width="148" height="68"></rect>
          <text x="${pos.x}" y="${pos.y - 8}" class="node-title">${esc(`${agent.emoji || ""} ${agent.displayName || agent.agentId}`.trim())}</text>
          <text x="${pos.x}" y="${pos.y + 10}" class="node-role">${esc(agent.theme || agent.agentId)}</text>
        </g>
      `).join("")}
    </svg>
  `;
}

function truncateText(value, max = 120) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function stripPromptMetadata(value) {
  return String(value || "")
    .replace(/Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```/gi, "")
    .replace(/Sender \(untrusted metadata\):\s*```json[\s\S]*?```/gi, "")
    .replace(/Recipient \(untrusted metadata\):\s*```json[\s\S]*?```/gi, "")
    .replace(/System \(untrusted\):[\s\S]*$/gi, "")
    .replace(/<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*$/gi, "")
    .replace(/\[Internal task completion event][\s\S]*$/gi, "")
    .replace(/\[Subagent Context][\s\S]*?\[Subagent Task]:/gi, "")
    .replace(/\[message_id:[^\]]+\]/gi, "")
    .replace(/Current time:[^\n]*\n?/gi, "")
    .replace(/Return your response as plain text[^\n]*\n?/gi, "")
    .replace(/\[(Sat|Sun|Mon|Tue|Wed|Thu|Fri) .*?\]\s*/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .trim();
}

function deriveTaskSummary(run) {
  const raw = stripPromptMetadata(run.promptText);
  const firstMeaningfulLine = raw
    .split(/\n+/)
    .map((line) => line.trim())
    .find((line) =>
      line &&
      !/^```/.test(line) &&
      !/^[{\[]/.test(line) &&
      !/^(conversation info|sender|recipient|system)/i.test(line)
    );
  return truncateText(firstMeaningfulLine || raw || run.lastExternalMessage || "任务处理中", 52);
}

function getAgentDisplayName(data, agentId) {
  if (!agentId) return "相关同事";
  const match = (data.agentRoster || []).find((agent) => agent.agentId === agentId);
  return match?.displayName || agentId;
}

function getTimelineOwnerName(data, owner, fallbackAgentId) {
  const normalizedOwner = String(owner || "").trim();
  if (!normalizedOwner) return getAgentDisplayName(data, fallbackAgentId);
  if (normalizedOwner === "用户") return "用户";
  return getAgentDisplayName(data, normalizedOwner);
}

function summarizeBlocker(reason) {
  const text = String(reason || "").trim();
  if (!text) return "处理过程中遇到异常，需要重新跟进。";
  if (/not allowed|forbidden|denied/i.test(text)) return "当前这条协作没有权限发出去，需要换一种处理方式。";
  if (/timeout|timed out/i.test(text)) return "等待时间过长，暂时还没有收到后续结果。";
  if (/invalid|without sessionkey|label/i.test(text)) return "这次交接方式不成立，需要重新建立任务连接。";
  return truncateText(text, 72);
}

function needsTextToggle(value) {
  const text = String(value || "");
  return text.length > 96 || text.includes("\n");
}

function buildWorkTreeRows(run, data) {
  const timelineEvents = Array.isArray(run.timelineEvents) ? run.timelineEvents : [];
  if (timelineEvents.length > 0) {
    return timelineEvents
      .map((item) => ({
        timestamp: item.timestamp,
        owner: getTimelineOwnerName(data, item.owner, run.agentId),
        role: item.role === "最终回复"
          ? "回复用户"
          : item.role === "内部查询"
            ? "任务拆解"
          : item.role === "安排跟进"
            ? "任务分配"
            : (item.role || "任务更新"),
        text: item.text || "",
        tone: item.tone || ""
      }))
      .filter((item) => item.text)
      .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
  }
  const rows = [{
    timestamp: run.startedAt,
    owner: "用户",
    role: "用户发起",
    text: deriveTaskSummary(run)
  }];

  for (const entry of (data.recentDispatches || []).filter((item) => item.runId === run.runId)) {
    const targetName = getAgentDisplayName(data, entry.target?.agentId);
    rows.push({
      timestamp: entry.timestamp,
      owner: getAgentDisplayName(data, entry.agentId || run.agentId),
      role: "安排跟进",
      text: `已交给${targetName}继续处理。`
    });
  }

  for (const task of (run.childTasks || [])) {
    rows.push({
      timestamp: task.updatedAt,
      owner: getAgentDisplayName(data, task.agentId),
      role: "协同反馈",
      text: task.progressSummary || task.label || "当前正在推进中"
    });
  }

  for (const entry of (data.recentBlockers || []).filter((item) => item.runId === run.runId)) {
    rows.push({
      timestamp: entry.timestamp,
      owner: getAgentDisplayName(data, entry.agentId || run.agentId),
      role: "异常摘要",
      text: summarizeBlocker(entry.reason),
      tone: "blocked"
    });
  }

  if (run.lastExternalMessage) {
    rows.push({
      timestamp: run.updatedAt,
      owner: getAgentDisplayName(data, run.agentId),
      role: "对话更新",
      text: run.lastExternalMessage
    });
  }

  if (rows.length === 1) {
    rows.push({
      timestamp: run.updatedAt || run.startedAt,
      owner: getAgentDisplayName(data, run.agentId),
      role: "对话更新",
      text: "已接单，正在处理中。"
    });
  }

  return rows
    .filter((item) => item.text)
    .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
}

function captureUiState() {
  uiState.agentOpen = new Set(
    Array.from(document.querySelectorAll("[data-agent-id]"))
      .filter((node) => node.open)
      .map((node) => node.dataset.agentId)
      .filter(Boolean)
  );
  uiState.taskOpen = new Set(
    Array.from(document.querySelectorAll("[data-run-id]"))
      .filter((node) => node.open)
      .map((node) => node.dataset.runId)
      .filter(Boolean)
  );
}

function getCurrentOwner(run, data) {
  const latestDispatch = getLatestDispatch(run, data);
  return run.childTasks?.at?.(-1)?.agentId ||
    latestDispatch?.target?.agentId ||
    run.agentId ||
    "待分配";
}

function getParticipantLine(run) {
  const participants = new Set(["用户"]);
  if (run.agentId) participants.add(run.agentId);
  for (const task of (run.childTasks || [])) {
    if (task.agentId) participants.add(task.agentId);
  }
  return Array.from(participants).join(" -> ");
}

function getCurrentProgress(run, data) {
  if (run.flowWaitSummary) return run.flowWaitSummary;
  if (getFlowStepText(run)) return `当前阶段：${getFlowStepText(run)}`;
  return run.childTasks?.at?.(-1)?.progressSummary ||
    run.lastExternalMessage ||
    humanizeLatestDetail(run, getLatestBlocker(run, data));
}

function renderTimeline(data) {
  const tasks = buildTaskCards(data);
  el.taskCount.textContent = `${tasks.length} 项`;
  if (!tasks.length) return renderEmpty(el.timeline, "No active TaskFlow runs are visible right now.");

  el.timeline.innerHTML = tasks.map((run, index) => {
    const worktree = buildWorkTreeRows(run, data);
    const taskSummary = deriveTaskSummary(run);
    const status = getEffectiveStatus(run);
    return `
      <details
        class="task-card worktree-card"
        data-run-id="${esc(run.runId || "")}"
        ${uiState.taskOpen.has(run.runId) || (index === 0 && uiState.taskOpen.size === 0) ? "open" : ""}
      >
        <summary class="task-summary">
          <div class="task-head">
            <div>
              <div class="task-time">Task ${index + 1} · ${esc(fmtTime(run.updatedAt || run.startedAt))}</div>
              <h3>${esc(taskSummary)}</h3>
            </div>
            <div class="task-status ${esc(status)}">${esc(getStatusText(status))}</div>
          </div>
        </summary>
        <div class="worktree-body">
          <div class="worktree-rail">
            ${worktree.length ? worktree.map((item) => `
              <article class="worktree-node ${esc(item.tone || "")}">
                <div class="worktree-dot"></div>
                <div class="worktree-content">
              <div class="worktree-meta">${esc(item.role)} · ${esc(item.owner || "-")} · ${esc(fmtTime(item.timestamp))}</div>
              <div class="worktree-text ${needsTextToggle(item.text) ? "is-collapsed" : ""}">${esc(item.text)}</div>
                  ${needsTextToggle(item.text) ? `<button type="button" class="worktree-toggle" aria-expanded="false">Expand</button>` : ""}
                </div>
              </article>
            `).join("") : `<div class="empty-inline">No timeline entries are available yet.</div>`}
          </div>
        </div>
      </details>
    `;
  }).join("");
}

async function loadDashboard() {
  try {
    captureUiState();
    const response = await fetch(`./status.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!isValidSnapshot(data)) {
      throw new Error("快照结构不完整");
    }
    if (shouldIgnoreSnapshot(data)) {
      el.generatedAt.textContent = `Updated: ${fmtTime(lastGoodData?.meta?.generatedAt)} · waiting for a stable snapshot`;
      return;
    }
    lastGoodData = data;
    applyDashboard(data);
  } catch (error) {
    if (lastGoodData) {
      el.generatedAt.textContent = `Updated: ${fmtTime(lastGoodData?.meta?.generatedAt)} · transient fetch failure, showing the latest cached snapshot`;
      refreshHeartbeat();
      return;
    }
    lastGeneratedAt = "";
    el.generatedAt.textContent = "Updated: load failed";
    el.heartbeat.textContent = "Heartbeat: load failed";
    el.heroSub.textContent = "The dashboard snapshot could not be loaded.";
    renderEmpty(el.summary, "Waiting for data");
    renderEmpty(el.agents, "Waiting for data");
    renderEmpty(el.graph, "Waiting for data");
    renderEmpty(el.timeline, `暂时无法加载：${error.message}`);
  }
}

loadDashboard();
setInterval(refreshHeartbeat, 1000);
setInterval(loadDashboard, 3000);

document.addEventListener("click", (event) => {
  const button = event.target.closest(".worktree-toggle");
  if (!button) return;
  const text = button.parentElement?.querySelector(".worktree-text");
  if (!text) return;
  const expanded = text.classList.toggle("is-expanded");
  text.classList.toggle("is-collapsed", !expanded);
  button.textContent = expanded ? "收起" : "展开";
  button.setAttribute("aria-expanded", expanded ? "true" : "false");
});
