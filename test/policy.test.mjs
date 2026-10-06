import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, isFree, makeCooldowns, isRateLimitFailure } from '../lib/policy.mjs'

const cap = (id, scores, price, extra = {}) => ({
  id, scores, price, tool_calling: true, modalities: ['text'], measured: { reachable: true, tool: true }, ...extra,
})

const INDEX = new Map([
  ['free-flash', cap('free-flash', { daily_chat: 3, coding: 3, learning_tutor: 3 }, { input: 0, output: 0 }, { measured: { reachable: true, tool: true, ttftMs: 600 } })],
  ['mid-pro', cap('mid-pro', { daily_chat: 4, coding: 4, learning_tutor: 4 }, { input: 0.45, output: 0.9 }, { measured: { reachable: true, tool: true, ttftMs: 1000 } })],
  ['top-sol', cap('top-sol', { daily_chat: 5, coding: 5, learning_tutor: 5 }, { input: 5, output: 25 }, { measured: { reachable: true, tool: true, ttftMs: 12000 } })],
  ['grok-4', cap('grok-4', { daily_chat: 4, coding: 4 }, null, { tool_calling: false, price: null })],
])

const CANDIDATES = [
  { provider: 'custom', id: 'free-flash' },
  { provider: 'open', id: 'mid-pro' },
  { provider: 'open', id: 'top-sol' },
  { provider: 'grok', id: 'grok-4' },
]

const CONFIG = {
  fallback: { provider: 'deepseek-account', model: 'deepseek-flash' },
  research: { types: ['learning_tutor', 'coding', 'math_reasoning', 'knowledge_qa', 'agentic_tools'] },
  casual: { types: ['daily_chat'], minScore: 3, preferFree: true },
  balanced: { types: ['writing_literature', 'translation', 'long_context'], maxScoreDrop: 1 },
  grok: { enabled: true, allowedTypes: ['daily_chat'] },
  respectModalities: true,
}

const run = (classification, config = CONFIG, extra = {}) =>
  decide({ candidates: CANDIDATES, index: INDEX, classification, config, ...extra })

test('research tasks are quality-first: the best rating wins even when it is the most expensive', () => {
  const r = run({ type: 'coding', needsTools: true, hasImage: false })
  assert.equal(r.pick.id, 'top-sol')
  assert.equal(r.kind, 'research')
})

test('within the top rating, price breaks the tie', () => {
  const index = new Map(INDEX)
  index.set('twin-sol', cap('twin-sol', { coding: 5 }, { input: 2, output: 10 }))
  const r = decide({
    candidates: [...CANDIDATES, { provider: 'open', id: 'twin-sol' }],
    index,
    classification: { type: 'coding', needsTools: true, hasImage: false },
    config: CONFIG,
  })
  assert.equal(r.pick.id, 'twin-sol', 'same rating, lower price should win')
})

test('small talk prefers a free model that clears the floor over a stronger paid one', () => {
  const r = run({ type: 'daily_chat', needsTools: false, hasImage: false })
  assert.equal(r.pick.id, 'free-flash')
  assert.equal(isFree(r.pick.cap), true)
  assert.equal(r.kind, 'casual')
})

test('small talk relaxes the floor rather than failing when nothing qualifies', () => {
  const index = new Map(INDEX)
  index.set('free-flash', cap('free-flash', { daily_chat: 2 }, { input: 0, output: 0 }))
  const r = decide({
    candidates: [{ provider: 'custom', id: 'free-flash' }],
    index,
    classification: { type: 'daily_chat', needsTools: false, hasImage: false },
    config: CONFIG,
  })
  assert.equal(r.kind, 'casual-relaxed')
  assert.equal(r.pick.id, 'free-flash')
})

test('grok is never chosen for a turn that executes a task, even though it is free and rated well', () => {
  const r = run({ type: 'agentic_tools', needsTools: true, hasImage: false })
  assert.notEqual(r.pick.provider, 'grok')
  const grok = r.considered.find(c => c.provider === 'grok')
  assert.match(grok.excluded, /cannot call tools/)
})

test('grok is barred outside its allowed types', () => {
  const r = run({ type: 'writing_literature', needsTools: false, hasImage: false })
  const grok = r.considered.find(c => c.provider === 'grok')
  assert.match(grok.excluded, /restricted to daily_chat/)
})

test('grok can only win the small-talk turn it is allowed in, and only on merit', () => {
  const onlyGrok = [{ provider: 'grok', id: 'grok-4' }]
  const r = decide({
    candidates: onlyGrok, index: INDEX,
    classification: { type: 'daily_chat', needsTools: false, hasImage: false },
    config: CONFIG,
  })
  assert.equal(r.pick.id, 'grok-4')
})

