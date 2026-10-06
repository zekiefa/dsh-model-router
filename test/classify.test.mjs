import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, needsToolExecution, hasImage, TYPES } from '../lib/classify.mjs'

const user = text => [{ role: 'user', content: [{ type: 'text', text }] }]
// A tool cycle as the harness actually models it: no 'tool' role exists, the
// result is a user-role message whose source kind is 'tool'.
const toolTurn = text => [
  { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  {
    id: 'm2', role: 'assistant', source: { kind: 'model', provider: 'custom', model: 'agnes-3.0-flash' },
    content: [{ type: 'tool-call', id: 'c1', name: 'fs_read', arguments: '{}' }],
  },
  {
    id: 'm3', role: 'user', source: { kind: 'tool', callId: 'c1' },
    content: [{ type: 'tool-result', callId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false }],
  },
]

test('every declared type is reachable', () => {
  assert.equal(TYPES.length, 9)
})

test('coding questions classify as coding', () => {
  assert.equal(classify({ messages: user('这段 TypeScript 报错怎么修？TypeError: x is not a function') }).type, 'coding')
  assert.equal(classify({ messages: user('帮我看看这个函数为什么死循环\n```js\nwhile(1){}\n```') }).type, 'coding')
})

test('learning questions classify as learning_tutor', () => {
  assert.equal(classify({ messages: user('能讲解一下什么是递归吗，最好通俗一点') }).type, 'learning_tutor')
  assert.equal(classify({ messages: user('explain how a hash map works internally') }).type, 'learning_tutor')
})

test('small talk classifies as daily_chat', () => {
  assert.equal(classify({ messages: user('你好') }).type, 'daily_chat')
  assert.equal(classify({ messages: user('哈哈') }).type, 'daily_chat')
  assert.equal(classify({ messages: user('thanks!') }).type, 'daily_chat')
})

test('translation wins over generic knowledge wording', () => {
  assert.equal(classify({ messages: user('帮我把这段翻译成英文') }).type, 'translation')
})

test('math wins over coding when symbols dominate', () => {
  assert.equal(classify({ messages: user('证明：对任意正整数 n，∑(1/k) 发散') }).type, 'math_reasoning')
})

test('requesting work on the environment classifies as agentic_tools', () => {
  const v = classify({ messages: user('帮我改一下 src/index.ts 里的那个 bug 然后跑一下测试') })
  assert.equal(v.type, 'agentic_tools')
  assert.equal(v.needsTools, true)
})

test('a short bare line falls back to small talk, a longer one to knowledge', () => {
  assert.equal(classify({ messages: user('嗯嗯') }).type, 'daily_chat')
  assert.equal(classify({ messages: user('这个库的设计取舍是什么') }).type, 'knowledge_qa')
})

test('needsToolExecution is true inside a tool cycle even when the text looks casual', () => {
  assert.equal(needsToolExecution(toolTurn('好的'), '好的'), true)
  assert.equal(needsToolExecution(user('好的'), '好的'), false)
  assert.equal(needsToolExecution(user('运行一下测试'), '运行一下测试'), true)
  assert.equal(needsToolExecution(user('今天天气不错'), '今天天气不错'), false)
})

test('image detection sees through content blocks', () => {
  const withImage = [{ role: 'user', content: [{ type: 'image', source: {} }, { type: 'text', text: '看看' }] }]
  assert.equal(hasImage(withImage), true)
  assert.equal(hasImage(user('看看')), false)
})

test('difficulty rises with explicit depth requests', () => {
  assert.equal(classify({ messages: user('你好') }).difficulty, 'trivial')
  assert.equal(classify({ messages: user('请详细、系统地分析并证明这个结论，给出完整推导过程') }).difficulty, 'hard')
})
