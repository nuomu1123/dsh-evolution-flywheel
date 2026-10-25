/**
 * 事件流韧性：SSE 心跳帧、断连看门狗与连接状态文案。
 *
 * 背景（2026-10-25 架构师要求）：前端曾把断连当成红色错误块，连接假活时界面静默停止更新。
 * 这里把"帧语义 / 何时重建 / 状态文案"三件纯逻辑与 Host 心跳一起焊死，防止回退。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { MemoryEventHub } from '../lib/memory/events.js'
import {
  classifyStreamFrame,
  describeStreamLink,
  shouldReconnectStream,
  STREAM_STALE_MS,
  STREAM_WATCHDOG_MS,
} from '../src/client/logic.ts'

/** 最小 ServerResponse 替身：只实现事件总线用到的四个方法。 */
function fakeRes(options = {}) {
  const writes = []
  const res = {
    writes,
    status: 0,
    headers: undefined,
    ended: false,
    closeHandler: undefined,
    failAfter: options.failAfter ?? Number.POSITIVE_INFINITY,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    write(chunk) {
      if (writes.length >= this.failAfter) throw new Error('EPIPE')
      writes.push(String(chunk))
      return true
    },
    end() {
      this.ended = true
    },
    on(event, handler) {
      if (event === 'close') this.closeHandler = handler
    },
  }
  return res
}

const framesOf = res => res.writes.map(chunk => chunk.trim()).filter(chunk => chunk !== '')

test('订阅后立刻收到心跳帧：前端不必等一个周期才知道链路是活的', () => {
  const hub = new MemoryEventHub(60_000)
  try {
    const res = fakeRes()
    hub.subscribe(res)
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /text\/event-stream/u)
    assert.equal(framesOf(res)[0], ': connected')
    const ping = framesOf(res).find(frame => frame.startsWith('data: '))
    assert.ok(ping !== undefined, '必须立即发一帧心跳')
    const payload = JSON.parse(ping.slice('data: '.length))
    assert.equal(payload.type, 'ping')
    assert.equal(typeof payload.at, 'string')
  } finally {
    hub.close()
  }
})

test('心跳按固定间隔持续发送，且能被 classifyStreamFrame 识别为 ping', async () => {
  const hub = new MemoryEventHub(10)
  try {
    const res = fakeRes()
    hub.subscribe(res)
    await new Promise(resolve => setTimeout(resolve, 120))
    const pings = framesOf(res).filter(frame => frame.startsWith('data: '))
    assert.ok(pings.length >= 2, `120ms 内至少 2 帧心跳，实际 ${pings.length}`)
    for (const frame of pings) {
      assert.equal(classifyStreamFrame(frame.slice('data: '.length)).kind, 'ping')
    }
  } finally {
    hub.close()
  }
})

test('业务事件帧格式与心跳区分清晰；写失败的连接会被摘掉', () => {
  const hub = new MemoryEventHub(60_000)
  try {
    const alive = fakeRes()
    const dead = fakeRes({ failAfter: 0 })
    hub.subscribe(alive)
    hub.subscribe(dead)
    hub.publish({ type: 'memory:removed', id: 'mem-1' })
    const eventFrame = framesOf(alive).find(frame => frame.includes('memory:removed'))
    assert.ok(eventFrame !== undefined)
    const parsed = classifyStreamFrame(eventFrame.slice('data: '.length))
    assert.equal(parsed.kind, 'event')
    assert.equal(parsed.payload.type, 'memory:removed')

    // 死连接第一次写就抛错：必须从集合里摘掉，后续 publish 不再碰它。
    const before = dead.writes.length
    hub.publish({ type: 'memory:removed', id: 'mem-2' })
    assert.equal(dead.writes.length, before)
  } finally {
    hub.close()
  }
})

test('close 会结束连接并停止心跳定时器', async () => {
  const hub = new MemoryEventHub(10)
  const res = fakeRes()
  hub.subscribe(res)
  await new Promise(resolve => setTimeout(resolve, 30))
  hub.close()
  assert.equal(res.ended, true)
  const frozen = res.writes.length
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(res.writes.length, frozen, 'close 之后不应再有心跳写入')
})

test('帧语义：坏帧丢弃但不断流，数组/标量都不算业务事件', () => {
  assert.deepEqual(classifyStreamFrame(''), { kind: 'invalid' })
  assert.deepEqual(classifyStreamFrame('not-json'), { kind: 'invalid' })
  assert.deepEqual(classifyStreamFrame('[1,2]'), { kind: 'invalid' })
  assert.deepEqual(classifyStreamFrame('123'), { kind: 'invalid' })
  assert.deepEqual(classifyStreamFrame('{"type":"ping","at":"2026-10-25T00:00:00Z"}'), { kind: 'ping' })
  const frame = classifyStreamFrame('{"type":"memory:added","item":{"id":"a"}}')
  assert.equal(frame.kind, 'event')
  assert.equal(frame.payload.type, 'memory:added')
})

test('看门狗：超过阈值才重建，未超时或数据异常一律不重建', () => {
  const now = 1_000_000
  assert.equal(STREAM_STALE_MS > STREAM_WATCHDOG_MS, true, '阈值必须大于检查间隔，否则每轮都重建')
  assert.equal(shouldReconnectStream(now - 1_000, now), false)
  assert.equal(shouldReconnectStream(now - STREAM_STALE_MS, now), false, '刚好等于阈值不算超时')
  assert.equal(shouldReconnectStream(now - STREAM_STALE_MS - 1, now), true)
  assert.equal(shouldReconnectStream(Number.NaN, now), false)
  assert.equal(shouldReconnectStream(now, Number.NaN), false)
})

test('连接状态文案：live 静默，其余都有可读兜底', () => {
  assert.equal(describeStreamLink('live'), '')
  for (const state of ['connecting', 'reconnecting', 'offline']) {
    const text = describeStreamLink(state)
    assert.ok(text.length > 0, `${state} 必须有文案`)
    assert.match(text, /事件流/u)
  }
  assert.match(describeStreamLink('reconnecting'), /自动重连/u)
  assert.match(describeStreamLink('offline'), /重新连接/u)
})
