# dsh-remote-wecom

[![npm](https://img.shields.io/npm/v/dsh-remote-wecom)](https://www.npmjs.com/package/dsh-remote-wecom)

> Control DeepSeek Harness Desktop sessions from WeCom (企业微信) on your phone: send messages, receive results, switch sessions and models, answer approvals and questions, fetch artifacts. The docs are in Chinese; commands and cards are Chinese-first.

在手机企业微信里遥控 DeepSeek Harness Desktop 的会话：发消息、看结果、切会话、切模型、审批与回答提问、取回产物。命令、卡片和推送策略与 [pi-remote-wecom](https://github.com/lukeinx/pi-remote-wecom) 一致，宿主换成 DSH。

它是一个 DSH bundle 插件，跑在 Desktop 的 host 进程里，自己持有企微智能机器人长连接；Desktop 关闭即离线。设计与宿主接口见 [docs/DESIGN.md](docs/DESIGN.md)。

## 与 pi-remote-wecom、dsh-im 的关系

- [pi-remote-wecom](https://github.com/lukeinx/pi-remote-wecom)：遥控 pi 终端 / 后台会话的 launchd daemon + pi 扩展。本项目搬来它的宿主无关部分（企微传输、命令与中文别名、卡片、推送与引用路由、关注/取关、目录别名、产物、outbox、附件），把 TUI / RPC 会话换成 Desktop 会话，HTTP 协议换成插件内直接调用 DSH 会话控制器。两者互不依赖，可以同时运行，但要用不同的机器人。
- `@xmanrui/dsh-im`：DSH 官方生态里的多 IM 插件，企微交互是斜杠命令 + 单聊绑定单会话。本项目只参考了它的插件写法和审批 / 提问抢答方式，不依赖它；如果它的企微通道和本插件用同一个 BotID，两边会互相顶掉长连接。

## 要求

- DeepSeek Harness Desktop（DSH `>=0.2.0-rc.2`，在 `0.2.1-rc.2` 上验证）
- Node.js `>=22.19.0`（运行配置命令用）
- 一个专用的企业微信智能机器人（长连接模式，拿到 BotID 和 Secret）。同一个 BotID 只能有一条长连接，不能与 pi-remote-wecom、dsh-im 企微通道共用。

## 安装

`desktop` profile 只归 Desktop 管，`dsh plugin --profile desktop add` 会报 `managed exclusively by the Electron application`。所以要先退出 Desktop，手动改 profile 的 `package.json`，再用 Desktop 自带的 pnpm 安装。

1. 完全退出 DeepSeek Harness Desktop。
2. 编辑 `~/.dsh/profiles/desktop/package.json`，保留已有条目，只加两处：

   ```json
   {
     "dependencies": {
       "dsh-remote-wecom": "^0.1.0"
     },
     "dsh": {
       "profile": {
         "bundles": ["…已有条目…", "dsh-remote-wecom"]
       }
     }
   }
   ```

3. 安装并启动 Desktop：

   ```sh
   cd ~/.dsh/profiles/desktop
   node "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" install
   open -a "DeepSeek Harness"
   ```

4. 打开「设置 → 企微远程」，能看到二维码即安装成功，接着按下面「配置与绑定」操作。

升级：改 `dependencies` 里的版本号后重复第 3 步。

从源码安装（开发用）：先 `git clone https://github.com/lukeinx/dsh-remote-wecom.git && cd dsh-remote-wecom && npm install && npm run build`（`build` 生成设置页前端 `dist/client.js`，它不进 git，缺了 Desktop 会加载失败），第 2 步的依赖写成 `"dsh-remote-wecom": "link:<仓库绝对路径>"`。改了插件代码（含重新 `npm run build` 的设置页）要重启 Desktop 才生效，配置变化不用。

### 命令行

配置、绑定和看门狗还有命令行入口。下文的 `dsh-remote-wecom` 命令指向 profile 里装好的那份：

```sh
alias dsh-remote-wecom='node ~/.dsh/profiles/desktop/node_modules/dsh-remote-wecom/bin/dsh-remote.mjs'
```

源码安装时直接用仓库里的 `node bin/dsh-remote.mjs`。不要用 `npx dsh-remote-wecom` 安装看门狗，`npx` 的缓存目录随时会被清掉。

### 让 Agent 代装

把本 README 交给 coding agent 时，请它遵守：

- 改 `~/.dsh/profiles/desktop/package.json` 前先退出 Desktop，只追加条目，不删除、不重排已有的 `dependencies` 和 `bundles`。
- 不用 `dsh plugin --profile desktop add`（会被拒绝），用上面的 pnpm 命令。
- 不读取、不打印 `config.json` 里的 Secret；扫码和发绑定码需要用户本人在手机上完成，Agent 只负责打开设置页或运行 `dsh-remote-wecom setup`。
- 验证用 `dsh-remote-wecom status`：出现 `Secret：已配置` 和 `主人：已绑定` 即完成；末尾日志可以看连接情况。
- 在本仓库里改代码前先读 [AGENTS.md](AGENTS.md)。

### Desktop 离线看门狗（可选，macOS）

插件跑在 Desktop 进程里，Desktop 退出后企微就没人接了。看门狗是一个 launchd 常驻进程，补上这段：

```sh
dsh-remote-wecom watchdog install    # 写入 ~/Library/LaunchAgents 并启动，登录后自动运行
dsh-remote-wecom watchdog status     # 是否运行、插件心跳、暂存消息数、最近日志
dsh-remote-wecom watchdog uninstall
```

- 插件运行时每 10 秒写一次心跳（`alive.json`），看门狗只在心跳超过 30 秒没更新时才连企微，平时不占连接。
- Desktop 离线时发来的消息先暂存到 `spool/`（附件已下载到 `inbox/`），看门狗用 `open -g -j` 在后台拉起 Desktop。插件上线后连上企微（同一机器人只能有一个连接，看门狗随即被挤下线），按顺序处理暂存的消息；超过 30 分钟的只提示不执行。拉起是预期路径，中间不发「已启动 / 已重启 / 开始处理」之类的通知，手机直接收到结果；只有拉起失败或超时才提醒。
- 卡片点击引用的是插件内存里的状态，离线期间点了只提示重新操作，Desktop 拉起上线后再提醒一次。
- 拉起 2 分钟后插件仍未上线（比如插件被停用），手机会收到提醒。
- 安装时如果 Desktop 正在运行却没有心跳（还是旧版本插件），会拒绝安装：先重启 Desktop 加载新插件再装，否则看门狗会把正在运行的插件挤下线。
- 安装时记下当前 Node 和插件所在路径，换 Node 版本、升级插件或移动仓库后要重新 `watchdog install`。

## 配置与绑定

推荐在 Desktop 里完成：**设置 → 企微远程**。

1. 页面显示二维码，用企业微信扫码并确认，自动创建智能机器人并写入 BotID / Secret（`config.json`，权限 600），插件随即连接。
2. 扫码成功后 10 分钟内，在企业微信里给这个机器人发任意一条单聊消息，发送人即成为主人。页面同时给出 6 位备用绑定码，自动绑定窗口过了也可以发绑定码完成绑定。之后只接主人的单聊消息。
3. 绑定后在同一页可以：更换机器人（重新扫码）、解绑账号或换绑定码、选「新会话位置」（Desktop 工作区或未分组，与手机上的 `工作区` 命令是同一项；宿主不支持工作区时不显示）、改「手机审批」的超时策略与秒数、开关「新建会话时打开 Desktop」、重新连接；目录别名只能用命令行 `alias` 管理。改动即时保存、立即生效。

扫不了码时，页面上的「手动填写 BotID」可以直接输入已有机器人的 BotID / Secret。也可以用命令行（结果相同）：

```sh
dsh-remote-wecom setup                         # 交互输入 BotID / Secret
dsh-remote-wecom setup --bot-id ID --secret S  # 非交互
```

`setup` 写入 `config.json` 并打印 6 位绑定码，在机器人单聊里发送绑定码，第一个发对的人成为主人。运行中的插件每 5 秒检查一次 `config.json` / `bind.json`，命令行改动后自动重连，不必重启 Desktop。

| 命令 | 作用 |
|---|---|
| `setup [--bot-id ID --secret S]` | 写入凭证；未绑定时生成绑定码（换机器人会清掉原主人） |
| `bind` | 解除当前主人，生成新绑定码（10 分钟有效，错 5 次作废） |
| `status` | 配置、绑定状态、待发消息和最近日志（不显示 Secret） |
| `alias [名称 目录 \| rm 名称]` | 查看或修改目录别名（「创建会话 别名 消息」「工作区 别名」用；别名目录是 Desktop 工作区时归入该工作区，否则进「未分组」） |
| `watchdog install\|uninstall\|status` | Desktop 离线看门狗，见上面「安装」 |

所有命令都可加 `--dir 目录` 指定数据目录。

数据目录默认 `$DSH_HOME/integrations/dsh-remote-wecom/`（`DSH_HOME` 默认 `~/.dsh`），里面有 `config.json`、`bind.json`、`aliases.json`、`.default-place`（新建会话的默认工作区）、`phone-sessions.json`（最近一次用户消息来自手机的会话）、`outbox/`（断网待发）、`inbox/`（手机发来的附件）、`alive.json`（插件心跳）、`spool/` 与 `watchdog.log`（看门狗暂存的消息和日志）、`bridge.log` 等。

`config.json` 可选项：

| 字段 | 默认 | 说明 |
|---|---|---|
| `remoteConfirm` | `ask-then-allow` | 手机发起的任务里，审批转企微卡片；超时后 `ask-then-allow` 允许、`ask` 拒绝；`allow` 不问直接允许 |
| `remoteConfirmTimeoutMs` | `600000` | 审批与提问的等待上限（1 秒到 1 天） |
| `openDesktop` | `false` | 「创建会话」后用 `open dsh://open` 把 Desktop 窗口拉到前台（锁屏时跳过）；Desktop 对这个链接只做聚焦窗口，不会切到新会话 |
| `nameWaitMs` | `10000` | 创建会话后等模型起标题的时间，超时用首条消息截断的临时标题 |
| `inboxDir` | `<数据目录>/inbox` | 附件落地目录 |
| `dirAliases` | `{"home": "~"}` | 在没有 `aliases.json` 时使用的初始目录别名 |

## 常用命令

**手机企微**：选中会话后，直接发消息即可。引用某条推送回复，消息会发给推送所属的会话，并把它切为当前会话。有其他会话推送过、你还没回过消息时，不引用直接发的消息会先暂存，弹卡片让你在当前会话和推送过的会话里选，选完直接投递。

命令与 pi-remote-wecom 相同；「DSH 下」一栏列出行为差异，空着的表示一致。

| 缩写 | 命令 | 用途 | DSH 下 |
|---|---|---|---|
| `ls` | `活跃会话` / `切换会话` | 选择活跃会话 | 活跃 = 运行中、当前选中、Desktop 置顶的会话，加上最近 24 小时有活动的（最多 10 个）；不含 subagent 和已归档，Desktop 重启不影响；置顶在前（📌），其余按 Desktop 侧栏的工作区顺序分组、未分组最后，每项标出工作区 |
| `h` | `历史会话 [关键词]` | 查找并继续历史会话；默认隐藏 subagent 会话，加 `全部` 才显示（如 `历史会话 全部 关键词`） | 只检索会话名和每轮用户消息摘要，不检索回复；Desktop 里已归档的会话也要加 `全部` 才显示 |
| `n` | `创建会话 [工作区] [消息]` / `新建会话` | 新建会话并投递首条消息 | 第一个词是工作区名、`未分组`、目录别名或 `~/路径` 时作为位置，否则用 `工作区` 选的默认位置；`openDesktop` 打开时新建后 `open dsh://open` 拉起窗口（没有跳到指定会话的入口，需在侧栏点开），默认不拉起 |
| `nb` | `创建后台会话 [工作区] [消息]` / `新建后台会话` | 新建会话，不拉起窗口 | 同样是 Desktop 会话，不管 `openDesktop` 都不拉起 |
| `steer` | `插话 内容` | 把内容插进正在运行的这一轮，结果随这一轮推回；空闲时等同普通消息 | DSH 独有。直接发消息仍是排到下一轮 |
| `perm` | `权限模式 [模式名]` / `切换权限模式 [模式名]`（也可 `切换权限`；单发 `权限` 只弹卡片） | 切换当前会话的权限模式（如 read-only / workspace-write） | DSH 独有，走 `/permission`，只影响这个会话 |
| `goal` | `目标 [描述]` / `目标 修改 描述` / `目标 暂停` / `目标 继续` / `目标 清除` | 给当前会话设一个长期目标，模型在同一会话里自动续跑，直到完成、受阻、暂停或到达轮数上限；不带参数弹卡片看状态、点选操作 | DSH 独有，走 `/goal`。中间各轮不推，结束时推一条并附最后一轮结果；Desktop 重启后执行中的目标不会自己接着跑，发 `目标 继续` |
| `select N [消息]` | `选择会话 N [消息]` | 按列表序号切换，可顺带消息 | |
| `model` | `切换模型 [关键词]` / `模型 [关键词]` | 切换当前会话的模型 | 列出 DSH 模型目录里可路由的全部模型，没有 scope 之分 |
| `think` | `切换思考强度 [强度]` / `思考强度 [强度]` | 切换思考强度；只列当前模型支持的级别 | 级别取模型目录的 `reasoning.efforts` |
| `compact` | `压缩会话 [说明]` / `压缩 [说明]` | 手动压缩当前会话上下文；运行中不可压缩 | 不支持指定压缩重点，带说明时照常压缩并在卡片提示 |
| `restart` | `重启 [force]` / `重启服务` | 重启遥控服务；有任务运行时默认拒绝并列出占用会话，`重启 force` 强制 | 只重建插件内的遥控实例（重读配置、重连企微），不重启 Desktop，任务继续跑 |
| `cd` | `工作区 [名称]` / `切换工作区`（也可 `目录`、`切换目录`） | 选择新建会话的默认位置 | pi 里是选目录；DSH 里列出 Desktop 的工作区和「未分组」（默认），不是工作区的别名目录新会话进未分组 |
| `art` | `产物` / `查看产物` | 列出当前会话生成的 html/md/pdf/docx/xlsx/pptx/png/svg 文件（不含 git 跟踪的文件、隐藏目录和临时目录）：不超过 3 个直接发送，更多时卡片多选 | 来源是 `write` / `edit` / `present` 工具和回复里的文件链接 |
| `remote` / `mute` | `关注` / `取关`（也可 `取消关注`、`静音`） | 出门时 `关注`：电脑上发起的任务完成后也推送；回到电脑前 `取关`：只推手机发起的 | `关注` 后电脑发起的任务的审批也发到手机（Desktop 关窗后任务还在跑），`取关` 后留在 Desktop |
| `status` / `stop` / `help` | `状态` / `停止` / `帮助` | 查看状态、中断任务、查看全部命令 | 状态卡片显示工作区（分支）、模型·思考强度、上下文、权限模式与 token 用量，没有花费和扩展状态项 |

图片或文件可先发送，再在 5 分钟内补充说明；每次最多 10 件，每件不超过 100MiB。任务完成后自动回传结果，长结果以文件发送。

中文别名需要与参数用空白字符分隔：`模型 high` 是命令，`模型high` 会当作普通消息发出。

**电脑**：在「设置 → 企微远程」里管理，见上面的「配置与绑定」；没有 pi 里的 `/remote`、`/tabmodel`、`/tabname`（会话名由 DSH 自动生成）。

其他行为：

- 手机发的消息 2 秒内完成就直接回结果，否则回「运行中」，完成后推送；超长结果转成 Markdown 文件。
- 手机发起的任务里，审批和 `ask_user_question` 提问会同时出现在手机和 Desktop，谁先答用谁的；当前没选中的会话的弹窗先挂起，切过去时补推。多题逐题推送，可点选也可自己写。审批无人处理时按 `remoteConfirm` 决定。电脑发起的任务：提问也推手机，审批只在 `关注` 后推。
- 定时提醒（`schedule_*` 工具设的）和目标续跑（goal）自动跑的轮次：会话最近一次用户消息来自手机（或目标是在手机上设定 / 继续的）时推回手机，最近一次来自电脑时按电脑发起处理。定时任务每次都推（「⏰ 定时任务完成」）；目标续跑只在结束时推一条（「🎯 目标已完成 / 受阻 / 已暂停 / 到达轮数上限 / 已清除」），正文是最后一轮的结果，中途被中断或出错的一轮照常推。
- 往 Desktop 里已归档的会话发消息（引用旧推送、「历史会话 全部」选中）会先取消归档并提示；取消失败时 DSH 会拦下这一轮，手机收到「任务失败」。

## 限制

- 不装看门狗时，Desktop 未运行就离线；装了也只是暂存消息、拉起 Desktop，任务仍在 Desktop 里跑。
- `compact` 不支持指定压缩重点（DSH `0.2.1-rc.2` 的 `/compact` 不接受参数），带说明时照常压缩并提示。
- 历史检索只搜会话名和每轮用户消息的摘要（`turnOutline`），不搜回复。
- 产物来自插件运行期间的事件，打开会话时再用最近 1000 条消息范围的快照补扫；临时目录、隐藏目录和 git 跟踪的文件不算产物。
- 不能在手机上添加、移除或重命名工作区，也不能改会话名、分叉会话。
- 插件随 Desktop 启停：Desktop 退出时，运行中的手机任务回一条「任务中断」（结果不再送回，任务本身可能已在电脑上完成），下次启动后收到「已重启」通知。「已重启」只在手机端用得上时发：手机发了 `重启`、重启时有推送中的任务被中断，或手机 30 分钟内用过；在电脑上随手重启 Desktop 不提醒；被看门狗拉起时也不发。看门狗暂存的消息是「至多一次」：插件取出即删，处理到一半时 Desktop 崩溃，剩下的不会重放。
- 「关注」「取关」只在内存里生效：插件重启后恢复推送绑定会话的电脑任务，电脑发起的审批不再转手机。

## 开发

```sh
npm install
npm run build     # 打包设置页前端 client/ → dist/client.js
npm test          # 单元测试
npm run check     # build + 全部源文件语法检查 + 单元测试
npm run check:public  # 发布前检查：不含内网链接、本机路径，package.json 指向公开仓库
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
