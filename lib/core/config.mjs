import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
export const CONFIG_FILE = 'config.json';
export const WELCOME_FILE = 'welcome.json'; // 已发送主动欢迎的标记
export const RESTART_FILE = 'restart.json'; // 待通知的重启标记：停止前写入，下次连上后消费一次
export const RESTART_NOTICE_TTL_MS = 10 * 60 * 1000; // 停止后长期未启动则不再通知
export const WELCOME_QUIET_MS = 2 * 60 * 1000; // 刚给主人发过消息时，进会话不再回欢迎语
export const BIND_FILE = 'bind.json'; // 待绑定的一次性绑定码
export const BIND_TTL_MS = 10 * 60 * 1000;
export const BIND_MAX_FAILURES = 5;
const PACKAGE_JSON = new URL('../../package.json', import.meta.url);
export const VERSION = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version;

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}
export function defaultDataDir() {
  return path.join(dshHome(), 'integrations', 'dsh-remote-wecom');
}
export function defaults(dir) {
  return {
    botId: '', secret: '', ownerUserId: '', dirAliases: {home: '~'},
    nameWaitMs: 5000, inboxDir: path.join(dir, 'inbox'),
    // 「创建会话」后用 dsh://open 把 Desktop 拉到前台；「创建后台会话」不拉起。
    openDesktop: true,
    // 手机发起的任务里，审批转到企微卡片。超时策略：ask-then-allow（默认）| ask | allow。
    remoteConfirm: 'ask-then-allow', remoteConfirmTimeoutMs: 600000,
  };
}
export function loadConfig(dir) {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('遥控配置无效，请检查 config.json'); }
  const cfg = {...defaults(dir), ...user};
  if (cfg.wsUrl) {
    const endpoint = new URL(cfg.wsUrl);
    if (endpoint.protocol !== 'wss:' && !(endpoint.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))) throw new Error('wsUrl 必须使用 wss（本机测试服务除外）');
  }
  if (!cfg.dirAliases || typeof cfg.dirAliases !== 'object' || Object.values(cfg.dirAliases).some(v => typeof v !== 'string')) throw new Error('dirAliases 无效');
  if (!['ask-then-allow', 'ask', 'allow'].includes(cfg.remoteConfirm)) throw new Error('remoteConfirm 只能是 ask-then-allow、ask 或 allow');
  // 上限 1 天：超过 2^31-1 的 setTimeout 会立即触发，等于直接放行。
  if (!Number.isFinite(cfg.remoteConfirmTimeoutMs) || cfg.remoteConfirmTimeoutMs < 1000 || cfg.remoteConfirmTimeoutMs > 86400000) throw new Error('remoteConfirmTimeoutMs 需在 1000–86400000 毫秒之间');
  if (typeof cfg.openDesktop !== 'boolean') throw new Error('openDesktop 需为 true 或 false');
  return cfg;
}
const validField = v => typeof v === 'string' && v.trim() && !/[\r\n\0]/.test(v);
export function hasCredentials(cfg) {
  return [cfg.botId, cfg.secret].every(validField);
}
// ownerUserId 可留空：进入待绑定状态，由主人在企微单聊发送一次性绑定码完成绑定。
export function validateCredentials(cfg) {
  if (!hasCredentials(cfg)) throw new Error('需要 botId、secret；请运行 dsh-remote-wecom setup');
  if (cfg.ownerUserId && !validField(cfg.ownerUserId)) throw new Error('ownerUserId 无效；请运行 dsh-remote-wecom setup');
}
function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = file + '.' + crypto.randomUUID();
  try {
    fs.writeFileSync(tmp, text, {mode: 0o600, flag: 'wx'});
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, {force: true}); }
}
/** 生成 6 位绑定码并写入数据目录（600），返回明文供电脑端展示。 */
export function createBindCode(dir, now = Date.now()) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  writePrivate(path.join(dir, BIND_FILE), JSON.stringify({code, expiresAt: now + BIND_TTL_MS, failures: 0}));
  return code;
}
export function saveConfig(dir, cfg) {
  validateCredentials(cfg);
  writePrivate(path.join(dir, CONFIG_FILE), JSON.stringify(cfg, null, 2) + '\n');
}
/** 只改磁盘上的 ownerUserId，避免把默认值写回配置。 */
export function saveOwner(dir, userid) {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  saveConfig(dir, {...user, ownerUserId: userid});
}
