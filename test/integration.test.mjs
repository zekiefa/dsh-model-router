// Integration test: mount the REAL plugin into a REAL cordis context and a REAL
// LlmRuntime, then assert it reroutes actual requests. Bare specifiers are loaded
// by absolute URL because this package sits outside the profile's node_modules.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { apply, resolveConfig } from '../index.js'

const HOME = process.env.USERPROFILE.replace(/\\/g, '/')
const NM = `${HOME}/.dsh/profiles/node_modules`
const { Context } = await import(pathToFileURL(`${NM}/@deepseek-ai/cordis/lib/index.js`).href)
const { LlmRuntime, LlmAdapter, createUserMessage } = await import(pathToFileURL(`${NM}/@deepseek-ai/dsh-llm/lib/index.js`).href)

/** Adapter that records what it is asked to serve. */
const served = []
const servedEffort = []
class Recorder extends LlmAdapter {
  providerInfo(p) { return { id: p, name: p } }
  async listModels(p) {
    return {
      custom: [{ provider: p, id: 'agnes-3.0-flash', name: 'agnes-3.0-flash' }],
      open: [{ provider: p, id: 'gpt-6.1-sol', name: 'gpt-6.1-sol' }, { provider: p, id: 'gpt-6-luna', name: 'gpt-6-luna' }],
      grok: [{ provider: p, id: 'grok-420-thinking', name: 'grok-420-thinking' }],
    }[p] ?? []
  }
  async resolveModel(p, m) { return { provider: p, id: m, name: m, context: { contextWindow: 1000000 } } }
  async *stream(options) {
    served.push(`${options.provider}/${options.model}`)
    servedEffort.push(options.reasoningEffort ?? null)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const CONFIG = {
  enabled: true,
  dryRun: false,
  fallback: { provider: 'deepseek-account', model: 'deepseek-flash' },
  research: { types: ['learning_tutor', 'coding', 'math_reasoning', 'knowledge_qa', 'agentic_tools'] },
  casual: { types: ['daily_chat'], minScore: 3, preferFree: true },
  balanced: { types: ['writing_literature', 'translation', 'long_context'], maxScoreDrop: 1 },
  grok: { enabled: true, allowedTypes: ['daily_chat'] },
  chitchatMaxTokens: 700,
  respectModalities: true,
}

async function boot() {
  const ctx = new Context()
  try { await ctx.plugin(LlmRuntime) } catch { /* mounted below */ }
  const runtime = ctx.get('llm') ?? new LlmRuntime(ctx)
  runtime.registerAdapter(['custom', 'open', 'grok'], new Recorder())
  // A logger stub: cordis provides one, but keep the test's output clean.
  apply(ctx, CONFIG)
  return { ctx, runtime }
}

const text = t => [{ role: 'user', content: [{ type: 'text', text: t }] }]
// Contract-correct tool cycle: the harness reads `source.kind` off any message
// carrying tool blocks, so every message must declare its source.
const toolCycle = t => [
  { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: t }] },
  {
    id: 'm2', role: 'assistant', source: { kind: 'model', provider: 'custom', model: 'agnes-3.0-flash' },
    content: [{ type: 'tool-call', id: 'c1', name: 'fs_read', arguments: '{}' }],
  },
  {
    id: 'm3', role: 'user', source: { kind: 'tool', callId: 'c1' },
    content: [{ type: 'tool-result', callId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false }],
  },
]
async function drain(stream) { for await (const _ of stream) { /* consume */ } }

test('a coding question is routed to the strongest coding model, not the free one', async () => {
  const { runtime } = await boot()
  served.length = 0
  await drain(runtime.stream({ provider: 'custom', model: 'agnes-3.0-flash', messages: text('这段 Python 报错怎么修？TypeError: bad operand') }))
  assert.deepEqual(served, ['open/gpt-6.1-sol'])
})

test('small talk stays on the free model rather than being upgraded', async () => {
  const { runtime } = await boot()
  served.length = 0
  await drain(runtime.stream({ provider: 'open', model: 'gpt-6.1-sol', messages: text('你好') }))
  assert.deepEqual(served, ['custom/agnes-3.0-flash'], 'free model should win small talk')
})

test('a turn already inside a tool cycle can never be served by Grok', async () => {
  const { runtime } = await boot()
  served.length = 0
  const messages = toolCycle('继续')
  await drain(runtime.stream({ provider: 'grok', model: 'grok-420-thinking', messages }))
  assert.equal(served.length, 1, `expected exactly one dispatch, got ${JSON.stringify(served)}`)
  assert.ok(!served[0].startsWith('grok/'), `routed to ${served[0]} — must not be grok on a tool turn`)
})

test('the router never recurses: exactly one dispatch per request', async () => {
  const { runtime } = await boot()
  served.length = 0
  await drain(runtime.stream({ provider: 'custom', model: 'agnes-3.0-flash', messages: text('讲一下什么是递归') }))
  assert.equal(served.length, 1)
})

