# MISSION DECK

`mission-deck` 是一个非侵入式的 OpenClaw 插件，用于提供多 Agent 协作护栏，以及一个轻量级的独立静态 dashboard。

官方配套 skill：

- `skills/mission-deck-autonomy/` 提供通用的多 Agent 路由、TaskFlow 升级策略和完成标准，不要求修改用户自己的 workspace 提示文件。
- 这个 skill 会随插件一起安装；推荐使用 `mission-deck-install --apply --with-skill` 进行 agent-first 安装。

它的目标是让多 Agent 协作具备这些特性：

- 尽量复用已有、可见、可继续的 teammate 会话
- 在必须隔离执行时仍然保持可追踪
- 在向用户升级求助之前，优先完成可复用的内部协调和探测

## 当前路由策略

插件遵循以下规则：

- 先查找可复用、可见的 teammate 会话
- 如果目标 agent 已有可复用会话，优先使用 `sessions_send`
- 只有在明确需要隔离执行，或者确实没有可复用会话时，才使用 `sessions_spawn`

实际含义：

- `sessions_send`：继续已有 teammate 会话，例如 `agent:builder:chat:direct:...`
- `sessions_spawn`：为显式 ACP / 后台执行、并行 worker 或长任务隔离执行新开 lane

如果不确定，先用 `sessions_list` 或 `agents_list` 检查当前可见会话，再决定是否新开 lane。

## 功能说明

- 根据 prompt 行为识别工程型任务
- 推动 agent 在对外叙述前先做内部协调
- 阻止只靠 `agentId` 的无效 `sessions_send`
- 阻止过早的 `sessions_spawn`，除非明确需要隔离，或没有可复用会话
- 在宿主支持的情况下创建并维护与 TaskFlow 绑定的 delegation trace
- 记录 child-task 链路，保证交接可追踪
- 将实时 dashboard 快照写入 `dashboard/status.json`
- 将每日 dashboard 事件追加到 `dashboard/data/YYYY-MM-DD.jsonl`

## 兼容性

此插件要求宿主 OpenClaw 同时支持：

- TaskFlow
- agent-to-agent messaging（`tools.agentToAgent.enabled = true`）

同时假设插件 hook 可用：

- `gateway_start`
- `before_prompt_build`
- `before_tool_call`
- `after_tool_call`
- `before_agent_reply`
- `before_message_write`
- `agent_end`

必需的运行时能力：

- `api.runtime.taskFlow` 或 `api.runtime.tasks.flow`
- `tools.agentToAgent`
- `agents.list` 中存在 agent `workspace` 配置

如果宿主缺少 TaskFlow 或 agent-to-agent 支持，就应该把 `mission-deck` 视为不受支持。当前版本会明确输出 prerequisite warning，而不是静默降级。

## 安装

agent-first 安装：

```bash
npx mission-deck-install@latest --apply --with-skill --json
```

如果本地已经有安装命令：

```bash
mission-deck-install --apply --with-skill --json
```

带校验和服务重启的完整安装：

```bash
npx mission-deck-install@latest --apply --with-skill --verify --restart --json
```

或：

```bash
mission-deck-install --apply --with-skill --verify --restart --json
```

这个 installer 会：

- 默认把插件复制到 `~/.openclaw/extensions/mission-deck`
- 把 bundled 的 `mission-deck-autonomy` skill 一起放入插件目录
- 更新 `~/.openclaw/openclaw.json`
- 校验插件文件和配置项是否安装成功
- 在需要时通过 `systemctl` 重启目标 OpenClaw 服务
- 返回结构化 JSON，便于其他 agent 继续自动处理

仍然保留手工安装作为 fallback：

将插件目录复制到 OpenClaw extensions 目录，例如：

```text
~/.openclaw/extensions/mission-deck/
```

然后在 OpenClaw 配置里注册它。

启用 `mission-deck` 前，请先确认宿主已经具备：

- TaskFlow 支持
- agent-to-agent 支持

推荐的安装前检查：

1. 确认 OpenClaw 版本暴露了 TaskFlow runtime API。
2. 确认 `tools.agentToAgent.enabled = true`。
3. 确认需要受保护的 agent 已在 `agents.list` 中声明。
4. 确认这些 agent 都配置了稳定的 `workspace` 路径。
5. 确认插件宿主支持 `Compatibility` 一节列出的 hooks。

配置示例：

```json
{
  "plugins": {
    "entries": {
      "mission-deck": {
        "enabled": true,
        "path": "~/.openclaw/extensions/mission-deck",
        "config": {}
      }
    }
  }
}
```

