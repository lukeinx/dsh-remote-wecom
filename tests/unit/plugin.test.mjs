import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {WebSocketServer} from 'ws';
import * as plugin from '../../lib/index.mjs';
import {RESTART_NOTICE, WELCOME} from '../../lib/core/wecom.mjs';
import {createWatchdog, spoolCount} from '../../lib/core/watchdog.mjs';

const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 10000, what = '') {
  const start = Date.now();
  while (Date.now() - start < ms) { const r = await fn(); if (r) return r; await delay(20); }
  throw new Error(`timed out${what ? `: ${what}` : ''}`);
}

/** 假企微：每个请求帧都回 errcode 0，记录主动发送的正文与连接次数。 */
async function fakeWeCom(t) {
  const server = new WebSocketServer({host: '127.0.0.1', port: 0});
  await new Promise(r => server.on('listening', r));
  const state = {server, socket: null, connections: 0, sent: []};
  server.on('connection', w => {
    state.socket = w;
    state.connections++;
    w.on('message', raw => {
      const frame = JSON.parse(String(raw));
      if (frame.cmd === 'aibot_send_msg') state.sent.push(frame.body?.markdown?.content || '');
      w.send(JSON.stringify({headers: frame.headers, errcode: 0, errmsg: 'ok'}));
    });
  });
  t.after(async () => { for (const c of server.clients) c.terminate(); await new Promise(r => server.close(r)); });
  state.url = `ws://127.0.0.1:${server.address().port}`;
  let seq = 0;
  state.say = text => {
    const id = `m${++seq}`;
    state.socket.send(JSON.stringify({cmd: 'aibot_msg_callback', headers: {req_id: id}, body: {
      msgid: id, aibotid: 'bot', chattype: 'single', from: {userid: 'owner'}, msgtype: 'text', text: {content: text},
    }}));
  };
  return state;
}

function fakeCtx() {
  const handlers = new Map();
  const disposers = [];
  const warnings = [];
  const routes = new Map();
  return {
    handlers, warnings, routes,
    logger: {warn: l => warnings.push(l), debug() {}},
    connection: {
      createPeer: () => ({}),
      fetch: {register(route) { routes.set(route.path, route); return () => routes.delete(route.path); }},
    },
    typertGateway: {invoke: async () => ({items: []})},
    on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
    effect(fn) { disposers.push(fn()); },
    dispose() { for (const d of disposers.splice(0)) d(); },
  };
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-plugin-'));
  const ctx = fakeCtx();
  t.after(async () => { ctx.dispose(); await delay(50); fs.rmSync(dir, {recursive: true, force: true}); });
  const writeConfig = (wsUrl, extra = {}) => fs.writeFileSync(path.join(dir, 'config.json'),
    JSON.stringify({botId: 'bot', secret: 'secret', ownerUserId: 'owner', wsUrl, openDesktop: false, ...extra}), {mode: 0o600});
  return {dir, ctx, writeConfig, apply: () => plugin.apply(ctx, {dataDir: dir, watchMs: 50})};
}

test('入口声明：name 与 inject', () => {
  assert.equal(plugin.name, 'dsh-remote-wecom');
  assert.deepEqual(plugin.inject, ['typertGateway', 'connection']);
});

test('未配置凭证只记日志；写入配置后自动连接，外部再改配置会重连', async t => {
  const wecom = await fakeWeCom(t);
  const s = setup(t);
  s.apply();
  assert.match(s.ctx.warnings.join('\n'), /未配置 BotID/);
  await delay(150);
  assert.equal(wecom.connections, 0);
  s.writeConfig(wecom.url);
  await until(() => wecom.sent.includes(WELCOME), 10000, 'welcome');
  assert.equal(wecom.connections, 1);
  await delay(30);
  s.writeConfig(wecom.url, {remoteConfirm: 'ask'});
  await until(() => wecom.connections === 2, 10000, 'reconnect');
});

test('设置页路由：随插件注册/注销；改偏好立即重连一次，mtime 轮询不重复触发，也不发重启通知', async t => {
  const wecom = await fakeWeCom(t);
  const s = setup(t);
  s.writeConfig(wecom.url);
  plugin.apply(s.ctx, {dataDir: s.dir, watchMs: 30});
  await until(() => wecom.sent.includes(WELCOME), 10000, 'welcome');
  const route = s.ctx.routes.get('/api/dsh-remote-wecom/settings');
  assert.ok(route);
  assert.deepEqual(route.methods, ['POST']);
  const res = await route.fetch(new Request('http://127.0.0.1:1/api/dsh-remote-wecom/settings', {
    method: 'POST', headers: {'content-type': 'application/json', host: '127.0.0.1:1'},
    body: JSON.stringify({type: 'client-request', rpcId: 'p1', method: 'dsh-remote-wecom/settings', payload: {method: 'setPrefs', payload: {remoteConfirm: 'ask'}}}),
  }));
  const body = await res.json();
  assert.equal(body.result.ok, true);
  assert.equal(body.result.value.prefs.remoteConfirm, 'ask');
  await until(() => wecom.connections === 2, 10000, 'reconnect');
  await delay(400);
  assert.equal(wecom.connections, 2);
  assert.ok(!wecom.sent.includes(RESTART_NOTICE));
  s.ctx.dispose();
  assert.equal(s.ctx.routes.size, 0);
});

test('「重启」重建遥控实例并在新连接上通知；停止后断开且审批交回 Desktop', async t => {
  const wecom = await fakeWeCom(t);
  const s = setup(t);
  s.writeConfig(wecom.url);
  s.apply();
  await until(() => wecom.sent.includes(WELCOME), 10000, 'welcome');
  wecom.say('重启');
  await until(() => wecom.sent.some(x => /正在重启/.test(x)), 10000, 'restart ack');
  await until(() => wecom.connections === 2 && wecom.sent.includes(RESTART_NOTICE), 15000, 'restart notice');

  const socket = wecom.socket;
  const closed = new Promise(r => socket.once('close', r));
  s.ctx.dispose();
  await closed;
  const approval = s.ctx.handlers.get('approval/request');
  assert.equal(await approval({agent: {session: {id: 's1'}}, toolName: 'write'}, async () => 'allowed-once'), 'allowed-once');
  await delay(200);
  assert.equal(wecom.connections, 2);
});

test('看门狗：Desktop 离线时暂存并拉起，插件上线后接管连接并重放，停止后清掉心跳', async t => {
  const wecom = await fakeWeCom(t);
  const s = setup(t);
  s.writeConfig(wecom.url);
  const launches = [];
  const dog = createWatchdog({dir: s.dir, launch: async () => { launches.push(Date.now()); }});
  t.after(() => dog.stop());
  dog.tick();
  await until(() => wecom.connections === 1, 10000, 'watchdog connect');
  await delay(100);
  wecom.say('状态');
  await until(() => spoolCount(s.dir) === 1, 10000, 'spooled');
  assert.equal(launches.length, 1);
  const before = wecom.sent.length;
  assert.equal(spoolCount(s.dir), 1);

  s.apply();
  dog.tick();
  assert.equal(dog.connected, false);
  await until(() => wecom.sent.length > before, 10000, 'replayed reply');
  assert.ok(!wecom.sent.some(x => /已在后台启动|已重启|开始处理离线/.test(x)), '拉起路径不发中间通知');
  assert.equal(wecom.connections, 2);
  assert.equal(spoolCount(s.dir), 0);

  s.ctx.dispose();
  await until(() => !fs.existsSync(path.join(s.dir, 'alive.json')), 15000, 'heartbeat cleared');
});
