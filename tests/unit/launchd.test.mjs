import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {WATCHDOG_LABEL, createLaunchd, renderPlist} from '../../lib/core/launchd.mjs';

const ELECTRON = {execPath: '/Apps/DSH.app/Contents/MacOS/DSH', electron: true, bin: '/pkg/bin/dsh-remote.mjs'};

function fixture(t, {fail = 0, loaded = true, ...spec} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-launchd-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const calls = [];
  let failures = fail;
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (args[0] === 'bootstrap' && failures-- > 0) throw new Error('Bootstrap failed: 5');
    if (args[0] === 'print' && !loaded) throw new Error('not loaded');
  };
  const dir = path.join(root, 'data');
  const make = (more = {}) => createLaunchd({dir, home: root, uid: 501, run, ...ELECTRON, ...spec, ...more});
  return {root, dir, calls, make, file: path.join(root, 'Library/LaunchAgents', `${WATCHDOG_LABEL}.plist`)};
}

test('plist：用 Desktop 自带的 Electron 时带 ELECTRON_RUN_AS_NODE，路径做 XML 转义', () => {
  const xml = renderPlist({dir: '/d/a&b', ...ELECTRON, dshHome: '/h'});
  assert.match(xml, /<string>\/Apps\/DSH.app\/Contents\/MacOS\/DSH<\/string>\n\s+<string>\/pkg\/bin\/dsh-remote.mjs<\/string>/);
  assert.match(xml, /<key>ELECTRON_RUN_AS_NODE<\/key><string>1<\/string>/);
  assert.match(xml, /<key>DSH_HOME<\/key><string>\/h<\/string>/);
  assert.match(xml, /<string>\/d\/a&amp;b<\/string>/);
  assert.doesNotMatch(renderPlist({dir: '/d', execPath: '/usr/bin/node', electron: false, bin: '/b'}), /ELECTRON_RUN_AS_NODE/);
});

test('开启：先 bootout 再写 plist 并 bootstrap；卸载中 bootstrap 失败会重试', t => {
  const f = fixture(t, {fail: 2});
  const l = f.make();
  assert.equal(l.enabled(), false);
  l.install();
  assert.equal(l.enabled(), true);
  assert.ok(fs.existsSync(f.dir));
  assert.deepEqual(f.calls, [
    `launchctl bootout gui/501/${WATCHDOG_LABEL}`,
    ...Array(3).fill(`launchctl bootstrap gui/501 ${f.file}`),
  ]);
  l.uninstall();
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(l.enabled(), false);
});

test('开启：bootstrap 一直失败时抛错', t => {
  assert.throws(() => fixture(t, {fail: 99}).make().install(), /Bootstrap failed/);
});

test('同步：只改写指向本数据目录的登记，路径变了或未加载才重装', t => {
  const f = fixture(t);
  assert.equal(f.make().sync(), false, '没开启时不装');
  assert.equal(fs.existsSync(f.file), false);

  createLaunchd({dir: path.join(f.root, 'other'), home: f.root, uid: 501, run: () => {}, ...ELECTRON}).install();
  const other = fs.readFileSync(f.file, 'utf8');
  assert.equal(f.make().sync(), false, '别的数据目录的看门狗不动');
  assert.equal(fs.readFileSync(f.file, 'utf8'), other);

  f.make({bin: '/old/pkg/bin/dsh-remote.mjs'}).install();
  f.calls.length = 0;
  assert.equal(f.make().sync(), true, '升级后路径变了');
  assert.match(fs.readFileSync(f.file, 'utf8'), /<string>\/pkg\/bin\/dsh-remote.mjs<\/string>/);
  assert.ok(f.calls.some(c => c.includes('bootstrap')));

  f.calls.length = 0;
  assert.equal(f.make().sync(), false, '已对齐且在运行');
  assert.ok(!f.calls.some(c => c.includes('bootstrap')));
});

test('同步：登记一致但没在运行时重新加载', t => {
  const f = fixture(t, {loaded: false});
  f.make().install();
  f.calls.length = 0;
  assert.equal(f.make().sync(), true);
  assert.ok(f.calls.some(c => c.includes('bootstrap')));
});
