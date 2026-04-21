import { resolveA2APolicy, resolveAllowedExecutorAgents, resolveCoordinatorAgentId, resolveWorkspaceRoots } from "./config-resolvers.js";
import { normalizeString } from "./text-helpers.js";
import { buildSpawnSuggestion } from "./task-classification.js";

function buildCoordinationGuidance({ agentId, cfg, pluginConfig, prompt, entryMode = "", orchestrationPlan = null }) {
  const workspaceRoots = resolveWorkspaceRoots(cfg, agentId, pluginConfig);
  const peers = resolveAllowedExecutorAgents(cfg, agentId);
  const a2a = resolveA2APolicy(cfg);
  const coordinatorAgentId = resolveCoordinatorAgentId(cfg, pluginConfig);
  const lines = [
    "You are running under the Team Orchestrator plugin.",
    "Treat hooks as event adapters and TaskFlow as the durable source of truth.",
    "Normalize the request, choose the correct route, and keep final completion gated by evidence.",
    "sessions_send only targets an existing session and requires sessionKey or label.",
    "Use sessions_send to continue a visible reusable teammate session.",
    "Use sessions_spawn only when you intentionally need a new isolated work lane."
  ];
  if (entryMode) lines.push(`Entry mode for this run: ${entryMode}.`);
  if (orchestrationPlan?.summary) lines.push(`Orchestration plan: ${normalizeString(orchestrationPlan.summary)}`);
  if (orchestrationPlan?.routeHint) lines.push(`Route hint: ${normalizeString(orchestrationPlan.routeHint)}`);
  if (orchestrationPlan?.finishCondition) lines.push(`Finish condition: ${normalizeString(orchestrationPlan.finishCondition)}`);
  if (peers.length > 0) lines.push(`Configured peer agents: ${peers.join(", ")}.`);
  if (coordinatorAgentId) lines.push(`Configured coordinator for root orchestration: ${coordinatorAgentId}.`);
  if (workspaceRoots.length > 0) lines.push(`Known team workspaces from config: ${workspaceRoots.join(", ")}.`);
  if (a2a.enabled) lines.push("Agent-to-agent messaging is enabled.");
  const spawnSuggestion = buildSpawnSuggestion(cfg, agentId, prompt, pluginConfig);
  if (spawnSuggestion) {
    lines.push(
      `Recommended internal executor for this task: ${spawnSuggestion.agentId}.`,
      `Preferred sessions_spawn payload: ${JSON.stringify({ agentId: spawnSuggestion.agentId, label: spawnSuggestion.label, task: spawnSuggestion.task })}`
    );
  }
  return lines.join("\n");
}

function buildExecutionMandate(cfg, agentId, prompt, flowId, pluginConfig = null, options = {}) {
  const spawn = buildSpawnSuggestion(cfg, agentId, prompt, pluginConfig);
  const lines = [
    "Execution mandate for this run:",
    "1. Perform an internal action immediately.",
    "2. Keep coordination traceable through TaskFlow and structured child evidence.",
    "3. Do not treat an assistant summary as completion unless evidence and finalize conditions are satisfied."
  ];
  if (options?.entryMode) lines.push(`Run mode: ${normalizeString(options.entryMode)}.`);
  if (flowId) lines.push(`Current TaskFlow flowId=${flowId}.`);
  if (options?.orchestrationPlan?.finishCondition) {
    lines.push(`Finish condition: ${normalizeString(options.orchestrationPlan.finishCondition)}`);
  }
  if (spawn) {
    lines.push(`Default executor for this task: ${spawn.agentId}.`);
  }
  return lines.join("\n");
}

export {
  buildCoordinationGuidance,
  buildExecutionMandate
};
