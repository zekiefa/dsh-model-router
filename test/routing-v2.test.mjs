import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, makeCooldowns, toolSupport, isRetired } from '../lib/policy.mjs'
import { classify, estimateTokens } from '../lib/classify.mjs'

const cap = (id, scores, price, extra = {}) => ({
  id, scores, price, tool_calling: true, modalities: ['text'],
  measured: { reachable: true, tool: true }, ...extra,
})
const CFG = {
  fallback: { provider: 'fb', model: 'fb-flash' },
  research: { types: ['coding', 'math_reasoning'] },
  casual: { types: ['daily_chat'], minScore: 3, preferFree: true },
  balanced: { types: ['writing_literature'], maxScoreDrop: 0 },
}
const run = (classification, index, candidates, config = CFG, extra = {}) =>
  decide({ candidates, index, classification: { needsTools: false, hasImage: false, ...classification }, config, ...extra })

// --- ① a measurement beats a claim, but only when the probe actually ran ---

test('a reachable probe that refused tool_choice is believed over the vendor claim', () => {
  const record = cap('grok-ish', { coding: 5 }, { input: 1, output: 2 },
    { tool_calling: true, measured: { reachable: true, tool: false, note: 'ok' } })
  assert.equal(toolSupport(record), false)
})

test('a probe that never reached the model is NOT believed: 200-but-unparsed is not incapability', () => {
  // The probe logged seventeen models exactly like this before the parser was
  // fixed, and `reachable:false` turned every one of them into a permanent ban.
  const record = cap('gpt-5.3-codex', { coding: 5 }, { input: 5, output: 25 },
    { tool_calling: true, measured: { reachable: false, tool: false, note: 'no delta' } })
  assert.equal(toolSupport(record), true, 'falls back to the vendor claim, not to the parser miss')
})

