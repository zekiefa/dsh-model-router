// Health-check the models the user actually has configured, through each route's
// real baseURL + credential. This is the same check the router will need.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const HOME = process.env.USERPROFILE.replace(/\\/g, '/')
const NM = `${HOME}/.dsh/profiles/node_modules`
const yaml = (await import(pathToFileURL(`${NM}/js-yaml/index.js`).href)).default
const refs = yaml.load(readFileSync(`${HOME}/.dsh/.credentials.yaml`, 'utf8')).refs
const patch = yaml.load(readFileSync(`${HOME}/.dsh/profiles/desktop/cordis.patch.yml`, 'utf8'))
const providers = patch.find(e => e.id === 'llm-pi-ai').config.providers

const TOOLS = [{
  type: 'function',
  function: { name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
}]

const rows = []
for (const [route, p] of Object.entries(providers)) {
  const key = refs[p.apiKeyEnv]
  if (!key) { console.log(`${route}: 缺少凭据 ${p.apiKeyEnv}`); continue }
  for (const m of p.models) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 75000)
    const t0 = Date.now()
    let status = null, tool = null, note = ''
    try {
      const r = await fetch(`${p.baseURL}/chat/completions`, {
        method: 'POST', signal: ac.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: m.id,
          messages: [{ role: 'user', content: 'Weather in Paris? Use get_weather.' }],
          stream: true, tools: TOOLS, max_tokens: 256,
        }),
      })
      status = r.status
      let buf = '', sawDelta = false, err = null
      const names = new Set()
      const raw = await r.text()
      if (!r.ok) { note = raw.slice(0, 110).replace(/\s+/g, ' ') }
      else {
        // A gateway may answer 200 with a plain JSON error body instead of SSE.
        try { const j = JSON.parse(raw); if (j.error) err = j.error.message ?? JSON.stringify(j.error) } catch {}
        if (err) note = String(err).slice(0, 110)
        else {
          for (const line of raw.split('\n')) {
            const s = line.trim()
            if (!s.startsWith('data:')) continue
            const pl = s.slice(5).trim()
            if (!pl || pl === '[DONE]') continue
            try {
              const ev = JSON.parse(pl)
              if (ev.choices?.[0]?.delta) sawDelta = true
              for (const tc of ev.choices?.[0]?.delta?.tool_calls ?? []) if (tc.function?.name) names.add(tc.function.name)
            } catch {}
          }
          tool = names.has('get_weather')
          note = sawDelta ? 'ok' : 'no delta'
        }
      }
    } catch (e) { status = 'ERR'; note = `${e.name}: ${e.message}`.slice(0, 110) }
    finally { clearTimeout(timer) }
    const ok = status === 200 && note === 'ok'
    rows.push({ route, id: m.id, status, tool, ms: Date.now() - t0, ok, note })
    console.log(`  ${ok ? 'OK  ' : 'BAD '} ${String(status).padEnd(4)} tool=${String(tool).padEnd(5)} ${String(Date.now() - t0).padStart(6)}ms  ${route.padEnd(9)} / ${m.id.padEnd(20)} ${note}`)
  }
}

const bad = rows.filter(r => !r.ok)
console.log(`\n[health] 配置中可用: ${rows.length - bad.length}/${rows.length}`)
if (bad.length) console.log(`[health] 有问题: ${bad.map(b => `${b.route}/${b.id} (${b.status} ${b.note})`).join('; ')}`)
