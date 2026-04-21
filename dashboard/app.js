const el = {
  versionBadge: document.getElementById("versionBadge"),
  generatedAt: document.getElementById("generatedAt"),
  heartbeat: document.getElementById("heartbeat"),
  heroSub: document.getElementById("heroSub"),
  summary: document.getElementById("summary"),
  agents: document.getElementById("agents"),
  graph: document.getElementById("graph"),
  timeline: document.getElementById("timeline"),
  taskCount: document.getElementById("task-count")
};

const DASHBOARD_VERSION = "v0.1.0+patch3";

let lastGeneratedAt = "";
let lastGoodData = null;
const uiState = {
  agentOpen: new Set(),
  taskOpen: new Set()
};

const STATUS_TEXT = {
  blocked: "需要关注",
  waiting: "处理中",
  completed: "已完成",
  delegated: "已分派",
  lane_open: "已建立处理通道",
  coordinating: "协同中",
  triaging: "分流中",
  non_engineering: "其他"
};

const TARGET_KIND_TEXT = {
  "persistent-channel-session": "继续当前 Channel Session",
  "subagent-session": "新建专用 Subagent Session",
  "cron-session": "在定时 Session 中继续处理",
  "spawned-run": "新建隔离 Run 通道",
  "existing-session": "复用已有 Session"
};

function fmtTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function timeAgo(value) {
  if (!value) return "暂无心跳";
  const diff = Math.max(0, Date.now() - new Date(value).getTime());
  const secs = Math.round(diff / 1000);
  if (secs < 1) return "刚刚";
  if (secs < 60) return `${secs} 秒前`;
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  return `${hours} 小时前`;
}

function refreshHeartbeat() {
  el.heartbeat.textContent = lastGeneratedAt
    ? `实时心跳：${timeAgo(lastGeneratedAt)}`
    : "实时心跳：-";
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
  if (el.versionBadge) {
    el.versionBadge.textContent = `Version: ${DASHBOARD_VERSION}`;
  }
  el.generatedAt.textContent = `更新时间：${fmtTime(data.meta?.generatedAt)}`;
  lastGeneratedAt = data.meta?.generatedAt || "";
  refreshHeartbeat();
  renderHero(data);
  renderSummary(data);
  renderAgents(data);
  renderGraph(data);
  renderTimeline(data);
}

