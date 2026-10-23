import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRemote, PHONE_RPC_PREFIX} from '../../lib/core/remote.mjs';
import {loadConfig} from '../../lib/core/config.mjs';
import {createDshHost, sessionInfo} from '../../lib/host/dsh-host.mjs';

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
const textOf = m => typeof m === 'string' ? m : m?.text || m?.fallback || '';

/** 假宿主：记录调用；prompt 之后由测试用 onPrompt 模拟 DSH 事件。 */
function fakeHost(sessions) {
  const calls = [];
  const host = {
    calls, onPrompt: null,
    async listSessions() { return sessions; },
    async projections(sid) { return {title: sessions.find(s => s.sessionId === sid)?.title || null, modelSelection: {next: {provider: 'mock', model: 'echo', reasoningEffort: 'low'}}, contextPressure: {pressureTokens: 2000, projectedTokens: 2000, contextWindow: 100000}}; },
    async createSession(cwd) { calls.push(['create', cwd]); sessions.push({sessionId: 's-new', cwd, agentAvailable: true}); return 's-new'; },
    async prompt(sid, requestId, text) { calls.push(['prompt', sid, requestId, text]); setImmediate(() => host.onPrompt?.(sid, requestId, text)); },
    async cancel(sid) { calls.push(['cancel', sid]); },
    async modelCatalog() { return {routableProviders: ['mock'], groups: [{id: 'mock', models: [{id: 'echo', name: 'Echo', reasoning: {efforts: [{id: 'low'}, {id: 'high'}], defaultEffort: 'low'}}, {id: 'echo2', name: 'Echo 2'}]}]}; },
    async selectModel(sid, sel) { calls.push(['select', sid, sel]); return sel; },
    async compact(sid) { calls.push(['compact', sid]); return {kind: 'success', text: 'Compacted 3 history items.'}; },
    async snapshot() { return []; },
  };
  return host;
}
function fakeTransport(sent) {
  return () => ({connected: true, start() {}, stop() {}, drain() {}, bound: () => true, send(m) { sent.push(m); return Promise.resolve(true); }});
}
function fixture(t, {sessions, config = {}, onRestart = null} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-unit-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-ws-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({botId: 'b', secret: 's', ownerUserId: 'owner', openDesktop: false, nameWaitMs: 300, ...config}));
  const host = fakeHost(sessions || [{sessionId: 's1', cwd: ws, agentAvailable: true, running: false, title: 'Alpha', prompts: ['第一句']}]);
  const sent = [];
  const remote = createRemote({host, dir, config: loadConfig(dir), createTransport: fakeTransport(sent), onRestart});
  remote.start();
  t.after(async () => { await remote.stop('测试结束'); fs.rmSync(dir, {recursive: true, force: true}); fs.rmSync(ws, {recursive: true, force: true}); });
  const say = (text, quote = '') => remote.handleCommand(text, [], {media: false}, {quote});
  /** 一轮完整的 DSH 事件序列（已翻译成 core 入口）。 */
  const turn = (sid, {rpcId = '', text = 'hi', reply = `echo: ${text}`, kind = 'completed', error} = {}) => {
    remote.sessionStatus(sid, true);
    remote.turnBegin(sid, {rpcId, text});
    if (reply) remote.output(sid, reply);
    remote.turnEnd(sid, {kind, error});
    remote.sessionStatus(sid, false);
  };
  return {remote, host, sent, say, turn, dir, ws};
}
const boundSid = f => fs.readFileSync(path.join(f.dir, '.current'), 'utf8').trim();
async function bindFirst(f) {
  await f.say('活跃会话');
  return textOf(await f.say('选择会话 1'));
}

test('手机投递：requestId 带 wecom- 前缀，同一 id 的轮次结束后即时回传结果', async t => {
  const f = fixture(t);
  assert.match(await bindFirst(f), /Alpha/);
  f.host.onPrompt = (sid, id, text) => f.turn(sid, {rpcId: id, text});
  const reply = textOf(await f.say('你好'));
  const prompt = f.host.calls.find(c => c[0] === 'prompt');
  assert.ok(prompt[2].startsWith(PHONE_RPC_PREFIX));
  assert.match(reply, /任务完成/);
  assert.match(reply, /echo: 你好/);
  assert.match(reply, /上下文：2\.0%/);
});

