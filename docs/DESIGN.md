# dsh-remote-wecom 设计

把 [pi-remote-wecom](../../pi-remote-package)（下称 pi remote）的手机企微遥控体验搬到 DeepSeek Harness Desktop。命令、卡片版式、推送与路由策略保持与 pi remote 一致；只有宿主一侧换成 DSH。

基线：DSH `0.2.1-rc.2`（Desktop 内置 harness），pi remote `0.3.17`。

## 形态

一个 `dsh.bundle` 插件，运行在 DSH host 进程内，自己持有企微智能机器人长连接。

```
DeepSeek Harness.app ── host 进程
  └─ dsh-remote-wecom（cordis 插件）
       ├─ core/      从 pi remote daemon 搬来的宿主无关层：企微传输、命令、卡片、Run/Target 状态机、推送与路由
       └─ host/      DSH 适配：typertGateway 调用 + session/event 翻译 + 审批/提问 waterfall
```

与 pi remote 的差异：

| pi remote | dsh-remote-wecom |
|---|---|
| launchd daemon + pi TUI 扩展，HTTP 长轮询 | 插件在 host 内直接调用会话控制器，无进程间协议 |
| 终端会话（TUI）/ 后台会话（`pi --mode rpc`） | 都是 Desktop 里的会话；「创建会话」新建后 `open dsh://open` 把 Desktop 拉到前台，「创建后台会话」只新建 |
| 会话 jsonl 扫描 | `session/list` + projections（标题、turnOutline） |
| tab-title 自动命名 | DSH 自带标题（`session/title` 事件） |
| `ctx.ui.confirm` 等弹窗 | `approval/request`、`user-questions/request` waterfall |
| `~/.config/pi-remote-wecom/` | `$DSH_HOME/integrations/dsh-remote-wecom/`（`DSH_HOME` 默认 `~/.dsh`） |
| Desktop 离线仍可起后台 pi | Desktop 未运行即离线 |

## 宿主接口（0.2.1-rc.2 实测）

`inject: ['typertGateway', 'connection']`。`peer = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })`，调用 `ctx.typertGateway.invoke({ namespace, method, args, peer })`，流式接口用 `.stream(...)` 返回异步迭代器。args 外层键必须与描述符完全一致，否则报 `gateway/arguments-invalid`。

| 用途 | 调用 |
|---|---|
| 会话列表 | `session/list` `{_request:{}}` → `items[{sessionId, updatedAt, agentAvailable, running, blank, cwd, origin?, parentSessionId?, projections?}]` |
| 会话投影 | `session/projections` `{request:{sessionId}}` → `values.{title, tokenUsage, contextPressure{pressureTokens, contextWindow}, turnOutline[{turn, prompt, response}], modelSelection{lastUsed, next}, workingDirectory}` |
| 新建 | `session/create` `{request:{cwd}}` → `{sessionId}` |
| 投递 | `session/prompt` `{request:{requestId, sessionId, mode:'queue', content:[{type:'text', text}]}}`；对未激活的历史会话会自动激活 |
| 停止 | `session/cancel` `{request:{sessionId}}` |
| 模型目录 | `session/modelCatalog` `{}` → `{default, groups[{id, name, models[{id, name, reasoning{efforts[{id, name}], defaultEffort}}]}], routableProviders}` |
| 切模型 / 思考强度 | `session/selectModel` `{request:{sessionId, provider, model, reasoningEffort?}}` |
| 压缩 | `commands/execute` `{agentId: sessionId, line: '/compact 说明', submittedAttachments: []}` → `{result:{kind, text}}` |
| 历史事件 | `session/follow`（首帧 snapshot）+ `session/page` |

`session/search` 在 Desktop 默认关闭，不用；历史检索在插件内对标题和 turnOutline 的 prompt 做，沿用 pi remote 的相关性打分。

事件（`ctx.on(name, fn, { global: true })`）：

- `session/event (session, event)`：`turn/start{turn}`、`user/message{source.kind, source.rpcId}`、`assistant/message{message.content[]}`、`tool/call{name, arguments}`、`tool/result{message.isError, meta.path}`、`turn/end{reason.kind: completed|aborted|error|max-tokens, reason.error.message}`、`session/title{title}`。`user/message` 混有系统注入消息，只认 `source.kind === 'user'`。
- `api-session/added (summary)`、`api-session/removed (sessionId)`、`api-session/status (sessionId, running)`。
- `approval/request (req, next)`，注册时加 `prepend: true`：`req.{toolName, callId, reason, displayReason.zh, agent}`，返回 `'allowed-once' | 'rejected' | 'cancelled'`。
- `user-questions/request (req, next)`：`req.questions[{id, question, header, options[{label, description}], multiSelect}]`，返回 `{answers:[{id, selected:[label], custom?}]}`。