## 配置

插件配置示例：

```json
{
  "enabledAgents": ["dispatcher", "builder", "reviewer"],
  "dashboardRetentionDays": 14
}
```

稳定公开字段：

- `enabledAgents`：把 orchestration 限制在一组明确 agent 内
- `internalFirst`：在向用户索要入口信息前，优先做 teammate 协调
- `blockPrematureUserEscalation`：阻止过早向用户索要 repo path、workspace path、git URL 等入口信息
- `blockPrematureSpawn`：普通 `sessions_spawn` 前要求先检查可见会话
- `blockInvalidSessionsSend`：阻止只带 `agentId` 的 `sessions_send`
- `redactDashboardContent`：清洗 dashboard 持久化的摘要和 prompt 派生文本
- `redactSessionKeys`：把原始 session key 替换成稳定的脱敏标识
- `redactPromptMetadata`：在 dashboard 持久化前去掉 prompt scaffolding 元数据
- `dashboardRetentionDays`：每日 `jsonl` 日志保留天数

高级覆盖项：

- `taskKeywords`：额外任务识别关键词
- `agentWorkspaceRoots`：按 agent id 指定显式 workspace root
- `entrypointPatterns`：自定义“向用户升级入口信息”的触发短语
- `discoveryToolNames`：自定义哪些工具算 workspace discovery
- `dashboardStatusPath`：覆盖生成的 `status.json` 路径
- `dashboardDataDir`：覆盖 dashboard 事件日志目录

默认行为：

- installer 只写最小插件入口，除非你显式设置，否则不把默认值铺进配置文件
- `internalFirst`、三个 block guardrail、dashboard redaction 默认开启；只有显式设为 `false` 才关闭
- `dashboardRetentionDays` 默认是 `14`

## 会话路由规则

在这些情况下使用 `sessions_send`：

- 你已经知道应该继续哪个 teammate 会话
- 希望工作继续留在已有、可复用的可见线程里
- 你是在跟进已有对话

在这些情况下使用 `sessions_spawn`：

- 任务明确需要隔离执行
- 任务需要 ACP / 后台执行
- 任务需要并行推进，且不适合污染已有可见线程
- 没有合适的可复用 teammate 会话

如果只提供 `agentId`，`sessions_send` 并不成立；必须已知 `sessionKey` 或 `label`。

## Dashboard

插件自带一个独立静态 dashboard：

- `dashboard/index.html`
- `dashboard/status.json`
- `dashboard/data/YYYY-MM-DD.jsonl`

这些文件属于运行时输出，不应把 `status.json` 或 `dashboard/data/` 当作发布源码的一部分。

推荐的反向代理配置：

```nginx
location = /mission-deck {
    return 301 /mission-deck/;
}

location = /mission-deck/ {
    return 302 /mission-deck/index.html;
}

location ^~ /mission-deck/ {
    auth_basic "Restricted";
    auth_basic_user_file /etc/nginx/.openclaw_pass;

    alias /path/to/mission-deck/dashboard/;
    index index.html;
    try_files $uri $uri/ /mission-deck/index.html;
}
```

如果你不想对外发布 dashboard，也可以只使用 orchestration guardrails，而不暴露静态文件。

## Smoke Test

安装完成后，建议在一台干净宿主上跑这套最小验证流程：

1. 启动 OpenClaw，确认日志里没有缺少 `TaskFlow` 或 `agentToAgent` 的 prerequisite 报错。
2. 发送一个应当复用已有 teammate 会话的任务。
3. 确认插件优先选择 `sessions_send`，而不是过早新开隔离 lane。
4. 发送一个明确需要 ACP / 后台隔离执行的任务。
5. 确认此时 `sessions_spawn` 会被允许。
6. 打开 dashboard，确认会生成新的 `status.json`。
7. 检查 `status.json`，确认默认情况下没有原始 peer ID、原始 `sessionKey`、`chat_id`、`message_id`。

预期失败模式：

- 如果宿主缺少 TaskFlow 或 agent-to-agent 支持，启动日志应当明确告警，相关 tool call 应被 prerequisite error 阻止，而不是静默降级

## Dashboard 数据模型

`status.json` 包含：

- `summary`
- `agentRoster`
- `agentLoad`
- `flowHealth`
- `childTaskBoard`
- `deliveryHub`
- `consoleFeed`
- `activeRuns`
- `recentRuns`
- `recentDispatches`
- `recentBlockers`
