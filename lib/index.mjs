// DSH bundle plugin entry: owns one remote instance at a time and rebuilds it on restart or config change.
import fs from 'node:fs';
import path from 'node:path';
import {createRemote, expandPath} from './core/remote.mjs';
import {BIND_FILE, CONFIG_FILE, defaultDataDir, hasCredentials, loadConfig, validateCredentials} from './core/config.mjs';
import {createDshHost} from './host/dsh-host.mjs';

export const name = 'dsh-remote-wecom';
export const inject = ['typertGateway', 'connection'];

const WATCH_MS = 5000;
// 插件自己写配置（绑定主人）时会连带删掉 bind.json：这段时间内的变化不算外部修改。
const SELF_WRITE_QUIET_MS = 1500;

export function apply(ctx, options = {}) {
  const dir = options?.dataDir ? expandPath(options.dataDir) : defaultDataDir();
  const logger = ctx.logger;
  const warn = line => logger?.warn?.(`dsh-remote-wecom: ${line}`);
  const debug = line => logger?.debug?.(`dsh-remote-wecom: ${line}`);
  let remote = null;
  let alive = true;
  let quietUntil = 0;
  const host = createDshHost(ctx, () => remote);
  const stampOf = () => [CONFIG_FILE, BIND_FILE].map(f => {
    try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch { return 0; }
  }).join('/');
  let stamp = stampOf();

  function boot() {
    if (!alive) return;
    let config;
    try {
      config = loadConfig(dir);
      if (!hasCredentials(config)) {
        warn('未配置 BotID / Secret，运行 dsh-remote-wecom setup 后自动连接');
        return;
      }
      validateCredentials(config);
    } catch (e) {
      warn(`${e.message}（数据目录 ${dir}）`);
      return;
    }
    remote = createRemote({
      host, dir, config, log: debug,
      onRestart: () => void restart('收到重启命令'),
      onConfigWritten: () => { quietUntil = Date.now() + SELF_WRITE_QUIET_MS; },
    });
    try {
      remote.start();
    } catch (e) {
      warn(`启动失败：${e?.message || e}`);
      const r = remote;
      remote = null;
      void r.stop('启动失败');
    }
  }
  let chain = Promise.resolve();
  function restart(why) {
    chain = chain.then(async () => {
      const old = remote;
      remote = null;
      await old?.stop(why).catch(e => warn(`停止失败：${e?.message || e}`));
      stamp = stampOf();
      boot();
    });
    return chain;
  }

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
    const old = remote;
    remote = null;
    void old?.stop('插件已停止');
  }, 'dsh-remote-wecom');
}
