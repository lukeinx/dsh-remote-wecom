#!/usr/bin/env node
// 电脑端配置工具：只读写数据目录，运行中的插件约 5 秒内发现配置变化并重连。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import {parseArgs} from 'node:util';
import {BIND_FILE, BIND_TTL_MS, CONFIG_FILE, VERSION, applyCredentials, defaultDataDir, hasCredentials, loadConfig, readUserConfig, resetOwner} from '../lib/core/config.mjs';
import {checkName, expandDir, loadAliases, missingDirs, saveAliases, tildeDir} from '../lib/core/aliases.mjs';
import {execFileSync} from 'node:child_process';
import {DESKTOP_BUNDLE_ID, createWatchdog, heartbeatAge, heartbeatFresh, spoolCount, watchdogState} from '../lib/core/watchdog.mjs';
import {createLaunchd, launchdSupported} from '../lib/core/launchd.mjs';

const USAGE = `dsh-remote-wecom ${VERSION}

用法：
  dsh-remote-wecom setup [--bot-id ID --secret SECRET]   写入机器人凭证并生成绑定码（不带参数则交互输入）
  dsh-remote-wecom bind                                  重新生成绑定码（解除当前主人）
  dsh-remote-wecom status                                查看配置与最近日志
  dsh-remote-wecom alias [名称 目录 | rm 名称]           查看或修改目录别名
  dsh-remote-wecom watchdog install|uninstall|status     Desktop 离线看门狗（launchd）：暂存消息并后台拉起 Desktop

选项：
  --dir 目录   数据目录，默认 $DSH_HOME/integrations/dsh-remote-wecom（DSH_HOME 默认 ~/.dsh）`;

const LOG_TAIL = 20;

function printCode(code) {
  console.log(`\n绑定码：${code}（${BIND_TTL_MS / 60000} 分钟内有效）`);
  console.log('在企业微信里打开与该机器人的单聊，发送这 6 位数字完成绑定。');
}
async function prompt(question, {secret = false} = {}) {
  const rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: true});
  if (secret) rl._writeToOutput = s => { if (/\n|\r/.test(s) || s.startsWith(question)) process.stdout.write(s.startsWith(question) ? question : s); };
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

async function setup(dir, values) {
  const user = readUserConfig(dir);
  let botId = values['bot-id'];
  let secret = values.secret;
  if (!botId && !secret) {
    if (!process.stdin.isTTY) throw new Error('非交互环境请用 setup --bot-id ID --secret SECRET');
    botId = await prompt(`BotID${user.botId ? `（回车沿用 ${user.botId}）` : ''}：`) || user.botId;
    secret = await prompt('Secret：', {secret: true});
    process.stdout.write('\n');
  }
  if (!botId || !secret) throw new Error('BotID 和 Secret 都需要提供');
  const {bound, code} = applyCredentials(dir, {botId, secret});
  console.log(`配置已保存：${path.join(dir, CONFIG_FILE)}`);
  if (bound) {
    console.log('已绑定主人，保持不变；需要换绑时执行 dsh-remote-wecom bind。');
    return;
  }
  printCode(code);
  console.log('运行中的 DeepSeek Harness 会在约 5 秒内自动连接；若未安装插件，请先按 README 安装并重启 Desktop。');
}

function bind(dir) {
  const {unbound, code} = resetOwner(dir);
  if (unbound) console.log('已解除原主人的绑定。');
  printCode(code);
}

function status(dir) {
  console.log(`dsh-remote-wecom ${VERSION}`);
  console.log(`数据目录：${dir}`);
  let cfg;
  try { cfg = loadConfig(dir); }
  catch (e) { console.log(`配置：无效（${e.message}）`); return; }
  if (!hasCredentials(cfg)) console.log('配置：未配置机器人，运行 dsh-remote-wecom setup');
  else {
    console.log(`BotID：${cfg.botId}`);
    console.log('Secret：已配置');
    console.log(`主人：${cfg.ownerUserId ? '已绑定' : '未绑定'}`);
  }
  try {
    const b = JSON.parse(fs.readFileSync(path.join(dir, BIND_FILE), 'utf8'));
    const left = b.expiresAt - Date.now();
    console.log(`绑定码：${left > 0 ? `有效，剩余 ${Math.ceil(left / 60000)} 分钟` : '已过期，运行 dsh-remote-wecom bind 重新生成'}`);
  } catch {}
  console.log(`审批超时：${Math.round(cfg.remoteConfirmTimeoutMs / 1000)} 秒后${cfg.remoteConfirm === 'ask' ? '拒绝' : '允许'}${cfg.remoteConfirm === 'allow' ? '（remoteConfirm=allow，不询问）' : ''}`);
  let pending = 0;
  try { pending = fs.readdirSync(path.join(dir, 'outbox')).filter(f => f.endsWith('.json')).length; } catch {}
  if (pending) console.log(`待发消息：${pending} 条`);
  let lines = [];
  try { lines = fs.readFileSync(path.join(dir, 'bridge.log'), 'utf8').trimEnd().split('\n').slice(-LOG_TAIL); } catch {}
  console.log(lines.length ? `\n最近日志：\n${lines.join('\n')}` : '\n还没有日志：插件未运行过，或 Desktop 未重启。');
}