test('models measured as unable to call tools are excluded from tool turns', () => {
  const r = run({ type: 'coding', needsTools: true, hasImage: false })
  assert.ok(!r.considered.some(c => c.id === 'grok-4' && !c.excluded))
})

test('tool support that is merely unknown is not good enough for a tool turn', () => {
  const index = new Map([['mystery', { id: 'mystery', scores: { coding: 5 }, price: { input: 1, output: 1 } }]])
  const r = decide({
    candidates: [{ provider: 'x', id: 'mystery' }], index,
    classification: { type: 'coding', needsTools: true, hasImage: false },
    config: CONFIG,
  })
  assert.equal(r.kind, 'unknown-fallback')
  assert.equal(r.pick.id, 'deepseek-flash')
})

test('an entirely unknown pool falls back instead of guessing', () => {
  const r = decide({
    candidates: [{ provider: 'x', id: 'never-heard-of-it' }], index: new Map(),
    classification: { type: 'knowledge_qa', needsTools: false, hasImage: false },
    config: CONFIG,
  })
  assert.equal(r.kind, 'unknown-fallback')
  assert.equal(r.pick.provider, 'deepseek-account')
})

test('a route in cooldown is skipped, not retried', () => {
  const cooldowns = makeCooldowns(60_000)
  cooldowns.mark('open/top-sol')
  const r = run({ type: 'coding', needsTools: true, hasImage: false }, CONFIG, { cooldowns })
  assert.equal(r.pick.id, 'mid-pro')
  const top = r.considered.find(c => c.id === 'top-sol')
  assert.match(top.excluded, /rate-limited/)
})

test('an image turn rejects text-only models', () => {
  const index = new Map([
    ['text-only', cap('text-only', { knowledge_qa: 5 }, { input: 0, output: 0 }, { modalities: ['text'] })],
  ])
  const r = decide({
    candidates: [{ provider: 'x', id: 'text-only' }], index,
    classification: { type: 'knowledge_qa', needsTools: false, hasImage: true },
    config: CONFIG,
  })
  assert.equal(r.kind, 'unknown-fallback')
})

// --- chat mode (user-selected "闲聊" override) ---
const CHAT_INDEX = new Map([
  ['space-bunny-free', cap('space-bunny-free', { daily_chat: 4, knowledge_qa: 3, math_reasoning: 3, coding: 3 }, { input: 0, output: 0 }, { measured: { reachable: true, tool: true, ttftMs: 2000 } })],
  ['agnes-3.0-flash', cap('agnes-3.0-flash', { daily_chat: 4, knowledge_qa: 3, math_reasoning: 3, coding: 4 }, { input: 0, output: 0 }, { measured: { reachable: true, tool: true, ttftMs: 600 } })],
  ['grok-420-thinking', cap('grok-420-thinking', { daily_chat: 4, knowledge_qa: 5, math_reasoning: 4, coding: 4 }, { input: 1.25, output: 2.5 })],
  ['gpt-6.1-sol', cap('gpt-6.1-sol', { daily_chat: 4, knowledge_qa: 5, math_reasoning: 5, coding: 5 }, { input: 2, output: 10 })],
])
const CHAT_CANDIDATES = [
  { provider: 'opencode', id: 'space-bunny-free' },
  { provider: 'custom', id: 'agnes-3.0-flash' },
  { provider: 'grok', id: 'grok-420-thinking' },
  { provider: 'open', id: 'gpt-6.1-sol' },
]
const CHAT_CONFIG = { ...CONFIG, mode: 'chat' }

test('chat mode: a simple turn prefers Space Bunny Free first, then other free models', () => {
  const r = decide({ candidates: CHAT_CANDIDATES, index: CHAT_INDEX, classification: { type: 'daily_chat', difficulty: 'trivial', needsTools: false, hasImage: false }, config: CHAT_CONFIG })
  assert.equal(r.kind, 'chat-free')
  assert.equal(r.pick.id, 'space-bunny-free')
  assert.equal(isFree(r.pick.cap), true)
})

test('chat mode: when Space Bunny Free is absent the next free model wins', () => {
  const r = decide({ candidates: CHAT_CANDIDATES.filter(c => c.id !== 'space-bunny-free'), index: CHAT_INDEX, classification: { type: 'daily_chat', difficulty: 'trivial', needsTools: false, hasImage: false }, config: CHAT_CONFIG })
  assert.equal(r.kind, 'chat-free')
  assert.equal(r.pick.id, 'agnes-3.0-flash')
})

test('chat mode: a very complex question may use Grok for reasoning', () => {
  const r = decide({ candidates: CHAT_CANDIDATES, index: CHAT_INDEX, classification: { type: 'knowledge_qa', difficulty: 'hard', needsTools: false, hasImage: false }, config: CHAT_CONFIG })
  assert.equal(r.kind, 'chat-complex')
  assert.equal(r.pick.provider, 'grok')
  assert.equal(r.pick.id, 'grok-420-thinking')
})

