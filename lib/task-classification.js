import { MAX_LABEL_LENGTH } from "./contracts.js";
import {
  resolveAgentIdentity,
  resolveAllowedExecutorAgents,
  resolveConfiguredCodeExecutorAgentIds,
  resolveCoordinatorAgentId
} from "./config-resolvers.js";
import {
  normalizeString,
  sanitizeTaskPrompt,
  tokenizeText
} from "./text-helpers.js";

function looksLikeMarketResearchTask(prompt) {
  const text = sanitizeTaskPrompt(prompt).toLowerCase();
  if (!text) return false;
  return /(\ba股\b|\b港股\b|\b美股\b|股市|大盘|走势|行情|指数|板块|投资|研判|宏观|策略|仓位|资产|基金|债券|期货|外汇|黄金|原油|加密|比特币|etf|财报|cpi|非农|联储|伊朗|美国|地缘|news|market|macro|stocks?|equity|fed|inflation|oil|gold)/i.test(text);
}

function looksLikeDeliveryManagementTask(prompt) {
  const text = sanitizeTaskPrompt(prompt).toLowerCase();
  if (!text) return false;
  return /(进展|汇报|排期|推进|协调|督办|负责人|里程碑|验收|跟进|同步|风险|管理|安排|项目状态|project|timeline|owner|delivery)/i.test(text);
}

function requiresMultiPartyEvidence(prompt) {
  const text = sanitizeTaskPrompt(prompt).toLowerCase();
  if (!text) return false;
  const participantSignal = /(每个人|每位|各自|逐个|分别|大家|所有人|全员|一人一条|每个agent|每个 agent|everyone|every agent|each agent|each member|all agents|all teammates|individually|separately)/i.test(text);
  const reportingSignal = /(汇报|同步|反馈|回复|说明|职责|分工|状态|进展|当前在做|report|reply|respond|share|status|role|responsibilit|ownership|update)/i.test(text);
  return participantSignal && reportingSignal;
}

function isEngineeringPrompt(prompt, pluginConfig) {
  const text = sanitizeTaskPrompt(prompt).toLowerCase();
  if (!text) return false;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;

  const trivialPatterns = [
    /^(hi|hello|hey|thanks|thank you|ok|okay|sure|got it|收到|好的|好|行|嗯|哦|谢谢)[!. ]*$/i,
    /^(heartbeat_ok|no_reply)$/i
  ];
  if (trivialPatterns.some((pattern) => pattern.test(normalized))) return false;

  const taskKeywords = Array.isArray(pluginConfig?.taskKeywords)
    ? pluginConfig.taskKeywords.map((value) => normalizeString(value).toLowerCase()).filter(Boolean)
    : [];
  if (taskKeywords.some((keyword) => normalized.includes(keyword))) return true;

  const actionablePatterns = [
    /\b(check|look|find|search|investigate|analyze|analyse|compare|summarize|report|review|fix|implement|continue|track|verify|prepare|draft|research|plan|deliver)\b/i,
    /(查一下|看一下|看下|帮我|继续|跟进|汇总|分析|判断|研究|整理|排查|修复|实现|准备|追踪|比较|总结|汇报|核实|确认|推进|处理)/i
  ];
  if (actionablePatterns.some((pattern) => pattern.test(normalized))) return true;

  const executionPatterns = [
    /\b(e2e|acceptance|execute|execution|actually execute|write(?:\s+to)?\s+\/|file content|confirm file|verify file|real task|real run)\b/i,
    /(真实|实测|验收|实际执行|写入文本|写文件|落文件|文件内容|确认文件|核对文件|e2e|端到端)/i
  ];
  if (executionPatterns.some((pattern) => pattern.test(normalized))) return true;

  const tokenCount = tokenizeText(normalized).length;
  if (tokenCount >= 4) return true;
  if (normalized.length >= 12) return true;
  return false;
}

