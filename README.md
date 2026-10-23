# dsh-remote-wecom

在手机企业微信里遥控 DeepSeek Harness Desktop 的会话：发消息、看结果、切会话、切模型、审批与回答提问、取回产物。命令、卡片和推送策略与 [pi-remote-wecom](../pi-remote-package) 一致，宿主换成 DSH。

它是一个 DSH bundle 插件，跑在 Desktop 的 host 进程里，自己持有企微智能机器人长连接；Desktop 关闭即离线。设计与宿主接口见 [docs/DESIGN.md](docs/DESIGN.md)。

## 与 pi-remote-wecom、dsh-im 的关系

- [pi-remote-wecom](../pi-remote-package)：遥控 pi 终端 / 后台会话的 launchd daemon + pi 扩展。本项目搬来它的宿主无关部分（企微传输、命令与中文别名、卡片、推送与引用路由、关注/取关、目录别名、产物、outbox、附件），把 TUI / RPC 会话换成 Desktop 会话，HTTP 协议换成插件内直接调用 DSH 会话控制器。两者互不依赖，可以同时运行，但要用不同的机器人。
- `@xmanrui/dsh-im`：DSH 官方生态里的多 IM 插件，企微交互是斜杠命令 + 单聊绑定单会话。本项目只参考了它的插件写法和审批 / 提问抢答方式，不依赖它；如果它的企微通道和本插件用同一个 BotID，两边会互相顶掉长连接。

## 要求

- DeepSeek Harness Desktop（DSH `>=0.2.0-rc.2`，在 `0.2.1-rc.2` 上验证）
- Node.js `>=22.19.0`（运行配置命令用）
- 一个专用的企业微信智能机器人（长连接模式，拿到 BotID 和 Secret）。同一个 BotID 只能有一条长连接，不能与 pi-remote-wecom、dsh-im 企微通道共用。

## 安装

`desktop` profile 只归 Desktop 管，`dsh plugin --profile desktop add` 会报 `managed exclusively by the Electron application`。先退出 Desktop，再手动加进 profile：

```sh
cd dsh-remote-wecom && npm install && npm run build   # build 生成设置页前端 dist/client.js（不进 git，缺了 Desktop 会加载失败）
cd ~/.dsh/profiles/desktop
# package.json：dependencies 加 "dsh-remote-wecom": "link:<本仓库绝对路径>"，dsh.profile.bundles 末尾加 "dsh-remote-wecom"
node "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" install
```

然后启动 DeepSeek Harness Desktop。改了插件代码（含重新 `npm run build` 的设置页）要重启 Desktop 才生效，配置变化不用。

## 配置与绑定

推荐在 Desktop 里完成：**设置 → 企微远程**。

1. 页面显示二维码，用企业微信扫码并确认，自动创建智能机器人并写入 BotID / Secret（`config.json`，权限 600），插件随即连接。
2. 扫码成功后 10 分钟内，在企业微信里给这个机器人发任意一条单聊消息，发送人即成为主人。页面同时给出 6 位备用绑定码，自动绑定窗口过了也可以发绑定码完成绑定。之后只接主人的单聊消息。
3. 绑定后在同一页可以：更换机器人（重新扫码）、解绑账号或换绑定码、选「新会话位置」（Desktop 工作区或未分组，与手机上的 `工作区` 命令是同一项；宿主不支持工作区时不显示）、改「手机审批」的超时策略与秒数、开关「新建会话时打开 Desktop」、在折叠的「其他目录」里管理目录别名（已是工作区的会标出）、重新连接。改动即时保存、立即生效。

扫不了码时，页面上的「手动填写 BotID」可以直接输入已有机器人的 BotID / Secret。也可以用命令行（结果相同）：

```sh
node bin/dsh-remote.mjs setup                         # 交互输入 BotID / Secret
node bin/dsh-remote.mjs setup --bot-id ID --secret S  # 非交互
```

`setup` 写入 `config.json` 并打印 6 位绑定码，在机器人单聊里发送绑定码，第一个发对的人成为主人。运行中的插件每 5 秒检查一次 `config.json` / `bind.json`，命令行改动后自动重连，不必重启 Desktop。

