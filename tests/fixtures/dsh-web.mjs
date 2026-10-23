// 用临时 DSH_HOME 起一个隔离的 `dsh --profile web`（加载本插件 + 假 LLM），拿到带 token 的登录 URL 与浏览器 cookie。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DSH_BIN = path.join(ROOT, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const delay = ms => new Promise(r => setTimeout(r, ms));

export async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

/**
 * @param {{tmp: string, dataDir: string, pluginConfig?: object, port?: number}} opts
 */
export async function startDshWeb({tmp, dataDir, pluginConfig = {}, port}) {
  port ||= await freePort();
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, {recursive: true});
  const patch = path.join(tmp, 'patch.yml');
  fs.writeFileSync(patch, [
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config: {provider: mock, model: echo}',
    '- insert:',
    '    - id: mock-llm',
    `      name: ${JSON.stringify(path.join(ROOT, 'tests/fixtures/mock-llm.mjs'))}`,
    '    - id: dsh-remote-wecom',
    `      name: ${JSON.stringify(path.join(ROOT, 'lib/index.mjs'))}`,
    `      config: ${JSON.stringify({dataDir, ...pluginConfig})}`,
  ].join('\n') + '\n');
  let output = '';
  const child = spawn(process.execPath, [DSH_BIN, '--profile', 'web', '--patch', patch, '--no-open', '--port', String(port)],
    {cwd: tmp, env: {...process.env, DSH_HOME: home}, stdio: ['ignore', 'pipe', 'pipe']});
  child.stdout.on('data', d => { output = (output + d).slice(-20000); });
  child.stderr.on('data', d => { output = (output + d).slice(-20000); });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode) return;
    const exited = new Promise(r => child.once('exit', r));
    child.kill('SIGTERM');
    await Promise.race([exited, delay(8000)]);
    if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await exited; }
  };
  const start = Date.now();
  let url = '';
  while (!url) {
    if (child.exitCode !== null) throw new Error(`dsh 已退出：\n${output.slice(-4000)}`);
    if (Date.now() - start > 90000) { await stop(); throw new Error(`dsh 启动超时：\n${output.slice(-4000)}`); }
    url = /https?:\/\/\S+\?token=\S+/.exec(output)?.[0] || '';
    if (!url) await delay(100);
  }
  const origin = new URL(url).origin;
  const login = await fetch(url, {redirect: 'manual'});
  const cookie = (login.headers.get('set-cookie') || '').split(';', 1)[0];
  return {child, url, origin, cookie, port, stop, output: () => output};
}

/** 以浏览器身份调用设置 RPC（与客户端 connection.rpc.call 的信封一致）。 */
export async function callSettings(web, method, payload = {}, headers = {}) {
  const res = await fetch(`${web.origin}/api/dsh-remote-wecom/settings`, {
    method: 'POST',
    headers: {'content-type': 'application/json', cookie: web.cookie, ...headers},
    body: JSON.stringify({type: 'client-request', rpcId: `r-${Date.now()}`, method: 'dsh-remote-wecom/settings', payload: {method, payload}}),
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return {status: res.status, text, json, result: json?.result};
}
