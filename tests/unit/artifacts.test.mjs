import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {artAllowed, freshArtifacts, ingestEvent, listArtifacts, mentionedPaths} from '../../lib/core/artifacts.mjs';

// Not under os.tmpdir(): temp dirs are excluded on purpose.
const root = fs.mkdtempSync(path.join(os.homedir(), 'dsh-remote-art-test-'));
test.after(() => fs.rmSync(root, {recursive: true, force: true}));

const T0 = Date.now() - 60_000;
let seq = 0;
const ev = (type, data) => ({type, seq: seq++, time: T0 + seq * 1000, data});
const call = (name, args) => ev('tool/call', {callId: `c${seq}`, name, arguments: JSON.stringify(args)});
const say = (text) => ev('assistant/message', {message: {role: 'assistant', content: [{type: 'text', text}]}});
function session(events) {
  const st = freshArtifacts();
  for (const e of events) ingestEvent(st, e, root);
  return st;
}
function put(rel, body = 'x', mtime) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, body);
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return fs.realpathSync(file);
}
const names = (list) => list.map((a) => path.relative(fs.realpathSync(root), a.file)).sort();
const scan = (st, tracked = new Set()) => listArtifacts(st, {isTracked: (f) => tracked.has(f)});

test('artAllowed 排除临时目录、隐藏目录和敏感文件名', () => {
  assert.equal(artAllowed('/Users/a/out/report.html'), true);
  assert.equal(artAllowed('/tmp/report.html'), false);
  assert.equal(artAllowed('/private/var/folders/x/report.html'), false);
  assert.equal(artAllowed(path.join(os.homedir(), '.dsh/profiles/x.md')), false);
  assert.equal(artAllowed('/Users/a/proj/node_modules/x/README.md'), false);
  assert.equal(artAllowed('/Users/a/out/secret-notes.md'), false);
  assert.equal(artAllowed('/Users/a/out/run.log'), false);
});

test('mentionedPaths 认链接、file:// 和绝对路径，不认行内代码', () => {
  const text = [
    '报告：[报告.html](file:///Users/a/My%20Docs/%E6%8A%A5%E5%91%8A.html)。',
    '另见 [prd](docs/prd.md) 和 [官网](https://x.com/a.html)，',
    '截图在 /Users/a/shots/1.png，配置在 `web/index.html`。',
    '```\ncat /Users/a/code-block.md\n```',
  ].join('\n');
  assert.deepEqual(mentionedPaths(text, '/Users/a/proj').sort(), ['/Users/a/My Docs/报告.html', '/Users/a/proj/docs/prd.md', '/Users/a/shots/1.png'].sort());
});

test('write / edit 写过的文件算产物，仓库跟踪的源码不算', () => {
  put('out/mock.html');
  put('out/notes.md');
  const src = put('repo/README.md');
  const st = session([call('write', {file_path: 'out/mock.html', content: 'x'}), call('edit', {file_path: 'out/notes.md'}), call('write', {file_path: 'repo/README.md', content: 'x'})]);
  assert.deepEqual(names(scan(st, new Set([src]))), ['out/mock.html', 'out/notes.md']);
});

test('tool/result 的 meta.path 和 present 声明的文件算产物；失败的写入不算', () => {
  const ok = put('res/ok.pdf');
  put('res/bad.pdf');
  put('res/shown.png');
  const st = session([
    ev('tool/call', {callId: 'w1', name: 'write', arguments: '{}'}),
    ev('tool/result', {message: {toolCallId: 'w1', isError: false}, meta: {path: ok}}),
    ev('tool/call', {callId: 'w2', name: 'write', arguments: '{}'}),
    ev('tool/result', {message: {toolCallId: 'w2', isError: true}, meta: {path: path.join(root, 'res/bad.pdf')}}),
    call('present', {files: [{path: 'res/shown.png'}]}),
  ]);
  assert.deepEqual(names(scan(st)), ['res/ok.pdf', 'res/shown.png']);
});

test('shell 搬过去并在回复里链接的文件算产物', () => {
  put('final/page.html');
  const st = session([
    call('write', {file_path: '/tmp/draft.html', content: 'x'}),
    call('bash', {command: 'cp /tmp/draft.html final/page.html'}),
    say(`已完成：[page.html](file://${encodeURI(path.join(root, 'final/page.html'))})`),
  ]);
  assert.deepEqual(names(scan(st)), ['final/page.html']);
});

test('回复里提到但本会话没碰过的旧文件不算', () => {
  put('old/report.html', 'x', T0 - 3 * 86400_000);
  const st = session([say(`参考了 ${path.join(root, 'old/report.html')}`)]);
  assert.deepEqual(names(scan(st)), []);
});

test('subagent 写的文件：回复里链接且修改时间在会话期间也算', () => {
  put('proposals/a.html', 'x', T0 + 2000);
  const st = session([call('agent', {prompt: '写提案'}), say(`[a.html](${path.join(root, 'proposals/a.html')})`)]);
  assert.deepEqual(names(scan(st)), ['proposals/a.html']);
});

test('软链接与原路径去重，按真实路径过滤', () => {
  put('materials/x.html');
  fs.symlinkSync(path.join(root, 'materials'), path.join(root, '.materials'));
  const st = session([call('write', {file_path: '.materials/x.html', content: 'x'}), say(`[x](${path.join(root, 'materials/x.html')})`)]);
  assert.deepEqual(names(scan(st)), ['materials/x.html']);
});

test('实时事件与快照重叠按 seq 去重；新事件增量识别，文件删除后不再列出', () => {
  const a = put('inc/a.md');
  const first = call('write', {file_path: 'inc/a.md', content: 'x'});
  const st = session([first]);
  assert.equal(scan(st).length, 1);
  put('inc/b.pdf');
  ingestEvent(st, first, root);
  ingestEvent(st, call('write', {file_path: 'inc/b.pdf', content: 'x'}), root);
  assert.equal(scan(st).length, 2);
  assert.equal(st.seqs.size, 2);
  fs.rmSync(a);
  assert.deepEqual(names(scan(st)), ['inc/b.pdf']);
});
