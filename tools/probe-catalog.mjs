// Phase 0 live probe: for every model the user's gateways advertise, measure what
// actually matters for routing — reachability, tool calling, streaming, latency.
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const HOME = process.env.USERPROFILE.replace(/\\/g, '/')
const yaml = (await import(pathToFileURL(`${HOME}/.dsh/profiles/node_modules/js-yaml/index.js`).href)).default
const creds = yaml.load(readFileSync(`${HOME}/.dsh/.credentials.yaml`, 'utf8')).refs

// Which gateways to probe is deployment-specific, so it is configuration rather
// than source. List them in `gateways.local.json` (git-ignored), as
//   [{ "route": "my-gateway", "base": "https://example.com/v1", "keyEnv": "MY_API_KEY" }]
// `keyEnv` names a credential from ~/.dsh/.credentials.yaml, so no secret is ever
// written to disk here.
// A UTF-8 BOM is stripped: this file is meant to be hand-written, and Windows
// editors add one by default, which JSON.parse rejects outright.
const readJson = p => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''))

function readGateways() {
  let list
  try {
    list = readJson('gateways.local.json')
  } catch {
    console.error('[abort] gateways.local.json is missing or is not valid JSON.')
    console.error('[abort] copy gateways.local.json.example, then list the endpoints you want probed:')
    console.error('[abort]   [{ "route": "my-gateway", "base": "https://api.example.com/v1", "keyEnv": "MY_GATEWAY_API_KEY" }]')
    process.exit(1)
  }
  return list
}

const GATEWAYS = readGateways().map(g => ({
  ...g,
  key: creds[g.keyEnv],
}))

if (GATEWAYS.some(g => !g.key)) {
  const missing = GATEWAYS.filter(g => !g.key).map(g => `${g.route} (${g.keyEnv})`)
  console.error(`[abort] no credential for: ${missing.join(', ')}`)
  console.error('[abort] check the `keyEnv` names in gateways.local.json against ~/.dsh/.credentials.yaml')
  process.exit(1)
}

const TOOLS = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
}]

const MEDIA = /image|video|tts|whisper|embed/i

async function listModels(g) {
  const r = await fetch(`${g.base}/models`, { headers: { authorization: `Bearer ${g.key}` } })
  const j = await r.json()
  return (j.data ?? []).map(x => x.id)
}

/**
 * Read a streamed chat completion into the facts routing cares about.
 *
 * The previous version set `chat = sawDelta` where `sawDelta` meant only "a chunk
 * carried `choices[0].delta`". Seventeen models that answered HTTP 200 were filed
 * as dead with the note "no delta" — gpt-4o, gpt-5.3-codex, gemini-3.x,
 * claude-sonnet-4-6 among them — because the response shape did not match that one
 * expectation. `reachable: false` then excluded them from routing permanently, so a
 * parser assumption was silently promoted to a fact about the model.
 *
 * Two changes, and they are the same change in principle: record evidence, and let
 * "I did not understand this" be distinguishable from "this model did not answer".
 * Assistant content is now detected wherever the gateway puts it — `content`,
 * `reasoning_content`, `reasoning`, or a non-streamed `message` — and anything still
 * unreadable is recorded as `null` (unknown) with the raw evidence attached, never
 * as `false`.
 */
async function readStream(r, out) {
  let buf = ''
  const names = new Set()
  let errBody = ''
  let events = 0
  let sawContent = false
  let finishReason = null
  let tail = ''

  const inspect = (ev) => {
    events += 1
    if (ev.error) errBody = JSON.stringify(ev.error).slice(0, 120)
    const choice = ev.choices?.[0]
    if (choice?.finish_reason) finishReason = choice.finish_reason
    const delta = choice?.delta ?? choice?.message ?? {}
    if (delta.content || delta.reasoning_content || delta.reasoning || delta.tool_calls) sawContent = true
    for (const tc of delta.tool_calls ?? []) if (tc.function?.name) names.add(tc.function.name)
  }

  for await (const chunk of r.body) {
    if (out.ttftMs === null) out.ttftMs = Date.now() - out._t0
    buf += Buffer.from(chunk).toString('utf8')
    tail = (tail + buf).slice(-600)
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const p = line.slice(5).trim()
      if (p === '[DONE]' || !p) continue
      try { inspect(JSON.parse(p)) } catch {}
    }
  }
  // A gateway that ignores `stream: true` answers with one JSON object and no
  // `data:` prefixes at all. That is a shape difference, not a dead model.
  if (!events && buf.trim()) {
    try { inspect(JSON.parse(buf.trim())) } catch { /* genuinely unparseable */ }
  }
  return { names, errBody, events, sawContent, finishReason, tail }
}

async function probe(g, id) {
  const out = { route: g.route, id, status: null, chat: null, tool: null, ttftMs: null, totalMs: null, note: '' }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 75000)
  out._t0 = Date.now()
  const body = {
    model: id,
    messages: [{ role: 'user', content: 'What is the weather in Paris? Use the get_weather tool.' }],
    stream: true,
    stream_options: { include_usage: true },
    tools: TOOLS,
    max_tokens: 256,
  }
  let r
  try {
    r = await fetch(`${g.base}/chat/completions`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${g.key}` },
      body: JSON.stringify(body),
    })
    out.status = r.status
    if (!r.ok) {
      out.note = (await r.text()).slice(0, 120).replace(/\s+/g, ' ')
      return out
    }
    const seen = await readStream(r, out)
    // A tool call only counts when we actually parsed a response; anything else is
    // unknown, and unknown must not be written down as a capability.
    out.tool = seen.events > 0 ? seen.names.has('get_weather') : null
    if (seen.errBody) { out.chat = false; out.note = `200 但错误体: ${seen.errBody}` }
    else if (seen.sawContent) { out.chat = true; out.note = `ok (${seen.events} events, finish=${seen.finishReason ?? '-'}, tool=${out.tool})` }
    else { out.chat = null; out.note = `UNPARSED 200 (${seen.events} events, finish=${seen.finishReason ?? '-'}) raw=${seen.tail.replace(/\s+/g, ' ').slice(-160)}` }
  } catch (e) {
    out.status = out.status ?? 'ERR'
    out.note = `${e.name}: ${e.message}`.slice(0, 120)
  } finally {
    clearTimeout(timer)
    out.totalMs = Date.now() - out._t0
    delete out._t0
  }
  return out
}

const results = []
for (const g of GATEWAYS) {
  const ids = await listModels(g)
  console.log(`\n=== ${g.route} (${ids.length} models) ===`)
  for (const id of ids) {
    if (MEDIA.test(id)) {
      results.push({ route: g.route, id, status: 'SKIP', chat: false, tool: null, note: 'media model, not chat' })
      console.log(`  SKIP ${id.padEnd(30)} media model`)
      continue
    }
    const r = await probe(g, id)
    results.push(r)
    console.log(`  ${String(r.status).padEnd(4)} chat=${String(r.chat).padEnd(5)} tool=${String(r.tool).padEnd(5)} ttft=${String(r.ttftMs).padEnd(6)}ms ${id.padEnd(30)} ${r.note}`)
  }
}

writeFileSync('_probe_results.json', JSON.stringify(results, null, 2))
console.log('\n[written] _probe_results.json')
console.log(`[summary] chat-capable: ${results.filter(r => r.chat).length} / ${results.filter(r => r.status !== 'SKIP').length} probed`)
console.log(`[summary] tool-capable: ${results.filter(r => r.tool).length}`)
