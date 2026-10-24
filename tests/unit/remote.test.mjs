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
function fakeHost(sessions, ws = {items: [], archived: new Set(), pinned: []}) {
  const calls = [];
  const host = {
    calls, onPrompt: null, ws, permission: 'read-only', goalState: null, armed: false,
    async listSessions() { return sessions; },
    async projections(sid) { return {title: sessions.find(s => s.sessionId === sid)?.title || null, permissions: {currentValue: host.permission}, goal: host.goalState, modelSelection: {next: {provider: 'mock', model: 'echo', reasoningEffort: 'low'}}, contextPressure: {pressureTokens: 2000, projectedTokens: 2000, contextWindow: 100000}}; },
    async createSession(place) {
      calls.push(['create', place]);
      const w = ws.items.find(x => x.id === place.workspaceId);
      if (w) w.sessionIds.unshift('s-new');
      sessions.push({sessionId: 's-new', cwd: w?.path || place.cwd || os.homedir(), agentAvailable: true});
      return 's-new';
    },
    async prompt(sid, requestId, text, mode) { calls.push(['prompt', sid, requestId, text, mode]); setImmediate(() => host.onPrompt?.(sid, requestId, text, mode)); },
    async workspaces() { return {items: ws.items.map(w => ({...w, sessionIds: [...w.sessionIds]})), archived: new Set(ws.archived), pinned: [...ws.pinned]}; },
    async unarchive(sid) { calls.push(['unarchive', sid]); ws.archived.delete(sid); },
    async permissionCatalog() { return [{value: 'read-only', name: 'read-only'}, {value: 'workspace-write', name: 'workspace-write'}]; },
    async setPermission(sid, preset) { calls.push(['perm', sid, preset]); host.permission = preset; return {kind: 'success', text: `preset ${preset}`}; },
    async goal(sid, line = '') {
      calls.push(['goal', sid, line]);
      const g = host.goalState?.goal;
      const set = (patch, armed) => { host.goalState = {...host.goalState, goal: {...g, ...patch}}; host.armed = armed; return {kind: 'success', text: 'ok'}; };
      if (!line) return {kind: 'success', text: g ? `Goal\nStatus: ${g.phase}\nActivation: ${host.armed ? 'armed' : 'disarmed'}` : 'No goal is currently set.'};
      if (['pause', 'resume', 'clear'].includes(line) && !g) return {kind: 'error', text: `No goal is currently set; /goal ${line} requires one.`};
      if (line === 'pause') return set({phase: 'paused'}, false);
      if (line === 'resume') return set({phase: 'active'}, true);
      if (line === 'clear') { host.goalState = null; host.armed = false; return {kind: 'success', text: 'Goal cleared'}; }
      if (line.startsWith('edit ')) return set({objective: line.slice(5)}, host.armed);
      if (g && g.phase !== 'complete') return {kind: 'error', text: `A goal is already ${g.phase}. Use /goal edit <objective> to change it or /goal clear before replacing it.`};
      host.goalState = {goal: {id: 'g1', revision: 1, objective: line, phase: 'active', maxGoalRounds: 3}, roundsStarted: 0, createdAt: 1, updatedAt: 1};
      host.armed = true;
      return {kind: 'success', text: 'Goal created'};
    },
    async cancel(sid) { calls.push(['cancel', sid]); },
    async modelCatalog() { return {routableProviders: ['mock'], groups: [{id: 'mock', models: [{id: 'echo', name: 'Echo', reasoning: {efforts: [{id: 'low'}, {id: 'high'}], defaultEffort: 'low'}}, {id: 'echo2', name: 'Echo 2'}]}]}; },
    async selectModel(sid, sel) { calls.push(['select', sid, sel]); return sel; },
    async compact(sid) { calls.push(['compact', sid]); return {kind: 'success', text: 'Compacted 3 history items.'}; },
    async snapshot() { return []; },
  };
  return host;
}
function fakeTransport(sent, drains = []) {
  return () => ({connected: true, start() {}, stop() {}, drain(o) { drains.push(o); }, bound: () => true, send(m) { sent.push(m); return Promise.resolve(true); }});
}
function fixture(t, {sessions, wsState, config = {}, onRestart = null} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-unit-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-ws-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({botId: 'b', secret: 's', ownerUserId: 'owner', openDesktop: false, nameWaitMs: 300, ...config}));
  const host = fakeHost(sessions || [{sessionId: 's1', cwd: ws, agentAvailable: true, running: false, title: 'Alpha', prompts: ['第一句']}], wsState);
  const sent = [], drains = [];
  const remote = createRemote({host, dir, config: loadConfig(dir), createTransport: fakeTransport(sent, drains), onRestart});
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
  return {remote, host, sent, drains, say, turn, dir, ws};
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

