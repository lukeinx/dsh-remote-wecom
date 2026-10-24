// Desktop 离线看门狗：插件心跳过期时接管企微、暂存消息并拉起 Desktop，心跳恢复即让出连接。
// 同一 BotID 只允许一个连接，新连接会把旧连接踢下线：看门狗只在心跳过期时连，插件连上时自然把它踢掉。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {hasCredentials, loadConfig} from './config.mjs';
import {WeComTransport} from './wecom.mjs';

export const HEARTBEAT_FILE = 'alive.json';
export const WATCHDOG_FILE = 'watchdog.json';
export const SPOOL_DIR = 'spool';
export const LAUNCH_FILE = 'launched.json';
export const HEARTBEAT_MS = 10_000;
export const STALE_MS = 30_000;
export const LAUNCH_WAIT_MS = 120_000;
export const SPOOL_TTL_MS = 30 * 60_000;
// 被非插件的连接踢下线后的退避，避免和重复部署互踢。
export const KICK_BACKOFF_MS = 5 * 60_000;
// tick 间隔超过这个值视为刚从睡眠唤醒：给插件一个心跳周期补写，免得抢先连上把它踢掉。
export const WAKE_GAP_MS = 15_000;
export const DESKTOP_BUNDLE_ID = 'com.deepseek.dsh';
export const OFFLINE_WELCOME = 'DSH Desktop 未运行，发来的消息会先暂存，并在后台启动 Desktop，上线后自动处理。';

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = `${file}.${crypto.randomUUID()}`;
  fs.writeFileSync(tmp, JSON.stringify(value), {mode: 0o600});
  fs.renameSync(tmp, file);
}

export function writeHeartbeat(dir, now = Date.now()) {
  writeJson(path.join(dir, HEARTBEAT_FILE), {pid: process.pid, at: now});
}
export function clearHeartbeat(dir) {
  const file = path.join(dir, HEARTBEAT_FILE);
  if (readJson(file)?.pid === process.pid) fs.rmSync(file, {force: true});
}
export function heartbeatAge(dir, now = Date.now()) {
  const at = Number(readJson(path.join(dir, HEARTBEAT_FILE))?.at);
  return Number.isFinite(at) ? now - at : Infinity;
}
export const heartbeatFresh = (dir, now = Date.now()) => heartbeatAge(dir, now) < STALE_MS;
export const watchdogState = dir => readJson(path.join(dir, WATCHDOG_FILE));

export function spoolMessage(dir, entry) {
  writeJson(path.join(dir, SPOOL_DIR, `${entry.at}-${crypto.randomUUID()}.json`), entry);
}
export function spoolCount(dir) {
  try { return fs.readdirSync(path.join(dir, SPOOL_DIR)).filter(f => f.endsWith('.json')).length; } catch { return 0; }
}
/** 按到达顺序取出并删除全部暂存消息。 */
export function takeSpool(dir) {
  const spool = path.join(dir, SPOOL_DIR);
  let names = [];
  try { names = fs.readdirSync(spool).filter(f => f.endsWith('.json')).sort(); } catch { return []; }
  const out = [];
  for (const name of names) {
    const file = path.join(spool, name);
    const entry = readJson(file);
    fs.rmSync(file, {force: true});
    if (entry && typeof entry.text === 'string') out.push(entry);
  }
  return out;
}

/** 看门狗拉起 Desktop 后留标记：插件上线时据此按「拉起」而不是「重启」处理。 */
export function markLaunched(dir, now = Date.now()) {
  writeJson(path.join(dir, LAUNCH_FILE), {at: now});
}
export function takeLaunched(dir, now = Date.now()) {
  const file = path.join(dir, LAUNCH_FILE);
  const at = Number(readJson(file)?.at);
  fs.rmSync(file, {force: true});
  return Number.isFinite(at) && now - at <= SPOOL_TTL_MS;
}

/** 看门狗跑在 ELECTRON_RUN_AS_NODE 下；`open` 会把环境传给 Desktop，不去掉它 Desktop 会以 Node 模式启动后立即退出。 */
export function desktopEnv(env = process.env) {
  const {ELECTRON_RUN_AS_NODE, ...rest} = env;
  return rest;
}

