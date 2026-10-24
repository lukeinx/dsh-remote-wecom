// 看门狗的 launchd 登记：设置页开关与命令行共用。
// 优先用 Desktop 自带的 Electron 以 Node 模式运行（dsh 命令行也是这样跑的），不依赖用户自己装的 Node。
// 这样的进程不向 LaunchServices 登记，`open -b` 仍会正常拉起 Desktop。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const WATCHDOG_LABEL = 'com.dsh-remote-wecom.watchdog';
export const DESKTOP_EXECUTABLE = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const BIN = fileURLToPath(new URL('../../bin/dsh-remote.mjs', import.meta.url));
const BOOTSTRAP_TRIES = 5;

export const launchdSupported = (platform = process.platform) => platform === 'darwin';

const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function runtime() {
  if (process.versions.electron) return {execPath: process.execPath, electron: true};
  if (fs.existsSync(DESKTOP_EXECUTABLE)) return {execPath: DESKTOP_EXECUTABLE, electron: true};
  return {execPath: process.execPath, electron: false};
}

export function renderPlist({dir, execPath, electron, bin = BIN, dshHome = process.env.DSH_HOME}) {
  const args = [execPath, bin, 'watchdog', 'run', '--dir', dir];
  const env = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    ...(electron ? {ELECTRON_RUN_AS_NODE: '1'} : {}),
    ...(dshHome ? {DSH_HOME: dshHome} : {}),
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${WATCHDOG_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(a => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>${xml(path.join(dir, 'watchdog.err'))}</string>
</dict>
</plist>
`;
}

/**
 * 一台机器只登记一个看门狗：只认指向 dir 的那份，别的数据目录（如测试）不会改写它。
 * @param {{dir: string, home?: string, uid?: number, run?: (cmd: string, args: string[]) => void, execPath?: string, electron?: boolean, bin?: string}} opts
 */
export function createLaunchd({dir, home = os.homedir(), uid = process.getuid?.(), run = null, ...spec}) {
  const exec = run || ((cmd, args) => execFileSync(cmd, args, {stdio: 'ignore'}));
  const file = path.join(home, 'Library', 'LaunchAgents', `${WATCHDOG_LABEL}.plist`);
  const target = `gui/${uid}/${WATCHDOG_LABEL}`;
  const render = () => renderPlist({dir, ...runtime(), ...spec});
  const read = () => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
  const bootout = () => { try { exec('launchctl', ['bootout', target]); } catch {} };
  const loaded = () => { try { exec('launchctl', ['print', target]); return true; } catch { return false; } };

  function install() {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    bootout();
    fs.writeFileSync(file, render());
    // bootout 是异步卸载，紧接着 bootstrap 可能还在卸载中。
    for (let i = 1; ; i++) {
      try { exec('launchctl', ['bootstrap', `gui/${uid}`, file]); return; }
      catch (e) { if (i >= BOOTSTRAP_TRIES) throw e; sleep(200 * i); }
    }
  }
  return {
    file,
    loaded,
    install,
    /** 当前登记的是不是这个数据目录的看门狗。 */
    enabled: () => read().includes(`<string>${xml(dir)}</string>`),
    uninstall() {
      bootout();
      fs.rmSync(file, {force: true});
    },
    /** 已开启时把登记对齐到当前插件（升级后安装路径会变）；返回是否改写。 */
    sync() {
      const current = read();
      if (!current.includes(`<string>${xml(dir)}</string>`)) return false;
      if (current === render() && loaded()) return false;
      install();
      return true;
    },
  };
}