function inferExecutorCandidates(cfg, currentAgentId, prompt, pluginConfig = null) {
  const taskPrompt = sanitizeTaskPrompt(prompt);
  const promptTokens = new Set(tokenizeText(taskPrompt));
  const engineeringTask = isEngineeringPrompt(taskPrompt, {});
  const codeExecutionTask = /(code|coding|developer|development|engineer|engineering|bug|fix|repo|execute|execution|e2e|acceptance|write file|file content|开发|代码|工程|修复|执行|验收|写文件|文件内容|写入文本)/i.test(taskPrompt);
  const marketResearchTask = looksLikeMarketResearchTask(taskPrompt);
  const deliveryManagementTask = looksLikeDeliveryManagementTask(taskPrompt);
  const configuredCodeExecutors = new Set(resolveConfiguredCodeExecutorAgentIds(cfg, currentAgentId, pluginConfig));
  return resolveAllowedExecutorAgents(cfg, currentAgentId)
    .map((agentId) => {
      const identity = resolveAgentIdentity(cfg, agentId);
      const identityText = [identity.name, identity.theme, identity.toolProfile].filter(Boolean).join(" ");
      const identityTokens = new Set(tokenizeText([agentId, identityText].filter(Boolean).join(" ")));
      let score = 0;
      for (const token of promptTokens) {
        if (identityTokens.has(token)) score += 4;
      }
      if ((identity.toolProfile === "coding" || identity.toolProfile === "full") && codeExecutionTask) score += 3;
      if (configuredCodeExecutors.has(agentId) && codeExecutionTask) score += 100;
      if (configuredCodeExecutors.has(agentId) && engineeringTask && !deliveryManagementTask) score += 40;
      if (/(code|coding|developer|development|engineer|engineering|bug|fix|repo|开发|代码|工程|修复)/i.test(identityText) && codeExecutionTask) score += 5;
      if (/(research|analyst|analysis|macro|market|trading|finance|investment|investing|投资|研究|行情|宏观|策略|资产)/i.test(identityText) && marketResearchTask) score += 8;
      if (/(manager|management|project|delivery|coordination|operations|督办|项目|协调|推进|管理|交付)/i.test(identityText) && deliveryManagementTask) score += 7;
      return { agentId, identity, score };
    })
    .sort((a, b) => b.score - a.score || a.agentId.localeCompare(b.agentId));
}

function slugifyLabel(value) {
  const normalized = normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized.slice(0, MAX_LABEL_LENGTH) || "task";
}

function buildSpawnSuggestion(cfg, currentAgentId, prompt, pluginConfig = null) {
  const task = sanitizeTaskPrompt(prompt) || "Handle the requested task.";
  const shortPrompt = tokenizeText(task).length <= 2 && task.length <= 12;
  const roleSignal =
    looksLikeMarketResearchTask(task) ||
    looksLikeDeliveryManagementTask(task) ||
    /(code|coding|dev|engineer|bug|fix|repo|开发|代码|工程|修复)/i.test(task);
  if (shortPrompt && !roleSignal) return null;
  const [topCandidate] = inferExecutorCandidates(cfg, currentAgentId, prompt, pluginConfig);
  if (!topCandidate || Number(topCandidate.score || 0) < 4) return null;
  return {
    agentId: topCandidate.agentId,
    label: slugifyLabel(task),
    task,
    theme: topCandidate.identity.theme,
    name: topCandidate.identity.name
  };
}

function classifyOrchestrationMode(cfg, currentAgentId, prompt, pluginConfig = null) {
  const task = sanitizeTaskPrompt(prompt);
  if (!task) return "solo";
  if (/heartbeat_ok|read heartbeat\.md|nothing needs attention/i.test(task)) return "solo";
  if (requiresMultiPartyEvidence(task)) return "multi_party_required";
  const coordinatorAgentId = resolveCoordinatorAgentId(cfg, pluginConfig);
  const spawn = buildSpawnSuggestion(cfg, currentAgentId, task, pluginConfig);
  const explicitExecutionSignal = /(code|coding|developer|development|engineer|engineering|bug|fix|repo|build|test run|execute|execution|e2e|acceptance|write file|file content|开发|代码|工程|修复|构建|测试|执行|实测|验收|写文件|文件内容|写入文本)/i.test(task);
  const explicitDelegationSignal = /(sub[\s-]?agent|child agent|delegate|delegation|spawn|让.+agent|让合适的子 agent|子 agent|子agent|委派|协同)/i.test(task);
  if (
    spawn?.agentId &&
    spawn.agentId !== currentAgentId &&
    (explicitExecutionSignal || explicitDelegationSignal) &&
    (!coordinatorAgentId || currentAgentId === coordinatorAgentId)
  ) {
    return "delegate_once";
  }
  return "solo";
}