test('dry run changes nothing but still decides', async () => {
  const ctx = new Context()
  try { await ctx.plugin(LlmRuntime) } catch {}
  const runtime = ctx.get('llm') ?? new LlmRuntime(ctx)
  runtime.registerAdapter(['custom', 'open', 'grok'], new Recorder())
  apply(ctx, { ...CONFIG, dryRun: true })
  served.length = 0
  await drain(runtime.stream({ provider: 'custom', model: 'agnes-3.0-flash', messages: text('这段代码有 bug') }))
  assert.deepEqual(served, ['custom/agnes-3.0-flash'], 'dry run must not reroute')
})

test('an auxiliary call keeps the model it was given', async () => {
  const { runtime } = await boot()
  served.length = 0
  await drain(runtime.stream({
    provider: 'custom', model: 'agnes-3.0-flash', purpose: 'session-title',
    messages: text('这段 Python 报错怎么修？TypeError: bad operand'),
  }))
  assert.deepEqual(served, ['custom/agnes-3.0-flash'], 'title/compaction calls must not be rerouted')
})

test('a model pinned by configuration can be exempted from routing', async () => {
  const ctx = new Context()
  try { await ctx.plugin(LlmRuntime) } catch {}
  const runtime = ctx.get('llm') ?? new LlmRuntime(ctx)
  runtime.registerAdapter(['custom', 'open', 'grok'], new Recorder())
  apply(ctx, { ...CONFIG, respectModels: ['custom/agnes-3.0-flash'] })
  served.length = 0
  await drain(runtime.stream({
    provider: 'custom', model: 'agnes-3.0-flash',
    messages: text('这段 Python 报错怎么修？TypeError: bad operand'),
  }))
  assert.deepEqual(served, ['custom/agnes-3.0-flash'], 'a pinned model must survive routing')
})

test('with nothing qualified, the fallback is dispatched and actually reaches an adapter', async () => {
  const ctx = new Context()
  try { await ctx.plugin(LlmRuntime) } catch {}
  const runtime = ctx.get('llm') ?? new LlmRuntime(ctx)
  // One provider with no capability record, plus the configured fallback route.
  class FallbackRecorder extends Recorder {
    async listModels(p) {
      if (p === 'deepseek-account') return [{ provider: p, id: 'deepseek-flash', name: 'deepseek-flash' }]
      if (p === 'mystery') return [{ provider: p, id: 'never-heard-of-it', name: 'never-heard-of-it' }]
      return []
    }
  }
  runtime.registerAdapter(['mystery', 'deepseek-account'], new FallbackRecorder())
  apply(ctx, CONFIG)
  served.length = 0
  await drain(runtime.stream({ provider: 'mystery', model: 'never-heard-of-it', messages: text('这个设计取舍是什么') }))
  assert.deepEqual(served, ['deepseek-account/deepseek-flash'],
    `fallback must dispatch a complete provider/model, got ${JSON.stringify(served)}`)
})

test('a reasoning effort the target does not support is dropped, not forwarded', async () => {
  const ctx = new Context()
  try { await ctx.plugin(LlmRuntime) } catch {}
  const runtime = ctx.get('llm') ?? new LlmRuntime(ctx)
  // This adapter advertises only 'low' effort on every model, so 'high' must be dropped.
  class NoHigh extends Recorder {
    async resolveModel(p, m) {
      return { provider: p, id: m, name: m, context: { contextWindow: 1000000 }, reasoning: { efforts: [{ id: 'low', name: 'low' }] } }
    }
  }
  runtime.registerAdapter(['custom', 'open', 'grok'], new NoHigh())
  apply(ctx, CONFIG)
  served.length = 0
  servedEffort.length = 0
  await drain(runtime.stream({
    provider: 'custom', model: 'agnes-3.0-flash', reasoningEffort: 'high',
    messages: text('这段 Python 报错怎么修？TypeError: bad operand'),
  }))
  assert.deepEqual(served, ['open/gpt-6.1-sol'])
  assert.deepEqual(servedEffort, [null], 'unsupported reasoningEffort must be stripped before dispatch')
})

test('a reasoning effort the target supports is preserved', async () => {
  const ctx = new Context()
  try { await ctx.plugin(LlmRuntime) } catch {}
  const runtime = ctx.get('llm') ?? new LlmRuntime(ctx)
  class SupportsHigh extends Recorder {
    async resolveModel(p, m) {
      return { provider: p, id: m, name: m, context: { contextWindow: 1000000 }, reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }] } }
    }
  }
  runtime.registerAdapter(['custom', 'open', 'grok'], new SupportsHigh())
  apply(ctx, CONFIG)
  served.length = 0
  servedEffort.length = 0
  await drain(runtime.stream({
    provider: 'custom', model: 'agnes-3.0-flash', reasoningEffort: 'high',
    messages: text('这段 Python 报错怎么修？TypeError: bad operand'),
  }))
  assert.deepEqual(served, ['open/gpt-6.1-sol'])
  assert.deepEqual(servedEffort, ['high'], 'a supported reasoningEffort must be forwarded unchanged')
})

test('resolveConfig rejects unusable values at mount time', () => {
  assert.throws(() => resolveConfig({ chitchatMaxTokens: -1 }), /positive integer/)
  assert.throws(() => resolveConfig({ fallback: { provider: 'x' } }), /both provider and model/)
  assert.equal(resolveConfig({}).enabled, true)
  assert.equal(resolveConfig({ enabled: false }).enabled, false)
})
