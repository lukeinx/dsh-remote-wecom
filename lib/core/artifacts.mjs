// Session artifacts: files the agent produced in this session that are worth sending to the phone.
// A file qualifies if the agent wrote it with write/edit, declared it with present, or pointed to it
// in a reply (markdown link, file:// URL or bare absolute path) after touching it in this session;
// shell-made outputs (cp, mv, exporters, subagents) only show up through the last route.
// Git-tracked files are source, not artifacts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

export const ART_EXT = new Set(['.html', '.htm', '.md', '.pdf', '.docx', '.xlsx', '.pptx', '.png', '.svg']);
const HOME = os.homedir();
const EXT_RE = String.raw`\.(?:html?|md|pdf|docx|xlsx|pptx|png|svg)`;
const FILE_URL = new RegExp(String.raw`file://[^\s)\]>"'\x60]+?${EXT_RE}(?![\w.])`, 'gi');
const MD_LINK = /\]\((<[^>\n]+>|[^)\s]+)\)/g;
const BARE_ABS = new RegExp(String.raw`(?<![\w/:.%~])((?:~|/)[^\s\x60"'<>()\[\]]+?${EXT_RE})(?![\w.])`, 'gi');
// The file may be finished a little after the last event we have seen (e.g. a slow exporter).
const MTIME_SLACK_BEFORE = 60_000;
const MTIME_SLACK_AFTER = 10 * 60_000;
const BASH_TEXT_MAX = 1 << 20;
const WRITE_TOOLS = new Set(['write', 'edit']);

/** Path-only checks, cheap enough to repeat right before sending. */
export function artAllowed(p) {
  if (!ART_EXT.has(path.extname(p).toLowerCase())) return false;
  if (/^(\/private)?\/(tmp|var\/folders)\//.test(p) || p.startsWith(path.join(HOME, 'Library', 'Caches') + path.sep)) return false;
  const segs = p.split(path.sep);
  // Hidden directories hold tool state and config (~/.dsh, ~/.config, .cache), not deliverables.
  if (segs.slice(0, -1).some((s) => s === 'node_modules' || (s.length > 1 && s.startsWith('.')))) return false;
  const base = path.basename(p).toLowerCase();
  return !(base.startsWith('.') || base.endsWith('.pem') || base.includes('secret'));
}

export function gitTracked(file) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', path.basename(file)], {cwd: path.dirname(file), stdio: 'ignore', timeout: 3000});
    return true;
  } catch {
    return false;
  }
}

function resolveRef(raw, cwd) {
  let p = raw.trim().replace(/^<|>$/g, '');
  if (/^[a-z][\w+.-]*:/i.test(p) && !p.startsWith('file://')) return '';
  if (p.startsWith('file://')) p = p.slice(7);
  try { p = decodeURIComponent(p); } catch { }
  p = p.split(/[?#]/)[0];
  if (!p) return '';
  if (p === '~' || p.startsWith('~/')) p = path.join(HOME, p.slice(1));
  return path.resolve(cwd || HOME, p);
}

/** Local file references in assistant prose; inline code is skipped since it mostly names source files. */
export function mentionedPaths(text, cwd) {
  const prose = String(text).replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const refs = [...prose.matchAll(FILE_URL)].map((m) => m[0]);
  for (const m of prose.matchAll(MD_LINK)) refs.push(m[1]);
  for (const m of prose.replace(MD_LINK, ' ').replace(FILE_URL, ' ').matchAll(BARE_ABS)) refs.push(m[1]);
  return [...new Set(refs.map((r) => resolveRef(r, cwd)).filter(Boolean))];
}

export function freshArtifacts() {
  return {t0: 0, t1: 0, tool: new Set(), linked: new Set(), bash: '', calls: new Map(), seqs: new Set()};
}

function toolArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw ?? '')) ?? {}; } catch { return {}; }
}

/**
 * Feeds one session event ({type, data, seq?, time?}). Live events and snapshot records may overlap:
 * events carrying a seq are counted once.
 */
export function ingestEvent(st, event, cwd) {
  if (!event || typeof event.type !== 'string') return;
  if (Number.isInteger(event.seq)) {
    if (st.seqs.has(event.seq)) return;
    st.seqs.add(event.seq);
  }
  const at = Number(event.time) || Date.now();
  if (!st.t0 || at < st.t0) st.t0 = at;
  st.t1 = Math.max(st.t1, at);
  const data = event.data ?? {};
  if (event.type === 'tool/call') {
    const args = toolArgs(data.arguments);
    if (data.callId) st.calls.set(data.callId, data.name);
    if (WRITE_TOOLS.has(data.name)) {
      const raw = args.file_path || args.path;
      if (typeof raw === 'string' && raw) st.tool.add(resolveRef(raw, cwd));
    } else if (data.name === 'present' && Array.isArray(args.files)) {
      for (const f of args.files) if (typeof f?.path === 'string' && f.path) st.tool.add(resolveRef(f.path, cwd));
    } else if (data.name === 'bash' && typeof args.command === 'string') {
      st.bash = (st.bash + '\n' + args.command).slice(-BASH_TEXT_MAX);
    }
  } else if (event.type === 'tool/result') {
    const callId = data.message?.toolCallId;
    const p = data.meta?.path;
    if (typeof p === 'string' && p && !data.message?.isError && WRITE_TOOLS.has(st.calls.get(callId))) st.tool.add(path.resolve(p));
  } else if (event.type === 'assistant/message') {
    for (const part of data.message?.content ?? []) {
      if (part?.type === 'text') for (const p of mentionedPaths(part.text ?? '', cwd)) st.linked.add(p);
    }
  }
}

/**
 * Qualifying files recorded so far, newest first.
 * @returns {{file: string, size: number, mtime: number}[]}
 */
export function listArtifacts(st, {isTracked = gitTracked, trackedCache = new Map()} = {}) {
  const isSource = (file, mtime) => {
    const key = `${file}\0${mtime}`;
    if (!trackedCache.has(key)) trackedCache.set(key, isTracked(file));
    return trackedCache.get(key);
  };
  const touched = (file, mtime) => st.tool.has(file) || st.bash.includes(path.basename(file))
    || (st.t0 > 0 && mtime >= st.t0 - MTIME_SLACK_BEFORE && mtime <= st.t1 + MTIME_SLACK_AFTER);
  const out = new Map();
  for (const [file, viaTool] of [...[...st.tool].map((f) => [f, true]), ...[...st.linked].map((f) => [f, false])]) {
    if (!ART_EXT.has(path.extname(file).toLowerCase())) continue;
    let stat, real;
    try {
      stat = fs.statSync(file);
      real = fs.realpathSync(file);
    } catch { continue; }
    if (!stat.isFile() || out.has(real) || !artAllowed(real)) continue;
    if (!viaTool && !touched(file, stat.mtimeMs)) continue;
    if (isSource(real, stat.mtimeMs)) continue;
    out.set(real, {file: real, size: stat.size, mtime: stat.mtimeMs});
  }
  return [...out.values()].sort((a, b) => b.mtime - a.mtime);
}
