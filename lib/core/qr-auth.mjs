// 企微扫码创建机器人：generate 拿二维码链接，轮询 query_result 拿 BotID / Secret。
// 参考 @xmanrui/dsh-im 的 src/channels/wecom/qr-auth.mjs；接口不返回扫码人。
export const DEFAULT_QR_BASE_URL = 'https://work.weixin.qq.com';
export const QR_SOURCE = 'dsh-remote-wecom';
export const QR_TTL_MS = 5 * 60_000;
export const QR_POLL_MS = 3_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_POLL_ERRORS = 3;
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

const clean = v => typeof v === 'string' && v.trim() ? v.trim() : '';

/** 只接受企微官方 https 链接作为二维码内容，避免把任意地址展示给用户扫。 */
export function safeAuthUrl(value) {
  try {
    const url = new URL(clean(value));
    return url.protocol === 'https:' && url.hostname === 'work.weixin.qq.com' && (!url.port || url.port === '443') ? url.href : '';
  } catch { return ''; }
}
/** 接口根地址：生产只用官方 https，测试/预览允许本机 http。 */
export function checkBaseUrl(value) {
  const url = new URL(value || DEFAULT_QR_BASE_URL);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.includes(url.hostname))) throw new Error('qrBaseUrl 必须使用 https（本机测试服务除外）');
  return url.href.replace(/\/+$/, '');
}
const platform = () => process.platform === 'win32' ? 2 : process.platform === 'linux' ? 3 : 1;

export function createQrAuth({fetch: fetchImpl = globalThis.fetch, baseUrl = DEFAULT_QR_BASE_URL, source = QR_SOURCE, now = Date.now} = {}) {
  const base = checkBaseUrl(baseUrl);
  async function get(pathname, params, signal) {
    const url = new URL(base + pathname);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const res = await fetchImpl(url, {method: 'GET', redirect: 'error', headers: {accept: 'application/json'},
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout});
    if (!res.ok) throw new Error(`扫码服务返回 HTTP ${res.status}`);
    return res.json();
  }
  return {
    async start(signal) {
      const body = await get('/ai/qc/generate', {source, plat: String(platform())}, signal);
      const scode = clean(body?.data?.scode);
      const authUrl = safeAuthUrl(body?.data?.auth_url);
      if (!scode || !authUrl) throw new Error('扫码服务返回的数据无效');
      return {scode, authUrl, expiresAt: now() + QR_TTL_MS};
    },
    async poll(scode, signal) {
      const body = await get('/ai/qc/query_result', {scode}, signal);
      const status = clean(body?.data?.status).toLowerCase();
      if (status === 'success') {
        const botId = clean(body?.data?.bot_info?.botid);
        const secret = clean(body?.data?.bot_info?.secret);
        if (!botId || !secret) throw new Error('扫码结果缺少机器人凭证');
        return {status: 'success', botId, secret};
      }
      if (['expired', 'timeout'].includes(status)) return {status: 'expired'};
      if (['fail', 'failed', 'error'].includes(status)) return {status: 'failed'};
      return {status: 'waiting'};
    },
  };
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, {once: true});
});

/**
 * 同时只有一个扫码任务。状态：idle | waiting | connecting | expired | failed。
 * waiting 且还没有 dataUrl 表示二维码生成中。onSuccess 收到凭证（持久化 + 重载），完成后回到 idle。
 */
export function createQrFlow({auth, encode, onSuccess, intervalMs = QR_POLL_MS, now = Date.now, log = () => {}}) {
  let state = {state: 'idle'};
  let ac = null;
  const set = next => { state = next; };

  async function run(signal) {
    const ticket = await auth.start(signal);
    const dataUrl = await encode(ticket.authUrl);
    if (signal.aborted) return;
    set({state: 'waiting', dataUrl, expiresAt: ticket.expiresAt});
    let errors = 0;
    while (!signal.aborted) {
      await sleep(intervalMs, signal);
      if (now() >= ticket.expiresAt) { set({state: 'expired', dataUrl, expiresAt: ticket.expiresAt}); return; }
      let r;
      try { r = await auth.poll(ticket.scode, signal); errors = 0; }
      catch (e) {
        if (signal.aborted) return;
        if (++errors < MAX_POLL_ERRORS) continue;
        throw e;
      }
      if (r.status === 'expired') { set({state: 'expired', dataUrl, expiresAt: ticket.expiresAt}); return; }
      if (r.status === 'failed') throw new Error('扫码未完成，请重新生成二维码');
      if (r.status === 'success') {
        set({state: 'connecting'});
        await onSuccess({botId: r.botId, secret: r.secret});
        if (!signal.aborted) set({state: 'idle'});
        return;
      }
    }
  }

  return {
    snapshot: () => ({...state}),
    running: () => ac !== null,
    start() {
      if (ac) return;
      const mine = new AbortController();
      ac = mine;
      set({state: 'waiting'});
      run(mine.signal).catch(e => {
        if (mine.signal.aborted) return;
        log(`扫码失败：${String(e?.message || e).slice(0, 200)}`);
        set({state: 'failed', error: String(e?.message || e)});
      }).finally(() => { if (ac === mine) ac = null; });
    },
    cancel() {
      ac?.abort(new Error('cancelled'));
      ac = null;
      set({state: 'idle'});
    },
    dispose() { ac?.abort(new Error('disposed')); ac = null; },
  };
}
