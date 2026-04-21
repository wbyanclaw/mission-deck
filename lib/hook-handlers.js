import {
  EXECUTION_LANE_TOOL_NAMES,
  FLOW_STATES,
  INTERNAL_COORDINATION_TOOL_NAMES,
  MESSAGE_TOOL_NAME,
  SESSIONS_SEND_TOOL_NAME,
  appendTimelineEvent,
  buildCanonicalEvent,
  buildChainAssessment,
  buildCoordinationGuidance,
  buildExecutionMandate,
  buildOrchestrationPlan,
  buildSpawnSuggestion,
  buildSupervisorIntervention,
  canDelegateToOtherAgents,
  classifyMissionEntryMode,
  classifyOrchestrationMode,
  getMessageText,
  getRuntimeTaskFlow,
  hasAnyInternalExecutionStep,
  hasNonEmptyString,
  isEngineeringPrompt,
  isoNow,
  looksLikeEntrypointEscalation,
  looksLikeExplicitIsolationNeed,
  looksLikeWorkspaceDiscoveryTool,
  normalizeString,
  resolveWorkspaceRoots,
  sanitizeTaskPrompt,
  setRunTelemetry,
  shouldForceSpawnInsteadOfSend
} from "./orchestrator-helpers.js";
import { buildHostPrereqMessage } from "./runtime-registry.js";

function isPlanningSafeRead(toolName, params, workspaceRoots) {
  if (normalizeString(toolName).toLowerCase() !== "read") return false;
  const path = normalizeString(params?.path);
  if (!path) return false;
  const lowerPath = path.toLowerCase();
  if (workspaceRoots.some((root) => lowerPath.includes(normalizeString(root).toLowerCase()))) {
    return false;
  }
  return (
    lowerPath.includes("/lib/node_modules/openclaw/skills/") ||
    lowerPath.includes("/lib/node_modules/openclaw/dist/") ||
    lowerPath.includes("/.openclaw/extensions/mission-deck/") ||
    lowerPath.includes("/.openclaw/workspace-coder/mission-deck/")
  );
}

function isPlanningSafeTool(toolName, params, workspaceRoots) {
  const normalizedToolName = normalizeString(toolName).toLowerCase();
  if (normalizedToolName === "update_plan") return true;
  return isPlanningSafeRead(toolName, params, workspaceRoots);
}

function updateRunMetadata({ state, agentId, event, ctx, canonicalEvent, parentLink, apiConfig, pluginConfig, isSpawnedExecutionRun }) {
  state.agentId = agentId;
  state.ownerAgentId = agentId;
  state.sessionKey = normalizeString(ctx?.sessionKey);
  state.promptText = normalizeString(event?.prompt);
  state.normalizedPromptText = sanitizeTaskPrompt(event?.prompt);
  state.engineeringTask = isEngineeringPrompt(event?.prompt, pluginConfig);
  state.entryMode = classifyMissionEntryMode(apiConfig, agentId, event?.prompt, pluginConfig);
  state.orchestrationPlan = buildOrchestrationPlan(apiConfig, agentId, event?.prompt, pluginConfig);
  state.orchestrationMode = normalizeString(state.orchestrationPlan?.mode) || classifyOrchestrationMode(apiConfig, agentId, event?.prompt, pluginConfig);
  state.normalizedEvent = canonicalEvent;
  if (parentLink) {
    state.parentRunId = normalizeString(parentLink.parentRunId);
    state.parentFlowId = normalizeString(parentLink.parentFlowId);
    state.parentTaskId = normalizeString(parentLink.childTaskId);
    state.parentSessionKey = normalizeString(parentLink.parentSessionKey);
    state.parentAgentId = normalizeString(parentLink.parentAgentId);
  }
  if (isSpawnedExecutionRun(state, ctx) && state.orchestrationMode !== "multi_party_required") {
    state.entryMode = state.engineeringTask ? "mission-lite" : "plain";
    state.orchestrationMode = "solo";
    state.orchestrationPlan = {
      mode: "solo",
      targetAgentIds: [],
      requiredEvidenceCount: 0,
      routeHint: "这是已派发的执行子任务，先直接完成并回报父任务。",
      finishCondition: "完成本地执行或明确报告阻塞后即可回传父任务。",
      summary: "链路规划：执行子任务，自主完成并回报父任务。"
    };
  }
  state.chainAssessment = buildChainAssessment(state);
  state.suggestedSpawn = buildSpawnSuggestion(apiConfig, agentId, event?.prompt, pluginConfig);
}

