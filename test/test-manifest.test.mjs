/**
 * 护栏：`npm test` 是显式的文件列表，新增测试文件忘记加入时会**静默不跑**。
 *
 * 2026-10-25 真实踩坑：新增 critic.test.mjs 后全量仍报 259（应为 266），7 个测试没执行，
 * 结果却全绿。这条测试把「列表是否覆盖 test/ 下所有 *.test.mjs」变成硬约束。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'

test('package.json 的 test 脚本必须覆盖 test/ 下所有 *.test.mjs', async () => {
  const root = new URL('..', import.meta.url)
  const entries = await readdir(new URL('test/', root))
  const files = entries.filter(name => name.endsWith('.test.mjs')).sort((left, right) => left.localeCompare(right))
  assert.ok(files.length > 0, 'test/ 下没有任何测试文件，检查路径')

  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const script = typeof pkg.scripts?.test === 'string' ? pkg.scripts.test : ''
  assert.ok(script !== '', 'package.json 缺少 scripts.test')

  const missing = files.filter(name => !script.includes(`test/${name}`))
  assert.equal(
    missing.length,
    0,
    `以下测试文件未加入 npm test（会静默不跑）：${missing.join(', ')}`,
  )
})
