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

/**
 * 2026-10-26 真实事故：`dsh.plugin.json` 里混进**字面反引号 + n**（某次写入把换行写坏），
 * 让清单从 1a26ac9 起就不是合法 JSON，而 CI 只跑 build/test/pack，没人读它 → 潜伏数个提交。
 * 这条测试把「清单必须可解析、工具清单与实现一致、入口文件存在」变成硬约束。
 */
test('dsh.plugin.json 必须是合法 JSON，且工具清单/入口文件与实现一致', async () => {
  const root = new URL('..', import.meta.url)
  const raw = await readFile(new URL('dsh.plugin.json', root), 'utf8')
  const literalBacktickN = String.fromCharCode(96) + 'n'
  assert.ok(!raw.includes(literalBacktickN), 'dsh.plugin.json 含字面反引号+n（曾导致 JSON 损坏）')

  let manifest
  assert.doesNotThrow(() => { manifest = JSON.parse(raw) }, 'dsh.plugin.json 不是合法 JSON')

  assert.deepEqual(manifest.tools, [
    'memory_ping',
    'memory_list',
    'memory_search',
    'memory_delete',
    'memory_approve',
    'memory_update_resolution',
    'memory_probe',
    'memory_remember',
  ])

  for (const key of ['entry', 'client', 'patch']) {
    const rel = String(manifest[key] ?? '').replace(/^\.\//u, '')
    assert.ok(rel.length > 0, `dsh.plugin.json 缺少 ${key}`)
    await readFile(new URL(rel, root))
  }
})
