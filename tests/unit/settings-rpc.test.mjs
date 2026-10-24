import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createSettingsHandler, handleRequest, mask, qrSuccessWriter, SETTINGS_ENDPOINT} from '../../lib/host/settings-rpc.mjs';
import {createQrAuth, createQrFlow} from '../../lib/core/qr-auth.mjs';
import {AUTO_BIND_TTL_MS, createBindCode} from '../../lib/core/config.mjs';

const SECRET = 'super-secret-value-123';
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const start = Date.now();
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await delay(5); }
  throw new Error('timed out');
}

function setup(t, user = null, {statuses = ['waiting', 'waiting', 'success'], intervalMs = 5, getWorkspaces = null} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-settings-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  if (user) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(user), {mode: 0o600});
  const reloads = [];
  let remote = null;
  const reload = async (why, opts) => { reloads.push({why, notify: opts?.notify !== false}); };
  let i = 0;
  const fetch = async url => {
    url = new URL(url);
    if (url.pathname.endsWith('/generate')) return Response.json({data: {scode: 's', auth_url: 'https://work.weixin.qq.com/q'}});
    const s = statuses[Math.min(i++, statuses.length - 1)];
    return Response.json({data: s === 'success' ? {status: s, bot_info: {botid: 'scanned-bot-0001', secret: SECRET}} : {status: s}});
  };
  const qr = createQrFlow({auth: createQrAuth({fetch}), encode: async () => 'data:image/png;base64,AA', intervalMs,
    onSuccess: qrSuccessWriter({dir, reload, autoBindMs: AUTO_BIND_TTL_MS})});
  t.after(() => qr.dispose());
  const call = createSettingsHandler({dir, getRemote: () => remote, getBootError: () => '', reload, qr, getWorkspaces});
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  return {dir, call, reloads, read, qr, setRemote: r => { remote = r; }};
}
const noSecret = r => assert.ok(!JSON.stringify(r).includes(SECRET), 'Secret 不得出现在返回里');

test('打码：短串保留首尾，长串保留 4 位', () => {
  assert.equal(mask(''), '');
  assert.equal(mask('ab'), 'a•');
  assert.equal(mask('zhangsan'), 'zh••••an');
  assert.equal(mask('aibABCDEFGHIJKLMN'), 'aibA••••KLMN');
});

test('state：未配置时给出原因和默认偏好，不再下发目录别名', async t => {
  const s = setup(t);
  const r = await s.call('state', {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.bot, {botId: '', configured: false});
  assert.deepEqual(r.value.connection, {connected: false, reason: '未配置机器人'});
  assert.deepEqual(r.value.qr, {state: 'idle'});
  assert.equal(r.value.prefs.remoteConfirm, 'ask-then-allow');
  assert.equal('aliases' in r.value, false);
  assert.equal((await s.call('setAlias', {name: 'x', dir: '~'})).error.code, 'bad-request');
  assert.match(r.value.version, /^\d+\.\d+\.\d+/);
});

test('state：已绑定时打码 BotID / userid，连接状态取自当前 transport，不含 Secret', async t => {
  const s = setup(t, {botId: 'aib-0123456789abcdef', secret: SECRET, ownerUserId: 'zhangsan'});
  s.setRemote({stopped: false, transport: {connected: true, reason: '已连接'}});
  const r = await s.call('state');
  assert.deepEqual(r.value.bot, {botId: 'aib-••••cdef', configured: true});
  assert.deepEqual(r.value.owner, {bound: true, userId: 'zh••••an'});
  assert.deepEqual(r.value.connection, {connected: true, reason: '已连接'});
  assert.deepEqual(r.value.bind, {});
  noSecret(r);
});

test('saveCredentials：校验、写入、生成绑定码并立即重载；换机器人清空主人', async t => {
  const s = setup(t, {botId: 'old-bot', secret: 'x', ownerUserId: 'owner', openDesktop: false});
  const bad = await s.call('saveCredentials', {botId: 'a', secret: ''});
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /botId、secret/);
  assert.deepEqual(s.reloads, []);
  const r = await s.call('saveCredentials', {botId: ' new-bot ', secret: SECRET});
  assert.equal(r.ok, true);
  noSecret(r);
  assert.deepEqual(s.read(), {botId: 'new-bot', secret: SECRET, ownerUserId: '', openDesktop: false});
  assert.equal(r.value.owner.bound, false);
  assert.match(r.value.bind.code, /^\d{6}$/);
  assert.equal(r.value.bind.auto, undefined);
  assert.equal(s.reloads.length, 1);
  assert.equal((fs.statSync(path.join(s.dir, 'config.json')).mode & 0o777), 0o600);
});