export function launchDesktop() {
  return new Promise((resolve, reject) => execFile('open', ['-g', '-j', '-b', DESKTOP_BUNDLE_ID], {timeout: 15_000, env: desktopEnv()},
    e => e ? reject(e) : resolve()));
}

const sameBot = (a, b) => a.botId === b.botId && a.secret === b.secret && a.ownerUserId === b.ownerUserId && a.wsUrl === b.wsUrl;

/**
 * 一次 tick 决定连还是不连：心跳新鲜、未配置或未绑定主人时断开，否则保持连接。
 * 收到消息暂存到 spool/ 并拉起 Desktop；卡片引用的是插件内存状态，只提示重新操作。
 */
export function createWatchdog({dir, log = () => {}, launch = launchDesktop, createTransport = null, now = Date.now}) {
  let transport = null;
  let config = null;
  let launching = null;
  let backoffUntil = 0;
  let lastTick = 0;
  const state = connected => {
    try { writeJson(path.join(dir, WATCHDOG_FILE), {pid: process.pid, connected, at: now()}); } catch {}
  };

  function release(why) {
    if (!transport) return;
    log(`让出企微连接（${why}）`);
    transport.stop();
    transport = null;
    launching = null;
    state(false);
  }
  /** 拉起是预期路径，成功时不打扰手机；只有失败或超时才提示。返回需要回给手机的文案。 */
  async function wake() {
    if (launching) return '';
    launching = {at: now()};
    try {
      await launch();
      log('已拉起 Desktop');
      try { markLaunched(dir, now()); } catch {}
      return '';
    } catch (e) {
      launching = null;
      log(`拉起 Desktop 失败：${String(e?.message || e).slice(0, 200)}`);
      return '⚠️ 启动 DSH Desktop 失败，消息已暂存；请在电脑上打开 Desktop，上线后自动处理。';
    }
  }
  function connect(cfg) {
    config = cfg;
    const opts = {
      config: cfg, dir, log, greet: false, welcome: OFFLINE_WELCOME,
      onMessage: async (text, files, ack, {quote = ''} = {}) => {
        ack.media = true;
        spoolMessage(dir, {text, files: files.map(({local, name, kind, bytes}) => ({local, name, kind, bytes})), quote, at: now()});
        return wake();
      },
      onCard: async () => (await wake())
        || 'DSH Desktop 未运行，这次卡片操作未处理；正在后台拉起，上线后会提醒你重新操作。',
    };
    transport = createTransport ? createTransport(opts) : new WeComTransport(opts);
    transport.start();
    state(true);
    log('插件心跳过期，接管企微连接');
  }

  function tick() {
    if (lastTick && now() - lastTick > WAKE_GAP_MS) backoffUntil = Math.max(backoffUntil, now() + HEARTBEAT_MS + 5_000);
    lastTick = now();
    if (heartbeatFresh(dir, now())) return release('插件已上线');
    let cfg = null;
    try { cfg = loadConfig(dir); } catch {}
    if (!cfg || !hasCredentials(cfg) || !cfg.ownerUserId) return release('未配置或未绑定主人');
    if (transport && !sameBot(cfg, config)) release('配置已变更');
    if (transport?.kickedAt) {
      backoffUntil = now() + KICK_BACKOFF_MS;
      release('被其他连接占用');
    }
    if (!transport && now() >= backoffUntil) connect(cfg);
    if (launching && !launching.warned && now() - launching.at > LAUNCH_WAIT_MS) {
      launching.warned = true;
      log('Desktop 拉起后插件仍未上线');
      void transport?.send(`⚠️ DSH Desktop 拉起后 ${Math.round(LAUNCH_WAIT_MS / 60000)} 分钟内遥控插件仍未上线，请检查电脑（Desktop 是否启动、插件是否启用）。消息已暂存，插件上线后处理。`);
    }
    if (launching?.warned && now() - launching.at > 2 * LAUNCH_WAIT_MS) launching = null;
  }
  return {
    tick,
    stop: () => release('看门狗停止'),
    get connected() { return Boolean(transport); },
    get launching() { return launching; },
  };
}