test('电脑发起的轮次：绑定会话才推送；取关后不推送，关注后恢复', async t => {
  const f = fixture(t, {sessions: [
    {sessionId: 's1', cwd: os.homedir(), agentAvailable: true, title: 'Alpha'},
    {sessionId: 's2', cwd: os.homedir(), agentAvailable: true, title: 'Beta'},
  ]});
  await f.say('活跃会话');
  await f.say('选择会话 1');
  const bound = boundSid(f);
  const other = bound === 's1' ? 's2' : 's1';
  f.turn(other, {rpcId: 'desk-1', text: '没绑定'});
  f.turn(bound, {rpcId: 'desk-2', text: '桌面'});
  await tick(30);
  assert.deepEqual(f.sent.map(textOf).filter(s => /任务完成/.test(s)).length, 1);
  assert.match(textOf(f.sent.at(-1)), /echo: 桌面/);
  assert.match(textOf(await f.say('取关')), /已取关/);
  f.turn(bound, {rpcId: 'desk-3', text: '静音'});
  await tick(30);
  assert.ok(!f.sent.map(textOf).some(s => /echo: 静音/.test(s)));
  assert.match(textOf(await f.say('关注')), /关注/);
  f.turn(bound, {rpcId: 'desk-4', text: '恢复'});
  await tick(30);
  assert.match(textOf(f.sent.at(-1)), /echo: 恢复/);
});

test('重启：有任务运行时拒绝并列出会话，「重启 force」交给宿主重建', async t => {
  let restarts = 0;
  const f = fixture(t, {onRestart: () => { restarts++; }});
  await bindFirst(f);
  assert.match(textOf(await f.say('在跑的任务')), /运行中/);
  const refused = textOf(await f.say('重启'));
  assert.match(refused, /仍有任务运行/);
  assert.match(refused, /Alpha/);
  assert.match(textOf(await f.say('重启 稍后')), /用法/);
  assert.match(textOf(await f.say('重启 force')), /正在重启/);
  await tick(1700);
  assert.equal(restarts, 1);
});

test('停止：调 session/cancel，aborted 收尾且没有文本时不再多推一条', async t => {
  const f = fixture(t);
  await bindFirst(f);
  f.host.onPrompt = (sid, id, text) => { f.remote.sessionStatus(sid, true); f.remote.turnBegin(sid, {rpcId: id, text}); };
  assert.match(textOf(await f.say('/sleep 99999')), /运行中/);
  const before = f.sent.length;
  assert.match(textOf(await f.say('停止')), /已中断/);
  assert.ok(f.host.calls.some(c => c[0] === 'cancel' && c[1] === 's1'));
  f.remote.turnEnd('s1', {kind: 'aborted'});
  await tick(30);
  assert.equal(f.sent.length, before);
  assert.match(textOf(await f.say('状态')), /空闲/);
});

test('turn/end error 推失败；会话空闲后仍未开始的手机消息按失联收尾', async t => {
  const f = fixture(t);
  await bindFirst(f);
  f.host.onPrompt = (sid, id, text) => f.turn(sid, {rpcId: id, text, reply: '', kind: 'error', error: 'quota exceeded'});
  const reply = textOf(await f.say('会失败'));
  assert.match(reply, /任务失败/);
  assert.match(reply, /quota exceeded/);
});

test('切换模型与思考强度走 selectModel；压缩走 /compact 且提示不支持重点说明', async t => {
  const f = fixture(t);
  await bindFirst(f);
  const model = await f.say('模型 echo2');
  assert.match(JSON.stringify(model), /Echo 2/);
  assert.deepEqual(f.host.calls.find(c => c[0] === 'select')[2], {provider: 'mock', model: 'echo2'});
  await f.say('模型 echo');
  const think = await f.say('思考强度 high');
  assert.match(JSON.stringify(think), /high/);
  assert.deepEqual(f.host.calls.filter(c => c[0] === 'select').at(-1)[2], {provider: 'mock', model: 'echo', reasoningEffort: 'high'});
  const compact = JSON.stringify(await f.say('压缩 保留接口'));
  assert.match(compact, /DSH 不支持指定重点/);
  assert.ok(f.host.calls.some(c => c[0] === 'compact'));
});