function buildOrchestrationPlan(cfg, currentAgentId, prompt, pluginConfig = null) {
  const mode = classifyOrchestrationMode(cfg, currentAgentId, prompt, pluginConfig);
  const task = sanitizeTaskPrompt(prompt);
  const allowedPeers = resolveAllowedExecutorAgents(cfg, currentAgentId);
  const spawn = buildSpawnSuggestion(cfg, currentAgentId, task, pluginConfig);
  const targetAgentIds =
    mode === "multi_party_required"
      ? allowedPeers.slice(0, 4)
      : (spawn?.agentId ? [spawn.agentId] : []);
  const requiredEvidenceCount =
    mode === "multi_party_required"
      ? Math.max(2, Math.min(targetAgentIds.length || 2, 4))
      : mode === "delegate_once"
        ? 1
        : 0;
  const routeHint =
    mode === "multi_party_required"
      ? "先检查可复用 teammate session，再至少发起多路真实协同。"
      : mode === "delegate_once"
        ? "先检查可复用 teammate session，再至少完成一次真实委派。"
        : "主控可自主完成；如出现明确分工需求再转协同。";
  const finishCondition =
    mode === "multi_party_required"
      ? `至少保留 ${requiredEvidenceCount} 份独立 teammate evidence 后才能完成。`
      : mode === "delegate_once"
        ? "至少保留 1 份 child evidence 后才能完成。"
        : "主控完成内部检查或直接给出最终答复即可完成。";
  const summary =
    mode === "multi_party_required"
      ? `链路规划：多方协同，目标 ${targetAgentIds.join(", ") || "待路由"}；${finishCondition}`
      : mode === "delegate_once"
        ? `链路规划：单次委派，目标 ${targetAgentIds[0] || "待路由"}；${finishCondition}`
        : `链路规划：自主完成；${finishCondition}`;
  return {
    mode,
    targetAgentIds,
    requiredEvidenceCount,
    routeHint,
    finishCondition,
    summary
  };
}

function classifyMissionEntryMode(cfg, currentAgentId, prompt, pluginConfig = null) {
  const task = sanitizeTaskPrompt(prompt);
  if (!task) return "plain";
  if (/heartbeat_ok|read heartbeat\.md|nothing needs attention/i.test(task)) return "plain";
  if (!isEngineeringPrompt(task, pluginConfig)) return "plain";
  const mode = classifyOrchestrationMode(cfg, currentAgentId, task, pluginConfig);
  if (mode === "delegate_once" || mode === "multi_party_required") return "mission-flow";
  if (/(任务状态|当前任务|安排|汇报|同步|跟进|负责人|排期|里程碑|验收|全员|每个人|职责|分工|project status|assignment|delivery)/i.test(task)) return "mission-flow";
  return "mission-lite";
}

function buildChainAssessment(state) {
  const entryMode = normalizeString(state?.entryMode);
  const mode = normalizeString(state?.orchestrationMode);
  const targets = Array.isArray(state?.orchestrationPlan?.targetAgentIds) ? state.orchestrationPlan.targetAgentIds.filter(Boolean) : [];
  const routeHint = normalizeString(state?.orchestrationPlan?.routeHint);
  const finishCondition = normalizeString(state?.orchestrationPlan?.finishCondition);
  const evidenceCount = Number(state?.durable?.receivedEvidenceCount || 0);
  if (entryMode === "plain") {
    return {
      code: "plain-bypass",
      summary: "简单任务，已绕过 mission-deck 编排。",
      missing: "",
      nextAction: "主控可直接处理。",
      correct: true
    };
  }
  if (mode === "solo") {
    return {
      code: "solo-correct",
      summary: normalizeString(state?.parentRunId)
        ? "这是执行子任务，当前链路应直接执行并回报父任务。"
        : "这是单人处理链路，不需要额外协同。",
      missing: "",
      nextAction: finishCondition || "继续本地执行。",
      correct: true
    };
  }
  if (!state?.internalCoordinationSeen && !state?.executionLaneSeen) {
    return {
      code: "needs-routing",
      summary: `当前链路还没进入真实协同，目标应先路由到 ${targets.join(", ") || "合适执行者"}。`,
      missing: "缺少首次路由动作",
      nextAction: routeHint || "先 sessions_list / agents_list，再 sessions_send 或 sessions_spawn。",
      correct: false
    };
  }
  if (mode === "delegate_once" && evidenceCount < 1) {
    return {
      code: "awaiting-evidence",
      summary: "已进入委派链路，但还没有首次真实协同证据。",
      missing: "缺少 child evidence",
      nextAction: "等待或获取子任务回执后再汇总。",
      correct: false
    };
  }
  if (mode === "multi_party_required" && evidenceCount < Math.max(2, Number(state?.orchestrationPlan?.requiredEvidenceCount || 0) || 2)) {
    return {
      code: "partial-collaboration",
      summary: "多方协同已开始，但独立证据仍不足。",
      missing: "缺少足量 teammate evidence",
      nextAction: "继续补齐多方反馈，再统一汇总。",
      correct: false
    };
  }
  return {
    code: "correct",
    summary: "当前任务链路方向正确，正在按计划推进。",
    missing: "",
    nextAction: normalizeString(state?.flowCurrentStep) || finishCondition || "继续推进当前步骤。",
    correct: true
  };
}

export {
  buildChainAssessment,
  buildOrchestrationPlan,
  buildSpawnSuggestion,
  classifyMissionEntryMode,
  classifyOrchestrationMode,
  isEngineeringPrompt,
  looksLikeDeliveryManagementTask,
  looksLikeMarketResearchTask,
  requiresMultiPartyEvidence
};