function runBackground(api, promise, label) {
  Promise.resolve(promise).catch((error) => {
    api.logger.warn?.(`[mission-deck] ${label} failed: ${error?.message || error}`);
  });
}

async function flushRun(touchRun, dashboard, runId, agentId, state) {
  touchRun(runId, agentId, state);
  await dashboard.flush();
}

export function createHookHandlers(deps) {
  const {
    api,
    pluginConfig,
    dashboard,
    runtimeRuns,
    enabledAgents,
    coordinatorAgentId,
    supervisorConfig,
    supervisorAgentId,
    supervisorIntervalMs,
    interventionIdleMinutes,
    supervisorMaxConcurrent,
    missingHostPrereqs,
    getRun,
    findContinuableRootRun,
    rebindRunState,
    getBestEffortParentLink,
    isSyntheticAnnounceRun,
    touchRun,
    countEvidence,
    buildCollaborationRequirementReason,
    lacksRequiredCollaborationEvidence,
    isSpawnedExecutionRun,
    syncFlowSnapshot,
    transitionFlow,
    ensureFlowBound
  } = deps;

  let supervisorTimer = null;

  async function runSupervisorSweep(nowMs = Date.now()) {
    if (supervisorConfig?.enabled !== true) return;
    if (!supervisorAgentId || !enabledAgents.includes(supervisorAgentId)) return;
    const activeSupervisions = Array.from(runtimeRuns.values()).filter((state) => Boolean(state?.supervisorPending)).length;
    const availableSlots = Math.max(0, supervisorMaxConcurrent - activeSupervisions);
    if (availableSlots <= 0) return;
    const candidates = Array.from(runtimeRuns.entries())
      .map(([runId, state]) => ({
        runId,
        state,
        intervention: buildSupervisorIntervention(state, {
          interventionIdleMinutes,
          supervisorAgentId
        }, nowMs)
      }))
      .filter((entry) => entry.intervention)
      .sort((a, b) => String(a.state?.dashboardUpdatedAt || "").localeCompare(String(b.state?.dashboardUpdatedAt || "")))
      .slice(0, availableSlots);

    for (const entry of candidates) {
      const { runId, state, intervention } = entry;
      state.supervisorPending = true;
      state.supervisorAgentId = supervisorAgentId;
      state.supervisorReason = intervention.reason;
      state.supervisorLastInterventionAt = new Date(nowMs).toISOString();
      state.supervisorInterventionCount = Number(state.supervisorInterventionCount || 0) + 1;
      setRunTelemetry(state, "supervisor_intervention", {
        toolName: "taskflow_supervisor",
        toolStatus: "accepted",
        blockReason: intervention.reason
      });
      appendTimelineEvent(state, {
        role: "督办介入",
        owner: supervisorAgentId,
        text: `${supervisorAgentId} 已接手督办；任务已空转 ${intervention.idleMinutes} 分钟，原因：${intervention.reason}`
      });
      const taskFlow = getRuntimeTaskFlow(api, { sessionKey: state.sessionKey });
      transitionFlow(taskFlow, state, "setWaiting", {
        currentStep: FLOW_STATES.BLOCKED,
        blockedSummary: intervention.reason,
        waitJson: {
          kind: "supervisor_intervention",
          supervisorAgentId,
          reason: intervention.reason,
          idleMinutes: intervention.idleMinutes,
          interventionCount: state.supervisorInterventionCount
        },
        stateJson: {
          state: FLOW_STATES.BLOCKED,
          supervisorPending: true
        }
      }, {
        eventType: "supervisor_intervention",
        timestamp: isoNow()
      }, "supervisor intervention");
      await dashboard.pushBlocker({
        timestamp: isoNow(),
        runId,
        agentId: state.agentId,
        reason: `taskflow supervisor assigned ${supervisorAgentId}: ${intervention.reason}`,
        toolName: "taskflow_supervisor"
      });
      touchRun(runId, state.agentId, state);
    }

    if (candidates.length > 0) await dashboard.flush();
  }

  async function onGatewayStart() {
    if (missingHostPrereqs.length > 0) {
      api.logger.warn?.(
        `[mission-deck] host prerequisites missing: ${missingHostPrereqs.join(", ")}`
      );
    }
    api.logger.info(
      `[mission-deck] loaded enabledAgents=${enabledAgents.join(",") || "(none)"} coordinator=${coordinatorAgentId || "(none)"}`
    );
    await dashboard.flush();
    if (supervisorConfig?.enabled === true && !supervisorTimer) {
      supervisorTimer = setInterval(() => {
        runSupervisorSweep().catch((error) => {
          api.logger.warn?.(`[mission-deck] supervisor sweep failed: ${error?.message || error}`);
        });
      }, supervisorIntervalMs);
    }
  }

  async function onBeforePromptBuild(event, ctx) {
    const agentId = normalizeString(ctx?.agentId);
    const runId = normalizeString(ctx?.runId);
    if (!agentId || !runId) return;
    if (!enabledAgents.includes(agentId)) return;
    if (isSyntheticAnnounceRun(runId)) {
      api.logger.info(`[mission-deck] before_prompt_build agent=${agentId} run=${runId} synthetic_announce=true bypass=true`);
      return;
    }
    if (missingHostPrereqs.length > 0) {
      return {
        appendSystemContext: `MISSION DECK prerequisite failure.\n${buildHostPrereqMessage(missingHostPrereqs)}`
      };
    }

    const resumable = findContinuableRootRun(agentId, ctx?.sessionKey, runId);
    const state = resumable
      ? rebindRunState(resumable.runId, runId, resumable.state, agentId)
      : getRun(runId, agentId);
    const resumableSnapshot = resumable
      ? {
          entryMode: state.entryMode,
          orchestrationMode: state.orchestrationMode,
          orchestrationPlan: state.orchestrationPlan,
          chainAssessment: state.chainAssessment,
          flowId: state.flowId,
          flowRevision: state.flowRevision,
          flowStatus: state.flowStatus,
          flowCurrentStep: state.flowCurrentStep,
          flowWaitSummary: state.flowWaitSummary,
          durable: state.durable
        }
      : null;
    const parentLink = getBestEffortParentLink(runId, ctx?.sessionKey);
    const canonicalEvent = buildCanonicalEvent({
      hookName: "before_prompt_build",
      event,
      ctx,
      runState: state,
      parentLink
    });
    updateRunMetadata({
      state,
      agentId,
      event,
      ctx,
      canonicalEvent,
      parentLink,
      apiConfig: api.config,
      pluginConfig,
      isSpawnedExecutionRun
    });
    if (resumable) {
      state.entryMode = resumableSnapshot.entryMode;
      state.orchestrationMode = resumableSnapshot.orchestrationMode;
      state.orchestrationPlan = resumableSnapshot.orchestrationPlan;
      state.chainAssessment = resumableSnapshot.chainAssessment;
      state.flowId = resumableSnapshot.flowId;
      state.flowRevision = resumableSnapshot.flowRevision;
      state.flowStatus = resumableSnapshot.flowStatus;
      state.flowCurrentStep = resumableSnapshot.flowCurrentStep;
      state.flowWaitSummary = resumableSnapshot.flowWaitSummary;
      state.durable = resumableSnapshot.durable;
      appendTimelineEvent(state, {
        role: "链路续跑",
        owner: agentId,
        text: "检测到同 session 的待收口主链路，已继续附着到既有 flow。"
      });
    }
    if (state.entryMode === "plain") {
      api.logger.info(`[mission-deck] before_prompt_build agent=${agentId} run=${runId} entry=plain bypass=true`);
      return;
    }

    appendTimelineEvent(state, {
      role: "用户发起",
      owner: "用户",
      text: state.normalizedPromptText || state.promptText || "收到新任务"
    });
    if (state.orchestrationPlan?.summary) {
      appendTimelineEvent(state, {
        role: "链路规划",
        owner: agentId,
        text: state.orchestrationPlan.summary
      });
    }
    if (state.chainAssessment?.summary) {
      appendTimelineEvent(state, {
        role: "链路体检",
        owner: agentId,
        text: `${state.chainAssessment.summary}${state.chainAssessment.missing ? `；缺口：${state.chainAssessment.missing}` : ""}${state.chainAssessment.nextAction ? `；下一步：${state.chainAssessment.nextAction}` : ""}`,
        tone: state.chainAssessment.correct ? "" : "blocked"
      });
    }

    const taskFlow = state.entryMode === "mission-flow"
      ? ensureFlowBound(ctx, state, canonicalEvent, FLOW_STATES.PLANNED)
      : null;
    if (taskFlow && state.durable) {
      transitionFlow(taskFlow, state, "resume", {
        status: "running",
        currentStep: FLOW_STATES.PLANNED,
        waitJson: null,
        stateJson: {
          state: FLOW_STATES.PLANNED,
          entryMode: state.entryMode,
          orchestrationMode: state.orchestrationMode,
          orchestrationPlan: state.orchestrationPlan
        }
      }, canonicalEvent, "new task planned");
    }
    setRunTelemetry(state, "before_prompt_build");
    await flushRun(touchRun, dashboard, runId, agentId, state);
    api.logger.info(
      `[mission-deck] before_prompt_build agent=${agentId} run=${runId} entry=${state.entryMode} event=${canonicalEvent.eventType} mode=${state.orchestrationMode} flow=${state.flowId || "(none)"}`
    );

    const appendSystemContext = buildCoordinationGuidance({
      agentId,
      cfg: api.config,
      pluginConfig,
      prompt: event.prompt,
      entryMode: state.entryMode,
      orchestrationPlan: state.orchestrationPlan
    });
    const executionMandate = buildExecutionMandate(
      api.config,
      agentId,
      event.prompt,
      state.flowId,
      pluginConfig,
      {
        entryMode: state.entryMode,
        orchestrationPlan: state.orchestrationPlan
      }
    );
    return {
      appendSystemContext: `${appendSystemContext}\n\n${executionMandate}`
    };
  }

  async function onBeforeToolCall(event, ctx) {
    const agentId = normalizeString(ctx?.agentId);
    const runId = normalizeString(ctx?.runId);
    if (!agentId || !runId || !enabledAgents.includes(agentId)) return;
    if (isSyntheticAnnounceRun(runId)) return;
    if (missingHostPrereqs.length > 0) {
      return {
        block: true,
        blockReason: buildHostPrereqMessage(missingHostPrereqs)
      };
    }

    const state = runtimeRuns.get(runId);
    if (!state || state.entryMode === "plain") return;
    const parentLink = getBestEffortParentLink(runId, ctx?.sessionKey);
    const canonicalEvent = buildCanonicalEvent({
      hookName: "before_tool_call",
      event,
      ctx,
      runState: state,
      parentLink
    });
    const toolName = normalizeString(event.toolName).toLowerCase();
    const workspaceRoots = resolveWorkspaceRoots(api.config, agentId, pluginConfig);
    const taskFlow = state.entryMode === "mission-flow" ? ensureFlowBound(ctx, state, canonicalEvent, FLOW_STATES.PLANNED) : null;
    syncFlowSnapshot(taskFlow, state);

    if (looksLikeWorkspaceDiscoveryTool(event.toolName, event.params, workspaceRoots, pluginConfig)) {
      state.workspaceDiscoverySeen = true;
      state.chainAssessment = buildChainAssessment(state);
      setRunTelemetry(state, "workspace_discovery", { toolName: event.toolName });
      appendTimelineEvent(state, {
        role: "资料检查",
        owner: agentId,
        text: "正在检查相关文件、工作区或台账。"
      });
      if (taskFlow) {
        transitionFlow(taskFlow, state, "resume", {
          status: "running",
          currentStep: FLOW_STATES.ROUTING,
          stateJson: {
            state: FLOW_STATES.ROUTING
          }
        }, canonicalEvent, "workspace discovery");
      }
      await flushRun(touchRun, dashboard, runId, agentId, state);
      return;
    }

    if (INTERNAL_COORDINATION_TOOL_NAMES.has(toolName)) {
      state.internalCoordinationSeen = true;
      state.chainAssessment = buildChainAssessment(state);
      setRunTelemetry(state, "internal_coordination", { toolName: event.toolName });
      appendTimelineEvent(state, {
        role: "内部查询",
        owner: agentId,
        text: "正在查看现有会话和团队分工情况。"
      });
      if (taskFlow) {
        transitionFlow(taskFlow, state, "resume", {
          status: "running",
          currentStep: FLOW_STATES.ROUTING,
          stateJson: {
            state: FLOW_STATES.ROUTING
          }
        }, canonicalEvent, "internal coordination");
      }
      await flushRun(touchRun, dashboard, runId, agentId, state);
      return;
    }

    if (
      state.orchestrationMode !== "solo" &&
      !state.internalCoordinationSeen &&
      !state.workspaceDiscoverySeen &&
      !isPlanningSafeTool(event.toolName, event.params, workspaceRoots) &&
      !EXECUTION_LANE_TOOL_NAMES.has(toolName) &&
      toolName !== MESSAGE_TOOL_NAME
    ) {
      const blockReason = `This task requires routing first. Follow the orchestration plan before using ${toolName}.`;
      setRunTelemetry(state, "blocked_before_plan_routing", {
        toolName: event.toolName,
        blockReason
      });
      if (taskFlow) {
        transitionFlow(taskFlow, state, "setWaiting", {
          currentStep: FLOW_STATES.ROUTING,
          blockedSummary: blockReason,
          waitJson: {
            kind: "routing_required",
            summary: blockReason
          },
          stateJson: {
            state: FLOW_STATES.ROUTING
          }
        }, canonicalEvent, "routing required");
      }
      await dashboard.pushBlocker({
        timestamp: isoNow(),
        runId,
        agentId,
        reason: blockReason,
        toolName
      });
      await flushRun(touchRun, dashboard, runId, agentId, state);
      return {
        block: true,
        blockReason
      };
    }

    if (EXECUTION_LANE_TOOL_NAMES.has(toolName)) {
      const targetAgentId = normalizeString(event.params?.agentId) || "";
      const isChildRun = Boolean(state.parentRunId);
      if (!isChildRun && coordinatorAgentId && agentId !== coordinatorAgentId && targetAgentId && targetAgentId !== agentId) {
        const blockReason = `This root orchestration lane is reserved for coordinator ${coordinatorAgentId}.`;
        setRunTelemetry(state, "blocked_non_coordinator_root_orchestration", {
          toolName: event.toolName,
          blockReason
        });
        if (taskFlow) {
          transitionFlow(taskFlow, state, "setWaiting", {
            currentStep: FLOW_STATES.ROUTING,
            blockedSummary: blockReason,
            waitJson: {
              kind: "coordinator_required",
              coordinatorAgentId,
              requestedTargetAgentId: targetAgentId,
              summary: blockReason
            },
            stateJson: {
              state: FLOW_STATES.ROUTING
            }
          }, canonicalEvent, "coordinator required");
        }
        await flushRun(touchRun, dashboard, runId, agentId, state);
        return {
          block: true,
          blockReason
        };
      }
      if (isChildRun && targetAgentId && targetAgentId !== agentId && !canDelegateToOtherAgents(api.config, agentId)) {
        const blockReason = `This agent is execution-only and cannot delegate onward.`;
        setRunTelemetry(state, "blocked_secondary_delegation", {
          toolName: event.toolName,
          blockReason
        });
        if (taskFlow) {
          transitionFlow(taskFlow, state, "setWaiting", {
            currentStep: FLOW_STATES.BLOCKED,
            blockedSummary: blockReason,
            waitJson: {
              kind: "delegation_policy",
              summary: blockReason
            },
            stateJson: {
              state: FLOW_STATES.BLOCKED
            }
          }, canonicalEvent, "secondary delegation denied");
        }
        await flushRun(touchRun, dashboard, runId, agentId, state);
        return {
          block: true,
          blockReason
        };
      }
      if (toolName === "sessions_spawn" && pluginConfig?.blockPrematureSpawn !== false && !looksLikeExplicitIsolationNeed(event.params, state.promptText) && !state.internalCoordinationSeen) {
        const blockReason = "First inspect visible teammate sessions before opening a fresh isolated lane.";
        setRunTelemetry(state, "blocked_premature_spawn", {
          toolName: event.toolName,
          blockReason
        });
        if (taskFlow) {
          transitionFlow(taskFlow, state, "setWaiting", {
            currentStep: FLOW_STATES.ROUTING,
            blockedSummary: blockReason,
            waitJson: {
              kind: "routing_required",
              summary: blockReason
            },
            stateJson: {
              state: FLOW_STATES.ROUTING
            }
          }, canonicalEvent, "premature spawn");
        }
        await flushRun(touchRun, dashboard, runId, agentId, state);
        return {
          block: true,
          blockReason
        };
      }
      if (toolName === SESSIONS_SEND_TOOL_NAME) {
        const hasSessionKey = hasNonEmptyString(event.params?.sessionKey);
        const hasLabel = hasNonEmptyString(event.params?.label);
        const hasAgentId = hasNonEmptyString(event.params?.agentId);
        if ((hasSessionKey || hasLabel) && shouldForceSpawnInsteadOfSend(agentId, event.params)) {
          const blockReason = `Cross-agent sessions_send using only label is unreliable for ${targetAgentId}.`;
          setRunTelemetry(state, "blocked_cross_agent_label_send", {
            toolName: event.toolName,
            blockReason
          });
          await flushRun(touchRun, dashboard, runId, agentId, state);
          return {
            block: true,
            blockReason
          };
        }
        if (pluginConfig?.blockInvalidSessionsSend !== false && hasAgentId && !hasSessionKey && !hasLabel) {
          const blockReason = "sessions_send cannot target by agentId alone. Reuse a known session via sessionKey/label, or create an execution lane with sessions_spawn first.";
          setRunTelemetry(state, "blocked_invalid_sessions_send", {
            toolName: event.toolName,
            blockReason
          });
          await flushRun(touchRun, dashboard, runId, agentId, state);
          return {
            block: true,
            blockReason
          };
        }
      }
      state.dispatchAttempted = true;
      if (event.toolCallId) {
        state.pendingDispatches.set(event.toolCallId, {
          params: event.params ?? null,
          toolName
        });
      }
      appendTimelineEvent(state, {
        role: "安排跟进",
        owner: agentId,
        text: "正在建立协作链路。"
      });
      if (taskFlow) {
        transitionFlow(taskFlow, state, "resume", {
          status: "running",
          currentStep: FLOW_STATES.ROUTING,
          stateJson: {
            state: FLOW_STATES.ROUTING
          }
        }, canonicalEvent, "dispatch requested");
      }
      await flushRun(touchRun, dashboard, runId, agentId, state);
      return;
    }

    if (toolName === MESSAGE_TOOL_NAME) {
      if (pluginConfig?.blockPrematureUserEscalation !== false && looksLikeEntrypointEscalation(event.params, pluginConfig) && !state.workspaceDiscoverySeen) {
        const blockReason = "Use internal-first coordination before asking the user for repo paths, project directories, git URLs, or session entrypoints.";
        setRunTelemetry(state, "blocked_premature_user_escalation", {
          toolName: event.toolName,
          blockReason
        });
        await flushRun(touchRun, dashboard, runId, agentId, state);
        return {
          block: true,
          blockReason
        };
      }
      if (state.engineeringTask && !hasAnyInternalExecutionStep(state)) {
        const blockReason = "Execution-first rule: do at least one internal action before any external progress message on engineering work.";
        setRunTelemetry(state, "blocked_external_message_before_internal_action", {
          toolName: event.toolName,
          blockReason
        });
        await flushRun(touchRun, dashboard, runId, agentId, state);
        return {
          block: true,
          blockReason
        };
      }
      state.userVisibleMessageSent = true;
      state.lastBlockReason = "";
      setRunTelemetry(state, "external_message", {
        toolName: event.toolName,
        externalMessage: getMessageText(event.params)
      });
      appendTimelineEvent(state, {
        role: "对外同步",
        owner: agentId,
        text: getMessageText(event.params)
      });
      await flushRun(touchRun, dashboard, runId, agentId, state);
    }
  }

  return {
    onGatewayStart,
    onBeforePromptBuild,
    onBeforeToolCall,
    runBackground,
    flushRun: (runId, agentId, state) => flushRun(touchRun, dashboard, runId, agentId, state)
  };
}
