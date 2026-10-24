// DSH bundle plugin entry: owns one remote instance at a time and rebuilds it on restart or config change.
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import {createRemote, expandPath} from './core/remote.mjs';
import {AUTO_BIND_TTL_MS, BIND_FILE, CONFIG_FILE, defaultDataDir, hasCredentials, loadConfig, validateCredentials} from './core/config.mjs';
import {createQrAuth, createQrFlow} from './core/qr-auth.mjs';
import {createDshHost} from './host/dsh-host.mjs';
import {HEARTBEAT_MS, clearHeartbeat, watchdogState, writeHeartbeat} from './core/watchdog.mjs';
import {createSettingsHandler, qrSuccessWriter, registerSettingsRoute} from './host/settings-rpc.mjs';
import {createLaunchd, launchdSupported} from './core/launchd.mjs';

export const name = 'dsh-remote-wecom';
export const inject = ['typertGateway', 'connection'];

const WATCH_MS = 5000;
// 插件自己写配置（绑定主人）时会连带删掉 bind.json：这段时间内的变化不算外部修改。
const SELF_WRITE_QUIET_MS = 1500;

const encodeQr = url => QRCode.toDataURL(url, {type: 'image/png', errorCorrectionLevel: 'M', margin: 1, width: 320});

export function apply(ctx, options = {}) {
  const dir = options?.dataDir ? expandPath(options.dataDir) : defaultDataDir();
  const logger = ctx.logger;
  const warn = line => logger?.warn?.(`dsh-remote-wecom: ${line}`);
  const debug = line => logger?.debug?.(`dsh-remote-wecom: ${line}`);
  let remote = null;
  let alive = true;
  let quietUntil = 0;
  let bootError = '';
  const host = createDshHost(ctx, () => remote);
  const stampOf = () => [CONFIG_FILE, BIND_FILE].map(f => {
    try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch { return 0; }
  }).join('/');
  let stamp = stampOf();

  function boot() {
    if (!alive) return;
    bootError = '';
    let config;
    try {
      config = loadConfig(dir);
      if (!hasCredentials(config)) {
        bootError = '未配置机器人';
        warn('未配置 BotID / Secret，在「设置 → 企微远程」扫码或运行 dsh-remote-wecom setup 后自动连接');
        return;
      }
      validateCredentials(config);
    } catch (e) {
      bootError = e.message;
      warn(`${e.message}（数据目录 ${dir}）`);
      return;
    }
    remote = createRemote({
      host, dir, config, log: debug,
      onRestart: () => void restart('收到重启命令', {notify: true}),
      onConfigWritten: () => { quietUntil = Date.now() + SELF_WRITE_QUIET_MS; },
    });
    try {
      remote.start();
    } catch (e) {
      bootError = `启动失败：${e?.message || e}`;
      warn(bootError);
      const r = remote;
      remote = null;
      void r.stop('启动失败');
    }
  }
  let chain = Promise.resolve();
  function restart(why, opts) {
    chain = chain.then(async () => {
      const old = remote;
      remote = null;
      await old?.stop(why, opts).catch(e => warn(`停止失败：${e?.message || e}`));
      stamp = stampOf();
      boot();
    });
    return chain;
  }
  /** 设置页写完配置后立即重载；先记下当前 mtime，轮询不会再触发一次。 */
  function reload(why, opts) {
    stamp = stampOf();
    return restart(why, opts);
  }

  let auth;
  try { auth = createQrAuth({baseUrl: options?.qrBaseUrl}); }
  catch (e) {
    warn(e.message);
    auth = {start: async () => { throw e; }, poll: async () => { throw e; }};
  }
  const qr = createQrFlow({
    auth,
    encode: encodeQr,
    onSuccess: qrSuccessWriter({dir, reload, autoBindMs: AUTO_BIND_TTL_MS}),
    intervalMs: Number(options?.qrPollMs) > 0 ? Number(options.qrPollMs) : undefined,
    log: debug,
  });
  // watchdogDryRun：预览和测试用，plist 写进数据目录、不调 launchctl。
  const dryRun = options?.watchdogDryRun === true;
  const launchd = options?.watchdog === false || !(dryRun || launchdSupported()) ? null
    : createLaunchd({dir, ...(dryRun ? {home: dir, run: () => {}} : {})});
  try { if (launchd?.sync()) debug('看门狗已对齐到当前插件'); }
  catch (e) { warn(`看门狗更新失败：${e?.message || e}`); }
  const handler = createSettingsHandler({
    dir, getRemote: () => remote, getBootError: () => bootError, reload, qr,
    getWorkspaces: typeof host.workspaces === 'function' ? () => host.workspaces() : null,
    watchdog: launchd,
  });
  ctx.effect(() => registerSettingsRoute(ctx, handler), 'dsh-remote-wecom: settings route');

  // 心跳先于连接写出：看门狗看到就让出，配置重载期间也不中断。
  const beat = () => {
    try { writeHeartbeat(dir); } catch (e) { warn(`心跳写入失败：${e?.message || e}`); }
    // 看门狗抢先连上时会把插件踢下线；它让出后重连。
    const kickedAt = remote?.transport?.kickedAt;
    const wd = kickedAt && watchdogState(dir);
    if (wd && wd.connected === false && wd.at > kickedAt) void restart('看门狗已让出连接');
  };
  beat();
  const heartbeat = setInterval(beat, Number(options?.heartbeatMs) > 0 ? Number(options.heartbeatMs) : HEARTBEAT_MS);
  heartbeat.unref?.();

  boot();
  const watch = setInterval(() => {
    const now = stampOf();
    if (now === stamp) return;
    stamp = now;
    if (Date.now() < quietUntil) return;
    debug('配置文件已变化，重新加载');
    void restart('配置已变更');
  }, Number(options?.watchMs) > 0 ? Number(options.watchMs) : WATCH_MS);
  watch.unref?.();

  ctx.effect(() => () => {
    alive = false;
    clearInterval(watch);
    clearInterval(heartbeat);
    qr.dispose();
    const old = remote;
    remote = null;
    void Promise.resolve(old?.stop('插件已停止')).catch(() => {}).finally(() => clearHeartbeat(dir));
  }, 'dsh-remote-wecom');
}
