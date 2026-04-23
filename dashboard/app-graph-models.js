import { getAgentDisplayName } from "./app-task-core.js?v=dashboard-live-20260422-4";

export function getAgentStateTone(agent) {
  if (agent.blockedRuns > 0) return "risk";
  return agent.state === "busy" ? "busy" : "idle";
}

function isRecentDispatchActive(entry, nowMs = Date.now()) {
  const timestamp = new Date(entry?.timestamp || "").getTime();
  if (!Number.isFinite(timestamp)) return false;
  return nowMs - timestamp < 15 * 60 * 1000;
}

export function getOrgOrder(agent) {
  return Number(agent?.orderIndex ?? 999);
}

export function deriveOrgHierarchy(agents) {
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

export function buildGraphModel(data) {
  const agents = Array.isArray(data.agentRoster) ? data.agentRoster : [];
  const agentById = new Map(agents.map((agent) => [agent.agentId, agent]));
  const dispatches = Array.isArray(data.recentDispatches) ? data.recentDispatches : [];
  const nowMs = Date.now();
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
  const dispatchByPair = new Map();
  for (const entry of dispatches) {
    const from = entry.agentId;
    const to = entry.target?.agentId;
    if (!from || !to || !positions.has(from) || !positions.has(to)) continue;
    const key = `${from}->${to}`;
    const previous = dispatchByPair.get(key);
    if (!previous || String(entry.timestamp || "") > String(previous.timestamp || "")) {
      dispatchByPair.set(key, {
        from,
        to,
        timestamp: entry.timestamp,
        status: entry.status,
        routeType: entry.target?.routeType || ""
      });
    }
  }
  const edges = agents
    .filter((agent) => parentById.has(agent.agentId))
    .map((agent) => {
      const dispatch = dispatchByPair.get(`${parentById.get(agent.agentId)}->${agent.agentId}`) || null;
      const recentDispatch = dispatch && isRecentDispatchActive(dispatch, nowMs) ? dispatch : null;
      const childAgent = agentById.get(agent.agentId);
      return {
        from: parentById.get(agent.agentId),
        to: agent.agentId,
        kind: "org",
        dispatch: recentDispatch,
        active: Boolean(recentDispatch || childAgent?.state === "busy")
      };
    })
    .filter((edge) => edge.from && edge.to);
  return { width, height, positions, edges, topAgent: root };
}

export function formatGraphNodeTitle(agent) {
  return `${agent.emoji || ""} ${agent.displayName || agent.agentId}`.trim();
}

export { getAgentDisplayName };
