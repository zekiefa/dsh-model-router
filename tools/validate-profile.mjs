// Validate a profile's provider section against the adapter's own schema, and print
// the resulting model grouping. Reusable after any edit.
//
//   node tools/validate-profile.mjs [path/to/cordis.patch.yml]
//
// The profile to check defaults to this machine's desktop profile. Everything it
// reads is configuration, never a secret: `apiKeyEnv` names a credential to look up
// elsewhere, and the value itself is never printed.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const HOME = process.env.USERPROFILE.replace(/\\/g, '/')
const NM = `${HOME}/.dsh/profiles/node_modules`
const yaml = (await import(pathToFileURL(`${NM}/js-yaml/index.js`).href)).default
const piAi = await import(pathToFileURL(`${NM}/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`).href)

const PROFILE = process.argv[2] ?? `${HOME}/.dsh/profiles/desktop/cordis.patch.yml`

const doc = yaml.load(readFileSync(PROFILE, 'utf8'))
const entry = doc.find(e => e.id === 'llm-pi-ai')
if (!entry) throw new Error(`no 'llm-pi-ai' entry in ${PROFILE}`)
piAi.Config(entry.config)
console.log(`[schema] OK — ${doc.length} patch entries, llm-pi-ai section accepted`)

const providers = entry.config.providers
const supported = piAi.supportedProtocols()
let total = 0
for (const [route, p] of Object.entries(providers)) {
  if (!supported.includes(p.api)) throw new Error(`${route}: unsupported api ${p.api}`)
  if (!/^https:\/\//.test(p.baseURL)) throw new Error(`${route}: bad baseURL`)
  for (const m of p.models) {
    if (m.contextWindow !== undefined && (!Number.isInteger(m.contextWindow) || m.contextWindow <= 0)) {
      throw new Error(`${route}/${m.id}: bad contextWindow`)
    }
    total++
  }
  console.log(`  ${route.padEnd(9)} models(${p.models.length}): ${p.models.map(m => m.id).join(', ')}`)
}
console.log(`[check] routes=${Object.keys(providers).length} models=${total}`)