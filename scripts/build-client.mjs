/**
 * 构建 DSH Client 半的注册产物。
 *
 * DSH 0.2.x 的 Client bundle 契约是 `window.__ModuleLoader__.load({ id, factory })`。
 * 源码（src/client/index.ts）保持普通 ESM，不直接调用 loader；本脚本用 esbuild
 * 打包后用官方契约包装成 lib/client.js。这样源码可测试、可读，产物符合宿主加载器。
 */
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const packageName = manifest.name
if (typeof packageName !== 'string' || packageName.trim() === '') {
  throw new Error('build-client: package.json name must be a non-empty string')
}

const result = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/index.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['react'],
  charset: 'utf8',
  legalComments: 'none',
  logLevel: 'silent',
})

const output = result.outputFiles?.[0]
if (output === undefined) throw new Error('build-client: esbuild produced no output')

const artifact = `/* 由 scripts/build-client.mjs 生成；源码见 src/client/index.ts。DSH Client 只接受 window.__ModuleLoader__.load 注册格式。 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(packageName)},
  factory(require) {
    const module = { exports: {} };
    const exports = module.exports;
${output.text}
    return module.exports;
  },
});
`

await mkdir(new URL('../lib/', import.meta.url), { recursive: true })
await writeFile(new URL('../lib/client.js', import.meta.url), artifact, 'utf8')
console.log(`build-client: wrote lib/client.js (${Buffer.byteLength(artifact)} bytes)`)