function getStatusText(status) {
  return STATUS_TEXT[status] || "活跃";
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

function sortByTimestampAsc(items, pickTimestamp) {
  return [...items].sort((a, b) =>
    String(pickTimestamp(a) || "").localeCompare(String(pickTimestamp(b) || ""))
  );
}

function getRouteLabel(target) {
  return TARGET_KIND_TEXT[target?.targetKind] || "正在进行内部协作";
}

function getRouteReason(target) {
  if (!target) return "当前还在确认最合适的处理人。";
  if (target.routeType === "send") return "任务沿用已有 Session 继续推进。";
  if (target.routeType === "spawn") return "任务已新建独立 Run 通道，便于隔离或并行处理。";
  return "任务当前正在内部协作链路中推进。";
}

function humanizeLatestDetail(run, latestBlocker) {
  if (run.flowWaitSummary) return run.flowWaitSummary;
  if (latestBlocker?.reason) return latestBlocker.reason;
  if (run.lastExternalMessage) return run.lastExternalMessage;

  const status = String(run.lastToolStatus || "").toLowerCase();
  if (status === "sent" || status === "succeeded" || status === "success" || status === "accepted") {
    return "交接已完成，后续动作正在推进。";
  }
  if (status === "running" || status === "in_progress" || status === "pending") {
    return "相关 Agent 正在处理中。";
  }
  if (status === "timeout" || status === "timed_out") {
    return "等待时间较长，可能需要新的输入或继续跟进。";
  }
  if (status === "failed" || status === "error") {
    return "当前处理链路遇到异常，需要重新跟进。";
  }
  if (status === "unknown") {
    return "已发出跟进动作，正在等待结果。";
  }

  if (run.status === "blocked") return "任务当前被阻塞，需要决策或新的输入。";
  if (run.lastEvent) return "任务仍在推进，最新步骤已记录。";
  return "任务仍在处理中。";
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
      ? `已将 ${run.suggestedSpawn.agentId} 识别为候选执行者，并准备交接执行通道。`
      : "已完成任务分类，并准备进入下一步内部协作。";
  }
  if (item.event === "workspace_discovery") return "在继续追问前，先检查了已配置的工作区与项目线索。";
  if (item.event === "internal_coordination") return "已发起内部协作，寻找最合适的执行者。";
  if (item.event === "execution_lane_request") return "正在请求复用已有 Session，或新建执行通道。";
  if (item.event === "dispatch_result") return `协作调用已返回，状态：${item.toolStatus || "未知"}`;
  if (item.event === "external_message") return "已基于真实进展生成对用户可见的更新。";
  if (item.event === "agent_end") return "当前 Run 已结束，状态已落盘。";
  return item.event || "记录了一次内部动作";
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

function buildTaskChain(run, data) {
  const nodes = [];
  const seen = new Set();
  const addNode = (id, title, note = "") => {
    const normalizedId = String(id || "").trim() || title;
    if (!normalizedId || seen.has(normalizedId)) return;
    seen.add(normalizedId);
    nodes.push({ id: normalizedId, title, note });
  };

  addNode("user-request", "用户问句", deriveTaskSummary(run));
  addNode(`agent:${run.agentId}`, getAgentDisplayName(data, run.agentId), "Coordinator");

  const dispatches = sortByTimestampAsc(
    (data.recentDispatches || []).filter((entry) => entry.runId === run.runId),
    (entry) => entry.timestamp
  );
  for (const entry of dispatches) {
    const targetAgentId = String(entry.target?.agentId || "").trim();
    if (!targetAgentId) continue;
    addNode(`agent:${targetAgentId}`, getAgentDisplayName(data, targetAgentId), entry.target?.routeType === "spawn" ? "Spawn 通道" : "复用 Session");
  }

  const childTasks = sortByTimestampAsc(Array.isArray(run.childTasks) ? run.childTasks : [], (task) => task.updatedAt);
  for (const task of childTasks) {
    const taskAgentId = String(task.agentId || "").trim();
    if (!taskAgentId) continue;
    addNode(`agent:${taskAgentId}`, getAgentDisplayName(data, taskAgentId), `Child Task: ${task.phase || "progress"}`);
  }

  if (run.lastExternalMessage) {
    addNode("user-delivery", "用户交付", getEffectiveStatus(run) === "completed" ? "已交付" : "最近一次对外更新");
  }

  return nodes;
}

function buildTaskChainFacts(run, data) {
  const latestDispatch = getLatestDispatch(run, data);
  const facts = [
    { label: "用户问句", value: deriveTaskSummary(run) },
    { label: "Coordinator", value: getAgentDisplayName(data, run.agentId) },
    { label: "当前处理人", value: getAgentDisplayName(data, getCurrentOwner(run, data)) },
    { label: "Task Route", value: getRouteLabel(latestDispatch?.target) },
    { label: "Current Step", value: getCurrentProgress(run, data) }
  ];
  if (run.chainAssessment?.summary) {
    facts.push({ label: "链路体检", value: run.chainAssessment.summary });
  }
  if (run.chainAssessment?.missing) {
    facts.push({ label: "当前缺口", value: run.chainAssessment.missing });
  }
  if (run.chainAssessment?.nextAction) {
    facts.push({ label: "下一步", value: run.chainAssessment.nextAction });
  }
  return facts;
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
  el.heroSub.textContent = `由 OpenClaw 驱动，当前已配置 ${count} 个 Agent，并展示最近 ${activeLinks} 条协作链路。`;
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
    { title: "活跃任务", value: `${tasks.length}`, note: `${delegated} 项涉及多 Agent 协作` },
    { title: "处理中", value: `${waiting}`, note: "等待反馈、确认或下一步动作" },
    { title: "需要关注", value: `${blocked}`, note: "存在阻塞，可能需要人工介入" },
    { title: "近期完成率", value: `${summary.successRate || 0}%`, note: "按最近任务收口结果统计" }
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
  if (!agents.length) return renderEmpty(el.agents, "当前快照中暂无 Agent 信息。");
  el.agents.innerHTML = agents.map((agent) => `
    <article class="agent-card ${esc(getAgentStateTone(agent))}" data-agent-id="${esc(agent.agentId)}">
      <div class="agent-summary">
        <div class="agent-head">
          <div>
            <div class="agent-name">${esc(agent.emoji || "")} ${esc(agent.displayName || agent.agentId)}</div>
            <div class="agent-theme">${esc(agent.theme || agent.agentId)}</div>
          </div>
          <div class="agent-pill">${esc(agent.state === "busy" ? "忙碌" : "空闲")}</div>
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
    <svg viewBox="0 0 ${model.width} ${model.height}" class="graph-svg" role="img" aria-label="OpenClaw 协作关系图">
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
            <text x="${Math.round((from.x + to.x) / 2)}" y="${midY + 14}">分派</text>
          </g>
        `;
      }).join("")}
      ${edges.map((edge) => {
        const midY = Math.round((edge.from.y + edge.to.y) / 2);
        return `
          <g class="graph-edge ${edge.active ? "active" : ""}">
            <path d="M${edge.from.x},${edge.from.y + 38} C${edge.from.x},${midY} ${edge.to.x},${midY} ${edge.to.x},${edge.to.y - 38}" marker-end="url(#arrow)"></path>
            <text x="${Math.round((edge.from.x + edge.to.x) / 2)}" y="${midY - 8}">${esc(edge.routeType === "send" ? "send" : edge.routeType === "spawn" ? "spawn" : edge.status || "sent")}</text>
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
  if (!agentId) return "相关 Agent";
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

function sortTimelineDesc(items) {
  return items.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
}

function buildWorkTreeRows(run, data) {
  const rows = [{
    timestamp: run.startedAt,
    owner: "用户",
    role: "用户发起",
    text: deriveTaskSummary(run)
  }];

  for (const item of (Array.isArray(run.timelineEvents) ? run.timelineEvents : [])) {
    rows.push({
      timestamp: item.timestamp,
      owner: getTimelineOwnerName(data, item.owner, run.agentId),
      role: item.role === "最终回复"
        ? "回复用户"
        : item.role === "内部查询"
          ? "任务拆解"
        : item.role === "安排跟进"
          ? "任务分配"
        : item.role === "对外同步"
          ? "外部同步"
          : (item.role || "任务更新"),
      text: item.text || "",
      tone: item.tone || ""
    });
  }

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

  const seen = new Set();
  return sortTimelineDesc(rows.filter((item) => {
    if (!item.text) return false;
    const key = [
      String(item.timestamp || ""),
      String(item.owner || ""),
      String(item.role || ""),
      String(item.text || "")
    ].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
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

function getSupervisorSummary(run) {
  if (!run.supervisorPending && !run.supervisorLastInterventionAt) return null;
  const owner = String(run.supervisorAgentId || "").trim() || "manager";
  const reason = String(run.supervisorReason || run.flowWaitSummary || run.lastBlockReason || "").trim() || "任务等待时间过长，需要人工收敛";
  return {
    owner,
    reason,
    count: Number(run.supervisorInterventionCount || 0),
    time: run.supervisorLastInterventionAt || ""
  };
}

function buildSupervisorFacts(run) {
  const summary = getSupervisorSummary(run);
  if (!summary) return [];
  return [
    { label: "Supervisor", value: summary.owner },
    { label: "督办时间", value: fmtTime(summary.time) },
    { label: "督办次数", value: String(summary.count || 1) },
    { label: "督办原因", value: summary.reason }
  ];
}

function renderTimeline(data) {
  const tasks = buildTaskCards(data);
  el.taskCount.textContent = `${tasks.length} 项`;
  if (!tasks.length) return renderEmpty(el.timeline, "当前没有可展示的活跃 TaskFlow 任务。");

  el.timeline.innerHTML = tasks.map((run, index) => {
    const worktree = buildWorkTreeRows(run, data);
    const taskSummary = deriveTaskSummary(run);
    const status = getEffectiveStatus(run);
    const chain = buildTaskChain(run, data);
    const chainFacts = buildTaskChainFacts(run, data);
    const supervisorFacts = buildSupervisorFacts(run);
    const supervisorSummary = getSupervisorSummary(run);
    return `
      <details
        class="task-card worktree-card"
        data-run-id="${esc(run.runId || "")}"
        ${uiState.taskOpen.has(run.runId) || (index === 0 && uiState.taskOpen.size === 0) ? "open" : ""}
        >
        <summary class="task-summary">
          <div class="task-head">
            <div>
              <div class="task-time">任务 ${index + 1} · ${esc(fmtTime(run.updatedAt || run.startedAt))}</div>
              <h3>${esc(taskSummary)}</h3>
            </div>
            <div class="task-status ${esc(status)}">${esc(getStatusText(status))}</div>
          </div>
        </summary>
        <section class="task-chain">
          <div class="chain-title">任务链路</div>
          <div class="chain-path">
            ${chain.map((node, chainIndex) => `
              ${chainIndex > 0 ? `<span class="chain-arrow">→</span>` : ""}
              <span class="chain-node">
                <span class="chain-node-title">${esc(node.title)}</span>
                ${node.note ? `<span class="chain-node-note">${esc(node.note)}</span>` : ""}
              </span>
            `).join("")}
          </div>
          <div class="chain-facts">
            ${chainFacts.map((item) => `
              <div class="chain-fact">
                <div class="chain-fact-label">${esc(item.label)}</div>
                <div class="chain-fact-value">${esc(item.value || "-")}</div>
              </div>
            `).join("")}
          </div>
          ${supervisorSummary ? `
            <div class="supervisor-panel ${run.supervisorPending ? "pending" : ""}">
              <div class="supervisor-head">
                <div>
                  <div class="chain-title">督办状态</div>
                  <div class="supervisor-title">${esc(run.supervisorPending ? "Supervisor 已介入" : "最近一次督办记录")}</div>
                </div>
                <div class="supervisor-pill">${esc(supervisorSummary.owner)}</div>
              </div>
              <div class="supervisor-reason">${esc(supervisorSummary.reason)}</div>
              <div class="supervisor-facts">
                ${supervisorFacts.map((item) => `
                  <div class="supervisor-fact">
                    <div class="chain-fact-label">${esc(item.label)}</div>
                    <div class="chain-fact-value">${esc(item.value || "-")}</div>
                  </div>
                `).join("")}
              </div>
            </div>
          ` : ""}
        </section>
        <div class="worktree-body">
          <div class="worktree-rail">
            ${worktree.length ? worktree.map((item) => `
              <article class="worktree-node ${esc(item.tone || "")}">
                <div class="worktree-dot"></div>
                <div class="worktree-content">
                  <div class="worktree-meta">${esc(item.role)} · ${esc(item.owner || "-")} · ${esc(fmtTime(item.timestamp))}</div>
              <div class="worktree-text ${needsTextToggle(item.text) ? "is-collapsed" : ""}">${esc(item.text)}</div>
                  ${needsTextToggle(item.text) ? `<button type="button" class="worktree-toggle" aria-expanded="false">展开</button>` : ""}
                </div>
              </article>
            `).join("") : `<div class="empty-inline">暂时还没有时间线记录。</div>`}
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
      el.generatedAt.textContent = `更新时间：${fmtTime(lastGoodData?.meta?.generatedAt)} · 正在等待稳定快照`;
      return;
    }
    lastGoodData = data;
    applyDashboard(data);
  } catch (error) {
    if (lastGoodData) {
      el.generatedAt.textContent = `更新时间：${fmtTime(lastGoodData?.meta?.generatedAt)} · 拉取暂时失败，正在显示最近一次缓存快照`;
      refreshHeartbeat();
      return;
    }
    lastGeneratedAt = "";
    el.generatedAt.textContent = "更新时间：加载失败";
    el.heartbeat.textContent = "实时心跳：加载失败";
    el.heroSub.textContent = "暂时无法加载 Dashboard 快照。";
    renderEmpty(el.summary, "等待数据中");
    renderEmpty(el.agents, "等待数据中");
    renderEmpty(el.graph, "等待数据中");
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