| 命令 | 作用 |
|---|---|
| `setup [--bot-id ID --secret S]` | 写入凭证；未绑定时生成绑定码（换机器人会清掉原主人） |
| `bind` | 解除当前主人，生成新绑定码（10 分钟有效，错 5 次作废） |
| `status` | 配置、绑定状态、待发消息和最近日志（不显示 Secret） |
| `alias [名称 目录 \| rm 名称]` | 查看或修改目录别名（「创建会话 别名 消息」「目录 别名」用） |

所有命令都可加 `--dir 目录` 指定数据目录。

数据目录默认 `$DSH_HOME/integrations/dsh-remote-wecom/`（`DSH_HOME` 默认 `~/.dsh`），里面有 `config.json`、`bind.json`、`aliases.json`、`outbox/`（断网待发）、`inbox/`（手机发来的附件）、`bridge.log` 等。

`config.json` 可选项：

| 字段 | 默认 | 说明 |
|---|---|---|
| `remoteConfirm` | `ask-then-allow` | 手机发起的任务里，审批转企微卡片；超时后 `ask-then-allow` 允许、`ask` 拒绝；`allow` 不问直接允许 |
| `remoteConfirmTimeoutMs` | `600000` | 审批与提问的等待上限（1 秒到 1 天） |
| `openDesktop` | `true` | 「创建会话」后用 `open dsh://open` 把 Desktop 拉到前台（锁屏时跳过） |
| `nameWaitMs` | `5000` | 创建会话后等模型起标题的时间，超时用首条消息截断的临时标题 |
| `inboxDir` | `<数据目录>/inbox` | 附件落地目录 |
| `dirAliases` | `{"home": "~"}` | 在没有 `aliases.json` 时使用的初始目录别名 |

## 常用命令

**手机企微**：选中会话后，直接发消息即可。引用某条推送回复，消息会发给推送所属的会话，并把它切为当前会话。有其他会话推送过、你还没回过消息时，不引用直接发的消息会先暂存，弹卡片让你在当前会话和推送过的会话里选，选完直接投递。

命令与 pi-remote-wecom 相同；「DSH 下」一栏列出行为差异，空着的表示一致。

| 缩写 | 命令 | 用途 | DSH 下 |
|---|---|---|---|
| `ls` | `活跃会话` / `切换会话` | 选择活跃会话 | 活跃 = Desktop 里 agent 已加载或正在运行的会话（不含 subagent），加上手机打开过的 |
| `h` | `历史会话 [关键词]` | 查找并继续历史会话；默认隐藏 subagent 会话，加 `全部` 才显示（如 `历史会话 全部 关键词`） | 只检索会话名和每轮用户消息摘要，不检索回复 |
| `n` | `创建会话 [目录] [消息]` / `新建会话` | 新建会话并投递首条消息 | 新建 Desktop 会话后 `open dsh://open` 拉起窗口（没有跳到指定会话的入口，需在侧栏点开） |
| `nb` | `创建后台会话 [目录] [消息]` / `新建后台会话` | 新建会话，不拉起窗口 | 同样是 Desktop 会话，只是不拉起 |
| `select N [消息]` | `选择会话 N [消息]` | 按列表序号切换，可顺带消息 | |
| `model` | `切换模型 [关键词]` / `模型 [关键词]` | 切换当前会话的模型 | 列出 DSH 模型目录里可路由的全部模型，没有 scope 之分 |
| `think` | `切换思考强度 [强度]` / `思考强度 [强度]` | 切换思考强度；只列当前模型支持的级别 | 级别取模型目录的 `reasoning.efforts` |
| `compact` | `压缩会话 [说明]` / `压缩 [说明]` | 手动压缩当前会话上下文；运行中不可压缩 | 不支持指定压缩重点，带说明时照常压缩并在卡片提示 |
| `restart` | `重启 [force]` / `重启服务` | 重启遥控服务；有任务运行时默认拒绝并列出占用会话，`重启 force` 强制 | 只重建插件内的遥控实例（重读配置、重连企微），不重启 Desktop，任务继续跑 |
| `cd` | `切换目录 [别名]` / `目录 [别名]` | 选择新建会话的默认目录（默认 `~`） | |
| `art` | `产物` / `查看产物` | 列出当前会话生成的 html/md/pdf/docx/xlsx/pptx/png/svg 文件（不含 git 跟踪的文件、隐藏目录和临时目录）：不超过 3 个直接发送，更多时卡片多选 | 来源是 `write` / `edit` / `present` 工具和回复里的文件链接 |
| `remote` / `mute` | `关注` / `取关`（也可 `取消关注`、`静音`） | 出门时 `关注`：电脑上发起的任务完成后也推送；回到电脑前 `取关`：只推手机发起的 | |
| `status` / `stop` / `help` | `状态` / `停止` / `帮助` | 查看状态、中断任务、查看全部命令 | 状态卡片显示目录（分支）、模型·思考强度、上下文与 token 用量，没有花费和扩展状态项 |

