import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync, spawnSync} from 'node:child_process';
import {ALIASES_FILE, loadAliases, missingDirs, parseAliases, saveAliases} from '../../lib/core/aliases.mjs';

const CLI = new URL('../../bin/dsh-remote.mjs', import.meta.url).pathname;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-alias-'));
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({dirAliases: {Home: '~'}, botId: 'b', secret: 's', ownerUserId: 'u'}));
test.after(() => fs.rmSync(dir, {recursive: true, force: true}));
const cli = (...args) => execFileSync(process.execPath, [CLI, 'alias', '--dir', dir, ...args], {encoding: 'utf8'});

test('未保存前沿用 config.json 的 dirAliases；首次修改生成独立配置表', () => {
  assert.deepEqual(loadAliases(dir), {home: '~'});
  cli('proj', dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, ALIASES_FILE), 'utf8')), {home: '~', proj: dir.startsWith(os.homedir()) ? dir.replace(os.homedir(), '~') : dir});
  cli('tmp', os.tmpdir());
  cli('rm', 'proj');
  assert.deepEqual(Object.keys(loadAliases(dir)), ['home', 'tmp']);
});

test('非法名称与不存在的别名报错，不写入', () => {
  const before = fs.readFileSync(path.join(dir, ALIASES_FILE), 'utf8');
  for (const args of [['bad name', '~'], ['rm', 'nope'], ['a', 'b', 'c']]) {
    const r = spawnSync(process.execPath, [CLI, 'alias', '--dir', dir, ...args], {encoding: 'utf8'});
    assert.equal(r.status, 1, args.join(' '));
  }
  assert.equal(fs.readFileSync(path.join(dir, ALIASES_FILE), 'utf8'), before);
});

test('别名表校验：不区分大小写重复、空目录、非法 JSON', () => {
  assert.throws(() => parseAliases('{bad'), /不是合法 JSON/);
  assert.throws(() => parseAliases('{"A": "~", "a": "~"}'), /重复/);
  assert.throws(() => parseAliases('{"a": ""}'), /非空/);
  assert.deepEqual(saveAliases(dir, {B: '~', a: '~/nope-xyz'}), {a: '~/nope-xyz', b: '~'});
  assert.deepEqual(missingDirs(loadAliases(dir)), ['a']);
});
