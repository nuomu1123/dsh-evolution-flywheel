import test from 'node:test'
import assert from 'node:assert/strict'

// Client 产物会调用 window.__ModuleLoader__.load，先安装一个最小注册目标。
let registration
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      registration = value
    },
  },
}

await import('../lib/client.js')

const fakeReact = {
  createElement() {
    return null
  },
  useState(initial) {
    return [initial, () => {}]
  },
  useEffect() {},
  useMemo(factory) {
    return factory()
  },
  memo(component) {
    return component
  },
}

function createClientContext() {
  const calls = []
  const cleanups = []
  const ctx = {
    effect(callback) {
      const cleanup = callback()
      cleanups.push(cleanup)
      return cleanup
    },
    slots: {
      inject(name, callback) {
        calls.push(['inject', name])
        return callback()
      },
      register(options, component) {
        calls.push(['register', options.name, options.id ?? options.key, options.order, component])
        return () => {
          calls.push(['dispose', options.name, options.id ?? options.key])
        }
      },
    },
  }
  return { ctx, calls, cleanups }
}

test('Client 产物以包名注册到模块加载器', () => {
  assert.ok(registration)
  assert.equal(registration.id, 'dsh-evolution-flywheel')
  assert.equal(typeof registration.factory, 'function')
})

test('Client 工厂返回 inject 与 apply', () => {
  const module = registration.factory((id) => {
    if (id === 'react') return fakeReact
    throw new Error(`unexpected require: ${id}`)
  })
  assert.deepEqual(module.inject, ['slots'])
  assert.equal(typeof module.apply, 'function')
})

test('Client apply 注册 clarify、侧边栏入口与主面板', () => {
  const module = registration.factory((id) => {
    if (id === 'react') return fakeReact
    throw new Error(`unexpected require: ${id}`)
  })
  const { ctx, calls, cleanups } = createClientContext()
  module.apply(ctx)

  const injected = calls.filter(call => call[0] === 'inject').map(call => call[1])
  assert.deepEqual(injected, ['conversation.input.dock', 'main', 'sidebar.panellist', 'settings.section'])

  const registrations = calls.filter(call => call[0] === 'register')
  assert.equal(registrations.length, 4)
  assert.deepEqual(registrations[0].slice(1, 4), ['conversation.input.dock', 'clarify', 30])
  assert.deepEqual(registrations[1].slice(1, 4), ['main', 'memory-explorer', undefined])
  assert.deepEqual(registrations[2].slice(1, 4), ['sidebar.panellist', 'memory-explorer', 20])
  assert.deepEqual(registrations[3].slice(1, 4), ['settings.section', 'memory', 17])
  for (const registrationCall of registrations) {
    assert.equal(typeof registrationCall[4], 'function')
  }

  assert.equal(cleanups.length, 4)
  for (const cleanup of cleanups) cleanup()
  assert.deepEqual(calls.filter(call => call[0] === 'dispose'), [
    ['dispose', 'conversation.input.dock', 'clarify'],
    ['dispose', 'main', 'memory-explorer'],
    ['dispose', 'sidebar.panellist', 'memory-explorer'],
    ['dispose', 'settings.section', 'memory'],
  ])
})

test('Client 初始化异常只写 stderr，不 throw', () => {
  const module = registration.factory((id) => {
    if (id === 'react') return fakeReact
    throw new Error(`unexpected require: ${id}`)
  })
  const calls = []
  const original = console.error
  console.error = (...args) => calls.push(args)
  try {
    const ctx = {
      effect() {
        throw new Error('slots unavailable')
      },
      slots: {
        inject() {
          throw new Error('should not be reached')
        },
        register() {
          throw new Error('should not be reached')
        },
      },
    }
    assert.doesNotThrow(() => module.apply(ctx))
  } finally {
    console.error = original
  }
  assert.equal(calls.length, 4)
  assert.match(String(calls[0][0]), /clarify client initialization failed/)
  assert.match(String(calls[1][0]), /memory page registration failed/)
  assert.match(String(calls[2][0]), /memory sidebar registration failed/)
  assert.match(String(calls[3][0]), /memory settings registration failed/)
})
