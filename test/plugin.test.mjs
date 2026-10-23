import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendAudit, readAudit } from '../lib/audit.js'
import { apply, inject, MEMORY_PING_TOOL, name, PLUGIN_ID } from '../lib/index.js'

/** 构造一个只实现本插件所需 API 的 Cordis 上下文替身。 */
function createMockContext({ failRegister = false, failCommand = false } = {}) {
  const cleanups = []
  const registered = []
  const commands = []
  const routes = []
  const listeners = []
  const unregistered = []
  const ctx = {
    effect(callback) {
      const cleanup = callback()
      cleanups.push(cleanup)
      return cleanup
    },
    on(event, listener) {
      listeners.push({ event, listener })
      return () => {
        unregistered.push(`event:${event}`)
      }
    },
    tools: {
      register(definition) {
        if (failRegister) throw new Error('tools service unavailable')
        registered.push(definition)
        return () => {
          unregistered.push(definition.name)
        }
      },
    },
    commands: {
      register(definition) {
        if (failCommand) throw new Error('commands service unavailable')
        commands.push(definition)
        return () => {
          unregistered.push(`command:${definition.name}`)
        }
      },
    },
    inject(services, callback) {
      if (services.includes('webServer')) {
        callback({
          webServer: {
            register(options) {
              routes.push(options)
              return () => {
                unregistered.push(`route:${options.path}`)
              }
            },
          },
        })
      }
      return () => {}
    },
  }
  return { ctx, cleanups, registered, commands, routes, listeners, unregistered }
}

/** 捕获 console.error 的调用参数。 */
function captureConsoleError(callback) {
  const calls = []
  const original = console.error
  console.error = (...args) => {
    calls.push(args)
  }
  try {
    callback()
  } finally {
    console.error = original
  }
  return calls
}

test('插件元数据符合单包单 entry 约定', () => {
  assert.equal(name, 'dsh-memory-minimal')
  assert.equal(PLUGIN_ID, 'dsh-memory-minimal')
  assert.deepEqual(inject, ['tools', 'commands', 'systemPrompt'])
})

test('apply 注册 memory_ping、memory_list、memory_delete 与 /clarify 命令', () => {
  const { ctx, registered, commands, routes, listeners } = createMockContext()
  apply(ctx)

  assert.equal(registered.length, 6)
  assert.deepEqual(registered.map(definition => definition.name).sort(), [
    'memory_approve',
    'memory_delete',
    'memory_list',
    'memory_ping',
    'memory_search',
    'memory_update_resolution',
  ])
  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, 'clarify')
  assert.equal(typeof commands[0].handler, 'function')
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/memory-explorer')
  assert.deepEqual(listeners.map(listener => listener.event).sort(), [
    'agent/error',
    'agent/pre-step',
    'session/event',
    'session/event',
  ])
})

test('memory_ping 返回固定结构且 ts 为 ISO 时间戳', async () => {
  const { ctx } = createMockContext()
  apply(ctx)

  const result = await MEMORY_PING_TOOL.execute({}, {})
  assert.equal(result.ok, true)
  assert.equal(result.plugin, 'dsh-memory-minimal')
  assert.match(result.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

  const rendered = MEMORY_PING_TOOL.output.render({}, result)
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].type, 'text')
  assert.deepEqual(JSON.parse(rendered[0].text), result)
})

test('effect disposer 会注销工具、命令与 HTTP 路由', () => {
  const { ctx, cleanups, unregistered } = createMockContext()
  apply(ctx)

  for (const cleanup of cleanups) cleanup()
  assert.deepEqual(unregistered.sort(), [
    'command:clarify',
    'event:agent/error',
    'event:agent/pre-step',
    'event:session/event',
    'event:session/event',
    'memory_approve',
    'memory_delete',
    'memory_list',
    'memory_ping',
    'memory_search',
    'memory_update_resolution',
    'route:/memory-explorer',
  ])
})

test('工具注册失败只写 stderr，clarify 命令仍可用', () => {
  const { ctx, commands } = createMockContext({ failRegister: true })
  const calls = captureConsoleError(() => {
    assert.doesNotThrow(() => apply(ctx))
  })

  assert.ok(calls.length >= 1)
  assert.equal(commands.length, 1)
})

test('命令注册失败只写 stderr，记忆工具仍可用', () => {
  const { ctx, registered } = createMockContext({ failCommand: true })
  const calls = captureConsoleError(() => {
    assert.doesNotThrow(() => apply(ctx))
  })

  assert.equal(calls.length, 1)
  assert.match(String(calls[0][0]), /clarify command registration failed/)
  assert.equal(registered.length, 6)
})

test('成功加载不会自动调用审计日志', () => {
  const { ctx } = createMockContext()
  const calls = captureConsoleError(() => apply(ctx))
  assert.equal(calls.length, 0)
})

test('appendAudit 写入合法 JSONL 审计记录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-plugin-audit-'))
  const previous = process.env.DSH_MEMORY_AUDIT_DIR
  process.env.DSH_MEMORY_AUDIT_DIR = dir
  try {
    appendAudit('memory.test', { reason: 'unit-test' })
    const entries = await readAudit(10)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].plugin, 'dsh-memory-minimal')
    assert.equal(entries[0].event, 'memory.test')
    assert.deepEqual(entries[0].payload, { reason: 'unit-test' })
    assert.match(entries[0].ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  } finally {
    if (previous === undefined) delete process.env.DSH_MEMORY_AUDIT_DIR
    else process.env.DSH_MEMORY_AUDIT_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})
