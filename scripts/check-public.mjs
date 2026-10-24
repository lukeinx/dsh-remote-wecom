#!/usr/bin/env node
// Release guard: tracked files must not carry internal links, local paths or private identities.
// Extra private patterns (one regex per line) are read from ~/.config/check-public/deny.txt when it exists;
// keep them there, never in the repository.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SELF = 'scripts/check-public.mjs';
const rules = [
  [/[\w.-]+\.woa\.com|\btencent\.com\b/i, 'internal domain'],
  [new RegExp(`/(Users|home)/${os.userInfo().username}\\b`), 'local home path'],
  [/Mobile Documents|CloudDocs/, 'iCloud path'],
  [/"resolved": "https?:\/\/(?!registry\.npmjs\.org\/)/, 'non-npmjs registry in lockfile'],
];
const denyFile = path.join(os.homedir(), '.config/check-public/deny.txt');
if (fs.existsSync(denyFile))
  for (const line of fs.readFileSync(denyFile, 'utf8').split('\n').map(s => s.trim()))
    if (line && !line.startsWith('#')) rules.push([new RegExp(line, 'i'), 'private pattern from deny.txt']);

const problems = [];
const files = execFileSync('git', ['ls-files', '-z'], {encoding: 'utf8'}).split('\0').filter(f => f && f !== SELF);
for (const file of files) {
  if (!fs.statSync(file).isFile()) continue;
  fs.readFileSync(file, 'utf8').split('\n').forEach((text, i) => {
    for (const [re, why] of rules) if (re.test(text)) problems.push(`${file}:${i + 1}: ${why}`);
  });
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (pkg.private) problems.push('package.json: "private" must be removed before publishing');
if (!/^git\+https:\/\/github\.com\/[\w-]+\/[\w.-]+\.git$/.test(pkg.repository?.url || ''))
  problems.push('package.json: repository.url must be the public GitHub repository');

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`check:public ok (${files.length} files, ${rules.length} rules)`);
