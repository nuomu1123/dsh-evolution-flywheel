/**
 * 体检修复的回归护栏（2026-10-24）。
 *
 * 每条用例对应一处「静默吞错 → 可观测/可恢复」的修复，断言的是修复后的契约，
 * 不是实现细节。改动这些行为前，请先读对应报告：
 *   - reports/flywheel-audit-catch-memory.md（P0 store.ts:847）
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MemoryStore } from '../lib/memory/store.js'

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-repair-guards-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function goodRecord(overrides = {}) {
  return {
    id: 'mem-good',
    content: '正常记忆：修复护栏用例',
    type: 'fact',
    status: 'approved',
    createdAt: '2026-10-24T00:00:00.000Z',
    ...overrides,
  }
}

test('损坏 JSONL 行不会静默丢失：解析失败的行被隔离到 .corrupt', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'memories.jsonl')
    await writeFile(file, `${JSON.stringify(goodRecord())}\n{这不是合法 JSON\n`, 'utf8')

    const store = new MemoryStore(dir)
    const items = await store.list()

    // 正常行照常返回，坏行不阻塞列表。
    assert.equal(items.length, 1)
    assert.equal(items[0].id, 'mem-good')

    // 坏行必须留下可恢复的痕迹，而不是只写一行 console.error。
    const corrupt = await readFile(`${file}.corrupt`, 'utf8')
    assert.ok(corrupt.includes('这不是合法 JSON'), '坏行应被完整备份到 .corrupt')
  })
})

test('合法 JSON 但不是记忆对象（数组/空对象）同样被隔离', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'memories.jsonl')
    await writeFile(
      file,
      `${JSON.stringify(goodRecord())}\n[1,2,3]\n{}\n`,
      'utf8',
    )

    const store = new MemoryStore(dir)
    const items = await store.list()

    assert.equal(items.length, 1)
    const corrupt = await readFile(`${file}.corrupt`, 'utf8')
    assert.ok(corrupt.includes('[1,2,3]'), '数组行应被隔离')
    assert.ok(corrupt.includes('{}'), '空对象行应被隔离')
  })
})

test('同一坏行重复读取只隔离一次，避免高频读把 .corrupt 撑爆', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'memories.jsonl')
    await writeFile(file, `${JSON.stringify(goodRecord())}\n坏行\n`, 'utf8')

    const store = new MemoryStore(dir)
    await store.list()
    await store.list()
    await store.list()

    const corrupt = await readFile(`${file}.corrupt`, 'utf8')
    const occurrences = corrupt.split('\n').filter(line => line.includes('坏行')).length
    assert.equal(occurrences, 1, '.corrupt 里同一坏行只应出现一次')
  })
})

test('后续写入重写正式文件时，坏行仍保留在 .corrupt（不被永久删除）', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'memories.jsonl')
    await writeFile(file, `${JSON.stringify(goodRecord())}\n坏行-XYZ\n`, 'utf8')

    const store = new MemoryStore(dir)
    await store.list()
    // 触发一次整文件重写：追加一条新记忆。
    const appended = await store.appendSuggested('新增一条', 'fact')
    assert.ok(appended !== undefined)

    const formal = await readFile(file, 'utf8')
    assert.ok(!formal.includes('坏行-XYZ'), '正式文件里不应再包含坏行')
    assert.ok(formal.includes('新增一条'), '新记忆应正常写入')

    const corrupt = await readFile(`${file}.corrupt`, 'utf8')
    assert.ok(corrupt.includes('坏行-XYZ'), '坏行必须仍可从 .corrupt 恢复')
  })
})

test('全部行都合法时不创建 .corrupt 文件', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'memories.jsonl')
    await writeFile(file, `${JSON.stringify(goodRecord())}\n`, 'utf8')

    const store = new MemoryStore(dir)
    await store.list()

    await assert.rejects(readFile(`${file}.corrupt`, 'utf8'), { code: 'ENOENT' })
  })
})
