import test from 'node:test';
import assert from 'node:assert/strict';
import {createQrAuth, createQrFlow, checkBaseUrl, safeAuthUrl} from '../../lib/core/qr-auth.mjs';

const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const start = Date.now();
  while (Date.now() - start < ms) { const v = fn(); if (v) return v; await delay(5); }
  throw new Error('timed out');
}

/** 假扫码接口：按顺序返回 query_result 的状态，记录请求。 */
function fakeFetch({authUrl = 'https://work.weixin.qq.com/ai/qc/auth?code=x', statuses = ['waiting'], generateStatus = 200} = {}) {
  const calls = [];
  let i = 0;
  const fetch = async (url, init) => {
    url = new URL(url);
    calls.push({url, init});
    if (url.pathname === '/ai/qc/generate') {
      if (generateStatus !== 200) return new Response('no', {status: generateStatus});
      return Response.json({data: {scode: 'sc-1', auth_url: authUrl}});
    }
    const s = statuses[Math.min(i++, statuses.length - 1)];
    if (s instanceof Error) throw s;
    return Response.json({data: s === 'success'
      ? {status: 'success', bot_info: {botid: 'bot-new', secret: 'sec-new'}} : {status: s}});
  };
  return {fetch, calls};
}
const encode = async url => `data:image/png;base64,${Buffer.from(url).toString('base64')}`;

test('generate 带 source/plat，只接受企微官方 https auth_url', async () => {
  const f = fakeFetch();
  const auth = createQrAuth({fetch: f.fetch, baseUrl: 'http://127.0.0.1:9'});
  const t = await auth.start();
  assert.equal(t.scode, 'sc-1');
  assert.equal(t.authUrl, 'https://work.weixin.qq.com/ai/qc/auth?code=x');
  assert.equal(f.calls[0].url.searchParams.get('source'), 'dsh-remote-wecom');
  assert.match(f.calls[0].url.searchParams.get('plat'), /^[123]$/);
  assert.equal(f.calls[0].init.redirect, 'error');
  for (const bad of ['http://work.weixin.qq.com/x', 'https://evil.example.com/x', 'https://work.weixin.qq.com:8443/x', 'javascript:alert(1)']) {
    const g = fakeFetch({authUrl: bad});
    await assert.rejects(createQrAuth({fetch: g.fetch}).start(), /数据无效/);
  }
  assert.equal(safeAuthUrl(' https://work.weixin.qq.com/a '), 'https://work.weixin.qq.com/a');
  assert.throws(() => checkBaseUrl('http://example.com'), /https/);
  assert.equal(checkBaseUrl(), 'https://work.weixin.qq.com');
});

test('poll 映射状态：success 带凭证，expired/timeout、fail 归类，缺凭证报错', async () => {
  const auth = s => createQrAuth({fetch: fakeFetch({statuses: [s]}).fetch});
  assert.deepEqual(await auth('success').poll('sc'), {status: 'success', botId: 'bot-new', secret: 'sec-new'});
  assert.deepEqual(await auth('timeout').poll('sc'), {status: 'expired'});
  assert.deepEqual(await auth('expired').poll('sc'), {status: 'expired'});
  assert.deepEqual(await auth('fail').poll('sc'), {status: 'failed'});
  assert.deepEqual(await auth('scaning').poll('sc'), {status: 'waiting'});
  const broken = createQrAuth({fetch: async () => Response.json({data: {status: 'success', bot_info: {botid: 'b'}}})});
  await assert.rejects(broken.poll('sc'), /缺少机器人凭证/);
});

test('流程：第 3 次轮询成功 → connecting → onSuccess → idle；同时只有一个任务', async () => {
  const f = fakeFetch({statuses: ['waiting', 'scaning', 'success']});
  const got = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const flow = createQrFlow({auth: createQrAuth({fetch: f.fetch}), encode, intervalMs: 5,
    onSuccess: async creds => { got.push(creds); await gate; }});
  flow.start();
  assert.equal(flow.snapshot().state, 'waiting');
  assert.equal(flow.snapshot().dataUrl, undefined);
  flow.start();
  await until(() => flow.snapshot().dataUrl);
  assert.ok(flow.snapshot().expiresAt > Date.now());
  await until(() => flow.snapshot().state === 'connecting');
  release();
  await until(() => flow.snapshot().state === 'idle');
  assert.deepEqual(got, [{botId: 'bot-new', secret: 'sec-new'}]);
  assert.equal(f.calls.filter(c => c.url.pathname === '/ai/qc/generate').length, 1);
  assert.equal(flow.running(), false);
});

test('流程：服务端过期、本地超时都进入 expired并保留二维码', async () => {
  const a = createQrFlow({auth: createQrAuth({fetch: fakeFetch({statuses: ['waiting', 'expired']}).fetch}), encode, intervalMs: 5, onSuccess: async () => {}});
  a.start();
  await until(() => a.snapshot().state === 'expired');
  assert.ok(a.snapshot().dataUrl);
  let clock = Date.now();
  const b = createQrFlow({auth: createQrAuth({fetch: fakeFetch().fetch, now: () => clock}), encode, intervalMs: 5,
    now: () => clock, onSuccess: async () => {}});
  b.start();
  await until(() => b.snapshot().dataUrl);
  clock += 5 * 60_000;
  await until(() => b.snapshot().state === 'expired');
});

test('流程：fail、生成失败、连续网络错误进入 failed；偶发错误继续轮询；取消回到 idle', async () => {
  const fail = createQrFlow({auth: createQrAuth({fetch: fakeFetch({statuses: ['fail']}).fetch}), encode, intervalMs: 5, onSuccess: async () => {}});
  fail.start();
  await until(() => fail.snapshot().state === 'failed');
  assert.match(fail.snapshot().error, /重新生成/);

  const gen = createQrFlow({auth: createQrAuth({fetch: fakeFetch({generateStatus: 502}).fetch}), encode, intervalMs: 5, onSuccess: async () => {}});
  gen.start();
  await until(() => gen.snapshot().state === 'failed');
  assert.match(gen.snapshot().error, /HTTP 502/);

  const net = new Error('ECONNRESET');
  const flaky = createQrFlow({auth: createQrAuth({fetch: fakeFetch({statuses: [net, net, 'success']}).fetch}), encode, intervalMs: 5,
    onSuccess: async () => {}});
  flaky.start();
  await until(() => flaky.snapshot().state === 'idle' && !flaky.running());

  const down = createQrFlow({auth: createQrAuth({fetch: fakeFetch({statuses: [net]}).fetch}), encode, intervalMs: 5, onSuccess: async () => {}});
  down.start();
  await until(() => down.snapshot().state === 'failed');

  const c = createQrFlow({auth: createQrAuth({fetch: fakeFetch().fetch}), encode, intervalMs: 5, onSuccess: async () => { throw new Error('must not'); }});
  c.start();
  await until(() => c.snapshot().dataUrl);
  c.cancel();
  assert.deepEqual(c.snapshot(), {state: 'idle'});
  await delay(30);
  assert.deepEqual(c.snapshot(), {state: 'idle'});
  assert.equal(c.running(), false);
});
