#!/usr/bin/env node
// 设置页预览（手动运行，不进 npm test）：临时 DSH_HOME 起 web profile，接假企微与假扫码接口。
//   node scripts/preview.mjs [--state unconfigured|bound|unbound] [--port 5180]
// 假扫码接口在第 3 次轮询时返回成功；在本终端输入一行文字 = 用户 alice 在企微单聊里发给机器人。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {parseArgs} from 'node:util';
import {spawnSync} from 'node:child_process';
import {ROOT, startDshWeb} from '../tests/fixtures/dsh-web.mjs';
import {startFakeQr, startFakeWeCom} from '../tests/fixtures/fakes.mjs';
import {createBindCode} from '../lib/core/config.mjs';

const STATES = ['unconfigured', 'bound', 'unbound'];
const {values} = parseArgs({options: {state: {type: 'string', default: 'unconfigured'}, port: {type: 'string'}, help: {type: 'boolean', short: 'h'}}});
if (values.help || !STATES.includes(values.state)) {
  console.log('用法：node scripts/preview.mjs [--state unconfigured|bound|unbound] [--port 端口]');
  process.exit(values.help ? 0 : 2);
}
if (!fs.existsSync(path.join(ROOT, 'dist/client.js'))) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'client/build.mjs')], {stdio: 'inherit'});
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const BOT_ID = 'aibPreview7Kq2x9F3m';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-preview-'));
const data = path.join(tmp, 'data');
fs.mkdirSync(data, {mode: 0o700});
const wecom = await startFakeWeCom({botId: BOT_ID});
const qr = await startFakeQr({botId: BOT_ID});
const base = {wsUrl: wecom.url, openDesktop: true};
const config = values.state === 'unconfigured' ? base
  : {...base, botId: BOT_ID, secret: 'preview-secret', ownerUserId: values.state === 'bound' ? 'zhangsan' : ''};
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config, null, 2), {mode: 0o600});
if (values.state !== 'unconfigured') {
  fs.writeFileSync(path.join(data, 'aliases.json'), JSON.stringify({home: '~', 'dsh-remote': ROOT.replace(os.homedir(), '~').replace(/\/$/, '')}, null, 2));
}
if (values.state === 'unbound') createBindCode(data);

let web = null;
let cleaning = false;
async function cleanup(code = 0) {
  if (cleaning) return;
  cleaning = true;
  await web?.stop().catch(() => {});
  await wecom.close().catch(() => {});
  await qr.close().catch(() => {});
  fs.rmSync(tmp, {recursive: true, force: true});
  process.exit(code);
}
process.on('SIGINT', () => void cleanup(0));
process.on('SIGTERM', () => void cleanup(0));

try {
  web = await startDshWeb({tmp, dataDir: data, port: values.port ? Number(values.port) : undefined,
    pluginConfig: {qrBaseUrl: qr.url, watchMs: 1000, watchdogDryRun: true}});
} catch (e) {
  console.error(e.message);
  await cleanup(1);
}
console.log(`
预览已启动（状态：${values.state}）
  打开：${web.url}
  路径：左下角「设置」→「企微远程」
  URL 里的 token 只在首次打开时换取登录 cookie，之后可直接访问 ${web.origin}/
  假扫码接口在第 3 次轮询（约 9 秒）时返回成功
  在这里输入一行文字回车 = alice 在企微单聊里发给机器人（用来触发自动认主或发送绑定码）
  Ctrl-C 退出并清理临时目录 ${tmp}
`);
const rl = readline.createInterface({input: process.stdin});
rl.on('line', line => {
  const text = line.trim();
  if (!text) return;
  if (!wecom.state.socket) { console.log('（插件还没连上假企微）'); return; }
  wecom.say(text, {userid: 'alice'});
  console.log(`→ alice：${text}`);
});
rl.on('close', () => { if (!process.stdin.isTTY) return; void cleanup(0); });
let seen = 0;
setInterval(() => {
  for (const body of wecom.state.sent.slice(seen)) {
    const text = body?.markdown?.content || body?.template_card?.emphasis_content?.title || body?.template_card?.main_title?.title || body?.msgtype;
    console.log(`← 机器人：${String(text).split('\n')[0].slice(0, 120)}`);
  }
  seen = wecom.state.sent.length;
}, 500).unref();
