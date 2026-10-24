import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {BIND_FILE, createBindCode, defaultDataDir, loadConfig, saveConfig, saveOwner} from '../../lib/core/config.mjs';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-config-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
const write = (dir, v) => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(v));

test('remoteConfirm 配置：默认 ask-then-allow / 10 分钟；非法策略与越界超时报错', t => {
  const dir = tmp(t);
  write(dir, {});
  assert.equal(loadConfig(dir).remoteConfirm, 'ask-then-allow');
  assert.equal(loadConfig(dir).remoteConfirmTimeoutMs, 600000);
  write(dir, {remoteConfirm: 'ask', remoteConfirmTimeoutMs: 86400000});
  assert.equal(loadConfig(dir).remoteConfirm, 'ask');
  write(dir, {remoteConfirm: 'yes'}); assert.throws(() => loadConfig(dir), /remoteConfirm/);
  // > 2^31-1 would make setTimeout fire immediately, i.e. auto-allow at once.
  write(dir, {remoteConfirmTimeoutMs: 2 ** 31}); assert.throws(() => loadConfig(dir), /remoteConfirmTimeoutMs/);
  write(dir, {remoteConfirmTimeoutMs: 10}); assert.throws(() => loadConfig(dir), /remoteConfirmTimeoutMs/);
});

test('默认值：收件目录在数据目录下，创建会话默认不拉起 Desktop；openDesktop 非布尔报错', t => {
  const dir = tmp(t);
  const cfg = loadConfig(dir);
  assert.equal(cfg.inboxDir, path.join(dir, 'inbox'));
  assert.equal(cfg.openDesktop, false);
  write(dir, {openDesktop: 'no'}); assert.throws(() => loadConfig(dir), /openDesktop/);
});

test('wsUrl 只允许 wss 或本机 ws', t => {
  const dir = tmp(t);
  write(dir, {wsUrl: 'ws://127.0.0.1:1234'}); assert.equal(loadConfig(dir).wsUrl, 'ws://127.0.0.1:1234');
  write(dir, {wsUrl: 'ws://example.com'}); assert.throws(() => loadConfig(dir), /wss/);
});

test('数据目录跟随 DSH_HOME', t => {
  const previous = process.env.DSH_HOME;
  t.after(() => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; });
  process.env.DSH_HOME = '/x/home';
  assert.equal(defaultDataDir(), '/x/home/integrations/dsh-remote-wecom');
});

test('saveConfig 写 600 权限且要求凭证；saveOwner 只改 ownerUserId，不写回默认值', t => {
  const dir = tmp(t);
  assert.throws(() => saveConfig(dir, {botId: '', secret: 's'}), /setup/);
  saveConfig(dir, {botId: 'b', secret: 's', wsUrl: 'ws://127.0.0.1:1'});
  assert.equal(fs.statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600);
  saveOwner(dir, 'owner');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')), {botId: 'b', secret: 's', wsUrl: 'ws://127.0.0.1:1', ownerUserId: 'owner'});
});

test('绑定码：6 位数字，600 权限，10 分钟有效', t => {
  const dir = tmp(t);
  const code = createBindCode(dir, 1000);
  assert.match(code, /^\d{6}$/);
  const file = path.join(dir, BIND_FILE);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {code, expiresAt: 1000 + 600000, failures: 0});
});