test('chat mode: a very complex task that executes tools still never uses Grok', () => {
  const r = decide({ candidates: CHAT_CANDIDATES, index: CHAT_INDEX, classification: { type: 'coding', difficulty: 'hard', needsTools: true, hasImage: false }, config: CHAT_CONFIG })
  assert.notEqual(r.pick.provider, 'grok')
})

test('chat mode: no free model qualifies, so it falls through to the type policy', () => {
  const index = new Map([['gpt-6.1-sol', cap('gpt-6.1-sol', { coding: 5 }, { input: 2, output: 10 })]])
  const r = decide({ candidates: [{ provider: 'open', id: 'gpt-6.1-sol' }], index, classification: { type: 'coding', difficulty: 'trivial', needsTools: true, hasImage: false }, config: CHAT_CONFIG })
  assert.equal(r.kind, 'research')
  assert.equal(r.pick.id, 'gpt-6.1-sol')
})

test('work mode is unchanged: a hard knowledge question still never uses Grok', () => {
  const r = decide({ candidates: CHAT_CANDIDATES, index: CHAT_INDEX, classification: { type: 'knowledge_qa', difficulty: 'hard', needsTools: false, hasImage: false }, config: CONFIG })
  assert.notEqual(r.pick.provider, 'grok')
})

test('rate-limit failures are classified into three different recoveries', () => {
  // A throttle, a scheduled allowance and a spent balance need opposite treatment.
  assert.equal(isRateLimitFailure({ code: 'RATE_LIMIT', message: 'x' }), 'rate')
  assert.equal(isRateLimitFailure({ code: 'PROVIDER_ERROR', message: 'HTTP 429 too many requests' }), 'rate')
  assert.equal(isRateLimitFailure({ code: 'QUOTA_EXCEEDED', message: 'quota exceeded, resets 00:00 UTC' }), 'quota')
  // A spent balance does not restore itself, so it must not take the short window.
  assert.equal(isRateLimitFailure({ code: 'INSUFFICIENT_QUOTA', message: '' }), 'exhausted')
  assert.equal(isRateLimitFailure({ code: 'INSUFFICIENT_BALANCE', message: '' }), 'exhausted')
  // The slowest-resetting cause wins when a message names both.
  assert.equal(isRateLimitFailure({ message: 'rate limit exceeded and quota exceeded' }), 'quota')
  // A request id containing 429 is not a throttled request.
  assert.equal(isRateLimitFailure({ code: 'PROVIDER_ERROR', message: 'failed (req-42981)' }), false)
  assert.equal(isRateLimitFailure({ code: 'PROVIDER_ERROR', message: 'model unavailable' }), false)
})

test('cooldowns treat throttle, quota and spent credit differently', () => {
  const cooldowns = makeCooldowns({ ttlMs: 60_000, providerTtlMs: 60_000, maxTtlMs: 600_000, quotaTtlMs: 120_000 })

  // Quota: one flat window, never escalating.
  cooldowns.mark('gw/q', 'gw', 0, 'quota')
  const first = cooldowns.entries().providers.get('gw')
  cooldowns.mark('gw/q', 'gw', 0, 'quota')
  const again = cooldowns.entries().providers.get('gw')
  assert.equal(first.streak, 0)
  assert.equal(first.until, again.until)

  // A throttle escalates from its second consecutive failure.
  cooldowns.mark('gw/r', 'gw', 0, 'rate')
  const escalated = cooldowns.mark('gw/r', 'gw', 0, 'rate')
  assert.ok(escalated > 60_000, `a repeated throttle lengthens its window (got ${escalated})`)

  // A spent balance takes the longest window available, not a short retry loop.
  const exhausted = cooldowns.mark('gw/e', 'gw', 0, 'exhausted')
  assert.equal(exhausted, 600_000, 'billing exhaustion gets the capped window, not the 2-minute one')
})

test("a sibling's success does not clear a route that is still throttling", () => {
  // Five free models share one gateway key. If B succeeding cleared A's cooldown,
  // A would be reselected immediately, 429 again, and every turn would burn an
  // extra failed round trip.
  const cooldowns = makeCooldowns({ ttlMs: 60_000 })
  cooldowns.mark('gw/a', 'gw', 0, 'rate')
  cooldowns.succeed('gw/b')
  assert.ok(cooldowns.get('gw/a', 'gw') > 0, 'A stays blocked')
  cooldowns.succeed('gw/a')
  assert.equal(cooldowns.entries().models.has('gw/a'), false, "A's own entry is released once A itself succeeds")
  assert.ok(cooldowns.get('gw/a', 'gw') > 0, 'the shared provider entry still holds until its TTL, by design')
})
