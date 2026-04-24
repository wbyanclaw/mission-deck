import {
  esc,
  fmtCompactNumber,
  fmtTime,
  getStatusText,
  renderEmpty
} from "./app-utils.js?v=dashboard-live-20260424202409-g32df9";
import {
  buildTaskCards,
  buildTaskChain,
  deriveTaskSummary,
  getAgentDisplayName,
  getCurrentOwner,
  getCurrentProgress,
  getEffectiveStatus,
  humanizeLatestDetail,
} from "./app-task-core.js?v=dashboard-live-20260424202409-g32df9";
import {
  buildGraphModel,
  formatGraphNodeTitle,
  getAgentStateTone
} from "./app-graph-models.js?v=dashboard-live-20260424202409-g32df9";

export function renderHero(el, data) {
  const agents = Array.isArray(data.agentRoster) ? data.agentRoster : [];
  const count = agents.length;
  const activeLinks = Array.isArray(data.recentDispatches) ? data.recentDispatches.length : 0;
  el.heroSub.textContent = `由 OpenClaw 驱动，当前已配置 ${count} 个 Agent，并展示最近 ${activeLinks} 条协作链路。`;
}

export function renderSummary(el, data) {
  const summary = data.summary || {};
  const tasks = buildTaskCards(data);
  const directSessions = Array.isArray(data.directSessions) ? data.directSessions : [];
  const blocked = tasks.filter((task) => getEffectiveStatus(task) === "blocked").length;
  const waiting = tasks.filter((task) => getEffectiveStatus(task) === "waiting").length;
  const delegated = tasks.filter((task) => (task.flowTaskSummary?.total || 0) > 0 || (task.childTaskIds || []).length > 0).length;
  const cards = [
    { title: "活跃任务", value: `${tasks.length}`, note: `${delegated} 项涉及多 Agent 协作` },
    { title: "直接会话", value: `${directSessions.length}`, note: "直接找 Agent 的任务，单独展示不混入 TaskFlow" },
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

export function renderAgents(el, data) {
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
          <div class="agent-pill ${esc(agent.state === "busy" ? "busy" : "idle")}">${esc(agent.state === "busy" ? "忙碌" : "空闲")}</div>
        </div>
        <div class="agent-metrics compact">
          <span>Tokens ${esc(fmtCompactNumber(agent.tokenProxy || 0))}</span>
        </div>
      </div>
    </article>
  `).join("");
}

export function renderGraph(el, data) {
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
    return { ...edge, from, to, active: Boolean(edge.active) };
  });
  el.graph.innerHTML = `
    <svg viewBox="0 0 ${model.width} ${model.height}" class="graph-svg" role="img" aria-label="OpenClaw 协作关系图">
      <defs>
        <marker id="arrow" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto">
          <path d="M0,0 L0,6 L8,3 z" class="graph-arrow" />
        </marker>
      </defs>
      ${edges.map((edge) => {
        const midY = Math.round((edge.from.y + edge.to.y) / 2);
        return `
          <g class="graph-edge ${edge.active ? "active" : ""}">
            <path d="M${edge.from.x},${edge.from.y + 38} C${edge.from.x},${midY} ${edge.to.x},${midY} ${edge.to.x},${edge.to.y - 38}" ${edge.active ? `marker-end="url(#arrow)"` : ""}></path>
          </g>
        `;
      }).join("")}
      ${nodes.map(({ agent, pos }) => `
        <g class="graph-node ${esc(agent.state === "busy" ? "busy" : "idle")}">
          <rect x="${pos.x - 74}" y="${pos.y - 34}" rx="18" ry="18" width="148" height="68"></rect>
          <circle class="graph-node-status" cx="${pos.x + 52}" cy="${pos.y - 16}" r="5"></circle>
          <text x="${pos.x}" y="${pos.y - 8}" class="node-title">${esc(formatGraphNodeTitle(agent))}</text>
          <text x="${pos.x}" y="${pos.y + 10}" class="node-role">${esc(agent.theme || agent.agentId)}</text>
        </g>
      `).join("")}
    </svg>
  `;
}

export function renderTimeline(el, uiState, data) {
  const tasks = buildTaskCards(data);
  el.taskCount.textContent = `${tasks.length} 项`;
  if (!tasks.length) return renderEmpty(el.timeline, "当前没有可展示的活跃 TaskFlow 任务。");

  el.timeline.innerHTML = tasks.map((run, index) => {
    const taskSummary = deriveTaskSummary(run);
    const status = getEffectiveStatus(run);
    const chain = buildTaskChain(run, data);
    const currentOwner = getAgentDisplayName(data, getCurrentOwner(run, data));
    const currentProgress = getCurrentProgress(run, data);
    const childEvidence = Array.isArray(run.childTasks) && run.childTasks.length > 0
      ? `${(run.childTasks || []).filter((task) => ["reported", "succeeded", "success", "completed", "done", "delivered", "failed", "blocked", "cancelled", "timed_out", "timeout"].includes(String(task?.phase || "").toLowerCase())).length}/${run.childTasks.length}`
      : "-";
    const compactFacts = [
      { label: "主控", value: getAgentDisplayName(data, run.agentId) },
      { label: "当前处理人", value: currentOwner },
      { label: "子任务证据", value: childEvidence }
    ];
    const detailHref = `./detail.html?type=task&flowId=${encodeURIComponent(String(run.flowId || ""))}`;
    return `
      <article class="task-card worktree-card" data-run-id="${esc(run.runId || "")}">
        <div class="task-head">
          <div>
            <div class="task-time">任务 ${index + 1} · ${esc(fmtTime(run.userAskedAt || run.startedAt || run.updatedAt))}</div>
            <h3>${esc(taskSummary)}</h3>
          </div>
          <div class="task-status ${esc(status)}">${esc(getStatusText(status))}</div>
        </div>
        <section class="task-chain">
          <div class="task-compact-grid">
            ${compactFacts.map((item) => `
              <div class="task-kpi">
                <div class="task-kpi-label">${esc(item.label)}</div>
                <div class="task-kpi-value">${esc(item.value || "-")}</div>
              </div>
            `).join("")}
          </div>
          <div class="task-current-progress">${esc(currentProgress || humanizeLatestDetail(run))}</div>
          <div class="chain-path">
            ${chain.map((node, chainIndex) => `
              ${chainIndex > 0 ? `<span class="chain-arrow">→</span>` : ""}
              <span class="chain-node">
                <span class="chain-node-title">${esc(node.title)}</span>
                ${node.note ? `<span class="chain-node-note">${esc(node.note)}</span>` : ""}
              </span>
            `).join("")}
          </div>
          <div class="task-link-row">
            <a class="detail-link" href="${esc(detailHref)}" target="_blank" rel="noopener noreferrer">查看完整链路</a>
          </div>
        </section>
      </article>
    `;
  }).join("");
}

export function renderDirectSessions(el, uiState, data) {
  const allSessions = Array.isArray(data.directSessions) ? data.directSessions : [];
  const sessions = allSessions.filter((run) => uiState.visibleSessionKinds.has(String(run.sessionKind || "").toLowerCase() || "direct"));
  el.directCount.textContent = `${sessions.length} / ${allSessions.length} 项`;
  if (!sessions.length) return renderEmpty(el.directSessions, "当前没有需要单独展示的直接会话。");

  const groups = new Map();
  for (const run of sessions) {
    const agentId = String(run.agentId || "unknown");
    const bucket = groups.get(agentId) || [];
    bucket.push(run);
    groups.set(agentId, bucket);
  }
  const roster = Array.isArray(data.agentRoster) ? data.agentRoster : [];
  const order = (agentId) => {
    const match = roster.find((item) => item.agentId === agentId);
    return Number(match?.orderIndex ?? 9999);
  };
  const label = (agentId) => {
    const match = roster.find((item) => item.agentId === agentId);
    return match?.displayName || agentId;
  };
  const directTitle = (run) => {
    if (run.sessionTitle) return run.sessionTitle;
    const latestUserTurn = [...(Array.isArray(run.timelineEvents) ? run.timelineEvents : [])]
      .filter((item) => item?.role === "用户发起" || item?.role === "用户追问")
      .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))[0];
    if (latestUserTurn?.text) return deriveTaskSummary({ promptText: latestUserTurn.text });
    return deriveTaskSummary(run);
  };
  const kindLabel = (run) => {
    const kind = String(run.sessionKind || "").toLowerCase();
    if (kind === "heartbeat") return "心跳";
    if (kind === "cron") return "定时";
    if (kind === "system") return "系统";
    if (kind === "empty") return "回执";
    return "直聊";
  };
  el.directSessions.innerHTML = Array.from(groups.entries())
    .sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))
    .map(([agentId, runs]) => `
      <article class="task-card direct-agent-card">
        <div class="task-head">
          <div>
            <div class="task-time">会话状态</div>
            <h3>${esc(label(agentId))}</h3>
          </div>
          <div class="direct-group-count">${esc(String(runs.length))} 个 session</div>
        </div>
        <div class="direct-session-list">
          ${runs
            .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
            .map((run) => {
              const status = getEffectiveStatus(run);
              const summaryLine = directTitle(run);
              const detailHref = `./detail.html?type=session&sessionKey=${encodeURIComponent(String(run.sessionKey || ""))}`;
              return `
                <article class="direct-session-block">
                  <div class="direct-session-head">
                    <div class="direct-session-main">
                      <div class="direct-session-summary-line">${esc(summaryLine)}</div>
                      <div class="direct-meta">${esc(fmtTime(run.userAskedAt || run.startedAt || run.updatedAt))}</div>
                    </div>
                    <div class="direct-session-side">
                      <span class="session-kind">${esc(kindLabel(run))}</span>
                      <span class="task-status ${esc(status)}">${esc(getStatusText(status))}</span>
                      <a class="detail-link" href="${esc(detailHref)}" target="_blank" rel="noopener noreferrer">查看完整链路</a>
                    </div>
                  </div>
                </article>
              `;
            }).join("")}
        </div>
      </article>
    `).join("");
}
