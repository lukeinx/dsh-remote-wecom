// client/ → dist/client.js：CJS 包在 DSH 的 __ModuleLoader__ 工厂里，react 由宿主提供，不打进包。
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const out = path.join(root, 'dist/client.js');

const result = await build({
  entryPoints: [path.join(root, 'client/index.jsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome110', 'safari16'],
  external: ['react', 'react-dom'],
  jsx: 'transform',
  jsxFactory: 'h',
  jsxFragment: 'Fragment',
  write: false,
  legalComments: 'none',
});
const code = result.outputFiles?.[0]?.text;
if (!code) throw new Error('esbuild 没有产出客户端包');
const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${code}
    return module.exports;
  }
});
`;
await fs.mkdir(path.dirname(out), {recursive: true});
await fs.writeFile(out, wrapped);
console.log(`已生成 ${path.relative(root, out)}（${(wrapped.length / 1024).toFixed(1)} KB）`);
