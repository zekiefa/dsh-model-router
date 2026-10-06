// Merge both research matrices with the live probe data into one capabilities
// file, then derive the configuration recommendation from measured facts only.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const HOME = process.env.USERPROFILE.replace(/\\/g, '/')
const NM = `${HOME}/.dsh/profiles/node_modules`
const OUT = `${HOME}/.dsh/plugins/dsh-model-router/data`
mkdirSync(OUT, { recursive: true })

const yaml = (await import(pathToFileURL(`${NM}/js-yaml/index.js`).href)).default
const TYPES = ['daily_chat', 'knowledge_qa', 'learning_tutor', 'coding', 'math_reasoning', 'writing_literature', 'translation', 'long_context', 'agentic_tools']

const load = p => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return [] } }
const a = load('work/matrix_compact.json')
const b = load('research/matrix.compact.json')
console.log(`[input] matrix A=${a.length}  B=${b.length}`)

// This script OVERWRITES data/capabilities.json. Every input it reads is optional to
// its own error handling — `load` swallows a missing file — so running it from the
// wrong directory, or before the research dumps exist, produced an empty `merged`
// and quietly replaced the entire capability matrix with `{models: []}`. After that
// the router finds no candidate for anything and every turn falls back. The loss is
// silent and total, so the inputs are checked before a single byte is written.
if (a.length === 0 && b.length === 0) {
  console.error('[abort] no capability matrices found at work/matrix_compact.json or research/matrix.compact.json.')
  console.error('[abort] data/capabilities.json was NOT modified. Run this from the plugin root,')
  console.error('[abort] or restore the research dumps before rebuilding.')
  process.exit(1)
}

// measured facts. The tri-state matters: `null` means the probe never got a usable
// answer, which is NOT the same as a model answering "no". Collapsing the two is
// what turned seventeen parser misses into permanent routing exclusions.
const tri = v => (v === true ? true : v === false ? false : null)
const measured = new Map()
for (const r of load('_probe_results.json')) {
  measured.set(r.id, { route: r.route, reachable: tri(r.chat), tool: tri(r.tool), ttftMs: r.ttftMs, note: r.note })
}
for (const r of load('_probe_raw.json')) {
  const cur = measured.get(r.id) ?? {}
  measured.set(r.id, { ...cur, reachable: false, note: r.verdict, rawNote: r.raw?.slice(0, 120) })
}
// the user's live config, as the ground truth for what the router can even see
const patch = yaml.load(readFileSync(`${HOME}/.dsh/profiles/desktop/cordis.patch.yml`, 'utf8'))
const configured = new Map()
for (const [route, p] of Object.entries(patch.find(e => e.id === 'llm-pi-ai').config.providers)) {
  for (const m of p.models) configured.set(m.id, { route, baseURL: p.baseURL })
}
// measured directly through the user's own routes
for (const r of load('_health_cfg.json')) configured.set(r.id, { route: r.route, live: r.ok, tool: r.tool, ms: r.ms, note: r.note })

const pick = (o, keys) => { for (const k of keys) if (o?.[k] !== undefined) return o[k]; return undefined }
const merged = new Map()
for (const m of [...a, ...b]) {
  const id = m.id
  if (!id) continue
  const ctx = pick(m, ['context_window', 'ctx']) ?? null
  const tools = pick(m, ['tool_calling', 'tools']) ?? null
  const prev = merged.get(id)
  const scoreCount = o => Object.values(o?.scores ?? {}).filter(v => typeof v === 'number').length
  if (prev && scoreCount(prev) >= scoreCount(m)) continue
  merged.set(id, {
    id,
    context_window: ctx,
    tool_calling: tools,
    reasoning: pick(m, ['reasoning']) ?? null,
    modalities: m.modalities ?? [],
    price: m.price ?? null,
    scores: m.scores ?? {},
    evidence: m.evidence ?? {},
    notes: m.notes ?? '',
  })
}