## 映射

### 会话与轮次

- 每个 DSH 会话一个 `DshTarget`（替换 `TuiTarget` / `RpcTarget`），`kind = 'dsh'`，卡片类型文案「桌面会话」。「活跃会话」= `agentAvailable || running` 的非 subagent 会话；其余进「历史会话」。
- 手机投递的 `requestId` 以 `wecom-` 开头。一轮的来源看该轮第一条 `source.kind === 'user'` 的 `user/message`：`rpcId` 带前缀为手机发起，否则为电脑发起（`local`）。
- 翻译关系（对应 pi remote daemon 的 HTTP 路由）：会话出现 → `/register`；该轮首条用户消息 → `/turn`；`tool/call` → `/activity`；`turn/end` + 累计的 `assistant/message` 文本 → `/result`；`api-session/removed` → `/unregister`。
- `turn/end` 的 `aborted` 记为已停止，`error` 记为失败（`reason.error.message`）。

### 命令

| 命令 | DSH 实现 |
|---|---|
| `ls` 活跃会话 / `h` 历史会话 | `session/list` + projections；历史默认隐藏 subagent（`origin === 'subagent'` 或有 `parentSessionId`） |
| `n` / `nb` 创建（后台）会话 | `session/create {cwd}`，再投递首条消息；`n` 额外 `open dsh://open`（屏幕锁定时跳过） |
| `model` / `think` | `modelCatalog` + `selectModel`；思考强度取当前模型的 `reasoning.efforts` |
| `compact` | `commands/execute '/compact 说明'`，运行中拒绝 |
| `stop` | `session/cancel` |
| `status` | projections：目录（分支）、模型·思考强度、上下文 `pressureTokens / contextWindow`、token 用量 |
| `art` 产物 | `write` / `edit` 的 `tool/result.meta.path`，`present` 的 `files[].path`，回复里链接给出的文件；过滤规则沿用 pi remote（扩展名白名单、排除 git 跟踪文件、隐藏目录、临时目录） |
| `cd` 目录别名、`关注` / `取关`、引用路由、待投递选会话卡片 | 宿主无关，原样保留 |
| `restart` | 重启插件内的遥控服务（关传输、重载配置、重连），有任务运行时默认拒绝 |

### 弹窗

- 审批 → `openUiPrompt` 的 `confirm`：标题用 `displayReason.zh`（无则 `reason`），正文带工具名。允许 → `allowed-once`，拒绝 → `rejected`，取消 → `cancelled`；超时按 `remoteConfirm`（默认 `ask-then-allow`）。
- 提问 → `question`：多题逐题推送，标题 `（i/n）题目`，`header` 作短标签，允许自己写（返回 `custom`），取消或超时按未回答处理。
- 与 Desktop 窗口抢答：同时调 `next()` 让 Desktop 弹窗，两边谁先答用谁的；Desktop 先答时收回手机卡片，手机先答时取消 Desktop 侧的等待。`next()` 立即返回 `unavailable` 表示没有窗口在答，只等手机。未绑定会话的请求先挂起，切过去时补推（与 pi remote 相同）。

### 附件

入站图片和文件落到 `inbox/`，消息里附路径，提示模型用 `read` / `read_image` 查看。结果回传、长文本转文件、outbox 断网重发沿用 pi remote。

## 配置与绑定

- 数据目录 `$DSH_HOME/integrations/dsh-remote-wecom/`：`config.json`（`botId`、`secret`、`ownerUserId` 等）、`bind.json`、`cards.json`、`seen.json`、`aliases.json`、`outbox/`、`inbox/`、`bridge.log`。
- `node bin/dsh-remote.mjs setup` 写入 BotID / Secret 并生成 6 位绑定码，`bind` 重新生成绑定码，`status` 看状态。插件定时检查配置文件，变化后自动重连，不必重启 Desktop。
- 同一 BotID 只能一条长连接：不能与 pi remote、dsh-im 企微通道共用机器人。

## 验证

- 单元测试：从 pi remote 搬来的宿主无关测试（传输、配置、别名、产物过滤）。
- 端到端：`devDependencies` 带 `@deepseek-ai/dsh@0.2.1-rc.2`，测试用隔离 `DSH_HOME` 起 `dsh --profile web --patch`，加载脚本化假 LLM（`tests/fixtures/mock-llm.mjs`）和本插件，企微侧用 `ws` 假服务器（`wsUrl` 配置），覆盖绑定、活跃/历史/创建会话、投递与回传、停止、切模型与思考强度、压缩、状态、产物、审批与提问卡片、关注/取关、引用路由。
- 真机：安装到 `~/.dsh/profiles/desktop`（`dsh plugin --profile desktop add`），重启 Desktop，用专用机器人走一遍主流程。