test('newBindCode / unbind：解除主人、生成新码、静默重载；重新生成保留自动认主窗口', async t => {
  const s = setup(t, {botId: 'bot-1', secret: SECRET, ownerUserId: 'owner'});
  const r = await s.call('unbind');
  assert.equal(r.value.owner.bound, false);
  assert.equal(s.read().ownerUserId, '');
  const first = r.value.bind.code;
  assert.match(first, /^\d{6}$/);
  assert.equal(r.value.bind.auto, undefined);
  assert.deepEqual(s.reloads.map(x => x.notify), [false]);
  createBindCode(s.dir, Date.now(), {auto: Date.now() + 60000});
  const again = await s.call('newBindCode');
  assert.match(again.value.bind.code, /^\d{6}$/);
  assert.ok(again.value.bind.auto.expiresAt > Date.now());
  noSecret(again);
  const none = setup(t);
  assert.match((await none.call('newBindCode')).error.message, /还没有配置机器人/);
});

test('setPrefs：按 config.mjs 规则校验，只写传入字段，静默重载', async t => {
  const s = setup(t, {botId: 'bot-1', secret: SECRET, ownerUserId: 'owner'});
  for (const bad of [{remoteConfirm: 'never'}, {remoteConfirmTimeoutMs: 10}, {openDesktop: 'yes'}]) {
    const r = await s.call('setPrefs', bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  assert.deepEqual(s.reloads, []);
  const r = await s.call('setPrefs', {remoteConfirm: 'ask', remoteConfirmTimeoutMs: 120000, openDesktop: false});
  assert.deepEqual(r.value.prefs, {remoteConfirm: 'ask', remoteConfirmTimeoutMs: 120000, openDesktop: false});
  assert.deepEqual(s.read(), {botId: 'bot-1', secret: SECRET, ownerUserId: 'owner', remoteConfirm: 'ask', remoteConfirmTimeoutMs: 120000, openDesktop: false});
  assert.deepEqual(s.reloads.map(x => x.notify), [false]);
  noSecret(r);
});

test('新会话位置：宿主不支持工作区时隐藏；选工作区写 .default-place，未分组删文件，工作区消失回到未分组', async t => {
  assert.equal((await setup(t, {botId: 'bot-1', secret: SECRET}).call('state', {})).value.place, null);
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-ws-'));
  t.after(() => fs.rmSync(wsDir, {recursive: true, force: true}));
  let items = [{id: 'w1', path: wsDir, title: 'App'}];
  const s = setup(t, {botId: 'bot-1', secret: SECRET}, {getWorkspaces: async () => ({items})});
  const file = path.join(s.dir, '.default-place');
  let r = await s.call('state', {});
  assert.deepEqual(r.value.place, {current: 'none', options: [{value: 'ws:w1', label: 'App'}, {value: 'none', label: ''}]});
  r = await s.call('setPlace', {value: 'ws:w1'});
  assert.equal(r.value.place.current, 'ws:w1');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {workspaceId: 'w1'});
  assert.match((await s.call('setPlace', {value: 'ws:gone'})).error.message, /不存在/);
  r = await s.call('setPlace', {value: 'none'});
  assert.equal(r.value.place.current, 'none');
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, JSON.stringify({cwd: wsDir}));
  r = await s.call('state', {});
  assert.equal(r.value.place.current, `dir:${wsDir}`);
  assert.equal((await s.call('setPlace', {value: `dir:${wsDir}`})).ok, true);
  items = [];
  fs.writeFileSync(file, JSON.stringify({workspaceId: 'w1'}));
  await s.call('setPlace', {value: 'ws:none-such'});
  assert.equal((await s.call('state', {})).value.place.current, 'none');
  assert.deepEqual(s.reloads, []);
});

test('restart：已配置时重载并通知，未配置报错；未知方法拒绝', async t => {
  const s = setup(t, {botId: 'bot-1', secret: SECRET});
  assert.equal((await s.call('restart')).ok, true);
  assert.deepEqual(s.reloads, [{why: '设置页重启服务', notify: true}]);
  assert.equal((await setup(t).call('restart')).ok, false);
  assert.equal((await s.call('readSecret')).error.code, 'bad-request');
  assert.equal((await s.call('toString')).error.code, 'bad-request');
});

