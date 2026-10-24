import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
export const CONFIG_FILE = 'config.json';
export const WELCOME_FILE = 'welcome.json'; // 已发送主动欢迎的标记
export const RESTART_FILE = 'restart.json'; // 待通知的重启标记：停止前写入，下次连上后消费一次
export const RESTART_NOTICE_TTL_MS = 10 * 60 * 1000; // 停止后长期未启动则不再通知
export const RESTART_NOTICE_ACTIVE_MS = 30 * 60 * 1000; // 手机这段时间内没用过，重启视为在电脑前操作，不发重启通知
export const WELCOME_QUIET_MS = 2 * 60 * 1000; // 刚给主人发过消息时，进会话不再回欢迎语
export const BIND_FILE = 'bind.json'; // 待绑定的一次性绑定码
export const BIND_TTL_MS = 10 * 60 * 1000;
export const BIND_MAX_FAILURES = 5;
// 扫码创建机器人后，这段时间内第一个单聊发消息的人直接成为主人（扫码接口不返回扫码人）。
export const AUTO_BIND_TTL_MS = 10 * 60 * 1000;
export const REMOTE_CONFIRM_POLICIES = ['ask-then-allow', 'ask', 'allow'];
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
    nameWaitMs: 10000, inboxDir: path.join(dir, 'inbox'),
    // 「创建会话」后用 dsh://open 把 Desktop 窗口拉到前台（不会切到新会话）；「创建后台会话」不拉起。
    openDesktop: false,
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
  validatePrefs(cfg);
  return cfg;
}
export function validatePrefs(cfg) {
  if (!REMOTE_CONFIRM_POLICIES.includes(cfg.remoteConfirm)) throw new Error('remoteConfirm 只能是 ask-then-allow、ask 或 allow');
  // 上限 1 天：超过 2^31-1 的 setTimeout 会立即触发，等于直接放行。
  if (!Number.isFinite(cfg.remoteConfirmTimeoutMs) || cfg.remoteConfirmTimeoutMs < 1000 || cfg.remoteConfirmTimeoutMs > 86400000) throw new Error('remoteConfirmTimeoutMs 需在 1000–86400000 毫秒之间');
  if (typeof cfg.openDesktop !== 'boolean') throw new Error('openDesktop 需为 true 或 false');
}
/** 磁盘上用户写过的字段（不含默认值）。 */
export function readUserConfig(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw new Error('config.json 不是合法 JSON，请检查或删除后重新 setup'); }
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
/**
 * 生成 6 位绑定码并写入数据目录（600），返回明文供电脑端展示。
 * auto 为自动认主窗口的截止时间：窗口内第一个单聊发消息的人直接成为主人。
 */
export function createBindCode(dir, now = Date.now(), {auto} = {}) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  writePrivate(path.join(dir, BIND_FILE), JSON.stringify({code, expiresAt: now + BIND_TTL_MS, failures: 0, ...(auto ? {auto: {expiresAt: auto}} : {})}));
  return code;
}
export function readBind(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, BIND_FILE), 'utf8')); } catch { return null; }
}
export function saveConfig(dir, cfg) {
  validateCredentials(cfg);
  saveUserConfig(dir, cfg);
}
/** 写入用户配置，不要求已有凭证（未配置机器人时也能改偏好）。 */
export function saveUserConfig(dir, cfg) {
  writePrivate(path.join(dir, CONFIG_FILE), JSON.stringify(cfg, null, 2) + '\n');
}
/**
 * 写入机器人凭证。换了机器人就清空主人；未绑定时生成绑定码，autoBindMs 打开自动认主窗口。
 * @returns {{bound: boolean, code: string}}
 */
export function applyCredentials(dir, {botId, secret}, {autoBindMs = 0, now = Date.now()} = {}) {
  const user = readUserConfig(dir);
  const sameBot = user.botId === botId;
  const cfg = {...user, botId, secret, ownerUserId: sameBot ? user.ownerUserId || '' : ''};
  saveConfig(dir, cfg);
  fs.rmSync(path.join(dir, WELCOME_FILE), {force: true});
  if (cfg.ownerUserId) return {bound: true, code: ''};
  return {bound: false, code: createBindCode(dir, now, autoBindMs ? {auto: now + autoBindMs} : {})};
}
/**
 * 解除主人并生成新绑定码。keepAuto 保留仍有效的自动认主窗口（仅在原本未绑定时）。
 * @returns {{unbound: boolean, code: string}}
 */
export function resetOwner(dir, {keepAuto = false, now = Date.now()} = {}) {
  const user = readUserConfig(dir);
  if (!hasCredentials({botId: user.botId, secret: user.secret})) throw new Error('还没有配置机器人，请先运行 dsh-remote-wecom setup');
  const unbound = Boolean(user.ownerUserId);
  if (unbound) {
    saveConfig(dir, {...user, ownerUserId: ''});
    fs.rmSync(path.join(dir, WELCOME_FILE), {force: true});
  }
  const auto = !unbound && keepAuto ? readBind(dir)?.auto?.expiresAt : 0;
  return {unbound, code: createBindCode(dir, now, auto > now ? {auto} : {})};
}
/** 只改磁盘上的 ownerUserId，避免把默认值写回配置。 */
export function saveOwner(dir, userid) {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  saveConfig(dir, {...user, ownerUserId: userid});
}
