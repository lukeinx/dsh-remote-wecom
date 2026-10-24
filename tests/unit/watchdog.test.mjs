import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {WeComTransport} from '../../lib/core/wecom.mjs';
import {HEARTBEAT_FILE, KICK_BACKOFF_MS, LAUNCH_WAIT_MS, OFFLINE_WELCOME, SPOOL_TTL_MS, STALE_MS, clearHeartbeat, createWatchdog,
  heartbeatFresh, spoolCount, spoolMessage, takeLaunched, takeSpool, watchdogState, writeHeartbeat} from '../../lib/core/watchdog.mjs';

const turn = () => new Promise(r => setTimeout(r, 15));
function fixture(t, {owner = 'owner'} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-watchdog-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({botId: 'bot', secret: 'secret', ownerUserId: owner}));
  const clock = {now: 1_000_000};
  const made = [];
  const launches = [];
  const dog = createWatchdog({
    dir, now: () => clock.now,
    launch: async () => { launches.push(clock.now); },
    createTransport: opts => {
      const tr = {opts, started: false, stopped: false, sent: [],
        start() { this.started = true; }, stop() { this.stopped = true; },
        send(m) { this.sent.push(m); return Promise.resolve(true); }};
      made.push(tr);
      return tr;
    },
  });
  t.after(() => dog.stop());
  const run = ms => { for (const end = clock.now + ms; clock.now < end;) { clock.now = Math.min(end, clock.now + 2000); dog.tick(); } };
  return {dir, clock, made, launches, dog, run};
}

test('看门狗：心跳过期才接管，心跳恢复即让出，状态写盘', t => {
  const f = fixture(t);
  writeHeartbeat(f.dir, f.clock.now);
  f.dog.tick();
  assert.equal(f.made.length, 0);
  f.run(STALE_MS - 2000);
  assert.equal(f.made.length, 0);
  f.run(2001);
  assert.equal(f.made.length, 1);
  assert.equal(f.made[0].started, true);
  assert.equal(f.made[0].opts.greet, false);
  assert.equal(f.made[0].opts.welcome, OFFLINE_WELCOME);
  assert.equal(watchdogState(f.dir).connected, true);
  f.dog.tick();
  assert.equal(f.made.length, 1);
  writeHeartbeat(f.dir, f.clock.now);
  f.dog.tick();
  assert.equal(f.made[0].stopped, true);
  assert.equal(f.dog.connected, false);
  assert.deepEqual([watchdogState(f.dir).connected, watchdogState(f.dir).at], [false, f.clock.now]);
});

test('看门狗：未绑定主人不连；插件停止时只删自己写的心跳', t => {
  const f = fixture(t, {owner: ''});
  f.dog.tick();
  assert.equal(f.made.length, 0);
  writeHeartbeat(f.dir);
  assert.equal(heartbeatFresh(f.dir), true);
  fs.writeFileSync(path.join(f.dir, HEARTBEAT_FILE), JSON.stringify({pid: -1, at: Date.now()}));
  clearHeartbeat(f.dir);
  assert.equal(heartbeatFresh(f.dir), true);
  writeHeartbeat(f.dir);
  clearHeartbeat(f.dir);
  assert.equal(heartbeatFresh(f.dir), false);
});

test('看门狗：消息暂存并静默拉起一次 Desktop；卡片提示重新操作；超时告警', async t => {
  const f = fixture(t);
  f.dog.tick();
  const {onMessage, onCard} = f.made[0].opts;
  const ack = {media: false};
  const first = await onMessage('你好', [{local: '/tmp/a.png', name: 'a.png', kind: 'image', bytes: 3, url: 'x'}], ack, {quote: 'q'});
  assert.equal(first, '');
  assert.equal(takeLaunched(f.dir, f.clock.now), true);
  assert.equal(takeLaunched(f.dir, f.clock.now), false);
  assert.equal(ack.media, true);
  f.clock.now += 1;
  assert.equal(await onMessage('第二条', [], {media: false}), '');
  assert.match(await onCard({}), /重新操作/);
  assert.equal(f.launches.length, 1);
  assert.equal(spoolCount(f.dir), 2);
  f.run(LAUNCH_WAIT_MS + 1);
  assert.match(String(f.made[0].sent[0]), /仍未上线/);
  f.dog.tick();
  assert.equal(f.made[0].sent.length, 1);
  const entries = takeSpool(f.dir);
  assert.deepEqual(entries.map(e => e.text), ['你好', '第二条']);
  assert.deepEqual(entries[0].files, [{local: '/tmp/a.png', name: 'a.png', kind: 'image', bytes: 3}]);
  assert.equal(entries[0].quote, 'q');
  assert.equal(spoolCount(f.dir), 0);
});

