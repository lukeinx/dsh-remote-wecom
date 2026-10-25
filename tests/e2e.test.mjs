// End to end: an isolated `dsh --profile web` with the scripted LLM, a stand-in for the Desktop window
// and this plugin; WeCom is a local ws server speaking the bot protocol. Nothing outside the temp dirs is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {WebSocketServer} from 'ws';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DSH_BIN = path.join(ROOT, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 20000, what = '') {
  const start = Date.now();
  while (Date.now() - start < ms) { const r = await fn(); if (r) return r; await delay(50); }
  throw new Error(`timed out${what ? `: ${what}` : ''}`);
}
async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

test('DSH + 插件 + 假企微：创建/活跃/历史/模型/停止/压缩/状态/产物/提问/审批/关注/引用', {timeout: 240000}, async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-e2e-'));
  // Artifacts under the temp dir are filtered out on purpose, so the workspace lives under $HOME.
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), 'dsh-remote-e2e-ws-')));
  const home = path.join(tmp, 'home');
  const data = path.join(tmp, 'data');
  fs.mkdirSync(home);
  fs.mkdirSync(data, {mode: 0o700});

  const server = new WebSocketServer({host: '127.0.0.1', port: 0});
  await new Promise(r => server.on('listening', r));
  let socket = null;
  const sent = [];
  const uploads = [];
  server.on('connection', w => {
    socket = w;
    w.on('message', raw => {
      const frame = JSON.parse(String(raw));
      let body;
      if (frame.cmd === 'aibot_send_msg') sent.push(frame.body);
      if (frame.cmd === 'aibot_upload_media_init') { uploads.push(frame.body); body = {upload_id: `u${uploads.length}`}; }
      if (frame.cmd === 'aibot_upload_media_finish') body = {media_id: `m-${frame.body.upload_id}`, type: 'file'};
      w.send(JSON.stringify({headers: frame.headers, errcode: 0, errmsg: 'ok', ...(body ? {body} : {})}));
    });
  });

  const probePort = await freePort();
  const webPort = await freePort();
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    botId: 'test-bot', secret: 'test-secret', ownerUserId: 'owner',
    wsUrl: `ws://127.0.0.1:${server.address().port}`, openDesktop: false, nameWaitMs: 4000,
    remoteConfirmTimeoutMs: 60000, dirAliases: {ws},
  }), {mode: 0o600});
  const patch = path.join(tmp, 'patch.yml');
  fs.writeFileSync(patch, [
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config: {provider: mock, model: echo}',
    '- insert:',
    '    - id: mock-llm',
    `      name: ${JSON.stringify(path.join(ROOT, 'tests/fixtures/mock-llm.mjs'))}`,
    '    - id: desktop-probe',
    `      name: ${JSON.stringify(path.join(ROOT, 'tests/fixtures/desktop-probe.mjs'))}`,
    `      config: {port: ${probePort}}`,
    '    - id: dsh-remote-wecom',
    `      name: ${JSON.stringify(path.join(ROOT, 'lib/index.mjs'))}`,
    `      config: {dataDir: ${JSON.stringify(data)}}`,
    '- id: permission',
    '  name: "@deepseek-ai/dsh-permission-presets"',
    '  config:',
    '    presets:',
    '      read-only: {sandbox: read-only, approval: ask}',
    '      workspace-write: {sandbox: workspace-write, approval: ask}',
    '      danger-full-access: {sandbox: danger-full-access, approval: never}',
    '    defaultPreset: read-only',
    '- id: goal',
    '  name: "@deepseek-ai/dsh-goal"',
    '  config: {defaultMaxGoalRounds: 2}',
  ].join('\n') + '\n');

  let child = null;
  let output = '';
  const boot = () => {
    child = spawn(process.execPath, [DSH_BIN, '--profile', 'web', '--patch', patch, '--no-open', '--port', String(webPort)],
      {cwd: tmp, env: {...process.env, DSH_HOME: home}, stdio: ['ignore', 'pipe', 'pipe']});
    child.stdout.on('data', d => { output = (output + d).slice(-20000); });
    child.stderr.on('data', d => { output = (output + d).slice(-20000); });
  };
  const halt = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise(r => child.once('exit', r));
    child.kill('SIGTERM');
    await Promise.race([exited, delay(8000)]);
    if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
  };
  t.after(async () => {
    await halt();
    for (const c of server.clients) c.terminate();
    await new Promise(r => server.close(r));
    fs.rmSync(tmp, {recursive: true, force: true});
    fs.rmSync(ws, {recursive: true, force: true});
  });

  const call = async (ns, method, args) => {
    const r = await fetch(`http://127.0.0.1:${probePort}/call`, {method: 'POST', body: JSON.stringify({ns, method, args}), signal: AbortSignal.timeout(10000)});
    const v = await r.json();
    if (r.status !== 200) throw new Error(v?.error || r.status);
    return v;
  };
  const outline = async sid => (await call('session', 'projections', {request: {sessionId: sid}}))?.values?.turnOutline ?? [];
  const desktopPrompt = (sid, requestId, text) => call('session', 'prompt', {request: {requestId, sessionId: sid, mode: 'queue', content: [{type: 'text', text}]}});
  const md = b => b?.markdown?.content || '';
  const cardOf = b => b?.template_card;
  const texts = (from = 0) => sent.slice(from).map(md).filter(Boolean);
  const waitText = (re, from = 0, ms = 20000) => until(() => texts(from).find(x => re.test(x)), ms, String(re));
  const waitCard = (pred, from = 0, ms = 20000) => until(() => sent.slice(from).map(cardOf).find(c => c && pred(c)), ms, 'card');
  let seq = 0;
  const say = (text, {quote} = {}) => {
    const id = `msg-${++seq}`;
    const at = sent.length;
    socket.send(JSON.stringify({cmd: 'aibot_msg_callback', headers: {req_id: id}, body: {
      msgid: id, aibotid: 'test-bot', chattype: 'single', from: {userid: 'owner'}, msgtype: 'text', text: {content: text},
      ...(quote ? {quote: {msgtype: 'text', text: {content: quote}}} : {}),
    }}));
    return at;
  };
  const pick = (card, match) => {
    const at = sent.length;
    const ids = card.checkbox.option_list.filter(o => match(o.text)).map(o => o.id);
    assert.ok(ids.length, `no option in ${JSON.stringify(card.checkbox.option_list.map(o => o.text))}`);
    socket.send(JSON.stringify({cmd: 'aibot_event_callback', headers: {req_id: `card-${++seq}`}, body: {
      msgid: `card-${seq}`, aibotid: 'test-bot', chattype: 'single', from: {userid: 'owner'}, msgtype: 'event',
      event: {eventtype: 'template_card_event', template_card_event: {task_id: card.task_id,
        selected_items: {selected_item: [{question_key: card.task_id, option_ids: {option_id: ids.slice(0, 1)}}]}}},
    }}));
    return at;
  };
  const connected = async (re, from) => {
    try { return await waitText(re, from, 90000); }
    catch (e) { throw new Error(`${e.message}\n--- dsh output ---\n${output.slice(-4000)}`); }
  };

  // 第一次启动：电脑上开一个会话跑完一轮（未绑定，不推送），重启后它就是历史会话。
  boot();
  await connected(/DSH Remote 已连接/, 0);
  const {sessionId: oldSid} = await call('session', 'create', {request: {cwd: ws}});
  await desktopPrompt(oldSid, 'desk-0', 'needle opener for history');
  await until(async () => (await outline(oldSid)).some(x => x.response), 30000, 'desktop turn');
  assert.ok(!texts().some(x => /needle/.test(x)), '未绑定的电脑轮次不推送');
  // DSH persists the session log asynchronously; stopping right after the turn can lose it.
  await delay(2000);
  await waitText(/命令/, say('帮助')); // 手机刚用过，重启后才会收到通知
  await halt();
  let at = sent.length;
  boot();
  await connected(/DSH Remote 已重启/, at);

  await t.test('历史会话：检索会话名与用户消息，选中后恢复对话', async () => {
    let card = await waitCard(c => /检索结果/.test(c.main_title?.title), say('历史会话 needle'));
    at = pick(card, x => /needle/.test(x));
    card = await waitCard(c => /选择会话/.test(c.main_title?.title), at);
    assert.equal(card.emphasis_content.title, 'needle');
    const reply = await waitText(/任务完成 · needle/, say('back again'));
    assert.match(reply, /echo: back again/);
  });

  await t.test('创建会话：带目录别名，卡片用模型标题，完成后推送', async () => {
    at = say('创建会话 ws alpha first task');
    const card = await waitCard(c => /创建会话/.test(c.main_title?.title), at);
    assert.equal(card.emphasis_content.title, 'alpha');
    assert.ok(card.horizontal_content_list.some(x => x.value.includes(path.basename(ws))));
    assert.match(await waitText(/任务完成 · alpha/, at), /echo: alpha first task/);
    at = say('创建后台会话 ws beta second task');
    await waitCard(c => c.emphasis_content?.title === 'beta', at);
    await waitText(/任务完成 · beta/, at);
  });

  await t.test('活跃会话卡片：列出三个会话，标出当前', async () => {
    const card = await waitCard(c => /活跃会话/.test(c.main_title?.title), say('活跃会话'));
    const opts = card.checkbox.option_list.map(o => o.text);
    for (const name of ['needle', 'alpha', 'beta']) assert.ok(opts.some(x => x.startsWith(name)), opts.join(' | '));
    assert.ok(opts.some(x => /^beta.*← 当前/.test(x)));
    pick(card, x => x.startsWith('alpha'));
    await waitCard(c => c.emphasis_content?.title === 'alpha', at);
  });

  await t.test('切换模型到 echo2、思考强度到 high，状态卡片反映出来', async () => {
    let card = await waitCard(c => /切换模型/.test(c.main_title?.title), say('模型 echo2'));
    assert.equal(card.emphasis_content.title, 'Echo 2');
    card = await waitCard(c => /切换思考强度/.test(c.main_title?.title) && c.emphasis_content, say('思考强度 high'));
    assert.equal(card.emphasis_content.title, 'high · 高');
    const status = await waitText(/空闲 · alpha/, say('状态'));
    assert.match(status, /模型：echo2 · high/);
    assert.doesNotMatch(status, /类型：/);
    assert.match(status, /上下文：[\d.]+% \/ 100k/);
  });

  await t.test('停止长任务：受理后停止，不再多推结果', async () => {
    at = say('/sleep 60000');
    await waitText(/运行中 · alpha/, at);
    const stopAt = say('停止');
    await waitText(/已中断 · alpha/, stopAt);
    await until(async () => { const from = say('状态'); return waitText(/空闲 · alpha/, from, 3000).catch(() => null); }, 20000, 'idle after stop');
    assert.ok(!texts(stopAt).some(x => /任务完成|echo: \/sleep/.test(x)));
  });

  await t.test('压缩会话：/compact 成功，带说明时提示未生效', async () => {
    const card = await waitCard(c => /压缩会话/.test(c.main_title?.title), say('压缩 保留接口'), 30000);
    assert.match(card.main_title.desc, /不支持指定重点/);
    assert.ok(card.horizontal_content_list.some(x => /Compacted/.test(x.value)));
  });

  await t.test('提问卡片：手机选中的答案交回 ask_user_question', async () => {
    const q = {questions: [{id: 'q1', question: 'Pick a color?', header: 'Color', options: [{label: 'Red', description: 'warm'}, {label: 'Blue', description: 'cool'}]}]};
    at = say(`/tool ask_user_question ${JSON.stringify(q)}`);
    const card = await waitCard(c => /Pick a color/.test(c.main_title?.title), at, 30000);
    pick(card, x => x.startsWith('2. Blue'));
    assert.match(await waitText(/任务完成 · alpha[\s\S]*tool done/, at, 30000), /Blue/);
  });

  const report = path.join(ws, 'report.md');
  await t.test('只读模式审批：手机允许后文件写入', async () => {
    at = say(`/tool write ${JSON.stringify({file_path: report, content: '# report', sandbox_permissions: 'workspace-write', justification: 'save report'})}`);
    const card = await waitCard(c => /^🔐/.test(c.main_title?.title || ''), at, 30000);
    assert.match(await waitText(/需要确认 · alpha/, at), /workspace-write 权限：save report[\s\S]*工具：write/);
    pick(card, x => x === '允许');
    await waitText(/任务完成 · alpha[\s\S]*tool done/, at, 30000);
    assert.equal(fs.readFileSync(report, 'utf8'), '# report');
  });

  await t.test('产物：列出写过的文件并发到手机', async () => {
    const before = uploads.length;
    at = say('产物');
    await until(() => uploads.length > before, 20000, 'upload');
    assert.equal(uploads.at(-1).filename, 'report.md');
    await until(() => sent.slice(at).some(b => b.msgtype === 'file'), 20000, 'file message');
  });

  await t.test('关注 / 取关：电脑发起的轮次在绑定会话里推送，取关后不推', async () => {
    const sid = fs.readFileSync(path.join(data, '.current'), 'utf8').trim();
    at = sent.length;
    await desktopPrompt(sid, 'desk-1', 'desktop ping');
    assert.match(await waitText(/任务完成 · alpha/, at), /echo: desktop ping/);
    await waitText(/已取关/, say('取关'));
    const n = (await outline(sid)).length;
    at = sent.length;
    await desktopPrompt(sid, 'desk-2', 'desktop quiet');
    await until(async () => (await outline(sid)).length > n && (await outline(sid)).at(-1).response, 20000, 'quiet turn');
    await delay(500);
    assert.ok(!texts(at).some(x => /desktop quiet/.test(x)));
    await waitText(/关注/, say('关注'));
    at = sent.length;
    await desktopPrompt(sid, 'desk-3', 'desktop loud');
    await waitText(/echo: desktop loud/, at);
  });

  await t.test('电脑发起的轮次：提问推到手机；关注时审批也推手机，取关后留在电脑', async () => {
    const sid = fs.readFileSync(path.join(data, '.current'), 'utf8').trim();
    const q = {questions: [{id: 'q1', question: 'Desk color?', options: [{label: 'Red'}, {label: 'Blue'}]}]};
    at = sent.length;
    await desktopPrompt(sid, 'desk-q', `/tool ask_user_question ${JSON.stringify(q)}`);
    const card = await waitCard(c => /Desk color/.test(c.main_title?.title), at, 30000);
    pick(card, x => x.startsWith('1. Red'));
    assert.match(await waitText(/任务完成 · alpha[\s\S]*tool done/, at, 30000), /Red/);
    const denied = path.join(ws, 'desk.md');
    const write = JSON.stringify({file_path: denied, content: '# desk', sandbox_permissions: 'workspace-write', justification: 'desk write'});
    at = sent.length;
    await desktopPrompt(sid, 'desk-f', `/tool write ${write}`);
    const ask = await waitCard(c => /^🔐/.test(c.main_title?.title || ''), at, 30000);
    pick(ask, x => x === '拒绝');
    await waitText(/任务完成 · alpha[\s\S]*tool done/, at, 30000);
    assert.ok(!fs.existsSync(denied));
    await waitText(/已取关/, say('取关'));
    const n = (await outline(sid)).length;
    at = sent.length;
    await desktopPrompt(sid, 'desk-a', `/tool write ${write}`);
    await until(async () => (await outline(sid)).length > n, 30000, 'desk approval turn start');
    await new Promise(r => setTimeout(r, 4000));
    assert.ok(!sent.slice(at).some(b => /^🔐/.test(cardOf(b)?.main_title?.title || '')), '电脑轮次的审批不推手机');
    assert.ok(!fs.existsSync(denied));
    await call('session', 'cancel', {request: {sessionId: sid}});
    await new Promise(r => setTimeout(r, 1000));
  });

  await t.test('插话：运行中的这一轮并入手机插话，结果只推一次', async () => {
    at = say('/sleep 3000');
    await waitText(/运行中 · alpha/, at);
    await waitText(/已插话 · alpha/, say('插话 steer me'));
    const done = await waitText(/任务完成 · alpha/, at, 30000);
    assert.match(done, /echo: steer me/);
    await delay(1000);
    assert.equal(texts(at).filter(x => /任务完成 · alpha/.test(x)).length, 1);
  });

  await t.test('权限模式：手机切到 workspace-write，状态里反映出来', async () => {
    const card = await waitCard(c => /切换权限模式/.test(c.main_title?.title || ''), say('权限模式 workspace-write'));
    assert.equal(card.emphasis_content.title, 'workspace-write');
    assert.match(await waitText(/空闲 · alpha/, say('状态')), /权限模式：workspace-write/);
  });

  await t.test('目标：手机设定后自动续跑，中间各轮不推，到达轮数上限只推一次', async () => {
    at = say('目标 把报告写完');
    const card = await waitCard(c => /已设定目标/.test(c.main_title?.title || ''), at);
    assert.equal(card.emphasis_content.title, '把报告写完');
    const done = await waitText(/目标到达轮数上限 · alpha/, at, 30000);
    assert.match(done, /目标：2\/2 轮/);
    await delay(1000);
    assert.equal(texts(at).filter(x => /目标|任务完成 · alpha/.test(x)).length, 1);
    assert.match(await waitText(/空闲 · alpha/, say('状态')), /目标：受阻 · 2\/2 轮/);
    assert.match(JSON.stringify(await waitCard(c => /已清除目标/.test(c.main_title?.title || ''), say('目标 清除'))), /已清除目标/);
  });

  await t.test('工作区：创建会话归入 Desktop 工作区；归档后手机发消息先取消归档', async () => {
    const {workspace} = await call('workspace', 'create', {request: {path: ws}});
    await waitCard(c => /切换工作区/.test(c.main_title?.title || '') && c.emphasis_content?.title?.startsWith(workspace.title.slice(0, 10)), say(`工作区 ${workspace.title}`));
    at = say('创建后台会话 gamma third task');
    await waitText(/任务完成 · gamma/, at, 30000);
    const sid = fs.readFileSync(path.join(data, '.current'), 'utf8').trim();
    const live = await waitCard(c => /活跃会话/.test(c.main_title?.title || ''), say('活跃会话'));
    assert.ok(live.checkbox.option_list.some(o => o.text.startsWith(`gamma · ${workspace.title}`)), live.checkbox.option_list.map(o => o.text).join(' | '));
    await call('workspace', 'archiveSession', {request: {sessionId: sid}});
    at = say('after archive');
    await waitText(/已取消归档 · gamma/, at);
    assert.match(await waitText(/任务完成 · gamma/, at, 30000), /echo: after archive/);
  });

  await t.test('引用推送回复：消息进入被引用的会话并切换当前会话', async () => {
    const reply = await waitText(/任务完成 · beta/, say('quoted hello', {quote: '🏁 任务完成 · beta\n\n---\n\necho: beta second task'}));
    assert.match(reply, /echo: quoted hello/);
    await waitText(/空闲 · beta/, say('状态'));
  });
});
