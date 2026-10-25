import test from 'node:test';
import assert from 'node:assert/strict';
import {lastTurn} from '../../lib/core/recap.mjs';

let seq = 0;
const T0 = Date.parse('2026-10-25T00:00:00Z');
const ev = (type, data = {}) => ({type, seq: ++seq, time: T0 + seq * 1000, data});
const user = (text, kind = 'user') => ev('user/message', {source: {kind}, content: [{type: 'text', text}]});
const say = (text) => ev('assistant/message', {message: {content: [{type: 'thinking', thinking: 'x'}, {type: 'text', text}]}});
const end = (kind = 'completed') => ev('turn/end', {reason: {kind}});

test('取最近一轮已结束的：跳过注入消息，插话不另起一轮，正文取最后一段文字', () => {
  const events = [
    ev('turn/start'), user('第一轮'), say('答一'), end(),
    ev('turn/start'), user('环境', 'runtime-context'), user('第二轮'), say('中间'), user('插话'), say('最终'), ev('assistant/message', {message: {content: []}}), end(),
  ];
  const t = lastTurn(events.reverse());
  assert.equal(t.prompt, '第二轮');
  assert.equal(t.text, '最终');
  assert.equal(t.status, 'done');
  assert.equal(t.endedAt - t.startedAt, 7000);
});

test('进行中的轮次和被拦下的空轮次跳过', () => {
  const events = [ev('turn/start'), user('旧'), say('旧答'), end(), ev('turn/start'), end('blocked'), ev('turn/start'), user('新'), say('半截')];
  assert.equal(lastTurn(events).prompt, '旧');
  assert.equal(lastTurn([ev('turn/start'), user('刚发')]), null);
  assert.equal(lastTurn([]), null);
});

test('中断、出错、目标触发和快照从一轮中间开始', () => {
  assert.equal(lastTurn([ev('turn/start'), user('跑'), end('aborted')]).status, 'aborted');
  assert.equal(lastTurn([ev('turn/start'), user('跑'), end('error')]).status, 'error');
  assert.equal(lastTurn([ev('turn/start'), user('继续目标', 'goal'), say('好'), end()]).prompt, '继续目标');
  const t = lastTurn([say('半轮回复'), end()]);
  assert.equal(t.prompt, '');
  assert.equal(t.text, '半轮回复');
});
