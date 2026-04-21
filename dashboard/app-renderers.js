import {
  esc,
  fmtCompactNumber,
  fmtTime,
  getStatusText,
  renderEmpty
} from "./app-utils.js?v=dashboard-live-20260422-4";
import {
  buildTaskCards,
  buildTaskChain,
  buildTaskChainFacts,
  deriveTaskSummary,
  getEffectiveStatus,
} from "./app-task-core.js?v=dashboard-live-20260422-4";
import {
  buildSupervisorFacts,
  buildWorkTreeRows,
  getSupervisorSummary,
  needsTextToggle
} from "./app-timeline-models.js?v=dashboard-live-20260422-4";
import {
  buildGraphModel,
  formatGraphNodeTitle,
  getAgentStateTone
} from "./app-graph-models.js?v=dashboard-live-20260422-4";

export function renderHero(el, data) {
  const agents = Array.isArray(data.agentRoster) ? data.agentRoster : [];
  const count = agents.length;
  const activeLinks = Array.isArray(data.recentDispatches) ? data.recentDispatches.length : 0;
  el.heroSub.textContent = `由 OpenClaw 驱动，当前已配置 ${count} 个 Agent，并展示最近 ${activeLinks} 条协作链路。`;
}

export function renderSummary(el, data) {
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
          </g>
        `;
      }).join("")}
      ${edges.map((edge) => {
        const midY = Math.round((edge.from.y + edge.to.y) / 2);
        return `
          <g class="graph-edge ${edge.active ? "active" : ""}">
            <path d="M${edge.from.x},${edge.from.y + 38} C${edge.from.x},${midY} ${edge.to.x},${midY} ${edge.to.x},${edge.to.y - 38}" marker-end="url(#arrow)"></path>
          </g>
        `;
      }).join("")}
      ${nodes.map(({ agent, pos }) => `
        <g class="graph-node ${agent.state === "busy" ? "busy" : "idle"}">
          <rect x="${pos.x - 74}" y="${pos.y - 34}" rx="18" ry="18" width="148" height="68"></rect>
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
