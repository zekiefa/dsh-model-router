// Second pass: for every model the first pass could NOT confirm as chat-capable,
// capture the RAW response body. The gateway answers 200 with a plain JSON error
// body for unroutable models, which an SSE-only parser silently reports as "no delta".
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const HOME = process.env.USERPROFILE.replace(/\\/g, '/')
const yaml = (await import(pathToFileURL(`${HOME}/.dsh/profiles/node_modules/js-yaml/index.js`).href)).default
const creds = yaml.load(readFileSync(`${HOME}/.dsh/.credentials.yaml`, 'utf8')).refs

// Same `gateways.local.json` contract as probe-catalog.mjs — see that file.
// A UTF-8 BOM is stripped: this file is meant to be hand-written, and Windows
// editors add one by default, which JSON.parse rejects outright.
const readJson = p => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''))

function readGateways() {
  let list
  try {
    list = readJson('gateways.local.json')
  } catch {
    console.error('[abort] gateways.local.json is missing or is not valid JSON.')
    console.error('[abort] copy gateways.local.json.example and list the endpoints you want probed.')
    process.exit(1)
  }
  return list
}

const GATEWAYS = Object.fromEntries(
  readGateways().map(g => [g.route, { base: g.base, key: creds[g.keyEnv] }]),
)

const first = JSON.parse(readFileSync('_probe_results.json', 'utf8'))
const targets = first.filter(r => r.chat !== true && r.status !== 'SKIP')
console.log(`[second pass] ${targets.length} unconfirmed models\n`)

const out = []
for (const t of targets) {
  const g = GATEWAYS[t.route]
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 45000)
  let raw = '', status = null
  const t0 = Date.now()
  try {
    const r = await fetch(`${g.base}/chat/completions`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${g.key}` },
      body: JSON.stringify({ model: t.id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
    })
    status = r.status
    raw = (await r.text()).slice(0, 260).replace(/\s+/g, ' ')
  } catch (e) {
    status = 'ERR'; raw = `${e.name}: ${e.message}`
  } finally { clearTimeout(timer) }

  let verdict = 'unknown'
  try {
    const j = JSON.parse(raw)
    const msg = j?.error?.message ?? j?.message ?? ''
    if (/No available channel/i.test(msg)) verdict = 'NO_CHANNEL (缺渠道)'
    else if (/不可用/.test(msg)) verdict = 'MODEL_UNAVAILABLE (网关无此模型)'
    else if (/model_not_found/i.test(msg)) verdict = 'MODEL_NOT_FOUND'
    else if (msg) verdict = 'ERROR: ' + msg.slice(0, 60)
  } catch { if (raw.length === 0) verdict = 'EMPTY_BODY' }

  out.push({ route: t.route, id: t.id, status, verdict, raw })
  console.log(`  ${String(status).padEnd(4)} ${String(Date.now() - t0).padStart(6)}ms  ${t.id.padEnd(30)} ${verdict}\n         raw: ${raw.slice(0, 150)}`)
}

writeFileSync('_probe_raw.json', JSON.stringify(out, null, 2))
const usable = out.filter(o => o.verdict === 'unknown')
console.log(`\n[verdict] 真正能用但首轮漏判的: ${usable.length ? usable.map(u => u.id).join(', ') : '(无)'}`)
console.log(`[verdict] 网关有列表但实际不可用: ${out.length - usable.length} 个`)
