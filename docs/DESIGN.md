# dsh-remote-wecom 设计

把 [pi-remote-wecom](https://github.com/lukeinx/pi-remote-wecom)（下称 pi remote）的手机企微遥控体验搬到 DeepSeek Harness Desktop。命令、卡片版式、推送与路由策略保持与 pi remote 一致；只有宿主一侧换成 DSH。

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
| 终端会话（TUI）/ 后台会话（`pi --mode rpc`） | 都是 Desktop 里的会话；「创建会话」新建后按 `openDesktop`（默认关）`open dsh://open` 把 Desktop 窗口拉到前台，「创建后台会话」只新建。Desktop 的 `open-url` 只认 `dsh://open` 并聚焦主窗口，不带会话定位；定位会话只有渲染进程的 `ctx.uiWorkspace.openSession` |
| 新会话按目录开（`cd` 选目录） | 新会话按 Desktop 工作区开（`工作区` 选工作区或未分组）；会话只有带 `workspaceId` 创建才归入工作区 |
| 会话没有归档、置顶 | 列表排除 Desktop 里已归档的会话、置顶在前；手机投递前先取消归档 |
| 轮次只有人发起 | 定时提醒（`schedule`）与目标续跑（`goal`）会自己唤起轮次，按会话最近一次用户消息的来源决定是否推手机 |
| 会话 jsonl 扫描 | `session/list` + projections（标题、turnOutline） |
| tab-title 自动命名 | DSH 自带标题（`session/title` 事件） |
| `ctx.ui.confirm` 等弹窗 | `approval/request`、`user-questions/request` waterfall |
| `~/.config/pi-remote-wecom/` | `$DSH_HOME/integrations/dsh-remote-wecom/`（`DSH_HOME` 默认 `~/.dsh`） |
| Desktop 离线仍可起后台 pi | Desktop 未运行即离线 |

## 宿主接口（0.2.1-rc.2 实测）

`inject: ['typertGateway', 'connection']`。`peer = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })`，调用 `ctx.typertGateway.invoke({ namespace, method, args, peer })`，流式接口用 `.stream(...)` 返回异步迭代器。args 外层键必须与描述符完全一致，否则报 `gateway/arguments-invalid`。

| 用途 | 调用 |
|---|---|
| 会话列表 | `session/list` `{_request:{}}` → `items[{sessionId, updatedAt, agentAvailable, running, blank, cwd, origin?, parentSessionId?, projections}]`；条目自带 `projections.values`（标题、turnOutline）。host 重启后旧会话 `agentAvailable: false`，投递时自动激活 |
| 会话投影 | `session/projections` `{request:{sessionId}}` → `values.{title, tokenUsage, contextPressure{pressureTokens, projectedTokens, contextWindow}, turnOutline[{turn, prompt, response}], modelSelection{lastUsed, next}}`；压缩后 `projectedTokens` 下降 |
| 新建 | `session/create` `{request:{workspaceId}}` 或 `{request:{cwd}}` 或 `{request:{}}` → `{sessionId}`。`workspaceId` 与 `cwd` 互斥；只有带 `workspaceId` 才 attach 到工作区，只传 `cwd`（哪怕等于某个工作区目录）或都不传都进「未分组」，都不传时 cwd 取宿主默认目录 |
| 投递 | `session/prompt` `{request:{requestId, sessionId, mode, content:[{type:'text', text}]}}` → `{accepted}`；对未激活的历史会话会自动激活。`mode:'queue'` 运行中投递的消息成为紧接着的下一轮；`mode:'steer'` 并入当前轮（同一轮里出现第二条 `source.kind:'user'` 的用户消息，`rpcId` 为插话的 requestId） |
| 工作区 | `workspace/follow` 流式，参数 `{}`，首帧 `{type:'baseline', value:{items[{workspaceId, path, title, sessionIds}], archivedSessionIds, pinnedSessionIds}}`；items 即 Desktop 侧栏顺序，置顶数组最近置顶的在前 |
| 取消归档 | `workspace/unarchiveSession` `{request:{sessionId}}` → `{archivedSessionIds}`。已归档会话的新轮次被 ArchivedSessionGate 拦下：只有 `turn/start` → `turn/end{reason.kind:'blocked'}`，中间没有用户消息 |
| 权限预设 | 目录 `permissionPresets/catalog` `{}` → `{options[{value, name}], defaultPreset}`；切换 `commands/execute` `{agentId, line:'/permission <value>', submittedAttachments:[]}` → `{result:{kind:'success', text:'preset <value>'}}`；当前值在投影 `permissions.currentValue` |
| 停止 | `session/cancel` `{request:{sessionId}}` → `{accepted}`，该轮以 `turn/end{reason.kind:'aborted'}` 结束 |
| 模型目录 | `session/modelCatalog` `{}` → `{default, groups[{id, name, models[{id, name, reasoning{efforts[{id, name}], defaultEffort}}]}], routableProviders}` |
| 切模型 / 思考强度 | `session/selectModel` `{request:{sessionId, provider, model, reasoningEffort?}}` → `{selected:{provider, model, reasoningEffort}}`，并发 `model/selection` 事件 |
| 压缩 | `commands/execute` `{agentId: sessionId, line: '/compact', submittedAttachments: []}` → `{result:{kind:'success', text:'Compacted N history items (~X tokens).'}}`。rc.2 的 `/compact` 不接受参数（带参数返回 `kind:'error'`，`Usage: /compact (no arguments)`） |
| 历史事件 | `session/follow` 流式 `{request:{address:{kind:'session', sessionId}, maxMessages}}`，首帧 `{type:'snapshot', records:[{type:'event', event:{type, seq, time, data}}], hasMore, projections}`；产物补扫只取首帧，不翻 `session/page` |

`session/search` 在 Desktop 默认关闭，不用；历史检索在插件内对标题和 turnOutline 的 prompt 做，沿用 pi remote 的相关性打分。

插件可能先于 `sessionController` 就绪（启动瞬间调用报 `active Service "sessionController" is unavailable`），启动时的会话同步需要重试。

事件（`ctx.on(name, fn, { global: true })`）：

- `session/event (session, event)`：`turn/start{turn}`、`user/message{source.kind, source.rpcId}`（`source.kind` 除 `user` 外还有注入类 `runtime-context` / `skill-catalog` / `time-context`，以及宿主唤起的 `schedule` / `goal`）、`assistant/message{message.content[]}`、`tool/call{name, arguments}`、`tool/result{message.isError, meta.path}`、`turn/end{reason.kind: completed|aborted|error|max-tokens, reason.error.message}`、`session/title{title, source}`、`model/selection{provider, model, reasoningEffort}`（只在切模型时发）、`request/header{header.config{provider, model, reasoningEffort}}`（每次 LLM 请求，新会话首轮靠它拿模型，此时 `modelSelection` 投影还是空的）。`user/message` 的 data 就是消息本身（`data.source`、`data.content`），混有 runtime-context 等系统注入消息，只认 `source.kind === 'user'`。一轮的顺序：`agent/inbox/spliced` → `api-session/status [sid, true]` → `turn/start` → `user/message` → … → `turn/end`。标题先来一条 `source.kind:'fallback'`（首条消息截断），模型起的标题随后再来一条。
- `api-session/added (summary)`、`api-session/removed (sessionId)`、`api-session/status (sessionId, running)`。
- `approval/request (req, next)`，注册时加 `prepend: true`：`req.{toolName, callId, reason, displayReason.zh, agent, signal}`，返回 `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`。会话 id 取 `req.agent.session.id ?? req.agent.id`。
- `user-questions/request (req, next)`：`req.questions[{id, question, header, options[{label, description}], multiSelect}]`，返回 `{answers:[{id, selected:[label], custom?}]}`。

## 映射

### 会话与轮次

- 每个 DSH 会话一个 `DshTarget`（替换 `TuiTarget` / `RpcTarget`），`kind = 'dsh'`，卡片类型文案「桌面会话」。「活跃会话」= 运行中 / 当前 / 置顶，加最近 24 小时 `updatedAt` 有更新的（最多 10 个），不含 subagent 与已归档；其余进「历史会话」，带关键词检索时活跃会话也参与。不用 `agentAvailable` 判定：DSH 不回收空闲 Agent，它只表示本次 host 启动后被激活过，host 重启即全部归零。
- 手机投递的 `requestId` 以 `wecom-` 开头。一轮的来源看该轮第一条 `source.kind === 'user'` 的 `user/message`：`rpcId` 带前缀为手机发起，否则为电脑发起（`local`）。
- 首条是 `schedule` / `goal` 来源的轮次带 `trigger`：会话最近一次用户消息来自手机（记在 `phone-sessions.json`，跨重启）时按手机发起处理。手机 `目标 描述` / `目标 继续` 也记为手机发起。`goal` 轮次在 `turn/end` 时按已收到的 `goal/change` 判断：目标仍是 active 就压下这一轮不推；轮内变为 complete / blocked / paused，或两轮之间来了非 active 的 `goal/change`（电脑上暂停、清除、到达上限）时推最后一轮；手机命令引起的变化由命令自己回复。
- 同一轮里的第二条用户消息是插话：对应的手机 loop 标为并入（不单独回传），这一轮改为推回手机。
- 没有任何消息就 `blocked` 结束的轮次 → `turnBlocked`：最早一条未开始的消息按失败收尾（会话已归档）。
- 翻译关系（对应 pi remote daemon 的 HTTP 路由）：会话出现 → `/register`；该轮首条用户消息 → `/turn`；`tool/call` → `/activity`；`turn/end` + 累计的 `assistant/message` 文本 → `/result`；`api-session/removed` → `/unregister`。
- `turn/end` 的 `aborted` 记为已停止，`error` 记为失败（`reason.error.message`）。

### 命令

| 命令 | DSH 实现 |
|---|---|
| `ls` 活跃会话 / `h` 历史会话 | `session/list` + projections + `workspace/follow` 首帧；默认隐藏 subagent（`origin === 'subagent'` 或有 `parentSessionId`）和已归档，`全部` 才显示；活跃列表置顶在前，其余按工作区顺序分组、未分组最后 |
| `n` / `nb` 创建（后台）会话 | 位置 = 首个词（工作区名 / `未分组` / 别名 / 路径）或默认位置；工作区 → `{workspaceId}`，非工作区目录 → `{cwd}`，未分组 → `{}`。再投递首条消息，等非 fallback 标题（`nameWaitMs`）；`n` 在 `openDesktop` 打开时额外 `open dsh://open`（默认关，屏幕锁定时跳过） |
| `cd` 工作区 | 列 `workspace/follow` 的工作区 + 未分组 + 不是工作区的别名目录，选中结果写 `.default-place`（`{workspaceId}` 或 `{cwd}`，没有文件 = 未分组）。不替用户在 Desktop 侧栏添加工作区 |
| `steer` 插话 | 运行中 `session/prompt mode:'steer'`，空闲时同普通消息 |
| `perm` 权限模式 | `permissionPresets/catalog` + `/permission <value>` |
| `goal` 目标 | `commands/execute '/goal [<目标>\|edit <目标>\|pause\|resume\|clear]'`；状态取 `goal` 投影（轮数只在 `goal/change` 时更新，当前轮取续跑提示词的 `Round: N/M`），续跑是否启用只在 `/goal` 输出的 `Activation:` 行。到达上限时续跑驱动在最后一轮后把目标标为 `blocked`（`round-limit`） |
| `model` / `think` | `modelCatalog` + `selectModel`；思考强度取当前模型的 `reasoning.efforts` |
| `compact` | `commands/execute '/compact'`，运行中拒绝；带说明时照常压缩，卡片提示说明未生效 |
| `stop` | `session/cancel` |
| `status` | projections：目录（分支）、模型·思考强度、上下文 `pressureTokens / contextWindow`、token 用量 |
| `art` 产物 | `write` / `edit` 的 `tool/call.arguments.file_path` 与 `tool/result.meta.path`，`present` 的 `files[].path`，回复里链接给出的文件；来自实时事件，首次查看时用 `session/follow` 快照补扫；过滤规则沿用 pi remote（扩展名白名单、排除 git 跟踪文件、隐藏目录、临时目录） |
| `关注` / `取关`、引用路由、待投递选会话卡片 | 宿主无关，原样保留；`关注` 额外打开「电脑发起的审批转手机」，`取关` 关闭 |
| `restart` | 重启插件内的遥控服务（关传输、重载配置、重连），有任务运行时默认拒绝 |

### 弹窗

- 审批接手机发起的轮次，以及 `关注` 后已挂上回传、未取关的电脑轮次（Desktop 关窗后任务仍在跑，没人点审批）；提问不限轮次。其余电脑发起的审批、插件未运行、未绑定主人、企微断开时直接 `return next()`。
- 审批 → `openUiPrompt` 的 `confirm`：标题用 `displayReason.zh`（无则 `reason`），正文带工具名。允许 → `allowed-once`，拒绝 → `rejected`，取消 → `cancelled`；超时按 `remoteConfirm`（默认 `ask-then-allow`）。
- 提问 → `question`：多题逐题推送，标题 `（i/n）题目`，`header` 作短标签，允许自己写（返回 `custom`），取消或超时按未回答处理。
- 与 Desktop 窗口抢答：同时调 `next()` 让 Desktop 弹窗，两边谁先答用谁的。`req.signal` 换成插件私有的 AbortController，手机先答时只中止 Desktop 侧那一个等待；Desktop 先答时手机卡片作废（再点提示已处理）。`next()` 返回 `unavailable` / `cancelled`，或 1.5 秒内返回空答案，都表示没有窗口在答，只等手机。插件停止时未答的请求交回 `next()` 的结果。未绑定会话的请求先挂起，切过去时补推（与 pi remote 相同）。

### 附件

入站图片和文件落到 `inbox/`，消息里附路径，提示模型用 `read` / `read_image` 查看。结果回传、长文本转文件、outbox 断网重发沿用 pi remote。

## 配置与绑定

- 数据目录 `$DSH_HOME/integrations/dsh-remote-wecom/`：`config.json`（`botId`、`secret`、`ownerUserId` 等）、`bind.json`、`cards.json`、`seen.json`、`aliases.json`、`.default-place`、`phone-sessions.json`、`outbox/`、`inbox/`、`alive.json`、`watchdog.json`、`spool/`、`bridge.log`、`watchdog.log`。
- `config.json` 可选项：

  | 字段 | 默认 | 说明 |
  |---|---|---|
  | `remoteConfirm` | `ask-then-allow` | 手机发起的任务里，审批转企微卡片；超时后 `ask-then-allow` 允许、`ask` 拒绝；`allow` 不问直接允许 |
  | `remoteConfirmTimeoutMs` | `600000` | 审批与提问的等待上限（1 秒到 1 天） |
  | `openDesktop` | `false` | 「创建会话」后用 `open dsh://open` 把 Desktop 窗口拉到前台 |
  | `nameWaitMs` | `10000` | 创建会话后等模型起标题的时间 |
  | `inboxDir` | `<数据目录>/inbox` | 附件落地目录 |
  | `dirAliases` | `{"home": "~"}` | 没有 `aliases.json` 时使用的初始目录别名 |
- 首选 Desktop「设置 → 企微远程」扫码（见下节）；命令行是后备：`node bin/dsh-remote.mjs setup` 写入 BotID / Secret 并生成 6 位绑定码，`bind` 解除原主人并重新生成绑定码，`status` 看状态，`alias` 管理目录别名。插件约每 5 秒检查 `config.json` / `bind.json` 的 mtime，变化后停掉并重建遥控实例（插件自己绑定主人时的写入不算），不必重启 Desktop。
- 同一 BotID 只能一条长连接：不能与 pi remote、dsh-im 企微通道共用机器人。

## 设置页

插件带一个客户端模块：`package.json` 的 `dsh.client`（`platform: 'web'`，inject `dsh-client-connection` / `dsh-client-locale` / `dsh-client-ui-settings`）加 `exports['./client']` 指向 `dist/client.js`。DSH 把它打进 `index.html` 的 `__DSH_BOOT__` 启动图，从 `plugins/??dsh-remote-wecom/client.js` 提供；文件缺失会让客户端激活失败，所以安装必须 `npm run build`（`dist/` 不进 git，但在 `files` 里）。`client/` 是 React（外部化，用宿主的 react / react-dom），esbuild 打成 CJS 并包进 `window.__ModuleLoader__.load({id, factory})`。

- 入口：`ctx.slots.inject('settings.section', ...)` 注册 id `dsh-remote-wecom`、标签「企微远程 / WeCom Remote」、`order: 30`（排在原生分区之后）。文案走 `ctx.locale`（zh / en）。样式是 `drw-` 前缀的类，只注入一次 `<style>`，只用 DSH 的 CSS 变量，照抄原生设置的行、按钮、开关、输入框尺寸，深浅色跟随宿主。二维码底固定白色，深色模式下也能扫。
- 传输：host 侧 `ctx.connection.fetch.register({path: '/api/dsh-remote-wecom/settings', methods: ['POST']})`，放在 `ctx.effect` 里随插件注销。客户端 `ctx.connection.rpc.call('/api', 'dsh-remote-wecom/settings', {method, payload})`，信封 `client-request` / `server-response`，失败结果带 `error.details`。
- 方法：`state`、`qrStart` / `qrCancel`、`saveCredentials`、`newBindCode`、`unbind`、`setPrefs`、`setPlace`、`restart`。都返回完整的 `state`（连接状态与原因、掩码后的 BotID 和主人、绑定码与到期时间、自动绑定窗口、偏好、新会话位置、扫码状态），参数不对时返回 `{ok: false, error: {code: 'invalid', message}}`，前端在对应行内显示红字。前端每 2 秒拉一次 `state`（页面隐藏时跳过）。
- 生效：写完配置立即重建遥控实例，并先刷新 mtime 快照，5 秒轮询不会再触发一次。改偏好、解绑、重新生成绑定码时不发「已重启」通知；「重启服务」和其他重启一样，只在手机 30 分钟内用过或有推送中的任务被中断时通知；换凭证后是新机器人，发欢迎语。请求最多等 2.5 秒重连完成再返回状态。

### 扫码创建机器人

`lib/core/qr-auth.mjs`：`generate` 拿 `scode` 和 `auth_url`（只接受 `https://work.weixin.qq.com`），host 用 `qrcode` 把 `auth_url` 编成 PNG data URL 下发；之后每 3 秒 `query_result`，成功即拿到 BotID / Secret。5 分钟过期，连续 3 次请求出错记为失败。同一时间只有一个轮询任务，插件停止时取消。`fetch` 和 base URL 可注入（插件配置 `qrBaseUrl` / `qrPollMs`，只允许 https 或回环 http），测试和预览都用假接口。

状态：`idle` → `waiting`（有二维码）→ `connecting`（写凭证并重连）→ `idle`；或 `expired`（保留旧码作蒙层背景）/ `failed`。

### 自动绑定

扫码成功后写凭证（换了机器人就清掉原主人），并在 `bind.json` 里同时写 6 位绑定码和 `auto: {expiresAt: now + 10min}`。窗口内第一条单聊消息（不含 `enter_chat` 事件和群聊）的发送人成为主人，窗口外退回绑定码。错码 5 次锁定优先于自动绑定，已有主人时不生效。手动填写和命令行 `setup` 不开窗口。未绑定时重新生成绑定码会保留仍在有效期的窗口；解绑已有主人时不会重新打开窗口。

### 安全取舍

- 只接回环：路由校验 `Host` 与 `Origin` 都是回环地址，否则 403；只收 `POST` + `application/json`。另外还有 DSH 自己的登录 cookie（未登录 401）和 Host / Origin 检查。代价是把 DSH web 暴露到局域网时设置页不可用，只能用命令行。
- 不回传 Secret：任何返回都不含 Secret，BotID 和主人 userid 都做掩码。前端不能显示或校对已存的 Secret，要换就重新扫码或重新填写。绑定码本身会显示在页面上，它本来就是要给人看的。
- 自动绑定窗口：10 分钟内任何能给这个机器人发单聊的人，都可能抢先成为主人。可以接受是因为机器人刚由扫码人创建，还没人知道它。窗口只开一次，绑定后立即关闭；页面显示主人掩码，绑错了可以解绑重来。

## Desktop 离线看门狗

插件随 Desktop 启停，macOS 上 Cmd+Q 后企微无人接。设置页「桌面端退出后仍可拉起」（`setWatchdog`）或 `dsh-remote-wecom watchdog install` 装一个 launchd LaunchAgent（`KeepAlive`）跑 `watchdog run`，每 2 秒 tick 一次（`lib/core/watchdog.mjs`）。

- 登记在 `lib/core/launchd.mjs`。可执行文件优先用 Desktop 自带的 Electron（`ELECTRON_RUN_AS_NODE=1`，与 dsh 命令行相同），不依赖用户的 Node。这样的进程不向 LaunchServices 登记，`open -b` 照常拉起 Desktop；但进程名同为 `DeepSeek Harness`，判断 Desktop 是否在运行要用 `lsappinfo find bundleid=...`，不能用 `pgrep`。
- 插件启动时 `sync()`：登记指向本数据目录且内容与当前插件路径不一致（pnpm 升级后路径会变）或未加载时重装；指向其他数据目录的登记（如测试）不动。插件配置 `watchdog: false` 隐藏开关，`watchdogDryRun: true`（预览、e2e）把 plist 写进数据目录且不调 launchctl。

- 交接靠心跳：插件 `apply` 时先写 `alive.json`（先于连企微），此后每 10 秒刷新，插件停止且遥控实例收尾后删除（只删自己 pid 写的）。心跳 30 秒内新鲜时看门狗不连、已连则断开；未配置或未绑定主人也不连。配置重载只重建遥控实例，心跳不断。
- 企微服务端在新连接建立时向旧连接发 `disconnected_event` 并断开，SDK 不重连被踢的一方。插件上线时挤掉看门狗是预期路径；看门狗被其他连接踢掉时退避 5 分钟，避免与重复部署互踢。反向竞争（看门狗刚好在插件连上后才连，把插件踢掉）：传输层记 `kickedAt`，看门狗下一个 tick 看到心跳会断开并把 `watchdog.json` 写成 `connected:false`，插件心跳 tick 发现「被踢之后看门狗已让出」就重建遥控实例。
- 看门狗复用 `WeComTransport`（只接主人单聊、msgid 去重、附件先下载到 `inbox/`、发件箱），关掉欢迎语与重启通知（不消费插件写的 `restart.json`），进会话提示换成离线文案。入站消息写 `spool/<at>-<uuid>.json`（`text`、已落盘附件、引用、时间），并 `open -g -j -b com.deepseek.dsh` 后台拉起 Desktop，成功后写 `launched.json`。拉起成功不回手机，只有失败或 2 分钟后仍无心跳才提示。卡片回调依赖插件内存状态，只提示重新操作。
- 插件 `remote.start()` 给传输层挂 `replaySpool`：首次 `authenticated` 时取出并删除全部暂存（至多一次），排进入站队列依次走 `handleCommand`，超过 30 分钟的只提示。重连不再重放。同时消费 `launched.json`：被拉起或有暂存时静默消费 `restart.json`（不发「已重启」），有暂存就直接回结果，只有卡片触发的拉起（无暂存）才发「已拉起，可以重新操作」。
- `watchdog install` 在 Desktop 进程存在但没有新鲜心跳时拒绝（旧版插件不写心跳，装上就会踢掉它），`--force` 跳过。

## 验证

- 单元测试：从 pi remote 搬来的宿主无关测试（传输、配置、别名、产物过滤），加上设置页的扫码流程、RPC 方法与路由校验、自动绑定。
- 设置页端到端（`tests/e2e-settings.test.mjs`）：隔离的 dsh web，验证启动图里有客户端模块且提供的就是 `dist/client.js`、未登录 401 / 非回环 403、假扫码接口第 3 次轮询成功后连上假企微、群聊不认主而单聊认主、改偏好重连且不发重启通知、所有响应不含 Secret。界面用 `scripts/preview.mjs` 人工看。
- 端到端：`devDependencies` 带 `@deepseek-ai/dsh@0.2.1-rc.2`，测试用隔离 `DSH_HOME` 起 `dsh --profile web --patch`，加载脚本化假 LLM（`tests/fixtures/mock-llm.mjs`，标题取首条消息的第一个词）、代替 Desktop 窗口发起电脑轮次的 `tests/fixtures/desktop-probe.mjs` 和本插件，中途重启一次 dsh 让旧会话变成历史会话，企微侧用 `ws` 假服务器（`wsUrl` 配置），覆盖绑定、活跃/历史/创建会话、投递与回传、停止、切模型与思考强度、压缩、状态、产物、审批与提问卡片、关注/取关、引用路由。
- 真机：安装到 `~/.dsh/profiles/desktop`（profile `package.json` 加 `link:` 依赖与 bundle，用 Desktop 自带 pnpm 安装；CLI 拒绝改 desktop profile），重启 Desktop，用专用机器人走一遍主流程。