test('创建会话：session/create 后投递首条，等模型标题，完成后推送', async t => {
  const f = fixture(t);
  f.host.onPrompt = (sid, id, text) => {
    f.remote.sessionStatus(sid, true);
    f.remote.turnBegin(sid, {rpcId: id, text});
    f.remote.title(sid, text.slice(0, 4), false);
    setTimeout(() => { f.remote.title(sid, 'Final Name'); f.remote.output(sid, 'done'); f.remote.turnEnd(sid, {kind: 'completed'}); }, 50);
  };
  const card = await f.say('创建会话 写个脚本');
  assert.deepEqual(f.host.calls[0], ['create', os.homedir()]);
  assert.match(JSON.stringify(card), /Final Name/);
  await tick(80);
  assert.match(textOf(f.sent.at(-1)), /任务完成[\s\S]*Final Name[\s\S]*done/);
});

test('引用推送回复：按会话名切到被引用的会话再投递', async t => {
  const f = fixture(t, {sessions: [
    {sessionId: 's1', cwd: os.homedir(), agentAvailable: true, title: 'Alpha'},
    {sessionId: 's2', cwd: os.homedir(), agentAvailable: true, title: 'Beta'},
  ]});
  await f.say('活跃会话');
  await f.say('选择会话 1');
  f.host.onPrompt = (sid, id, text) => f.turn(sid, {rpcId: id, text});
  const cur = boundSid(f);
  const other = [...f.remote.targets.values()].find(t => t.sessionId !== cur);
  const reply = textOf(await f.say('发给另一个', `🏁 任务完成 · ${other.name}\nbody`));
  const p = f.host.calls.filter(c => c[0] === 'prompt').at(-1);
  assert.equal(p[1], other.sessionId);
  assert.equal(boundSid(f), other.sessionId);
  assert.match(reply, new RegExp(other.name));
});

test('审批：只接手机发起的轮次；绑定会话推卡片，手机选「允许」兑现；未绑定会话先挂起', async t => {
  const f = fixture(t, {sessions: [
    {sessionId: 's1', cwd: os.homedir(), agentAvailable: true, title: 'Alpha'},
    {sessionId: 's2', cwd: os.homedir(), agentAvailable: true, title: 'Beta'},
  ]});
  await f.say('活跃会话');
  await f.say('选择会话 1');
  const bound = boundSid(f);
  const other = bound === 's1' ? 's2' : 's1';
  f.remote.turnBegin(bound, {rpcId: 'desk-1', text: '电脑发起'});
  assert.equal(f.remote.uiAsk(bound, {kind: 'confirm', reqId: 'r0', title: '电脑的审批'}), null);
  f.remote.turnEnd(bound, {kind: 'completed'});
  f.remote.turnBegin(bound, {rpcId: `${PHONE_RPC_PREFIX}1`, text: '手机发起'});
  f.remote.turnBegin(other, {rpcId: `${PHONE_RPC_PREFIX}2`, text: '手机发起'});
  const h = f.remote.uiAsk(bound, {kind: 'confirm', reqId: 'r1', title: '允许写文件', message: '工具：write'});
  const card = f.sent.find(m => m.card?.title?.includes('允许写文件'));
  assert.ok(card);
  const allow = card.card.options.find(o => o.text === '允许');
  await f.remote.handleCardCallback({taskId: card.card.task_id, optionId: allow.id});
  assert.deepEqual(await h.answer, {confirmed: true});
  const sentBefore = f.sent.length;
  const parked = f.remote.uiAsk(other, {kind: 'question', reqId: 'r2', title: '选页面', options: ['A', 'B'], allowText: true});
  assert.equal(f.sent.length, sentBefore + 1);
  assert.match(textOf(f.sent.at(-1)), /等你回答/);
  assert.ok(!f.sent.slice(sentBefore).some(m => m.card));
  parked.done();
});

