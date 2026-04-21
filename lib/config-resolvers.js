import { hasNonEmptyString, normalizeString } from "./text-helpers.js";

function getAgentEntries(cfg) {
  const list = cfg?.agents?.list;
  if (Array.isArray(list)) {
    return list
      .filter((entry) => entry && typeof entry === "object" && hasNonEmptyString(entry.id))
      .map((entry) => ({ id: entry.id.trim(), config: entry }));
  }
  if (list && typeof list === "object") {
    return Object.entries(list)
      .filter(([id, entry]) => hasNonEmptyString(id) && entry && typeof entry === "object")
      .map(([id, entry]) => ({ id: id.trim(), config: entry }));
  }
  return [];
}

function resolveAgentConfig(cfg, agentId) {
  return getAgentEntries(cfg).find((entry) => entry.id === agentId)?.config;
}

function listConfiguredAgentIds(cfg) {
  return getAgentEntries(cfg).map((entry) => entry.id);
}

function resolvePeerAgents(cfg, currentAgentId) {
  return listConfiguredAgentIds(cfg).filter((agentId) => agentId !== currentAgentId);
}

function resolveDelegationAllowAgents(cfg, currentAgentId) {
  const currentAgentConfig = resolveAgentConfig(cfg, currentAgentId);
  const explicitAgentAllow = Array.isArray(currentAgentConfig?.subagents?.allowAgents)
    ? currentAgentConfig.subagents.allowAgents
    : null;
  const defaultAllow = Array.isArray(cfg?.agents?.defaults?.subagents?.allowAgents)
    ? cfg.agents.defaults.subagents.allowAgents
    : null;
  const source = explicitAgentAllow ?? defaultAllow;
  if (!Array.isArray(source)) return [];
  return source.map((value) => normalizeString(value)).filter(Boolean);
}

function resolveA2APolicy(cfg) {
  const policy = cfg?.tools?.agentToAgent;
  const enabled = policy?.enabled === true;
  const allowed = Array.isArray(policy?.allow)
    ? new Set(policy.allow.map((value) => normalizeString(value)).filter(Boolean))
    : null;
  return { enabled, allowed };
}

function resolveAllowedExecutorAgents(cfg, currentAgentId) {
  const peers = resolvePeerAgents(cfg, currentAgentId);
  const resolvedAllowAgents = resolveDelegationAllowAgents(cfg, currentAgentId);
  const allowAgents = resolvedAllowAgents.length ? new Set(resolvedAllowAgents) : null;
  const a2a = resolveA2APolicy(cfg);
  return peers.filter((agentId) => {
    if (allowAgents && !allowAgents.has(agentId)) return false;
    if (a2a.enabled && a2a.allowed && !a2a.allowed.has(agentId)) return false;
    return true;
  });
}

function resolveWorkspaceDir(cfg, agentId) {
  const agentConfig = resolveAgentConfig(cfg, agentId);
  return normalizeString(agentConfig?.workspace) || normalizeString(cfg?.agents?.defaults?.workspace);
}

function resolveAgentIdentity(cfg, agentId) {
  const agentConfig = resolveAgentConfig(cfg, agentId);
  const identity = agentConfig?.identity ?? {};
  return {
    name: normalizeString(identity?.name),
    theme: normalizeString(identity?.theme),
    toolProfile: normalizeString(agentConfig?.tools?.profile)
  };
}

function resolveCoordinatorAgentId(cfg, pluginConfig = null) {
  const configuredCoordinator = normalizeString(
    pluginConfig?.coordinatorAgentId ??
    cfg?.plugins?.entries?.["mission-deck"]?.config?.coordinatorAgentId
  );
  if (configuredCoordinator) return configuredCoordinator;
  const defaultAgent = getAgentEntries(cfg).find((entry) => entry?.config?.default === true)?.id;
  return normalizeString(defaultAgent);
}

function resolveConfiguredCodeExecutorAgentIds(cfg, currentAgentId, pluginConfig = null) {
  const configured = Array.isArray(
    pluginConfig?.codeExecutorAgentIds ??
    cfg?.plugins?.entries?.["mission-deck"]?.config?.codeExecutorAgentIds
  )
    ? (pluginConfig?.codeExecutorAgentIds ??
      cfg?.plugins?.entries?.["mission-deck"]?.config?.codeExecutorAgentIds)
    : [];
  const allowed = new Set(resolveAllowedExecutorAgents(cfg, currentAgentId));
  return configured
    .map((value) => normalizeString(value))
    .filter((agentId) => agentId && allowed.has(agentId));
}

function pluginLikeWorkspaceRoots(cfg, pluginConfig) {
  return pluginConfig?.agentWorkspaceRoots ?? cfg?.plugins?.entries?.["mission-deck"]?.config?.agentWorkspaceRoots ?? null;
}

function resolveWorkspaceRoots(cfg, currentAgentId, pluginConfig = null) {
  const roots = new Set();
  const explicitRoots = pluginLikeWorkspaceRoots(cfg, pluginConfig);
  if (explicitRoots && typeof explicitRoots === "object") {
    for (const [agentId, root] of Object.entries(explicitRoots)) {
      if (!hasNonEmptyString(agentId)) continue;
      if (agentId === currentAgentId || resolvePeerAgents(cfg, currentAgentId).includes(agentId)) {
        const normalizedRoot = normalizeString(root);
        if (normalizedRoot) roots.add(normalizedRoot);
      }
    }
  }
  const currentWorkspace = resolveWorkspaceDir(cfg, currentAgentId);
  if (currentWorkspace) roots.add(currentWorkspace);
  for (const peerId of resolvePeerAgents(cfg, currentAgentId)) {
    const peerWorkspace = resolveWorkspaceDir(cfg, peerId);
    if (peerWorkspace) roots.add(peerWorkspace);
  }
  return Array.from(roots);
}

function resolveEnabledAgents(cfg, pluginConfig) {
  const configured = Array.isArray(pluginConfig?.enabledAgents)
    ? pluginConfig.enabledAgents.map((value) => normalizeString(value)).filter(Boolean)
    : [];
  if (configured.length > 0) return new Set(configured);
  return new Set(listConfiguredAgentIds(cfg));
}

function canDelegateToOtherAgents(cfg, currentAgentId) {
  const allowAgents = resolveDelegationAllowAgents(cfg, currentAgentId);
  if (!allowAgents.length) return false;
  return resolveAllowedExecutorAgents(cfg, currentAgentId).length > 0;
}

export {
  canDelegateToOtherAgents,
  getAgentEntries,
  listConfiguredAgentIds,
  pluginLikeWorkspaceRoots,
  resolveA2APolicy,
  resolveAgentConfig,
  resolveAgentIdentity,
  resolveAllowedExecutorAgents,
  resolveConfiguredCodeExecutorAgentIds,
  resolveCoordinatorAgentId,
  resolveDelegationAllowAgents,
  resolveEnabledAgents,
  resolvePeerAgents,
  resolveWorkspaceDir,
  resolveWorkspaceRoots
};