test('看门狗：拉起失败提示手动打开，下一条消息重试', async t => {
  const f = fixture(t);
  let fail = true;
  let opts;
  const dog = createWatchdog({dir: f.dir, now: () => f.clock.now,
    launch: async () => { if (fail) throw new Error('boom'); },
    createTransport: o => { opts = o; return {start() {}, stop() {}, send: async () => true}; }});
  t.after(() => dog.stop());
  dog.tick();
  assert.match(await opts.onMessage('a', [], {}), /启动 DSH Desktop 失败/);
  assert.equal(dog.launching, null);
  fail = false;
  assert.equal(await opts.onMessage('b', [], {}), '');
  assert.equal(spoolCount(f.dir), 2);
});

test('看门狗：被其他连接踢下线后退避，不互踢', t => {
  const f = fixture(t);
  f.dog.tick();
  f.made[0].kickedAt = f.clock.now;
  f.dog.tick();
  assert.equal(f.made[0].stopped, true);
  assert.equal(f.made.length, 1);
  f.run(KICK_BACKOFF_MS - 2000);
  assert.equal(f.made.length, 1);
  f.run(2000);
  assert.equal(f.made.length, 2);
});

test('看门狗：睡眠唤醒后先等插件补写心跳，不抢连接', t => {
  const f = fixture(t);
  writeHeartbeat(f.dir, f.clock.now);
  f.dog.tick();
  f.clock.now += 3600_000;
  f.dog.tick();
  assert.equal(f.made.length, 0);
  writeHeartbeat(f.dir, f.clock.now + 4000);
  f.run(10_000);
  assert.equal(f.made.length, 0);
  f.run(STALE_MS);
  assert.equal(f.made.length, 1);
});

test('传输层：首次连上后静默重放暂存，过期的只提示，重连不重复', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-watchdog-replay-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const client = new EventEmitter();
  const sent = [];
  Object.assign(client, {connect() {}, disconnect() {}, async sendMessage(to, body) { sent.push(body.markdown?.content); }});
  const calls = [];
  const config = {botId: 'bot', secret: 'secret', ownerUserId: 'owner', inboxDir: path.join(dir, 'inbox')};
  const tr = new WeComTransport({config, dir, client, greet: false,
    onMessage: async (text, files, ack, {quote}) => { calls.push([text, files.length, quote]); return `done ${text}`; }, onCard: async () => ''});
  t.after(() => tr.stop());
  const now = Date.now();
  spoolMessage(dir, {text: '旧', files: [], quote: '', at: now - SPOOL_TTL_MS - 1});
  spoolMessage(dir, {text: '新', files: [{local: '/tmp/x'}], quote: 'q', at: now});
  tr.replaySpool(() => takeSpool(dir), {ttlMs: SPOOL_TTL_MS});
  tr.start();
  client.emit('authenticated');
  await tr.inbound;
  await turn();
  assert.deepEqual(calls, [['新', 1, 'q']]);
  assert.match(sent[0], /^有 1 条离线消息超过/);
  assert.equal(sent[1], 'done 新');
  assert.equal(spoolCount(dir), 0);
  spoolMessage(dir, {text: '再来', files: [], quote: '', at: Date.now()});
  client.emit('authenticated');
  await tr.inbound;
  assert.equal(calls.length, 1);
});