function alias(dir, args) {
  let table = loadAliases(dir);
  if (args[0] === 'rm' && args[1]) {
    const name = checkName(args[1]);
    if (!(name in table)) throw new Error(`没有别名「${name}」`);
    delete table[name];
    table = saveAliases(dir, table);
  } else if (args.length === 2) {
    const name = checkName(args[0]);
    table = saveAliases(dir, {...table, [name]: tildeDir(expandDir(args[1]))});
  } else if (args.length) throw new Error('用法：dsh-remote-wecom alias 名称 目录 | alias rm 名称');
  const rows = Object.entries(table);
  const missing = new Set(missingDirs(table));
  console.log(rows.length ? rows.map(([n, d]) => `${n} → ${d}${missing.has(n) ? '（目录不存在）' : ''}`).join('\n') : '还没有目录别名。');
}

const WATCHDOG_TICK_MS = 2000;
const WATCHDOG_LOG = 'watchdog.log';
const WATCHDOG_LOG_MAX = 1024 * 1024;

function watchdogRun(dir) {
  const file = path.join(dir, WATCHDOG_LOG);
  const log = line => {
    try {
      if (fs.statSync(file, {throwIfNoEntry: false})?.size > WATCHDOG_LOG_MAX) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, {mode: 0o600});
    } catch {}
  };
  const dog = createWatchdog({dir, log});
  log('看门狗启动');
  const tick = () => { try { dog.tick(); } catch (e) { log(`tick 失败：${e?.message || e}`); } };
  tick();
  const timer = setInterval(tick, WATCHDOG_TICK_MS);
  const quit = () => { clearInterval(timer); dog.stop(); setTimeout(() => process.exit(0), 300); };
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
}

// 看门狗进程用的也是 Desktop 的可执行文件，按进程名判断会误报；只认登记到 LaunchServices 的 App。
function desktopRunning() {
  try { return execFileSync('lsappinfo', ['find', `bundleid=${DESKTOP_BUNDLE_ID}`], {encoding: 'utf8'}).trim() !== ''; } catch { return false; }
}

function watchdogInstall(dir, force) {
  // 旧版插件不写心跳：此时装上看门狗会把正在运行的插件踢下线。
  if (!force && desktopRunning() && !heartbeatFresh(dir))
    throw new Error('DSH Desktop 正在运行，但插件没有心跳（可能是旧版本插件或插件未启用）。请先重启 Desktop 加载新版插件再安装；确认无误可加 --force。');
  const launchd = createLaunchd({dir});
  launchd.install();
  console.log(`看门狗已安装并启动：${launchd.file}`);
  console.log('也可以在 Desktop「设置 → 企微远程」里开关。');
}

function watchdogUninstall(dir) {
  createLaunchd({dir}).uninstall();
  console.log('看门狗已卸载。');
}

function watchdogStatus(dir) {
  const launchd = createLaunchd({dir});
  console.log(`看门狗：${launchd.loaded() ? '已安装并运行' : fs.existsSync(launchd.file) ? '已安装但未加载' : '未安装'}`);
  const age = heartbeatAge(dir);
  console.log(`插件心跳：${Number.isFinite(age) ? `${Math.round(age / 1000)} 秒前` : '无'}`);
  const wd = watchdogState(dir);
  if (wd) console.log(`企微连接：${wd.connected ? '看门狗持有' : '看门狗未连接'}（${new Date(wd.at).toLocaleString()}）`);
  const n = spoolCount(dir);
  if (n) console.log(`暂存消息：${n} 条`);
  let lines = [];
  try { lines = fs.readFileSync(path.join(dir, WATCHDOG_LOG), 'utf8').trimEnd().split('\n').slice(-LOG_TAIL); } catch {}
  if (lines.length) console.log(`\n最近日志：\n${lines.join('\n')}`);
}

function watchdog(dir, [sub = 'status'], force) {
  if (!launchdSupported() && sub !== 'run') throw new Error('看门狗仅支持 macOS（launchd）');
  if (sub === 'run') watchdogRun(dir);
  else if (sub === 'install') watchdogInstall(dir, force);
  else if (sub === 'uninstall') watchdogUninstall(dir);
  else if (sub === 'status') watchdogStatus(dir);
  else throw new Error('用法：dsh-remote-wecom watchdog install|uninstall|status');
}

try {
  const {values, positionals} = parseArgs({allowPositionals: true, options: {
    'bot-id': {type: 'string'}, secret: {type: 'string'}, dir: {type: 'string'}, force: {type: 'boolean'}, help: {type: 'boolean', short: 'h'},
  }});
  const [command = 'help', ...rest] = positionals;
  const dir = values.dir ? path.resolve(expandDir(values.dir)) : defaultDataDir();
  if (values.help || command === 'help') console.log(USAGE);
  else if (command === 'setup') await setup(dir, values);
  else if (command === 'bind') bind(dir);
  else if (command === 'status') status(dir);
  else if (command === 'alias') alias(dir, rest);
  else if (command === 'watchdog') watchdog(dir, rest, values.force);
  else { console.log(USAGE); process.exitCode = 2; }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