test('重启通知：手机没用过、也没有推送中的任务时不发；手机刚用过或显式要求时发', async t => {
  const idle = fixture(t);
  await idle.remote.stop('插件已停止');
  assert.deepEqual(idle.drains, [{notify: false}]);
  const used = fixture(t);
  await used.say('帮助');
  await used.remote.stop('插件已停止');
  assert.deepEqual(used.drains, [{notify: true}]);
  const forced = fixture(t);
  await forced.remote.stop('收到重启命令', {notify: true});
  assert.deepEqual(forced.drains, [{notify: true}]);
});

test('重启通知：手机很久没用，但关注的会话有任务被中断时照常发', async t => {
  const later = Date.now() + 31 * 60 * 1000;
  const quiet = fixture(t);
  await bindFirst(quiet);
  t.mock.method(Date, 'now', () => later);
  await quiet.remote.stop('插件已停止');
  assert.deepEqual(quiet.drains, [{notify: false}]);
  t.mock.restoreAll();
  const busy = fixture(t);
  await bindFirst(busy);
  const sid = boundSid(busy);
  busy.remote.sessionStatus(sid, true);
  busy.remote.turnBegin(sid, {text: '电脑上发起'});
  t.mock.method(Date, 'now', () => later);
  await busy.remote.stop('插件已停止');
  t.mock.restoreAll();
  assert.deepEqual(busy.drains, [{notify: true}]);
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
  assert.deepEqual(f.host.calls[0], ['create', {}]);
  assert.match(JSON.stringify(card), /未分组/);
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
  emit('user/message', {source: {kind: 'user', rpcId: 'other'}, content: [{type: 'text', text: '插话'}]});
  emit('assistant/message', {message: {content: [{type: 'text', text: 'echo'}, {type: 'tool-call'}]}});
  emit('tool/call', {name: 'write'});
  emit('request/header', {header: {config: {provider: 'cursor', model: 'm1', reasoningEffort: 'medium'}}});
  emit('session/title', {title: '你好', source: {kind: 'fallback'}});
  emit('session/title', {title: 'Greeting'});
  emit('turn/end', {reason: {kind: 'error', error: {message: 'boom'}}});
  const calls = log.filter(c => c[0] !== 'ingest');
  assert.deepEqual(calls, [
    ['turnBegin', 's1', {rpcId: 'wecom-x', text: '你好'}],
    ['turnMerge', 's1', 'other'],
    ['output', 's1', 'echo'],
    ['activity', 's1', 'write'],
    ['modelSelected', 's1', {provider: 'cursor', model: 'm1', reasoningEffort: 'medium'}],
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

const wsFixture = (dir, extra = {}) => ({items: [{id: 'w1', path: dir, title: 'Proj', sessionIds: ['s1']}], archived: new Set(), pinned: [], ...extra});
const optionsOf = m => m?.card?.options?.map(o => o.text) || [];

test('工作区：卡片列出 Desktop 工作区与未分组；创建会话按工作区名带 workspaceId，未分组和非工作区目录不带', async t => {
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-proj-')));
  const loose = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-loose-')));
  t.after(() => { fs.rmSync(proj, {recursive: true, force: true}); fs.rmSync(loose, {recursive: true, force: true}); });
  const f = fixture(t, {wsState: wsFixture(proj), config: {dirAliases: {p: proj, l: loose}}});
  const card = await f.say('工作区');
  assert.deepEqual(optionsOf(card).map(x => x.split(' · ')[0]), ['Proj', '未分组', 'l']);
  assert.ok(optionsOf(card).some(x => /^未分组 · ← 当前$/.test(x)));
  await f.say('创建后台会话 Proj 第一句');
  assert.deepEqual(f.host.calls.find(c => c[0] === 'create')[1], {workspaceId: 'w1'});
  assert.ok(f.host.calls.some(c => c[0] === 'prompt' && c[3] === '第一句'));
  f.host.calls.length = 0;
  await f.say('创建后台会话 p');
  assert.deepEqual(f.host.calls.find(c => c[0] === 'create')[1], {workspaceId: 'w1'});
  f.host.calls.length = 0;
  await f.say('创建后台会话 l');
  assert.deepEqual(f.host.calls.find(c => c[0] === 'create')[1], {cwd: loose});
  f.host.calls.length = 0;
  assert.match(JSON.stringify(await f.say('工作区 proj')), /Proj/);
  await f.say('创建后台会话 写代码');
  assert.deepEqual(f.host.calls.find(c => c[0] === 'create')[1], {workspaceId: 'w1'});
  assert.ok(f.host.calls.some(c => c[0] === 'prompt' && c[3] === '写代码'));
  f.host.calls.length = 0;
  await f.say('创建后台会话 未分组 散活');
  assert.deepEqual(f.host.calls.find(c => c[0] === 'create')[1], {});
  assert.match(textOf(await f.say('工作区 不存在的')), /没有叫/);
});

test('归档：活跃与历史默认不显示，「历史会话 全部」标出；手机投递前先取消归档；被拦下的轮次推失败', async t => {
  const f = fixture(t, {
    sessions: [
      {sessionId: 's1', cwd: os.homedir(), agentAvailable: true, title: 'Alpha'},
      {sessionId: 's2', cwd: os.homedir(), agentAvailable: false, title: 'Archived'},
    ],
    wsState: {items: [], archived: new Set(['s2']), pinned: []},
  });
  assert.doesNotMatch(JSON.stringify(await f.say('活跃会话')), /Archived/);
  assert.doesNotMatch(JSON.stringify(await f.say('历史会话')), /Archived/);
  const all = await f.say('历史会话 全部');
  assert.ok(optionsOf(all).some(x => /Archived（已归档）/.test(x)));
  const opt = all.card.options.find(o => /Archived/.test(o.text));
  await f.remote.handleCardCallback({taskId: all.card.task_id, optionId: opt.id});
  f.host.onPrompt = (sid, id, text) => f.turn(sid, {rpcId: id, text});
  const reply = textOf(await f.say('继续'));
  assert.ok(f.host.calls.some(c => c[0] === 'unarchive' && c[1] === 's2'));
  assert.ok(f.sent.some(m => /已取消归档/.test(textOf(m))));
  assert.match(reply, /echo: 继续/);
  f.host.ws.archived.add('s2');
  f.host.unarchive = async () => { throw new Error('nope'); };
  f.host.onPrompt = sid => { f.remote.sessionStatus(sid, true); f.remote.turnBlocked(sid); f.remote.sessionStatus(sid, false); };
  const blocked = textOf(await f.say('再来'));
  assert.match(blocked, /任务失败[\s\S]*归档/);
});

test('活跃列表：置顶在前，其余按工作区顺序分组、未分组最后', async t => {
  const now = Date.now();
  const f = fixture(t, {
    sessions: [
      {sessionId: 'a', cwd: os.homedir(), agentAvailable: true, title: 'Loose', updatedAt: now},
      {sessionId: 'b', cwd: os.homedir(), agentAvailable: true, title: 'InW2', updatedAt: now - 1000},
      {sessionId: 'c', cwd: os.homedir(), agentAvailable: true, title: 'InW1', updatedAt: now - 2000},
      {sessionId: 'd', cwd: os.homedir(), agentAvailable: true, title: 'Pinned', updatedAt: now - 3000},
    ],
    wsState: {items: [{id: 'w1', path: '/x', title: 'W1', sessionIds: ['c', 'd']}, {id: 'w2', path: '/y', title: 'W2', sessionIds: ['b']}], archived: new Set(), pinned: ['d']},
  });
  const card = await f.say('活跃会话');
  assert.deepEqual(optionsOf(card).map(x => x.split(' · ').slice(0, 2).join(' · ')), ['📌 Pinned · W1', 'InW1 · W1', 'InW2 · W2', 'Loose · 未分组']);
});

test('活跃列表按最近活动：Agent 已加载但久未动的不算，重启后最近用过的仍在，非置顶最多 10 个', async t => {
  const now = Date.now();
  const day = 24 * 3600_000;
  const recent = Array.from({length: 12}, (_, i) => ({sessionId: `r${i}`, cwd: os.homedir(), agentAvailable: false, title: `Recent${i}`, updatedAt: now - (i + 1) * 60_000}));
  const f = fixture(t, {
    sessions: [
      {sessionId: 'stale', cwd: os.homedir(), agentAvailable: true, title: 'Stale', updatedAt: now - 2 * day},
      {sessionId: 'pin', cwd: os.homedir(), agentAvailable: false, title: 'OldPin', updatedAt: now - 30 * day},
      ...recent,
    ],
    wsState: {items: [], archived: new Set(), pinned: ['pin']},
  });
  const names = optionsOf(await f.say('活跃会话')).map(x => x.split(' · ')[0]);
  assert.ok(!names.includes('Stale'), names.join(' | '));
  assert.equal(names[0], '📌 OldPin');
  assert.deepEqual(names.slice(1), recent.slice(0, 10).map(s => s.title));
  assert.match(JSON.stringify(await f.say('历史会话 Recent1')), /Recent1/);
});

test('定时提醒：最近一次用户消息来自手机的会话推回手机，来自电脑的不推；归属写进文件', async t => {
  const f = fixture(t, {sessions: [
    {sessionId: 's1', cwd: os.homedir(), agentAvailable: true, title: 'Alpha'},
    {sessionId: 's2', cwd: os.homedir(), agentAvailable: true, title: 'Beta'},
  ]});
  await f.say('活跃会话');
  await f.say('选择会话 1');
  const bound = boundSid(f);
  const other = bound === 's1' ? 's2' : 's1';
  f.turn(other, {rpcId: `${PHONE_RPC_PREFIX}x`, text: '手机设的提醒'});
  await tick(30);
  f.remote.sessionStatus(other, true);
  f.remote.turnBegin(other, {text: '[SCHEDULE REMINDER]', trigger: 'schedule'});
  f.remote.output(other, '提醒结果');
  f.remote.turnEnd(other, {kind: 'completed'});
  await tick(30);
  assert.match(textOf(f.sent.at(-1)), /定时任务完成[\s\S]*提醒结果/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'phone-sessions.json'), 'utf8')), [other]);
  f.turn(other, {rpcId: 'desk-1', text: '电脑上接着聊'});
  await tick(30);
  const mid = f.sent.length;
  f.remote.turnBegin(other, {text: '[SCHEDULE REMINDER]', trigger: 'schedule'});
  f.remote.output(other, '不该推');
  f.remote.turnEnd(other, {kind: 'completed'});
  await tick(30);
  assert.equal(f.sent.length, mid);
});

test('关注后电脑发起的审批也转手机；取关后交回 Desktop', async t => {
  const f = fixture(t);
  await bindFirst(f);
  f.remote.turnBegin('s1', {rpcId: 'desk-1', text: '电脑发起'});
  assert.equal(f.remote.uiAsk('s1', {kind: 'confirm', reqId: 'a0', title: '写文件'}), null);
  assert.match(textOf(await f.say('关注')), /审批也会发到手机/);
  const h = f.remote.uiAsk('s1', {kind: 'confirm', reqId: 'a1', title: '写文件'});
  assert.ok(h);
  assert.ok(f.sent.some(m => m.card?.title?.includes('写文件')));
  h.done();
  await f.say('取关');
  assert.equal(f.remote.uiAsk('s1', {kind: 'confirm', reqId: 'a2', title: '写文件'}), null);
  f.remote.turnEnd('s1', {kind: 'completed'});
});

test('运行中直接发消息：回执说明排到下一轮并提示插话；空闲时不提示', async t => {
  const f = fixture(t);
  await bindFirst(f);
  assert.doesNotMatch(textOf(await f.say('在跑的任务')), /插话/);
  const reply = textOf(await f.say('再加一件事'));
  assert.match(reply, /已排队在此轮任务之后，完成后发送/);
  assert.match(reply, /`插话 内容`/);
  assert.doesNotMatch(textOf(await f.say('帮助')), /插话/);
});

test('插话：运行中走 steer 并入当前轮，这一轮结果推回手机且只推一次；空闲时按普通消息', async t => {
  const f = fixture(t, {sessions: [
    {sessionId: 's1', cwd: os.homedir(), agentAvailable: true, title: 'Alpha'},
    {sessionId: 's2', cwd: os.homedir(), agentAvailable: true, title: 'Beta'},
  ]});
  await f.say('活跃会话');
  await f.say('选择会话 1');
  const sid = boundSid(f);
  await f.say('取关');
  f.remote.sessionStatus(sid, true);
  f.remote.turnBegin(sid, {rpcId: 'desk-1', text: '电脑上的长任务'});
  f.host.onPrompt = (s, id) => f.remote.turnMerge(s, id);
  const reply = textOf(await f.say('插话 顺便改下标题'));
  assert.match(reply, /已插话/);
  assert.equal(f.host.calls.find(c => c[0] === 'prompt')[4], 'steer');
  await tick(20);
  const before = f.sent.length;
  f.remote.output(sid, '都改好了');
  f.remote.turnEnd(sid, {kind: 'completed'});
  f.remote.sessionStatus(sid, false);
  await tick(30);
  const done = f.sent.slice(before).map(textOf).filter(s => /任务完成/.test(s));
  assert.equal(done.length, 1);
  assert.match(done[0], /都改好了/);
  f.host.onPrompt = (s, id, text) => f.turn(s, {rpcId: id, text});
  assert.match(textOf(await f.say('插话 空闲时')), /echo: 空闲时/);
  assert.equal(f.host.calls.filter(c => c[0] === 'prompt').at(-1)[4], 'queue');
});

test('权限模式：卡片列出预设并标当前；按名称切换走 /permission，状态里显示', async t => {
  const f = fixture(t);
  await bindFirst(f);
  const card = await f.say('权限');
  assert.deepEqual(optionsOf(card), ['read-only · ← 当前', 'workspace-write']);
  assert.match(JSON.stringify(await f.say('权限模式 workspace')), /workspace-write/);
  assert.deepEqual(f.host.calls.find(c => c[0] === 'perm'), ['perm', 's1', 'workspace-write']);
  assert.match(textOf(await f.say('状态')), /权限模式：workspace-write/);
  assert.match(textOf(await f.say('切换权限 root')), /没有这个预设/);
  assert.doesNotMatch(JSON.stringify(await f.say('权限 不够怎么办')), /没有这个预设|切换权限模式/);
});

test('host 翻译：blocked 空轮次报 turnBlocked；定时提醒带 trigger', () => {
  const handlers = new Map();
  const ctx = {connection: {createPeer: () => ({})}, typertGateway: {invoke: async () => ({})}, on(n, fn) { handlers.set(n, fn); }};
  const log = [];
  const remote = new Proxy({stopped: false}, {get: (o, k) => k in o ? o[k] : (...a) => { log.push([k, ...a]); return null; }});
  createDshHost(ctx, () => remote);
  const emit = (type, data) => handlers.get('session/event')({id: 's1'}, {type, seq: 1, data});
  emit('turn/start', {turn: 1});
  emit('turn/end', {reason: {kind: 'blocked'}});
  emit('turn/start', {turn: 2});
  emit('turn/end', {reason: {kind: 'completed'}});
  emit('turn/start', {turn: 3});
  emit('user/message', {source: {kind: 'schedule'}, content: [{type: 'text', text: '[SCHEDULE REMINDER]'}]});
  emit('turn/end', {reason: {kind: 'completed'}});
  assert.deepEqual(log.filter(c => c[0] !== 'ingest'), [
    ['turnBlocked', 's1'],
    ['turnBegin', 's1', {rpcId: '', text: '[SCHEDULE REMINDER]', trigger: 'schedule'}],
    ['turnEnd', 's1', {kind: 'completed', error: undefined}],
  ]);
});

/** 目标续跑的一轮：roundsStarted +1，可选地在轮内改目标状态（模型调 update_goal）。 */
function goalRound(f, sid, reply, patch = null) {
  const st = f.host.goalState;
  st.roundsStarted++;
  f.remote.sessionStatus(sid, true);
  f.remote.turnBegin(sid, {text: `<goal_round>\nRound: ${st.roundsStarted}/${st.goal.maxGoalRounds}`, trigger: 'goal'});
  f.remote.output(sid, reply);
  if (patch) {
    st.goal = {...st.goal, ...patch};
    f.remote.ingest(sid, {type: 'goal/change', data: {kind: 'goal/change', operation: patch.phase || 'edit', ...st}});
  }
  f.remote.turnEnd(sid, {kind: 'completed'});
  f.remote.sessionStatus(sid, false);
}

test('目标：手机设定后续跑各轮不推，完成时推一次并带最后一轮结果', async t => {
  const f = fixture(t);
  await bindFirst(f);
  const created = JSON.stringify(await f.say('目标 写完周报'));
  assert.match(created, /已设定目标/);
  assert.match(created, /写完周报/);
  assert.deepEqual(f.host.calls.find(c => c[0] === 'goal'), ['goal', 's1', '写完周报']);
  const before = f.sent.length;
  goalRound(f, 's1', '第一轮：列了提纲');
  goalRound(f, 's1', '第二轮：写了一半');
  await tick(30);
  assert.equal(f.sent.length, before);
  assert.match(textOf(await f.say('状态')), /目标：执行中 · 2\/3 轮/);
  goalRound(f, 's1', '第三轮：写完了', {phase: 'complete'});
  await tick(30);
  assert.equal(f.sent.length, before + 1);
  const done = textOf(f.sent.at(-1));
  assert.match(done, /目标已完成/);
  assert.match(done, /第三轮：写完了/);
  assert.match(done, /目标：3\/3 轮/);
  assert.match(JSON.stringify(await f.say('目标 再来一个')), /已设定目标/);
});

test('目标：到达轮数上限推一次；两轮之间在电脑上暂停时推出压着的上一轮', async t => {
  const f = fixture(t);
  await bindFirst(f);
  await f.say('目标 跑满');
  const before = f.sent.length;
  goalRound(f, 's1', 'r1');
  goalRound(f, 's1', 'r2');
  goalRound(f, 's1', 'r3');
  await tick(30);
  assert.equal(f.sent.length, before);
  const lim = f.host.goalState;
  lim.goal = {...lim.goal, phase: 'blocked', blockedReason: {code: 'round-limit', message: 'Goal reached its configured limit of 3 rounds.'}};
  f.remote.ingest('s1', {type: 'goal/change', data: {kind: 'goal/change', operation: 'block', ...lim}});
  await tick(30);
  assert.equal(f.sent.length, before + 1);
  assert.match(textOf(f.sent.at(-1)), /目标到达轮数上限[\s\S]*r3/);
  assert.doesNotMatch(textOf(f.sent.at(-1)), /受阻原因/);
  assert.deepEqual(optionsOf(await f.say('目标')), ['清除']);

  await f.say('目标 清除');
  await f.say('目标 第二个');
  const mid = f.sent.length;
  goalRound(f, 's1', '压着的这一轮');
  await tick(30);
  assert.equal(f.sent.length, mid);
  const st = f.host.goalState;
  st.goal = {...st.goal, phase: 'paused'};
  f.remote.ingest('s1', {type: 'goal/change', data: {kind: 'goal/change', operation: 'pause', ...st}});
  await tick(30);
  assert.equal(f.sent.length, mid + 1);
  assert.match(textOf(f.sent.at(-1)), /目标已暂停[\s\S]*压着的这一轮/);
});

test('目标：卡片按状态给操作；暂停 / 继续 / 修改 / 清除走 /goal，冲突与缺目标给中文提示', async t => {
  const f = fixture(t);
  await bindFirst(f);
  assert.match(textOf(await f.say('目标')), /没有目标/);
  assert.match(textOf(await f.say('目标 暂停')), /还没有目标/);
  await f.say('目标 写完周报');
  assert.deepEqual(optionsOf(await f.say('目标')), ['暂停', '清除']);
  assert.match(textOf(await f.say('目标 另一个')), /已有未完成的目标/);
  await f.say('目标 暂停');
  assert.deepEqual(optionsOf(await f.say('目标')), ['继续', '清除']);
  await f.say('目标 继续');
  await f.say('目标 修改 写完月报');
  assert.deepEqual(f.host.calls.filter(c => c[0] === 'goal' && c[2]).map(c => c[2]),
    ['pause', '写完周报', '另一个', 'pause', 'resume', 'edit 写完月报']);
  assert.equal(f.host.goalState.goal.objective, '写完月报');
  assert.match(JSON.stringify(await f.say('目标 清除')), /已清除目标/);
  assert.equal(f.host.goalState, null);
});