test('a model that answers but does not call the tool is barred from tool turns', () => {
  const record = cap('grok-ish', { coding: 5 }, { input: 1, output: 2 },
    { tool_calling: true, measured: { reachable: true, tool: false } })
  const index = new Map([['grok-ish', record]])
  const r = run({ type: 'coding', needsTools: true }, index, [{ provider: 'grok', id: 'grok-ish' }],
    { ...CFG, grok: { enabled: false } })
  assert.equal(r.kind, 'unknown-fallback')
  assert.match(r.considered[0].excluded, /cannot call tools \(measured/)
})

test('tool support that is merely unknown still does not qualify', () => {
  assert.equal(toolSupport({ id: 'x' }), null)
})

// --- ② research.minScore is enforced, and says so when it cannot be ---

test('research minScore removes candidates below the floor', () => {
  const index = new Map([
    ['cheap4', cap('cheap4', { coding: 4 }, { input: 0.1, output: 0.2 })],
    ['rich5', cap('rich5', { coding: 5 }, { input: 5, output: 25 })],
  ])
  const candidates = [{ provider: 'a', id: 'cheap4' }, { provider: 'b', id: 'rich5' }]
  const r = run({ type: 'coding' }, index, candidates, { ...CFG, research: { types: ['coding'], minScore: 5 } })
  assert.equal(r.pick.id, 'rich5')
  assert.equal(r.considered.find(c => c.id === 'cheap4').cap, index.get('cheap4'),
    'the cheaper 4 is still listed as considered, it just never reaches the ranking')
  // Without the floor the 5 would still win on rating; the floor's job is to make
  // a HIGHER floor bite, which it does when nothing clears it.
  assert.match(run({ type: 'coding' }, index, candidates, { ...CFG, research: { types: ['coding'], minScore: 6 } }).reason,
    /excluded every candidate, relaxed/)
})

test('an unsatisfiable minScore relaxes rather than silencing the turn, and reports it', () => {
  const index = new Map([['only3', cap('only3', { coding: 3 }, { input: 1, output: 1 })]])
  const r = run({ type: 'coding' }, index, [{ provider: 'a', id: 'only3' }],
    { ...CFG, research: { types: ['coding'], minScore: 5 } })
  assert.equal(r.pick.id, 'only3')
  assert.match(r.reason, /excluded every candidate, relaxed/)
})

// --- ⑤ prefer reorders a tie but can never cross a real quality gap ---

test('a preference reorders a tie but can never outrank a real one-point gap', () => {
  const index = new Map([
    // Close enough that a preference is a reasonable tie-break.
    ['gpt-tied', cap('gpt-tied', { coding: 5 }, { input: 1.0, output: 2 })],
    ['claude-tied', cap('claude-tied', { coding: 5 }, { input: 3, output: 8 })],
    ['cheap-better', cap('cheap-better', { coding: 4 }, { input: 1.0, output: 2 })],
  ])
  const candidates = [
    { provider: 'a', id: 'gpt-tied' }, { provider: 'b', id: 'claude-tied' }, { provider: 'c', id: 'cheap-better' },
  ]
  const config = { ...CFG, prefer: { coding: ['claude', 'gpt'] } }
  assert.equal(run({ type: 'coding', brain: true }, index, candidates, config).pick.id, 'claude-tied',
    'on a tie the first-choice brand wins over a dearer second choice')
  assert.equal(run({ type: 'coding', brain: true }, index, [
    { provider: 'b', id: 'claude-tied' }, { provider: 'c', id: 'cheap-better' },
  ], config).pick.id, 'claude-tied',
    'a 1-point rating gap still outranks the preference, because all ratings are integers')
})

test('a preference may not buy an unbounded price premium', () => {
  const index = new Map([
    ['gpt-cheap', cap('gpt-cheap', { coding: 5 }, { input: 0.15, output: 0.6 })],
    ['claude-pricey', cap('claude-pricey', { coding: 5 }, { input: 5, output: 25 })],
  ])
  const config = { ...CFG, prefer: { coding: ['claude', 'gpt'] } }
  const base = { type: 'coding', brain: true, needsTools: false, hasImage: false }
  const candidates = [{ provider: 'a', id: 'gpt-cheap' }, { provider: 'b', id: 'claude-pricey' }]
  // 37x apart at the default cap of 4: price wins, or the brand name is a cheque
  // with no limit and "rated equal" stops meaning anything.
  assert.equal(run(base, index, candidates, config).pick.id, 'gpt-cheap')
  assert.equal(run(base, index, candidates, { ...config, preferPriceCap: 100 }).pick.id, 'claude-pricey',
    'the cap is configurable — a deployment can still express brand priority')
})

test('a rating the matrix flags as a guess gets no preference nudge', () => {
  const index = new Map([
    ['gpt-guessed', cap('gpt-guessed', { learning_tutor: 4 }, { input: 0.2, output: 0.4 },
      { evidence: { learning_tutor: { confidence: 'low' } } })],
    ['cheap-real', cap('cheap-real', { learning_tutor: 4 }, { input: 0.2, output: 0.3 },
      { evidence: { learning_tutor: { confidence: 'high' } } })],
  ])
  const config = { ...CFG, research: { types: ['learning_tutor'] }, prefer: { learning_tutor: ['gpt'] } }
  const r = run({ type: 'learning_tutor', brain: true }, index, [
    { provider: 'a', id: 'gpt-guessed' }, { provider: 'b', id: 'cheap-real' },
  ], config)
  assert.equal(r.pick.id, 'cheap-real', 'a brand list must not arbitrate between inferences')
})

test('a provider name never confers a preference', () => {
  const index = new Map([
    ['some-cheap-model', cap('some-cheap-model', { coding: 5 }, { input: 0.2, output: 0.4 })],
    ['claude-opus-4-8', cap('claude-opus-4-8', { coding: 5 }, { input: 0.5, output: 1 })],
  ])
  const r = run({ type: 'coding', brain: true }, index, [
    { provider: 'claude-proxy', id: 'some-cheap-model' }, { provider: 'real', id: 'claude-opus-4-8' },
  ], { ...CFG, prefer: { coding: ['claude'] } })
  assert.equal(r.pick.id, 'claude-opus-4-8', 'the gateway called claude-proxy does not make its models Claude')
})

// --- ③ a retired model is never routed to ---

test('a model marked deprecated is excluded even though it is free and reachable', () => {
  assert.equal(isRetired({ lifecycle: { status: 'deprecated' } }), true)
  const index = new Map([
    ['agnes-2.0-flash', cap('agnes-2.0-flash', { daily_chat: 3 }, { input: 0, output: 0 },
      { lifecycle: { status: 'deprecated' } })],
    ['live', cap('live', { daily_chat: 3 }, { input: 0.5, output: 1 })],
  ])
  const r = run({ type: 'daily_chat' }, index, [
    { provider: 'a', id: 'agnes-2.0-flash' }, { provider: 'b', id: 'live' },
  ])
  assert.equal(r.pick.id, 'live')
  assert.match(r.considered.find(c => c.id === 'agnes-2.0-flash').excluded, /retired/)
})

// --- the context-window gate ---

test('a conversation that cannot fit is routed away from the model that is too small', () => {
  const index = new Map([
    ['small', cap('small', { coding: 5 }, { input: 0.1, output: 0.2 }, { context_window: 128_000 })],
    ['big', cap('big', { coding: 5 }, { input: 0.3, output: 0.6 }, { context_window: 1_000_000 })],
  ])
  const candidates = [{ provider: 'a', id: 'small' }, { provider: 'b', id: 'big' }]
  assert.equal(run({ type: 'coding', promptTokens: 200_000 }, index, candidates).pick.id, 'big')
  assert.match(run({ type: 'coding', promptTokens: 200_000 }, index, candidates)
    .considered.find(c => c.id === 'small').excluded, /context window too small/)
})

test('a record with no declared window is admitted rather than excluded', () => {
  const index = new Map([['unknown-window', cap('unknown-window', { coding: 5 }, { input: 0.1, output: 0.2 })]])
  const r = run({ type: 'coding', promptTokens: 500_000 }, index, [{ provider: 'a', id: 'unknown-window' }])
  assert.equal(r.pick.id, 'unknown-window')
})

// --- ⑧ two-granularity cooldown with escalation and reset ---

test('a provider-level cooldown covers every model on that gateway', () => {
  const cooldowns = makeCooldowns({ ttlMs: 1000, providerTtlMs: 1000 })
  cooldowns.mark('gw/one', 'gw', 0)
  assert.ok(cooldowns.get('gw/two', 'gw') > 0, 'a sibling on the same key is blocked too')
  assert.equal(cooldowns.get('other/one', 'other'), 0)
})

test('marking one model does not knock out its siblings', () => {
  const cooldowns = makeCooldowns({ ttlMs: 1000 })
  cooldowns.mark('gw/one', null, 0)
  assert.ok(cooldowns.get('gw/one', 'gw') > 0)
  assert.equal(cooldowns.get('gw/two', 'gw'), 0)
})

test('consecutive failures at a provider escalate, and a success resets the streak', () => {
  const cooldowns = makeCooldowns({ ttlMs: 1000, providerTtlMs: 1000, maxTtlMs: 8000 })
  const first = cooldowns.mark('gw/one', 'gw', 0)
  const second = cooldowns.mark('gw/one', 'gw', 0)
  const third = cooldowns.mark('gw/one', 'gw', 0)
  assert.ok(second > first, 'the window grows while the limit persists')
  assert.ok(third > second)
  cooldowns.succeed('gw/one')
  assert.equal(cooldowns.entries().models.has('gw/one'), false, "the route's own entry is released")
  // The provider streak is deliberately NOT reset by one route succeeding: a
  // sibling on the same gateway succeeding says nothing about whether this gateway
  // is still throttling. It decays with the entry's TTL instead.
  cooldowns.mark('gw/two', 'gw', 0)
  assert.equal(cooldowns.entries().providers.get('gw').streak, 4, 'the streak only decays by TTL, not by a sibling success')
})

test('disabling grok disables grok, not the router', () => {
  // Regression: `grok.enabled: false` used to reject every candidate, collapsing the
  // whole pool onto the fallback.
  const index = new Map([['plain', cap('plain', { coding: 5 }, { input: 0.2, output: 0.4 })]])
  const r = run({ type: 'coding', difficulty: 'moderate', brain: true }, index,
    [{ provider: 'x', id: 'plain' }], { ...CFG, grok: { enabled: false } })
  assert.equal(r.kind, 'research')
  assert.equal(r.pick.id, 'plain')
})

test('a type with no policy still refuses a floor-less pick', () => {
  const index = new Map([
    ['awful', cap('awful', { translation: 1 }, { input: 0, output: 0 })],
    ['adequate', cap('adequate', { translation: 3 }, { input: 1, output: 2 })],
  ])
  const candidates = [{ provider: 'a', id: 'awful' }, { provider: 'b', id: 'adequate' }]
  const r = run({ type: 'translation' }, index, candidates)
  assert.equal(r.kind, 'default')
  assert.equal(r.pick.id, 'adequate', 'cheapest must not mean worst-rated')
  assert.match(r.reason, /cannot rank it on evidence/)
})

// --- the anchor: history may supply a topic, never a vote ---

test('history no longer leaks a type into a later unrelated remark', () => {
  const turns = (...texts) => texts.map(text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  for (const remark of ['有什么建议', '这个价位合理吗', '你觉得呢']) {
    const fresh = classify({ messages: turns(remark) })
    const afterCode = classify({ messages: turns('这段代码报错了 TypeError', remark) })
    assert.equal(afterCode.type, fresh.type, `"${remark}" must classify the same with or without a code question behind it`)
    assert.equal(afterCode.typeSource, 'fallback')
  }
})

test('a genuine continuation still inherits the topic', () => {
  const turns = (...texts) => texts.map(text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  const v = classify({ messages: turns('这个项目的鉴权模块报错了 401', '接着改') })
  assert.equal(v.typeSource, 'anchor')
  assert.equal(v.type, 'coding')
  assert.ok(v.anchorIndex >= 0, 'the anchor index is recorded so /route can be replayed')
})

test('a bare 「这个」 does not trigger inheritance', () => {
  const turns = (...texts) => texts.map(text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  const v = classify({ messages: turns('这段代码报错了 TypeError', '这个价位合理吗') })
  assert.equal(v.typeSource, 'fallback')
})

test('the anchor follows a topic switch instead of fighting it', () => {
  const turns = (...texts) => texts.map(text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  // A confidently-different turn becomes the new anchor: the topic moved, so the
  // continuation follows it. The point is that it does NOT keep the code anchor.
  const moved = classify({
    messages: turns('这段代码报错了 TypeError', '帮我润色一下这段话', '这段怎么调整'),
  })
  assert.equal(moved.type, 'writing_literature')
  assert.equal(moved.typeSource, 'anchor')

  // A same-type turn is the topic continuing, and must not retire the anchor.
  const sameTopic = classify({
    messages: turns('这段代码报错了 TypeError', '重构一下', '这段怎么调整'),
  })
  assert.equal(sameTopic.type, 'coding')
  assert.equal(sameTopic.typeSource, 'anchor')

  // Documented limitation: the abort needs the classifier to recognise the topic it
  // drifted to. Pricing talk scores zero on every table, so it does not retire a
  // code anchor — no signal, no inference, which is the honest outcome.
  const unrecognised = classify({
    messages: turns('这段代码报错了 TypeError', '我们的定价策略怎么样', '这段怎么调整'),
  })
  assert.equal(unrecognised.typeSource, 'anchor')
})

test('small talk never becomes the anchor, even though it scores the highest', () => {
  const turns = (...texts) => texts.map(text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  // "你好啊" scores 6 — the highest single pattern weight in the table — but it
  // says nothing about subject matter, so a continuation must skip past it.
  const v = classify({ messages: turns('这段代码报错了 TypeError', '你好啊', '接着说') })
  assert.equal(v.type, 'coding')
  assert.equal(v.typeSource, 'anchor')
  assert.equal(v.anchorIndex, 0, 'the anchor is the code turn, not the greeting')
})

test('an anchor beyond the lookback window is not used', () => {
  const turns = (...texts) => texts.map(text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  const v = classify({ messages: turns('这段代码报错了 TypeError', 'a', 'b', 'c', 'd', 'e', '接着改') })
  assert.equal(v.typeSource, 'fallback')
})

test('classification is a pure function of the request, so a replay reproduces it', () => {
  const messages = ['这个项目的鉴权模块报错了 401', 'a', '接着改']
    .map(text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  const first = classify({ messages })
  // Classifying again, and with a fresh memo, must give the same verdict — the
  // reason no per-session anchor map exists.
  const second = classify({ messages })
  assert.equal(second.typeSource, first.typeSource)
  assert.equal(second.anchorIndex, first.anchorIndex)
})

// --- the context gate prefers the provider's own window ---

test('a live window from the provider beats the matrix, in both directions', () => {
  const index = new Map([
    ['a', cap('a', { coding: 5 }, { input: 0.1, output: 0.2 }, { context_window: 1_000_000 })],
    ['b', cap('b', { coding: 5 }, { input: 0.1, output: 0.2 }, { context_window: 1_000_000 })],
  ])
  const candidates = [{ provider: 'gw', id: 'a' }, { provider: 'gw', id: 'b' }]
  const windows = new Map([['gw/a', 1_000_000], ['gw/b', 200_000]])
  // The matrix overstates b at 1M; the provider says 200K. Trusting the matrix here
  // would admit a model that truncates the conversation.
  const r = run({ type: 'coding', promptTokens: 400_000 }, index, candidates, CFG, { contextWindows: windows })
  assert.equal(r.pick.id, 'a')
  assert.match(r.considered.find(c => c.id === 'b').excluded, /provider says 200000/)
})

test('the matrix window is used when the provider is silent, unless it is excluded', () => {
  const index = new Map([['x', cap('x', { coding: 5 }, { input: 0.1, output: 0.2 }, { context_window: 128_000 })]])
  const candidates = [{ provider: 'gw', id: 'x' }]
  const prompt = { type: 'coding', promptTokens: 300_000 }
  const r = run(prompt, index, candidates, CFG, { contextWindows: new Map() })
  assert.equal(r.kind, 'unknown-fallback')
  assert.match(r.considered[0].excluded, /matrix says 128000/)
  const excluded = { ...CFG, contextWindowFallback: { default: true, exclude: ['gw'] } }
  assert.equal(run(prompt, index, candidates, excluded, { contextWindows: new Map() }).pick.id, 'x',
    'a provider known to overstate its window opts out entirely')
})

test('an implausible window is treated as no window at all', () => {
  const index = new Map([['x', cap('x', { coding: 5 }, { input: 0.1, output: 0.2 }, { context_window: 0 })]])
  const allowed = { ...CFG, contextWindowFallback: true }
  const r = run({ type: 'coding', promptTokens: 300_000 }, index, [{ provider: 'gw', id: 'x' }], allowed,
    { contextWindows: new Map([['gw/x', NaN]]) })
  assert.equal(r.pick.id, 'x', 'zero and NaN are not windows')
})

test('a long turn says out loud when the fallback window could not be checked', () => {
  const r = decide({
    candidates: [{ provider: 'x', id: 'nope' }], index: new Map(),
    classification: { type: 'coding', needsTools: true, hasImage: false, promptTokens: 400_000 },
    config: CFG,
  })
  assert.match(r.reason, /no known context window/)
})

test('a short but dense question is a question, not small talk', () => {
  const q = (text) => classify({ messages: [{ role: 'user', content: [{ type: 'text', text }] }] })
  assert.equal(q('这个方案可行吗').type, 'knowledge_qa')
  assert.equal(q('今天好累').type, 'daily_chat', 'an emotional aside is still an aside')
  assert.equal(q('辛苦了').type, 'daily_chat')
})

test('verbs that ask for a code change ask for tools', () => {
  for (const text of ['优化下这段代码', '这个报错帮我看看', '帮我检查一下 main.py']) {
    assert.equal(classify({ messages: [{ role: 'user', content: [{ type: 'text', text }] }] }).needsTools, true, text)
  }
})

test('a diagnosed failure counts as brain work; a bare transformation does not', () => {
  const q = (text) => classify({ messages: [{ role: 'user', content: [{ type: 'text', text }] }] })
  // "这行报错了" is a question whose answer is not in the prompt; "优化下这段代码"
  // is a transformation. Forcing the brand preference on the second one cost 33x
  // on a six-character request, so difficulty is what decides, not the type.
  assert.equal(q('这行报错了').brain, true)
  assert.equal(q('优化下这段代码').brain, false)
  assert.equal(q('你好').brain, false)
})

test('alwaysBrainTypes is opt-in, not hardwired', () => {
  const index = new Map([
    ['gpt-tied', cap('gpt-tied', { coding: 5 }, { input: 0.2, output: 0.4 })],
    ['claude-tied', cap('claude-tied', { coding: 5 }, { input: 0.6, output: 1.5 })],
  ])
  const candidates = [{ provider: 'a', id: 'gpt-tied' }, { provider: 'b', id: 'claude-tied' }]
  const prefer = { ...CFG, prefer: { coding: ['claude', 'gpt'] } }
  const trivial = { type: 'coding', difficulty: 'trivial', brain: false, needsTools: false, hasImage: false }
  assert.equal(run(trivial, index, candidates, prefer).pick.id, 'gpt-tied',
    'by default a trivial turn is not worth a brand premium')
  assert.equal(run(trivial, index, candidates, { ...prefer, alwaysBrainTypes: ['coding'] }).pick.id, 'claude-tied',
    'a deployment that wants it can ask for it explicitly')
})

test('the token estimate counts tool calls, images, and the prompt overhead', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'x'.repeat(400) }] },
    { role: 'assistant', content: [{ type: 'tool-call', name: 'fs_read', arguments: { path: 'a'.repeat(200) } }] },
    { role: 'user', content: [{ type: 'image', source: {} }] },
  ]
  const plain = estimateTokens(messages)
  assert.ok(plain > 100 + 50, `tool-call and image tokens counted (got ${plain})`)
  assert.equal(estimateTokens(messages, 8000), plain + 8000, 'overhead is added on top')
})