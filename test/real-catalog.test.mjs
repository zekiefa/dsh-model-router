// Runs the policy against the REAL capability matrix and the REAL provider
// routes, so the chat-mode requirement is locked to actual data rather than to a
// fixture that could quietly stop resembling it: small talk in 闲聊 mode must
// pick Space Bunny Free, and 工作 mode must keep the pre-existing behaviour.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decide, isFree } from '../lib/policy.mjs'

const catalog = JSON.parse(readFileSync(new URL('../data/capabilities.json', import.meta.url), 'utf8'))
const index = new Map(catalog.models.map(model => [model.id, model]))

/** Provider of each model id as the live profile routes it. */
function providerOf(id) {
  if (id === 'space-bunny-free') return 'opencode'
  if (/^agnes/.test(id)) return 'custom'
  if (/^grok/.test(id)) return 'grok'
  if (/^gemini/.test(id)) return 'genemi'
  if (/^claude/.test(id)) return 'claude'
  if (/^deepseek/.test(id)) return 'deepseek-account'
  return 'open'
}
const candidates = catalog.models.map(model => ({ provider: providerOf(model.id), id: model.id }))

const CONFIG = {
  fallback: { provider: 'deepseek-account', model: 'deepseek-flash' },
  research: { types: ['learning_tutor', 'coding', 'math_reasoning', 'knowledge_qa', 'agentic_tools'] },
  casual: { types: ['daily_chat'], minScore: 3, preferFree: true },
  balanced: { types: ['writing_literature', 'translation', 'long_context'], maxScoreDrop: 1 },
  grok: { enabled: true, allowedTypes: ['daily_chat'] },
  chat: { preferred: { id: 'space-bunny-free' } },
  respectModalities: true,
}
const run = (classification, mode) =>
  decide({ candidates, index, classification, config: mode === undefined ? CONFIG : { ...CONFIG, mode } })

test('chat mode: small talk picks Space Bunny Free on the real catalog', () => {
  const r = run({ type: 'daily_chat', difficulty: 'trivial', needsTools: false, hasImage: false }, 'chat')
  assert.equal(r.kind, 'chat-free')
  assert.equal(r.pick.id, 'space-bunny-free')
  assert.equal(isFree(r.pick.cap), true)
})

test('chat mode: Space Bunny Free also leads a tool-executing turn when it qualifies', () => {
  const r = run({ type: 'agentic_tools', difficulty: 'moderate', needsTools: true, hasImage: false }, 'chat')
  assert.equal(r.kind, 'chat-free')
  assert.equal(r.pick.id, 'space-bunny-free')
})

test('chat mode: a very complex question escalates to Grok', () => {
  const r = run({ type: 'knowledge_qa', difficulty: 'hard', needsTools: false, hasImage: false }, 'chat')
  assert.equal(r.kind, 'chat-complex')
  assert.equal(r.pick.provider, 'grok')
  assert.match(r.pick.id, /thinking/)
})

test('work mode is untouched: small talk still favours the fastest free model', () => {
  const r = run({ type: 'daily_chat', difficulty: 'trivial', needsTools: false, hasImage: false }, 'work')
  assert.equal(r.kind, 'casual')
  assert.notEqual(r.pick.id, 'space-bunny-free', 'work mode keeps the latency-tie-broken free pool')
  assert.equal(isFree(r.pick.cap), true)
})

test('work mode is untouched: a research turn still goes quality-first', () => {
  const r = run({ type: 'coding', difficulty: 'moderate', needsTools: true, hasImage: false }, 'work')
  assert.equal(r.kind, 'research')
  assert.equal(r.pick.cap.scores.coding, 5)
})
