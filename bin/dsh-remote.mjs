#!/usr/bin/env node
// 电脑端配置工具：只读写数据目录，运行中的插件约 5 秒内发现配置变化并重连。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import {parseArgs} from 'node:util';
import {BIND_FILE, BIND_TTL_MS, CONFIG_FILE, VERSION, WELCOME_FILE, createBindCode, defaultDataDir, hasCredentials, loadConfig, saveConfig} from '../lib/core/config.mjs';
import {checkName, expandDir, loadAliases, missingDirs, saveAliases, tildeDir} from '../lib/core/aliases.mjs';

const USAGE = `dsh-remote-wecom ${VERSION}

用法：
  dsh-remote-wecom setup [--bot-id ID --secret SECRET]   写入机器人凭证并生成绑定码（不带参数则交互输入）
  dsh-remote-wecom bind                                  重新生成绑定码（解除当前主人）
  dsh-remote-wecom status                                查看配置与最近日志
  dsh-remote-wecom alias [名称 目录 | rm 名称]           查看或修改目录别名

选项：
  --dir 目录   数据目录，默认 $DSH_HOME/integrations/dsh-remote-wecom（DSH_HOME 默认 ~/.dsh）`;

const LOG_TAIL = 20;

function readUser(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw new Error('config.json 不是合法 JSON，请检查或删除后重新 setup'); }
}
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
  const user = readUser(dir);
  let botId = values['bot-id'];
  let secret = values.secret;
  if (!botId && !secret) {
    if (!process.stdin.isTTY) throw new Error('非交互环境请用 setup --bot-id ID --secret SECRET');
    botId = await prompt(`BotID${user.botId ? `（回车沿用 ${user.botId}）` : ''}：`) || user.botId;
    secret = await prompt('Secret：', {secret: true});
    process.stdout.write('\n');
  }
  if (!botId || !secret) throw new Error('BotID 和 Secret 都需要提供');
  const sameBot = user.botId === botId;
  const cfg = {...user, botId, secret, ownerUserId: sameBot ? user.ownerUserId || '' : ''};
  saveConfig(dir, cfg);
  fs.rmSync(path.join(dir, WELCOME_FILE), {force: true});
  console.log(`配置已保存：${path.join(dir, CONFIG_FILE)}`);
  if (cfg.ownerUserId) {
    console.log('已绑定主人，保持不变；需要换绑时执行 dsh-remote-wecom bind。');
    return;
  }
  printCode(createBindCode(dir));
  console.log('运行中的 DeepSeek Harness 会在约 5 秒内自动连接；若未安装插件，请先按 README 安装并重启 Desktop。');
}

function bind(dir) {
  const user = readUser(dir);
  if (!hasCredentials({botId: user.botId, secret: user.secret})) throw new Error('还没有配置机器人，请先运行 dsh-remote-wecom setup');
  if (user.ownerUserId) {
    saveConfig(dir, {...user, ownerUserId: ''});
    fs.rmSync(path.join(dir, WELCOME_FILE), {force: true});
    console.log('已解除原主人的绑定。');
  }
  printCode(createBindCode(dir));
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

try {
  const {values, positionals} = parseArgs({allowPositionals: true, options: {
    'bot-id': {type: 'string'}, secret: {type: 'string'}, dir: {type: 'string'}, help: {type: 'boolean', short: 'h'},
  }});
  const [command = 'help', ...rest] = positionals;
  const dir = values.dir ? path.resolve(expandDir(values.dir)) : defaultDataDir();
  if (values.help || command === 'help') console.log(USAGE);
  else if (command === 'setup') await setup(dir, values);
  else if (command === 'bind') bind(dir);
  else if (command === 'status') status(dir);
  else if (command === 'alias') alias(dir, rest);
  else { console.log(USAGE); process.exitCode = 2; }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
