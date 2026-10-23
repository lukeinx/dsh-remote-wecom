import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {WebSocketServer} from 'ws';
import * as plugin from '../../lib/index.mjs';
import {RESTART_NOTICE, WELCOME} from '../../lib/core/wecom.mjs';

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
  return {
    handlers, warnings,
    logger: {warn: l => warnings.push(l), debug() {}},
    connection: {createPeer: () => ({})},
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
