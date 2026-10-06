import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chitchatStyleFor, latestUserText, installChitchatStyle,
  STYLE_DIRECTIVE, STYLE_SECTION, STYLE_ORDER,
} from '../lib/chitchat-style.mjs'

const CONFIG = {
  casual: { types: ['daily_chat'], minScore: 3, preferFree: true },
  chitchatStyle: { enabled: true },
}

const userEvent = text => ({ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const pluginEvent = text => ({ type: 'user/message', data: { role: 'user', source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text }] } })
const toolEvent = () => ({ type: 'user/message', data: { role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', callId: 'c1', content: [], isError: false }] } })
const scopeWith = events => ({ scope: { session: { events } } })

test('latestUserText reads the newest human turn', () => {
  assert.equal(latestUserText({ events: [userEvent('第一条'), pluginEvent('上下文'), userEvent('最后一条')] }), '最后一条')
})

test('latestUserText ignores plugin context and tool results', () => {
  assert.equal(latestUserText({ events: [pluginEvent('系统注入'), toolEvent()] }), '')
  assert.equal(latestUserText({ events: [] }), '')
  assert.equal(latestUserText(undefined), '')
})

test('small talk gets the directive', () => {
  assert.equal(chitchatStyleFor(scopeWith([userEvent('你好')]), CONFIG), STYLE_DIRECTIVE)
  assert.equal(chitchatStyleFor(scopeWith([userEvent('哈哈')]), CONFIG), STYLE_DIRECTIVE)
})

test('task turns assemble an empty section, so their prompt is unchanged', () => {
  assert.equal(chitchatStyleFor(scopeWith([userEvent('这段 Python 报错怎么修？')]), CONFIG), '')
  assert.equal(chitchatStyleFor(scopeWith([userEvent('帮我改一下 src/index.ts 然后跑测试')]), CONFIG), '')
  assert.equal(chitchatStyleFor(scopeWith([userEvent('证明：∑(1/k) 发散')]), CONFIG), '')
})

test('a turn with no human message contributes nothing', () => {
  assert.equal(chitchatStyleFor(scopeWith([]), CONFIG), '')
  assert.equal(chitchatStyleFor(undefined, CONFIG), '')
  assert.equal(chitchatStyleFor({}, CONFIG), '')
})

test('the feature can be switched off and the wording overridden', () => {
  assert.equal(chitchatStyleFor(scopeWith([userEvent('你好')]), { ...CONFIG, chitchatStyle: { enabled: false } }), '')
  const custom = { ...CONFIG, chitchatStyle: { enabled: true, directive: '只说一句话。' } }
  assert.equal(chitchatStyleFor(scopeWith([userEvent('你好')]), custom), '只说一句话。')
})

test('installation registers one named section and degrades when the service is absent', () => {
  let captured
  const disposer = installChitchatStyle({ systemPrompt: { section: s => { captured = s; return () => {} } } }, CONFIG)
  assert.equal(typeof disposer, 'function')
  assert.equal(captured.name, STYLE_SECTION)
  assert.equal(captured.order, STYLE_ORDER)
  assert.equal(captured.text(scopeWith([userEvent('你好')])), STYLE_DIRECTIVE)
  assert.equal(captured.text(scopeWith([userEvent('讲一下递归')])), '')
  assert.equal(installChitchatStyle({}, CONFIG), undefined)
  assert.equal(installChitchatStyle(undefined, CONFIG), undefined)
})
