import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {WeComTransport, AUTO_BIND_HINT} from '../../lib/core/wecom.mjs';
import {createBindCode} from '../../lib/core/config.mjs';

const turn = () => new Promise(r => setTimeout(r, 15));

function fixture(t, {owner = '', auto = Date.now() + 60000} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auto-bind-'));
  const client = new EventEmitter();
  const sent = []; const saved = []; const calls = [];
  Object.assign(client, {connect() {}, disconnect() {}, async sendMessage(to, body) { sent.push({to, body}); }});
  const config = {botId: 'bot', secret: 's', ownerUserId: owner, inboxDir: path.join(dir, 'inbox')};
  const transport = new WeComTransport({config, dir, client,
    onMessage: async text => { calls.push(text); return 'ok'; }, onCard: async () => '', onBind: async id => { saved.push(id); }});
  transport.connected = true;
  const code = createBindCode(dir, Date.now(), auto ? {auto} : {});
  t.after(() => { transport.stop(); fs.rmSync(dir, {recursive: true, force: true}); });
  let seq = 0;
  const say = (text, extra = {}) => transport.accept({headers: {req_id: `m${++seq}`}, body: {
    msgid: `m${seq}`, aibotid: 'bot', chattype: 'single', from: {userid: 'alice'}, msgtype: 'text', text: {content: text}, ...extra}});
  return {dir, client, transport, config, sent, saved, calls, code, say};
}
const bindCards = f => f.sent.filter(m => m.body.msgtype === 'template_card' && m.body.template_card.emphasis_content?.title === '绑定成功');

test('窗口内：第一个单聊发任意消息的人成为主人，回绑定成功卡片，消息不进会话', async t => {
  const f = fixture(t);
  f.say('你好');
  f.say('我也要', {from: {userid: 'mallory'}});
  await f.transport.inbound; await f.transport.flush(); await turn();
  assert.deepEqual(f.saved, ['alice']);
  assert.equal(f.config.ownerUserId, 'alice');
  assert.equal(fs.existsSync(path.join(f.dir, 'bind.json')), false);
  const cards = bindCards(f);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].to, 'alice');
  assert.deepEqual(f.calls, []);
  assert.ok(!f.sent.some(m => m.to === 'mallory' && m.body.msgtype === 'template_card'));
});

test('窗口过期：普通消息不绑定，退回绑定码模式（正确的码仍可绑定）', async t => {
  const f = fixture(t, {auto: Date.now() - 1});
  f.say('你好');
  await f.transport.inbound;
  assert.deepEqual(f.saved, []);
  assert.match(f.sent.at(-1).body.markdown.content, /6 位绑定码/);
  f.say(f.code);
  await f.transport.inbound;
  assert.deepEqual(f.saved, ['alice']);
});

test('群聊消息不认主；进入会话事件只提示不认主', async t => {
  const f = fixture(t);
  f.say('群里说话', {chattype: 'group', chatid: 'g1'});
  f.client.emit('event.enter_chat', {headers: {req_id: 'e1'}, body: {msgid: 'e1', aibotid: 'bot', chattype: 'single', from: {userid: 'bob'}, msgtype: 'event', event: {eventtype: 'enter_chat'}}});
  await f.transport.inbound; await turn();
  assert.deepEqual(f.saved, []);
  assert.equal(f.config.ownerUserId, '');
  assert.deepEqual(f.sent.map(m => [m.to, m.body.markdown?.content]), [['bob', AUTO_BIND_HINT]]);
  f.say('单聊');
  await f.transport.inbound;
  assert.deepEqual(f.saved, ['alice']);
});

test('已绑定：窗口仍在也不会被他人抢走', async t => {
  const f = fixture(t, {owner: 'owner'});
  f.say('抢一下', {from: {userid: 'mallory'}});
  await f.transport.inbound;
  assert.deepEqual(f.saved, []);
  assert.equal(f.config.ownerUserId, 'owner');
  assert.deepEqual(f.sent, []);
});

test('绑定锁定优先于自动认主', async t => {
  const f = fixture(t);
  f.transport.bindLocked = true;
  f.say('你好');
  await f.transport.inbound;
  assert.deepEqual(f.saved, []);
  assert.match(f.sent.at(-1).body.markdown.content, /已锁定/);
});
