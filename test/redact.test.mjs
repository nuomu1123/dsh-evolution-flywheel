/**
 * 敏感信息脱敏层回归护栏（2026-10-24 体检后补）。
 *
 * 这些用例锁的是「凭据绝不落盘」这条底线：
 * 记忆会广播到 Web 面板并可能被导出，URL token / 密码 / API Key 一旦写进去就收不回来。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { redactArgs, redactText, redactUrl } from '../lib/memory/redact.js'

test('redactUrl：丢弃 query 与 hash，只保留协议+主机+路径', () => {
  assert.equal(
    redactUrl('https://example.com/checkout?token=abc123&user=1#section'),
    'https://example.com/checkout',
  )
  assert.equal(redactUrl('https://example.com/'), 'https://example.com')
  assert.equal(redactUrl('http://127.0.0.1:3099/?token=secret'), 'http://127.0.0.1:3099')
})

test('redactUrl：about/data/file 等特殊页不解析成怪 URL', () => {
  assert.equal(redactUrl('about:blank'), 'about:blank')
  assert.ok(redactUrl('data:text/html,<h1>x</h1>').startsWith('data:'))
  // 非法 URL 退回文本打码，不能抛错
  assert.doesNotThrow(() => redactUrl('not a url with ?token=abc'))
})

test('redactText：打码 ?token=、Bearer、平台密钥前缀与邮箱', () => {
  assert.ok(!redactText('GET /api?token=abc123&x=1').includes('abc123'))
  assert.ok(!redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.xxx').includes('eyJhbGciOiJIUzI1NiJ9'))
  assert.ok(!redactText('key=sk-abcdefgh12345678').includes('abcdefgh12345678'))
  assert.ok(redactText('联系 someone@example.com').includes('***@example.com'))
})

test('redactText：普通文本原样保留（不能把正常内容也打码）', () => {
  assert.equal(redactText('点击提交按钮'), '点击提交按钮')
  assert.equal(redactText('https://example.com/a/b'), 'https://example.com/a/b')
})

test('redactArgs：敏感键整值打码，普通键保留', () => {
  const raw = JSON.stringify({ url: 'https://x.com/a?token=abc', element: '提交', password: 'hunter2' })
  const out = redactArgs(raw)
  assert.ok(!out.includes('hunter2'), out)
  assert.ok(out.includes('提交'), out)
  assert.ok(!out.includes('abc'), out)
})

test('redactArgs：嵌套对象与数组里的敏感键同样打码', () => {
  const raw = JSON.stringify({
    fields: [
      { name: 'user', value: 'alice' },
      { name: 'pwd', value: 'hunter2' },
    ],
    token: 'secret-token',
  })
  const out = redactArgs(raw)
  assert.ok(!out.includes('hunter2'), out)
  assert.ok(!out.includes('secret-token'), out)
  assert.ok(out.includes('alice'), out)
})

test('redactArgs：非 JSON 参数退回文本打码，不抛错', () => {
  const out = redactArgs('curl https://api.example.com/?api_key=abc123')
  assert.ok(!out.includes('abc123'), out)
  assert.equal(redactArgs(undefined), '无参数')
  assert.equal(redactArgs('   '), '无参数')
})
