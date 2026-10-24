// Desktop 设置页的 host 侧：/api/dsh-remote-wecom/settings 路由（仅本机）与方法分发。
// 协议与 @xmanrui/dsh-im 的 management-rpc 一致：client-request → server-response。返回值从不包含 Secret。
import {
  BIND_MAX_FAILURES, VERSION, applyCredentials, hasCredentials, loadConfig, readBind,
  readUserConfig, resetOwner, saveUserConfig, validateCredentials, validatePrefs,
} from '../core/config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {tildeDir} from '../core/aliases.mjs';

export const SETTINGS_ENDPOINT = 'dsh-remote-wecom/settings';
export const SETTINGS_METHODS = ['state', 'qrStart', 'qrCancel', 'saveCredentials', 'newBindCode', 'unbind', 'setPrefs', 'setPlace', 'restart'];
// 与遥控实例共用：手机「工作区」命令和设置页写同一个文件，内容 {workspaceId} 或 {cwd}，没有文件 = 未分组。
export const DEFAULT_PLACE_FILE = '.default-place';
const UNGROUPED = 'none';
const WORKSPACES_TTL_MS = 5000;
const WORKSPACES_WAIT_MS = 1500;

const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 保留首尾若干位，中间打码。 */
export function mask(value) {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= 2) return s[0] + '•';
  if (s.length <= 6) return s[0] + '•'.repeat(s.length - 2) + s.at(-1);
  const keep = s.length > 12 ? 4 : 2;
  return s.slice(0, keep) + '••••' + s.slice(-keep);
}

