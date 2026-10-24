// Directory aliases live in their own small table so they can be edited by hand
// without touching credentials. The remote re-reads it on every lookup: no restart.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {loadConfig} from './config.mjs';

export const ALIASES_FILE = 'aliases.json';
const HOME = os.homedir();
const NAME = /^[\p{L}\p{N}_.-]{1,32}$/u;

export function expandDir(p) {
  if (!p || p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return path.isAbsolute(p) ? p : path.join(HOME, p);
}
export function tildeDir(p) {
  const abs = path.resolve(expandDir(p));
  return abs === HOME ? '~' : abs.startsWith(HOME + path.sep) ? '~' + abs.slice(HOME.length) : abs;
}
export function checkName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!NAME.test(n)) throw new Error(`别名「${name}」无效：1–32 位字母、数字、中文或 _ . -，不含空格`);
  return n;
}
/** @returns {Record<string, string>} */
function normalize(table, where) {
  if (!table || typeof table !== 'object' || Array.isArray(table)) throw new Error(`${where} 应为 {"别名": "目录"}`);
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(table)) {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${where}：别名「${k}」的目录必须是非空字符串`);
    const name = checkName(k);
    if (name in out) throw new Error(`${where}：别名「${name}」重复（不区分大小写）`);
    out[name] = v.trim();
  }
  return out;
}
/** @returns {Record<string, string>} */
export function parseAliases(text, where = 'aliases.json') {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error(`${where} 不是合法 JSON：${e.message}`); }
  return normalize(data, where);
}
/** Table file wins; before the first save, fall back to config.json dirAliases.
 * @returns {Record<string, string>} */
export function loadAliases(dir) {
  try { return parseAliases(fs.readFileSync(path.join(dir, ALIASES_FILE), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return normalize(loadConfig(dir).dirAliases, 'config.json dirAliases');
}
/** @returns {Record<string, string>} */
export function saveAliases(dir, table) {
  const clean = normalize(table, '别名表');
  const sorted = Object.fromEntries(Object.entries(clean).sort(([a], [b]) => a.localeCompare(b)));
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const file = path.join(dir, ALIASES_FILE);
  const tmp = file + '.' + crypto.randomUUID();
  try {
    fs.writeFileSync(tmp, JSON.stringify(sorted, null, 2) + '\n', {mode: 0o644, flag: 'wx'});
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, {force: true}); }
  return sorted;
}
/** Returns alias names whose directory does not exist (warning only, not an error). */
export function missingDirs(table) {
  return Object.entries(table).filter(([, d]) => !fs.existsSync(expandDir(d))).map(([n]) => n);
}