test('qrStart：成功后写入凭证、打开自动认主窗口、备用绑定码并重载；过程中不回传 Secret', async t => {
  const s = setup(t, {botId: 'old', secret: 'x', ownerUserId: 'owner', wsUrl: 'ws://127.0.0.1:1'}, {intervalMs: 300});
  let r = await s.call('qrStart');
  assert.equal(r.value.qr.state, 'waiting');
  assert.equal(r.value.qr.dataUrl, 'data:image/png;base64,AA');
  assert.ok(r.value.qr.expiresAt > Date.now());
  r = await until(async () => { const v = await s.call('state'); noSecret(v); return v.value.qr.state === 'idle' && v; });
  assert.equal(r.value.bot.botId, 'scan••••0001');
  assert.equal(r.value.owner.bound, false);
  assert.match(r.value.bind.code, /^\d{6}$/);
  assert.ok(r.value.bind.auto.expiresAt > Date.now() + 9 * 60000);
  assert.deepEqual(s.read(), {botId: 'scanned-bot-0001', secret: SECRET, ownerUserId: '', wsUrl: 'ws://127.0.0.1:1'});
  assert.deepEqual(s.reloads.map(x => x.why), ['扫码创建了机器人']);
  const c = setup(t, null, {statuses: ['waiting']});
  await c.call('qrStart');
  r = await c.call('qrCancel');
  assert.deepEqual(r.value.qr, {state: 'idle'});
});

function request(body, headers = {}) {
  return new Request('http://127.0.0.1:5173/api/' + SETTINGS_ENDPOINT, {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {'content-type': 'application/json', host: '127.0.0.1:5173', ...headers},
  });
}
test('路由：信封协议、仅本机、失败带 error.details', async () => {
  const handler = async (method, payload) => method === 'state' ? {ok: true, value: {payload}} : {ok: false, error: {code: 'x', message: 'no'}};
  let res = await handleRequest(request({type: 'client-request', rpcId: 'r1', method: SETTINGS_ENDPOINT, payload: {method: 'state', payload: {a: 1}}}), handler);
  assert.deepEqual(await res.json(), {type: 'server-response', rpcId: 'r1', result: {ok: true, value: {payload: {a: 1}}}});
  res = await handleRequest(request({type: 'client-request', rpcId: 'r2', method: SETTINGS_ENDPOINT, payload: {method: 'other', payload: {}}}), handler);
  assert.deepEqual((await res.json()).result.error, {code: 'x', message: 'no', details: {}});
  res = await handleRequest(request({type: 'client-request', rpcId: 'r3', method: 'dsh-im/x', payload: {method: 'state', payload: {}}}), handler);
  assert.equal((await res.json()).result.error.code, 'gateway/bad-request');
  res = await handleRequest(request({}, {host: '192.168.1.5:5173'}), handler);
  assert.equal(res.status, 403);
  res = await handleRequest(request({}, {origin: 'http://evil.example.com'}), handler);
  assert.equal(res.status, 403);
  res = await handleRequest(request({type: 'client-request', rpcId: 'r4', method: SETTINGS_ENDPOINT, payload: {method: 'state', payload: {}}}, {origin: 'dsh-app://app'}), handler);
  assert.equal((await res.json()).result.ok, true);
  res = await handleRequest(request({}, {origin: 'dsh-app://app/x?y'}), handler);
  assert.equal(res.status, 403);
  res = await handleRequest(request('x', {'content-type': 'text/plain'}), handler);
  assert.equal(res.status, 415);
  res = await handleRequest(request('{'), handler);
  assert.equal(res.status, 400);
});

test('看门狗开关：不支持时不下发、调用报错；支持时开关即生效，失败给出友好提示', async t => {
  const s = setup(t);
  assert.equal((await s.call('state', {})).value.watchdog, null);
  assert.equal((await s.call('setWatchdog', {enabled: true})).error.message, '当前系统不支持');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-settings-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  let on = false;
  let broken = false;
  const watchdog = {
    enabled: () => on,
    install() { if (broken) throw new Error('Bootstrap failed: 5: Input/output error'); on = true; },
    uninstall() { on = false; },
  };
  const call = createSettingsHandler({dir, getRemote: () => null, getBootError: () => '', reload: async () => {}, qr: s.qr, watchdog});
  assert.deepEqual((await call('state', {})).value.watchdog, {enabled: false});
  assert.deepEqual((await call('setWatchdog', {enabled: true})).value.watchdog, {enabled: true});
  assert.deepEqual((await call('setWatchdog', {enabled: false})).value.watchdog, {enabled: false});
  assert.equal((await call('setWatchdog', {enabled: 'yes'})).error.message, '参数无效');
  broken = true;
  const r = await call('setWatchdog', {enabled: true});
  assert.equal(r.error.message, '开启失败，请稍后重试');
});