function isLoopbackAuthority(authority) {
  if (!authority) return false;
  try {
    const url = new URL(`http://${authority}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    const host = url.hostname.replace(/\.$/, '');
    return host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch { return false; }
}
// Desktop 窗口经自有的 dsh-app: scheme 访问 host。
const DESKTOP_ORIGIN = /^dsh-app:\/\/[^/]*$/;
export function isLoopbackRequest(request) {
  const origin = request.headers.get('origin');
  if (origin !== null && DESKTOP_ORIGIN.test(origin)) return true;
  if (!isLoopbackAuthority(request.headers.get('host'))) return false;
  if (origin === null) return true;
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && isLoopbackAuthority(url.host);
  } catch { return false; }
}
function reply(rpcId, result) {
  // Connection 客户端要求失败结果带 error.details。
  const value = result.ok === false ? {...result, error: {...result.error, details: result.error.details ?? {}}} : result;
  return Response.json({type: 'server-response', rpcId, result: value});
}

/** 注册 /api 路由，返回注销函数。DSH 先做浏览器鉴权和 Host/Origin 校验，这里再限定本机。 */
export function registerSettingsRoute(ctx, handler) {
  if (typeof ctx?.connection?.fetch?.register !== 'function') return () => {};
  return ctx.connection.fetch.register({
    path: `/api/${SETTINGS_ENDPOINT}`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => handleRequest(request, handler),
  });
}
export async function handleRequest(request, handler) {
  if (!isLoopbackRequest(request)) return new Response('forbidden', {status: 403});
  if (request.method !== 'POST') return new Response('method not allowed', {status: 405});
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json')
    return new Response('content type must be application/json', {status: 415});
  let message;
  try { message = await request.json(); }
  catch { return new Response('body is not JSON', {status: 400}); }
  const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request';
  const call = message?.payload;
  if (!isRecord(message) || message.type !== 'client-request' || typeof message.rpcId !== 'string'
    || message.method !== SETTINGS_ENDPOINT || !isRecord(call) || typeof call.method !== 'string' || !Object.hasOwn(call, 'payload'))
    return reply(rpcId, {ok: false, error: {code: 'gateway/bad-request', message: '请求格式无效'}});
  try { return reply(rpcId, await handler(call.method, call.payload, request.signal)); }
  catch { return new Response('settings handler failed', {status: 500}); }
}

const delay = ms => new Promise(r => setTimeout(r, ms).unref?.());
const realDir = d => { try { return fs.realpathSync(d); } catch { return path.resolve(d); } };
// 重载要等旧实例收尾（最多数秒），设置页不必等满：前端轮询会拿到后续状态。
const RELOAD_WAIT_MS = 2500;
const QR_READY_WAIT_MS = 3000;

/**
 * getWorkspaces 缺省时（宿主不支持工作区）不显示默认位置。
 * @param {{dir: string, getRemote: () => any, getBootError: () => string, reload: (why: string, opts?: {notify?: boolean}) => Promise<void>, qr: any,
 *   getWorkspaces?: (() => Promise<{items: {id: string, path: string, title: string}[]}>) | null}} deps
 */
export function createSettingsHandler({dir, getRemote, getBootError, reload, qr, getWorkspaces = null}) {
  const settle = p => Promise.race([Promise.resolve(p).catch(() => {}), delay(RELOAD_WAIT_MS)]);
  const placeFile = path.join(dir, DEFAULT_PLACE_FILE);

  // 设置页每 2 秒轮询一次：工作区列表短时缓存，取不到时沿用上一次。
  let wsCache = null;
  let wsAt = 0;
  async function workspaces(fresh = false) {
    if (!getWorkspaces) return null;
    if (!fresh && wsCache && Date.now() - wsAt < WORKSPACES_TTL_MS) return wsCache;
    try {
      const r = await Promise.race([getWorkspaces(), delay(WORKSPACES_WAIT_MS).then(() => { throw new Error('timeout'); })]);
      wsCache = (r?.items ?? []).map(w => ({id: w.id, title: w.title, path: realDir(w.path)}));
      wsAt = Date.now();
    } catch {}
    return wsCache;
  }
  function readPlace() {
    try { return JSON.parse(fs.readFileSync(placeFile, 'utf8')) || {}; } catch { return {}; }
  }
  function placeState(items) {
    if (!items) return null;
    const saved = readPlace();
    const options = [...items.map(w => ({value: `ws:${w.id}`, label: w.title})), {value: UNGROUPED, label: ''}];
    let current = UNGROUPED;
    if (saved.workspaceId && items.some(w => w.id === saved.workspaceId)) current = `ws:${saved.workspaceId}`;
    else if (typeof saved.cwd === 'string' && saved.cwd && fs.statSync(saved.cwd, {throwIfNoEntry: false})?.isDirectory()) {
      current = `dir:${saved.cwd}`;
      options.push({value: current, label: tildeDir(saved.cwd)});
    }
    return {current, options};
  }

  async function state() {
    let cfg = null;
    let configError = '';
    try { cfg = loadConfig(dir); } catch (e) { configError = e.message; }
    const configured = Boolean(cfg && hasCredentials(cfg));
    const bound = Boolean(configured && cfg.ownerUserId);
    const remote = getRemote();
    const transport = remote && !remote.stopped ? remote.transport : null;
    const connection = transport
      ? {connected: Boolean(transport.connected), reason: String(transport.reason || '')}
      : {connected: false, reason: configError || getBootError() || (configured ? '未启动' : '未配置机器人')};
    const bind = {};
    const now = Date.now();
    const pending = configured && !bound ? readBind(dir) : null;
    if (pending && typeof pending.code === 'string' && pending.expiresAt > now && (pending.failures || 0) < BIND_MAX_FAILURES) {
      bind.code = pending.code;
      bind.expiresAt = pending.expiresAt;
    }
    if (pending?.auto?.expiresAt > now) bind.auto = {expiresAt: pending.auto.expiresAt};
    const items = await workspaces();
    return {
      bot: {botId: configured ? mask(cfg.botId) : '', configured},
      connection,
      owner: {bound, userId: bound ? mask(cfg.ownerUserId) : ''},
      bind,
      qr: qr.snapshot(),
      prefs: cfg
        ? {remoteConfirm: cfg.remoteConfirm, remoteConfirmTimeoutMs: cfg.remoteConfirmTimeoutMs, openDesktop: cfg.openDesktop}
        : {remoteConfirm: 'ask-then-allow', remoteConfirmTimeoutMs: 600000, openDesktop: false},
      place: placeState(items),
      version: VERSION,
    };
  }
  const requireConfigured = () => {
    const user = readUserConfig(dir);
    if (!hasCredentials({botId: user.botId, secret: user.secret})) throw new Error('还没有配置机器人');
  };
  const str = (payload, key) => typeof payload?.[key] === 'string' ? payload[key].trim() : '';

  const methods = {
    state: async () => {},
    async qrStart() {
      qr.start();
      // 二维码通常一秒内就绪：稍等一下让这次返回直接带上图片，等不到就交给前端轮询。
      for (const until = Date.now() + QR_READY_WAIT_MS; Date.now() < until;) {
        const s = qr.snapshot();
        if (s.state !== 'waiting' || s.dataUrl) break;
        await delay(50);
      }
    },
    qrCancel: async () => { qr.cancel(); },
    async saveCredentials(payload) {
      const creds = {botId: str(payload, 'botId'), secret: str(payload, 'secret')};
      validateCredentials({...creds, ownerUserId: ''});
      if (qr.running()) qr.cancel();
      applyCredentials(dir, creds);
      await settle(reload('设置页更新了机器人凭证'));
    },
    async newBindCode() {
      resetOwner(dir, {keepAuto: true});
      await settle(reload('设置页重新生成绑定码', {notify: false}));
    },
    async unbind() {
      resetOwner(dir);
      await settle(reload('设置页解除了主人', {notify: false}));
    },
    async setPrefs(payload) {
      if (!isRecord(payload)) throw new Error('参数无效');
      const user = readUserConfig(dir);
      const next = {...user};
      for (const key of ['remoteConfirm', 'remoteConfirmTimeoutMs', 'openDesktop'])
        if (Object.hasOwn(payload, key)) next[key] = payload[key];
      validatePrefs({...loadConfig(dir), ...next});
      saveUserConfig(dir, next);
      if (hasCredentials(next)) await settle(reload('设置页修改了偏好', {notify: false}));
    },
    async setPlace(payload) {
      const value = str(payload, 'value');
      if (value === UNGROUPED) { fs.rmSync(placeFile, {force: true}); return; }
      if (value.startsWith('dir:') && value.slice(4) === readPlace().cwd) return;
      const id = value.startsWith('ws:') ? value.slice(3) : '';
      const items = await workspaces(true);
      if (!id || !items?.some(w => w.id === id)) throw new Error('这个工作区已不存在，请刷新后重选');
      fs.mkdirSync(dir, {recursive: true, mode: 0o700});
      fs.writeFileSync(placeFile, JSON.stringify({workspaceId: id}) + '\n', {mode: 0o600});
    },
    async restart() {
      requireConfigured();
      await settle(reload('设置页重启服务'));
    },
  };

  return async function handle(method, payload, signal) {
    if (signal?.aborted) return {ok: false, error: {code: 'cancelled', message: '请求已取消'}};
    if (!Object.hasOwn(methods, method)) return {ok: false, error: {code: 'bad-request', message: `未知方法 ${String(method).slice(0, 40)}`}};
    try {
      await methods[method](payload ?? {});
      return {ok: true, value: await state()};
    } catch (e) {
      return {ok: false, error: {code: 'invalid', message: String(e?.message || e)}};
    }
  };
}

/** 扫码成功：写入凭证（换机器人则清空主人）、打开自动认主窗口，再走重载连上。 */
export function qrSuccessWriter({dir, reload, autoBindMs}) {
  return async creds => {
    applyCredentials(dir, creds, {autoBindMs});
    await reload('扫码创建了机器人');
  };
}