function fakeCtx() {
  const handlers = new Map();
  return {
    handlers,
    connection: {createPeer: () => ({})},
    typertGateway: {invoke: async () => ({})},
    on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
  };
}

test('host 翻译：只认 source.kind=user 的首条消息定来源；标题区分 fallback；turn/end 带原因', () => {
  const ctx = fakeCtx();
  const log = [];
  const remote = new Proxy({stopped: false}, {get: (o, k) => k in o ? o[k] : (...a) => { log.push([k, ...a]); return null; }});
  createDshHost(ctx, () => remote);
  const emit = (type, data) => ctx.handlers.get('session/event')({id: 's1'}, {type, seq: 1, data});
  emit('turn/start', {turn: 1});
  emit('user/message', {source: {kind: 'runtime-context'}, content: [{type: 'text', text: 'ctx'}]});
  emit('user/message', {source: {kind: 'user', rpcId: 'wecom-x'}, content: [{type: 'text', text: '你好'}]});
  emit('user/message', {source: {kind: 'user', rpcId: 'other'}, content: [{type: 'text', text: '不算'}]});
  emit('assistant/message', {message: {content: [{type: 'text', text: 'echo'}, {type: 'tool-call'}]}});
  emit('tool/call', {name: 'write'});
  emit('session/title', {title: '你好', source: {kind: 'fallback'}});
  emit('session/title', {title: 'Greeting'});
  emit('turn/end', {reason: {kind: 'error', error: {message: 'boom'}}});
  const calls = log.filter(c => c[0] !== 'ingest');
  assert.deepEqual(calls, [
    ['turnBegin', 's1', {rpcId: 'wecom-x', text: '你好'}],
    ['output', 's1', 'echo'],
    ['activity', 's1', 'write'],
    ['title', 's1', '你好', false],
    ['title', 's1', 'Greeting', true],
    ['turnEnd', 's1', {kind: 'error', error: 'boom'}],
  ]);
  log.length = 0;
  emit('turn/start', {turn: 2});
  emit('assistant/message', {message: {content: [{type: 'text', text: 'no user'}]}});
  assert.deepEqual(log.filter(c => c[0] !== 'ingest')[0], ['turnBegin', 's1', {rpcId: '', text: ''}]);
  assert.equal(sessionInfo({sessionId: 'x', parentSessionId: 'p', projections: {values: {title: 'T', turnOutline: [{prompt: 'q'}]}}}).sub, true);
});

test('host 审批抢答：Desktop 立即 unavailable 时只等手机；手机先答时取消 Desktop 侧等待', async () => {
  const ctx = fakeCtx();
  let reply;
  const done = [];
  const remote = {stopped: false, uiAsk: (sid, req) => ({answer: new Promise(r => { reply = r; }), done: () => done.push(req.reqId)})};
  createDshHost(ctx, () => remote);
  const approval = ctx.handlers.get('approval/request');
  const p1 = approval({agent: {session: {id: 's1'}}, toolName: 'write', displayReason: {zh: '允许写'}}, async () => 'unavailable');
  await tick();
  reply({confirmed: false});
  assert.equal(await p1, 'rejected');
  let nativeSignal;
  const req = {agent: {session: {id: 's1'}}, toolName: 'write'};
  const p2 = approval(req, () => { nativeSignal = req.signal; return new Promise(() => {}); });
  await tick();
  reply({confirmed: true});
  assert.equal(await p2, 'allowed-once');
  assert.equal(nativeSignal.aborted, true);
  const p3 = approval({agent: {session: {id: 's1'}}, toolName: 'write'}, async () => { await tick(5); return 'allowed-once'; });
  await tick(1);
  assert.equal(await p3, 'allowed-once');
  assert.equal(done.length, 1);
  const questions = ctx.handlers.get('user-questions/request');
  const q = questions({agent: {id: 's1'}, questions: [{id: 'q1', question: '颜色？', options: [{label: 'Red'}, {label: 'Blue'}]}]}, async () => ({answers: []}));
  await tick();
  reply({index: 2, value: 'Blue'});
  assert.deepEqual(await q, {answers: [{id: 'q1', selected: ['Blue']}]});
});
