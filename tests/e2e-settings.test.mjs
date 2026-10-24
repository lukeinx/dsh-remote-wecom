// 设置页端到端：隔离的 dsh web 实例里走真实的浏览器鉴权与 /api 路由，假扫码接口 + 假企微完成
// 「扫码 → 写入凭证 → 连接 → 自动认主」，并确认 web 客户端的启动图里带着本插件的 dist/client.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {callSettings, ROOT, startDshWeb} from './fixtures/dsh-web.mjs';
import {startFakeQr, startFakeWeCom} from './fixtures/fakes.mjs';

const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 20000, what = '') {
  const start = Date.now();
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await delay(100); }
  throw new Error(`timed out${what ? `: ${what}` : ''}`);
}

test('设置页：前端加载、/api 鉴权、扫码创建机器人、自动认主、偏好', {timeout: 180000}, async t => {
  assert.ok(fs.existsSync(path.join(ROOT, 'dist/client.js')), '先运行 npm run build');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-e2e-settings-'));
  const data = path.join(tmp, 'data');
  fs.mkdirSync(data, {mode: 0o700});
  const wecom = await startFakeWeCom({botId: 'scan-bot-0001'});
  const qr = await startFakeQr({botId: 'scan-bot-0001'});
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({wsUrl: wecom.url, openDesktop: false}), {mode: 0o600});
  const web = await startDshWeb({tmp, dataDir: data, pluginConfig: {qrBaseUrl: qr.url, qrPollMs: 150, watchdogDryRun: true}});
  t.after(async () => {
    await web.stop();
    await wecom.close();
    await qr.close();
    fs.rmSync(tmp, {recursive: true, force: true});
  });
  const responses = [];
  const call = async (method, payload) => {
    const r = await callSettings(web, method, payload);
    responses.push(r.text);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.type, 'server-response');
    return r.result;
  };

  await t.test('web 客户端启动图包含本插件，脚本就是 dist/client.js', async () => {
    const html = await (await fetch(`${web.origin}/`, {headers: {cookie: web.cookie}})).text();
    const boot = JSON.parse(/__DSH_BOOT__"\]\s*=\s*(\{.*?\});?\s*<\/script>/s.exec(html)?.[1] ?? 'null');
    assert.ok(boot, '首页里没有 __DSH_BOOT__');
    const entry = boot.entries.find(e => e.id === 'dsh-remote-wecom');
    assert.ok(entry, `启动图里没有 dsh-remote-wecom：${boot.entries.map(e => e.id).join(', ')}`);
    assert.deepEqual(entry.inject, ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-settings']);
    const script = await (await fetch(new URL(entry.url, `${web.origin}/`))).text();
    assert.ok(script.includes(fs.readFileSync(path.join(ROOT, 'dist/client.js'), 'utf8').trim().slice(0, 2000)), '实例下发的脚本应包含 dist/client.js');
    assert.match(script, /settings\.section/);
  });

  await t.test('/api 路由：未登录 401，非本机 Origin 403，登录后可用', async () => {
    const anon = await callSettings({...web, cookie: ''}, 'state');
    assert.equal(anon.status, 401);
    const cross = await callSettings(web, 'state', {}, {origin: 'http://evil.example.com'});
    assert.equal(cross.status, 403);
    const r = await call('state');
    assert.equal(r.ok, true);
    assert.equal(r.value.bot.configured, false);
    assert.equal(r.value.connection.reason, '未配置机器人');
  });

  await t.test('扫码：第 3 次轮询成功 → 写入凭证并连上，进入自动认主窗口', async () => {
    let r = await call('qrStart');
    assert.equal(r.value.qr.state, 'waiting');
    r = await until(async () => { const v = await call('state'); return v.value.qr.dataUrl && v; }, 10000, 'qr dataUrl');
    assert.match(r.value.qr.dataUrl, /^data:image\/png;base64,/);
    r = await until(async () => {
      const v = await call('state');
      return v.value.bot.configured && v.value.connection.connected && v.value.qr.state === 'idle' && v;
    }, 30000, 'connected after scan');
    assert.equal(r.value.bot.botId, 'scan••••0001');
    assert.equal(r.value.owner.bound, false);
    assert.match(r.value.bind.code, /^\d{6}$/);
    assert.ok(r.value.bind.auto.expiresAt > Date.now());
    assert.equal(qr.state.polls, 3);
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    assert.equal(saved.botId, 'scan-bot-0001');
    assert.equal(saved.secret, qr.secret);
  });

  await t.test('自动认主：群聊不算，第一个单聊消息的人成为主人并收到绑定成功卡片', async () => {
    wecom.say('群里的消息', {userid: 'mallory', chattype: 'group'});
    await delay(500);
    assert.equal((await call('state')).value.owner.bound, false);
    wecom.say('你好', {userid: 'alice'});
    const r = await until(async () => { const v = await call('state'); return v.value.owner.bound && v; }, 15000, 'owner bound');
    assert.equal(r.value.owner.userId, 'a•••e');
    assert.deepEqual(r.value.bind, {});
    await until(() => wecom.state.sent.some(b => b.template_card?.emphasis_content?.title === '绑定成功'), 10000, 'bind card');
  });

  await t.test('偏好与别名：保存即生效，校验失败返回错误且不写盘', async () => {
    const before = wecom.state.connections;
    let r = await call('setPrefs', {remoteConfirm: 'ask', remoteConfirmTimeoutMs: 90000});
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.prefs, {remoteConfirm: 'ask', remoteConfirmTimeoutMs: 90000, openDesktop: false});
    await until(() => wecom.state.connections > before, 15000, 'reconnect after prefs');
    r = await call('setPrefs', {remoteConfirmTimeoutMs: 5});
    assert.equal(r.ok, false);
    assert.ok(r.error.details);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).remoteConfirmTimeoutMs, 90000);
    await until(async () => (await call('state')).value.connection.connected, 15000, 'connected again');
    assert.ok(!wecom.state.sent.some(b => /已重启/.test(b?.markdown?.content || '')), '改偏好不发重启通知');
  });

  await t.test('所有返回都不含 Secret', () => {
    assert.ok(responses.length > 5);
    for (const text of responses) assert.ok(!text.includes(qr.secret), text.slice(0, 200));
  });
});
