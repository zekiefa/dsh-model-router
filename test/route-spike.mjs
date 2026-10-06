// Route-A spike: can an `llm/stream` listener replace provider/model and re-dispatch?
// Runs in a throwaway cordis context — the user's DSH profile is never touched.
import { pathToFileURL } from 'node:url'

const HOME = process.env.USERPROFILE.replace(/\\/g, '/')
const NM = `${HOME}/.dsh/profiles/node_modules`
const imp = p => import(pathToFileURL(`${NM}/${p}`).href)

const { Context } = await imp('@deepseek-ai/cordis/lib/index.js')
const llm = await imp('@deepseek-ai/dsh-llm/lib/index.js')
const { LlmRuntime, LlmAdapter, createUserMessage, deepFreeze, markAgentLoopRequest } = llm

const ctx = new Context()
console.log('[diag] typeof ctx.plugin =', typeof ctx.plugin, '| typeof ctx.get =', typeof ctx.get)
try { await ctx.plugin(LlmRuntime) } catch (e) { console.log('[diag] ctx.plugin threw:', e.message) }
let runtime = ctx.get ? ctx.get('llm') : ctx.llm
if (!runtime) {
  try { runtime = new LlmRuntime(ctx) } catch (e) { console.log('[diag] new LlmRuntime threw:', e.message) }
  runtime = (ctx.get ? ctx.get('llm') : ctx.llm) ?? runtime
}
console.log('[diag] runtime =', runtime ? runtime.constructor.name : 'undefined', '| ctx.llm =', typeof ctx.llm, '| ctx.get(llm) =', typeof (ctx.get ? ctx.get('llm') : undefined))
if (!runtime) throw new Error('llm service did not mount')

/** Records every dispatch it is asked to serve. */
const seen = []
class Fake extends LlmAdapter {
  providerInfo(p) { return { id: p, name: p } }
  async listModels() { return [] }
  async resolveModel(p, m) { return { provider: p, id: m, name: m, context: { contextWindow: 1000 } } }
  async *stream(options) {
    seen.push({ provider: options.provider, model: options.model, system: options.system, maxTokens: options.maxTokens })
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
ctx.llm.registerAdapter(['alpha', 'beta', 'gamma'], new Fake())

// ---- the routing listener under test -------------------------------------
const routed = new Set()      // requests this plugin already decided on
const decisions = []
function attach() {
  ctx.on('llm/stream', (options, next) => {
    if (routed.has(options)) return next()          // guard: never re-decide a decision
    if (options.provider !== 'alpha') return next()
    const target = { provider: 'beta', model: 'chosen-by-router' }
    decisions.push({ from: `${options.provider}/${options.model}`, to: `${target.provider}/${target.model}` })
    // Options may be deep-frozen: build a NEW envelope instead of mutating.
    const next2 = { ...options, ...target }
    routed.add(next2)
    return ctx.llm.stream(next2)                     // re-enter; the guard stops recursion
  }, { global: true, prepend: true })
}
attach()

const msg = () => createUserMessage({
  content: [{ type: 'text', text: 'hello' }],
  source: { kind: 'user' },
})

const lastChunks = []
async function drain(stream) {
  lastChunks.length = 0
  for await (const c of stream) {
    lastChunks.push(c)
    if (c.type === 'finish' && c.reason?.kind === 'error') {
      console.log('    [terminal error]', JSON.stringify(c.reason.failure ?? c.reason).slice(0, 300))
    }
  }
  if (lastChunks.length === 0) console.log('    [no chunks at all]')
}

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`) }

console.log('=== spike: llm/stream reroute ===')

// 1) reroute happens
seen.length = 0; decisions.length = 0
await drain(ctx.llm.stream({ provider: 'alpha', model: 'orig', messages: [msg()] }))
check('rerouted alpha -> beta', seen.length === 1 && seen[0].provider === 'beta' && seen[0].model === 'chosen-by-router', JSON.stringify(seen))
check('listener decided exactly once (no recursion)', decisions.length === 1, `decisions=${decisions.length}`)

// 2) a non-matching provider is untouched
seen.length = 0; decisions.length = 0
await drain(ctx.llm.stream({ provider: 'gamma', model: 'g', messages: [msg()] }))
check('unrelated provider passes through', seen.length === 1 && seen[0].provider === 'gamma' && decisions.length === 0)

// 3) deep-frozen loop request, marked as the agent loop built it
seen.length = 0; decisions.length = 0
const loopReq = markAgentLoopRequest(deepFreeze({ provider: 'alpha', model: 'orig', messages: [msg()], system: 'SYS' }))
await drain(ctx.llm.stream(loopReq))
check('frozen loop request reroutes without throwing', seen.length === 1 && seen[0].provider === 'beta', JSON.stringify(seen))
check('original frozen request left unmutated', Object.isFrozen(loopReq) && loopReq.provider === 'alpha' && loopReq.system === 'SYS')

// 4) can we pass extra call-config fields through the new envelope?
// Uses gamma (never rerouted by the first listener) so this tests only the
// call-config rewrite path.
seen.length = 0
const tweakReq = { provider: 'gamma', model: 'g2', messages: [msg()] }
ctx.on('llm/stream', (options, next) => {
  if (options.provider !== 'gamma' || options.maxTokens === 7) return next()
  return ctx.llm.stream({ ...options, maxTokens: 7 })
}, { global: true, prepend: true })
// gamma is not alpha, so the reroute listener leaves it; this one adds maxTokens then re-enters
await drain(ctx.llm.stream(tweakReq))
check('call-config field survives re-dispatch', seen.some(s => s.maxTokens === 7), JSON.stringify(seen))

console.log(`\n${results.every(r => r.ok) ? 'SPIKE PASSED' : 'SPIKE FAILED'} (${results.filter(r => r.ok).length}/${results.length})`)
process.exitCode = results.every(r => r.ok) ? 0 : 1