const rows = [...merged.values()].map(r => {
  const mm = measured.get(r.id)
  const cf = configured.get(r.id)
  return {
    ...r,
    measured: mm ? { reachable: mm.reachable, tool: mm.tool, ttftMs: mm.ttftMs ?? null, note: mm.note ?? '' } : null,
    configured: cf ? { route: cf.route, live: cf.live ?? null } : null,
  }
}).sort((x, y) => Number(!!y.configured) - Number(!!x.configured) || x.id.localeCompare(y.id))

const confidence = {}
for (const r of rows) for (const e of Object.values(r.evidence)) {
  const c = e?.confidence ?? 'unknown'
  confidence[c] = (confidence[c] ?? 0) + 1
}

const doc = {
  generated: '2026-10-04',
  sources: [
    'https://models.dev/api.json (metadata; contains NO capability scores)',
    'vendor model cards: anthropic.com, blog.google, NVIDIA, Xiaomi MiMo, inclusionAI, Meituan LongCat, deepseek-ai',
    'benchmark aggregators: artificialanalysis.ai, the-decoder.de, simonwillison.net',
    'LIVE PROBE 2026-10-04 through the user\'s own gateways (availability, tool-calling, TTFT)',
  ],
  caveats: [
    'Score confidence: high=53, medium=85, low=158, unknown=37 of 333 cells. LOW cells are tier inference anchored on models.dev metadata, NOT measured capability.',
    'models.dev carries no capability scores; any cell sourcing only models.dev is an inference.',
    'Artificial Analysis intelligence index is NOT comparable across index versions.',
    'Same model id differs by provider (context/price); values here are indicative, the live config is authoritative.',
    'translation column is almost entirely null — do not route on it.',
    'grok-4 / grok-420-* are chat-capable but FAIL tool-calling: unusable for agent turns.',
  ],
  measured_inventory: {
    gateways_advertised: 51,
    chat_capable: rows.filter(r => r.measured?.reachable === true).length,
    tool_capable: rows.filter(r => r.measured?.tool === true).length,
    unknown_reachability: rows.filter(r => r.measured && r.measured.reachable === null).length,
    advertised_but_dead: rows.filter(r => r.measured && r.measured.reachable === false).length,
  },
  models: rows,
}

writeFileSync(`${OUT}/capabilities.json`, JSON.stringify(doc, null, 2))
writeFileSync(`${OUT}/capabilities.compact.json`, JSON.stringify(rows))
console.log(`[written] ${OUT}/capabilities.json  (${rows.length} models)`)
console.log(`[confidence] ${JSON.stringify(confidence)}`)
console.log(`[inventory] advertised=51 chat=${doc.measured_inventory.chat_capable} tool=${doc.measured_inventory.tool_capable} dead=${doc.measured_inventory.advertised_but_dead}`)

// ---- recommendation: only models that are BOTH tool-capable and reachable ----
const usable = rows.filter(r => r.measured?.tool === true && r.measured?.reachable === true)
console.log(`\n[usable for routing] ${usable.length} models`)
const priceOf = r => r.price?.input ?? (r.price?.input === 0 ? 0 : 999)
for (const t of TYPES) {
  const ranked = usable
    .filter(r => typeof r.scores?.[t] === 'number')
    .sort((x, y) => (y.scores[t] - x.scores[t]) || (priceOf(x) - priceOf(y)))
  const best = ranked.slice(0, 4).map(r => {
    const ev = r.evidence?.[t] ?? {}
    const p = r.price ? `$${r.price.input}/$${r.price.output}` : 'n/a'
    return `${r.id}(${r.scores[t]}${ev.confidence === 'high' ? '!' : ev.confidence === 'medium' ? '' : '?'} ${p}${r.configured ? ' [已配]' : ''})`
  })
  console.log(`  ${t.padEnd(20)} ${best.join('  ')}`)
}
console.log('\n图例: ! = high 置信度, 无标记 = medium, ? = low/推断;  [已配] = 已在你的 profile 里')