图片或文件可先发送，再在 5 分钟内补充说明；每次最多 10 件，每件不超过 100MiB。任务完成后自动回传结果，长结果以文件发送。

中文别名需要与参数用空白字符分隔：`模型 high` 是命令，`模型high` 会当作普通消息发出。

**电脑**：在「设置 → 企微远程」里管理，见上面的「配置与绑定」；没有 pi 里的 `/remote`、`/tabmodel`、`/tabname`（会话名由 DSH 自动生成）。

其他行为：

- 手机发的消息 2 秒内完成就直接回结果，否则回「运行中」，完成后推送；超长结果转成 Markdown 文件。
- 手机发起的任务里，审批和 `ask_user_question` 提问会同时出现在手机和 Desktop，谁先答用谁的；当前没选中的会话的弹窗先挂起，切过去时补推。多题逐题推送，可点选也可自己写。审批无人处理时按 `remoteConfirm` 决定。

## 限制

- Desktop 未运行时离线；没有独立的后台进程。
- `compact` 不支持指定压缩重点（DSH `0.2.1-rc.2` 的 `/compact` 不接受参数），带说明时照常压缩并提示。
- 历史检索只搜会话名和每轮用户消息的摘要（`turnOutline`），不搜回复。
- 产物来自插件运行期间的事件，打开会话时再用最近 1000 条消息范围的快照补扫；临时目录、隐藏目录和 git 跟踪的文件不算产物。
- 权限预设等 Desktop 侧设置不能在手机上改；电脑上发起的任务，审批和提问只在 Desktop 上弹（pi-remote-wecom 会把绑定终端会话里的提问也推到手机）。
- 插件随 Desktop 启停：Desktop 退出时，运行中的手机任务回一条「任务中断」（结果不再送回，任务本身可能已在电脑上完成），下次启动后收到「已重启」通知。
- 「取关」只在内存里生效，插件重启后恢复推送。

## 开发

```sh
npm install
npm run build     # 打包设置页前端 client/ → dist/client.js
npm test          # 单元测试
npm run check     # build + 全部源文件语法检查 + 单元测试
npm run test:e2e  # build 后用临时 DSH_HOME 起隔离的 dsh --profile web + 假 LLM + 假企微 + 假扫码接口，约 30 秒
```

端到端测试不碰 `~/.dsh`；会在 `$HOME` 下建一个临时工作目录（产物过滤会排除系统临时目录），结束时删除。

预览设置页（不碰 Desktop 和 `~/.dsh`，不请求真实扫码接口）：

```sh
node scripts/preview.mjs --state unconfigured   # 或 bound / unbound；--port 指定端口，默认随机
```

脚本用临时 `DSH_HOME` 起 web 版 DSH，接假企微和假扫码接口（第 3 次轮询返回成功），打印带 `?token=` 的地址，第一次必须用这个地址打开，之后浏览器靠 cookie 免 token。打开后点「继续」关掉预览版说明，再点「更多 → 设置 → 企微远程」。在终端输入一行文字，等于用户 alice 在企微单聊里发给机器人，用来走扫码后的自动绑定。Ctrl-C 退出并删除临时目录。

## 许可

MIT，见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。
