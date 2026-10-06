/**
 * Routing policy: which candidate serves which kind of question.
 *
 * The whole point is that correctness and efficiency are traded off differently
 * per task kind, so the objective is not one formula:
 *
 * - research kinds (learning, coding, math, knowledge, tool execution) are
 *   quality-first; price only separates candidates of equal quality;
 * - small talk is efficiency-first; any model clearing the floor is acceptable
 *   and the free ones win outright;
 * - everything else wants near-best quality, then the cheapest of those.
 *
 * Two invariants hold everywhere, and they are what make the decisions auditable:
 *
 * 1. A measurement beats a claim. `capabilities.json` carries both a vendor's
 *    documentation (`tool_calling`) and this deployment's own probe of that model
 *    through its own gateway (`measured`). Where they disagree, the probe wins —
 *    the probe exists precisely because the documentation was wrong.
 * 2. Unknown is not a guess. A candidate with no record, or whose support for
 *    something this turn requires is unknown, is excluded rather than admitted
 *    on optimism.
 *
 * @module dsh-model-router/policy
 */

/** Types where a verified reasoning model is worth a small, bounded nudge. */
const REASONING_TYPES = new Set(['math_reasoning', 'agentic_tools', 'learning_tutor'])

/**
 * Rank memoisation.
 *
 * These are called O(n log n) times per decision from inside the comparators,
 * over capability records that do not change between turns, so recomputing the
 * arithmetic is pure waste after the first comparison of a decision.
 */
const priceMemo = new WeakMap()
const latencyMemo = new WeakMap()

/** Models known to be free of charge. */
export function isFree(cap) {
  const p = cap?.price
  return p?.input === 0 && p?.output === 0
}

/** Lower is better; unknown price sorts last rather than first. */
export function priceRank(cap) {
  if (cap === null || typeof cap !== 'object') return Number.POSITIVE_INFINITY
  const hit = priceMemo.get(cap)
  if (hit !== undefined) return hit
  const p = cap.price
  const value = (!p || typeof p.input !== 'number') ? Number.POSITIVE_INFINITY : p.input + p.output / 4
  priceMemo.set(cap, value)
  return value
}

/** Latency tie-break; unmeasured sorts last. */
export function latencyRank(cap) {
  if (cap === null || typeof cap !== 'object') return Number.POSITIVE_INFINITY
  const hit = latencyMemo.get(cap)
  if (hit !== undefined) return hit
  const t = cap?.measured?.ttftMs
  const value = typeof t === 'number' ? t : Number.POSITIVE_INFINITY
  latencyMemo.set(cap, value)
  return value
}

/**
 * How much this deployment has verified about a model.
 *
 * `2` probed and reachable, `1` never probed, `0` probed and known dead.
 *
 * NOT used to order candidates, deliberately. The probe's own log records 17
 * models that answered HTTP 200 and were filed as failures because the response
 * was not parsed ("no delta"), so `reachable` currently carries roughly a third
 * false negatives. Ranking small talk by it would launder that into permanent
 * policy. The signal is kept and reported in the decision reason, where a human
 * can see it, rather than acted on, until the probe stops mis-reporting — the fix
 * belongs in `tools/probe-catalog.mjs`, not in the sort order.
 *
 * @param cap - the capability record.
 * @returns 2 verified, 1 unverified, 0 known dead.
 */
export function trustTier(cap) {
  const reachable = cap?.measured?.reachable
  if (reachable === true) return 2
  if (reachable === false) return 0
  return 1
}

/**
 * Whether a candidate can be relied on to call tools, or `null` when unknown.
 *
 * `measured.tool` is this deployment's own forced-`tool_choice` probe through the
 * actual gateway; `tool_calling` is what the vendor's documentation claims.
 *
 * The probe is authoritative ONLY when it actually ran. Its own records show 17
 * models answered with HTTP 200 and were logged as failures with the note "no
 * delta" — the response was not parsed, not the model dead — and `reachable:false`
 * then excluded them permanently. Treating those as evidence of incapability
 * would convert a probe bug into a permanent ban on models that demonstrably
 * work, so a `false` is trusted only alongside a `reachable:true` that proves the
 * probe completed. This is also what makes the Grok rows load-bearing evidence
 * rather than an assumption: they are measured, reachable, and still refuse tools.
 *
 * When the probe says yes but the documentation says no, the restrictive reading
 * wins. The asymmetry decides it: admitting a model that cannot call tools breaks
 * the agent loop for that turn, while refusing one that can costs a single turn
 * and another candidate. When neither source says anything the answer is `null`,
 * and the candidate is excluded — unknown is not a guess.
 *
 * @param cap - the capability record.
 * @returns `true`, `false`, or `null` for unknown.
 */
export function toolSupport(cap) {
  const measured = cap?.measured
  const claimed = cap?.tool_calling
  if (measured?.reachable === true) {
    if (measured.tool === false) return false
    if (measured.tool === true && claimed === false) return false
    if (measured.tool === true) return true
  }
  return typeof claimed === 'boolean' ? claimed : null
}

/** The refusal text for a candidate that cannot serve a tool-executing turn. */
function toolRefusal(cap) {
  if (cap?.measured?.reachable === true && cap.measured.tool === false) {
    return 'cannot call tools (measured: the probe reached the model, forced tool_choice, and got no tool call)'
  }
  if (cap?.measured?.reachable === true && cap.measured.tool === true && cap?.tool_calling === false) {
    return 'cannot call tools (vendor metadata says no while the probe says yes — taking the restrictive reading)'
  }
  return 'tool support unknown, and this turn executes a task'
}

/**
 * Whether a candidate is retired and must never be routed to.
 *
 * `capabilities.json` carries a `notes` field that records deprecation, but a
 * policy that never reads notes will keep selecting a model the vendor has
 * retired — the live ones still answer, so every availability check passes.
 *
 * @param cap - the capability record.
 * @returns whether the record is marked retired.
 */
export function isRetired(cap) {
  return cap?.lifecycle?.status === 'deprecated'
}

/**
 * Whether a Grok route may serve this turn.
 *
 * This is a policy question, not a measurement one. Whether Grok can call tools
 * is settled by `toolSupport` above; the provider-name check that used to answer
 * it here was a workaround for the policy not reading the probe, and it would
 * have outlived the problem it papered over — fix the gateway and the hardcoded
 * bar would still be there. What remains is the deployment's own rule about
 * where Grok may serve at all.
 *
 * @param candidate - the live route/model.
 * @param classification - this turn's verdict.
 * @param config - the router config.
 * @returns the refusal reason, or undefined when allowed.
 */
export function grokRefusal(candidate, classification, config) {
  const rules = config?.grok
  // Identity first, configuration second. Testing `enabled` before asking whether
  // this candidate is Grok at all made `grok.enabled: false` reject every model
  // in the pool, so the whole router silently collapsed onto the fallback.
  const pattern = rules?.match ?? /^(grok|xai)\b|^grok[-_]/i
  if (!pattern.test(`${candidate.provider}/${candidate.id}`)) return undefined
  if (rules?.enabled === false) return 'grok disabled by config'
  // Chat-mode escape hatch: a genuinely hard question that does not execute a
  // task may use Grok for its reasoning, whatever the task type.
  if (config?.mode === 'chat' && classification.difficulty === 'hard' && !classification.needsTools) return undefined
  const allowed = rules?.allowedTypes ?? ['daily_chat']
  if (!allowed.includes(classification.type)) return `grok is restricted to ${allowed.join('/')} (this is ${classification.type})`
  return undefined
}

/**
 * The context window to hold this candidate to, and where that number came from.
 *
 * The live value wins and is never overridden: gateway `/models` endpoints often
 * omit `context_length` or report the family's maximum rather than the ceiling of
 * the deployment actually serving, which is why the matrix is not trusted by
 * default — the matrix's own caveats say the live configuration is authoritative.
 * The matrix is available per provider for the gateways where it is known to be
 * better than nothing.
 *
 * Which direction an error hurts decides how each source is handled. An
 * over-stated window admits a model that cannot hold the conversation, and the
 * harness truncates it silently — truncation destroys work, so it is worse than
 * misrouting. A window that is too small only costs an unnecessary downgrade. So
 * the matrix is only ever used to fill a gap, never to raise a live value, and an
 * implausible number (zero, negative, NaN, non-finite) counts as no value at all.
 *
 * @returns `{ window, source }` with `window === null` when nothing is known.
 */
function resolveWindow({ candidate, cap, contextWindows, config }) {
  const key = `${candidate.provider}/${candidate.id}`
  const usable = value => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null)

  const live = usable(contextWindows?.get?.(key))
  if (live !== null) return { window: live, source: 'provider' }

  const rules = config?.contextWindowFallback
  // On by default: the matrix values are vendor-documented and all plausible, and
  // switching the fallback off leaves the gate inert on any provider whose
  // `resolveModelInfo` does not answer — which is the failure mode this gate
  // exists to prevent. Exclusions are per provider for the gateways whose /models
  // endpoint overstates the window.
  // Absent config means ON: the matrix values are vendor-documented and all
  // plausible, and defaulting this off leaves the gate inert on any provider
  // whose `resolveModelInfo` does not answer — the failure it exists to prevent.
  const enabled = rules === undefined || rules === true
    || (typeof rules === 'object' && rules !== null && rules.default !== false)
  const excluded = Array.isArray(rules?.exclude) ? rules.exclude : []
  if (enabled && !excluded.includes(candidate.provider)) {
    const matrix = usable(cap?.context_window)
    if (matrix !== null) return { window: matrix, source: 'matrix' }
  }
  return { window: null, source: 'unknown' }
}

/**
 * Choose one model for one classified turn.
 *
 * @param request - candidates, capability index, classification, config, cooldowns.
 * @returns the chosen route/model, the reason, and every candidate considered.
 */
export function decide(request) {
  const { candidates, index, classification, config, cooldowns = new Map(), now = Date.now(), contextWindows = null } = request
  const type = classification.type
  const considered = []

  const research = config?.research?.types ?? []
  const casual = config?.casual?.types ?? []
  const balanced = config?.balanced?.types ?? []

  // "Brain vs executor": a configured specialty preference applies to thinking
  // and planning turns, while trivial repetitive execution stays on the cheapest
  // qualifying model. The classifier decides this once, and the types that are
  // inherently brain work ignore the difficulty signal entirely.
  const brain = (classification.brain ?? classification.difficulty !== 'trivial')
    || (config?.alwaysBrainTypes ?? []).includes(type)

  // Estimated prompt size, supplied by the caller. Zero disables the gate.
  const promptTokens = classification.promptTokens ?? 0
  const headroom = config?.contextHeadroom ?? 1.15

  const pool = []
  for (const candidate of candidates) {
    const cap = index.get(candidate.id) ?? null
    const key = `${candidate.provider}/${candidate.id}`
    const entry = { ...candidate, cap, key, excluded: null }
    considered.push(entry)

    // Capability gates run before policy gates, deliberately. "This model cannot
    // call tools" is a fact about the model; "this model is not allowed here" is a
    // rule about the deployment. When both apply, the fact is the more useful
    // thing to log, so it is the reason reported.
    if (classification.needsTools && toolSupport(cap) !== true) {
      entry.excluded = toolRefusal(cap)
      continue
    }
    // The one gate that is deliberately permissive about unknown. An
    // over-estimate here costs a route that would have worked; an under-estimate
    // selects a model that cannot hold the conversation and fails the turn
    // outright. So a record with no declared window is admitted, not excluded.
    if (promptTokens > 0 && config?.respectContext !== false) {
      const { window, source } = resolveWindow({ candidate, cap, contextWindows, config })
      // Unknown is admitted, and that is deliberate. Over-estimating here only
      // costs a route that would have worked; under-estimating would admit a model
      // that cannot hold the conversation and lose the turn's work to a silent
      // truncation. `unknown` is also the one place this plugin does not treat a
      // missing value as disqualifying.
      if (window !== null && promptTokens * headroom > window) {
        entry.excluded = `context window too small (needs ~${Math.ceil(promptTokens * headroom)} tokens, ${source} says ${window})`
        continue
      }
    }
    if (classification.hasImage && config?.respectModalities !== false) {
      const mods = cap?.modalities ?? []
      if (mods.length > 0 && !mods.includes('image')) { entry.excluded = 'text-only model, request carries an image'; continue }
    }
    const grok = grokRefusal(candidate, classification, config)
    if (grok) { entry.excluded = grok; continue }
    if (cooldowns.get?.(key, candidate.provider) > now) { entry.excluded = 'recently rate-limited (cooldown)'; continue }
    if (isRetired(cap)) { entry.excluded = 'retired by its vendor (lifecycle: deprecated)'; continue }
    if (cap === null) { entry.excluded = 'no capability record (treated as unknown)'; continue }
    if (typeof cap.scores?.[type] !== 'number') { entry.excluded = `no ${type} rating`; continue }
    // Probed-dead is a verdict too, and it is applied here rather than in the
    // filter below so `/route` reports it. Leaving it to a later filter made the
    // diagnostics list a known-dead model as an unqualified candidate.
    if (cap.measured?.reachable === false) { entry.excluded = `probe: ${cap.measured.note || 'measured unreachable'}`; continue }
    pool.push(entry)
  }

  // A belt-and-braces pass for records assembled elsewhere; normally a no-op now
  // that the gate above is explicit.
  const usable = pool.filter(e => e.cap?.measured?.reachable !== false)

  if (usable.length === 0) {
    // The fallback used to be returned as a bare `{ provider, id, cap: null }`,
    // which meant it skipped every gate in the loop above AND carried no
    // capability record — so the one route guaranteed to be used exactly when the
    // pool collapsed was the one route that was never checked. A 900K-token coding
    // turn against an empty pool resolved to it silently.
    //
    // The fallback is still checked, but a failing check never removes it: it is
    // the last thing available, and sending a turn that might fail beats not
    // answering at all. Every problem is named in the reason so the log says what
    // is actually serving.
    const fb = config?.fallback
    if (fb === undefined || fb === null) {
      return {
        pick: null,
        reason: `no candidate qualifies for ${type}; leaving the request untouched`,
        kind: 'unknown-fallback',
        considered,
      }
    }
    const fbCap = index.get(fb.model) ?? null
    const fbKey = `${fb.provider}/${fb.model}`
    const faults = []
    if (fbCap === null) faults.push('no capability record')
    if (isRetired(fbCap)) faults.push('the fallback model is retired')
    if (classification.needsTools && toolSupport(fbCap) !== true) faults.push('the fallback cannot be relied on for tools')
    if (promptTokens > 0 && config?.respectContext !== false) {
      const { window, source } = resolveWindow({
        candidate: { provider: fb.provider, id: fb.model }, cap: fbCap, contextWindows, config,
      })
      if (window !== null && promptTokens * headroom > window) {
        faults.push(`the fallback window (${window}, from ${source}) is likely too small for ~${Math.ceil(promptTokens * headroom)} tokens`)
      } else if (source === 'unknown' && promptTokens > 100_000) {
        // Worth saying out loud: a long turn is exactly when this matters most,
        // and "we could not check" is not the same as "it is fine".
        faults.push(`the fallback has no known context window for a ~${Math.ceil(promptTokens)} token turn`)
      }
    }
    if (cooldowns.get?.(fbKey, fb.provider) > now) faults.push('the fallback is itself rate-limited')
    return {
      pick: { provider: fb.provider, id: fb.model, cap: fbCap, key: fbKey, fallback: true },
      reason: `no candidate qualifies for ${type}; falling back to ${fbKey}`
        + (faults.length > 0 ? ` — WARNING: ${faults.join('; ')}` : ''),
      kind: 'unknown-fallback',
      considered,
    }
  }

  const cheapest = (list) => [...list].sort((a, b) =>
    priceRank(a.cap) - priceRank(b.cap) || latencyRank(a.cap) - latencyRank(b.cap))

  const freeFirst = (list) => {
    const free = list.filter(e => isFree(e.cap))
    return free.length > 0 ? free : list
  }

  /**
   * Apply a configured quality floor, reporting when it starved the pool.
   *
   * A floor that empties the pool is a configuration mistake, not a reason to
   * abandon the turn, so it relaxes and says so in the reason rather than
   * silently pretending the floor held.
   */
  const applyFloor = (list, floor) => {
    if (!Number.isFinite(floor)) return { list, hit: true }
    const kept = list.filter(e => e.cap.scores[type] >= floor)
    return kept.length > 0 ? { list: kept, hit: true } : { list, hit: false }
  }

  /**
 * Rank a candidate against an ordered specialty-preference list for one task type.
 *
 * Two corrections to the original matcher, both of which changed which model won:
 *
 * - It searched `${id} ${provider} ${key}`, so a GATEWAY named `claude-proxy`
 *   handed top preference to every model it served, whatever those models were.
 *   A brand preference is a claim about a model, so it now matches the model id —
 *   and an explicit `provider/model` token still matches the full key.
 * - It returned only the rank, which the old lexicographic sort consumed directly.
 *   The rank is now turned into a decreasing bonus by `effective` below.
 *
 * @returns the preference rank, or `Infinity` when nothing matched.
 */
  const preferRank = (entry, prefer) => {
    if (!Array.isArray(prefer) || prefer.length === 0) return Number.POSITIVE_INFINITY
    const id = String(entry.id ?? '').toLowerCase()
    const key = String(entry.key ?? '').toLowerCase()
    for (let index = 0; index < prefer.length; index += 1) {
      const raw = prefer[index]
      if (typeof raw !== 'string') continue
      const token = raw.toLowerCase()
      if (token.includes('/') ? key.includes(token) : id.includes(token)) return index
    }
    return Number.POSITIVE_INFINITY
  }

  /**
   * Confidence levels strong enough to act on.
   *
   * This is the gate that makes `prefer` honest. `learning_tutor` currently has 31
   * models tied at its top rating, every one of them rated from tier inference
   * with `confidence: "low"` — there is no evidence in the matrix that separates
   * them, so a hand-written brand list was deciding that turn on its own, at up to
   * 20x the price. A candidate that explicitly claims its rating is a guess no
   * longer receives a preference nudge. Absence of the claim is NOT treated as a
   * guess: that would silently disable a deployment's configuration over a missing
   * field, which is a different failure.
   */
  const ratingIsGuess = (entry) => {
    const confidence = entry.cap?.evidence?.[type]?.confidence
    return confidence === 'low' || confidence === 'unknown'
  }

  const preferBonus = Number.isFinite(config?.preferBonus) ? config.preferBonus : 0.5
  const reasoningBonus = Number.isFinite(config?.reasoningBonus) ? config.reasoningBonus : 0.25

  /**
   * The score actually ranked on: the recorded rating plus bounded nudges.
   *
   * Every rating in the matrix is an integer on a 1-5 scale — all 446 cells, no
   * exceptions — so any bonus below 1 can only reorder a genuine tie and can never
   * let a preference outrank a real one-point quality gap. That was already true
   * of the old lexicographic sort, so the change here is not "weakly prefer", it
   * is "stop flattening the order": the bonus now decays as `bonus/(1+rank)`, so
   * a second-choice model cannot overtake a first-choice one on price.
   */
  const effective = (entry, affordable) => {
    let value = entry.cap.scores[type]
    if (brain) {
      const rank = preferRank(entry, config?.prefer?.[type])
      if (rank < Number.POSITIVE_INFINITY && !ratingIsGuess(entry) && (!affordable || affordable(entry))) {
        value += preferBonus / (1 + rank)
      }
      if (REASONING_TYPES.has(type) && entry.cap.reasoning === true) value += reasoningBonus
    }
    return value
  }

  /**
   * Quality first, then price, then latency.
   *
   * The preference may only buy a BOUNDED premium. Unbounded, it turns a brand
   * name into an open-ended cheque: two models tied at 5/5 would resolve to Opus
   * over a flash model 37x cheaper, and "the rating says they are equal" would stop
   * meaning anything. A configured `prefer` expresses a mild ordering among
   * comparable options, not a licence to ignore price. Beyond `preferPriceCap`
   * price wins, which is what makes the selection genuinely on demand.
   */
  const byQuality = (list) => {
    const prices = list.map(e => priceRank(e.cap)).filter(v => Number.isFinite(v))
    const floorPrice = prices.length > 0 ? Math.min(...prices) : Number.POSITIVE_INFINITY
    const cap = Number.isFinite(config?.preferPriceCap) ? config.preferPriceCap : 4
    const affordable = e => !Number.isFinite(floorPrice) || priceRank(e.cap) <= floorPrice * cap
    return [...list].sort((a, b) =>
      effective(b, affordable) - effective(a, affordable)
      || priceRank(a.cap) - priceRank(b.cap)
      || latencyRank(a.cap) - latencyRank(b.cap))
  }

  // Chat mode is a user-selected override that steers the WHOLE turn toward free
  // models, independent of the task type the classifier assigned. Work mode is
  // the unchanged type-based policy below.
  const mode = config?.mode ?? 'work'
  if (mode === 'chat') {
    // Escape hatch: a genuinely hard question — still not a tool-executing turn —
    // may use Grok for its reasoning, preferring the thinking variant.
    if (classification.difficulty === 'hard' && !classification.needsTools) {
      const groks = usable.filter(e => e.provider === 'grok' || /^grok/i.test(e.id))
      if (groks.length > 0) {
        const pick = groks.find(e => /thinking/i.test(e.id)) ?? groks[0]
        return { pick, reason: `chat mode, very complex question (${type}): Grok for reasoning`, kind: 'chat-complex', considered }
      }
    }
    // Free-first: Space Bunny Free ahead of the rest of the free pool.
    const free = usable.filter(e => isFree(e.cap))
    if (free.length > 0) {
      const preferredId = config?.chat?.preferred?.id ?? 'space-bunny-free'
      const bunny = free.filter(e => e.id === preferredId)
      const others = free.filter(e => e.id !== preferredId)
      const ordered = [...cheapest(bunny), ...cheapest(others)]
      return { pick: ordered[0], reason: `chat mode: free model first (${ordered[0].id})`, kind: 'chat-free', considered }
    }
    // No free model qualifies; fall through to the type-based policy below.
  }

  if (research.includes(type)) {
    // Quality-first. This floor was documented in the config and never read by
    // this function, so setting it changed nothing at all.
    const configured = config?.research?.minScore
    const { list, hit } = applyFloor(usable, typeof configured === 'number' ? configured : Number.NEGATIVE_INFINITY)
    const ordered = byQuality(list)
    const top = Math.max(...list.map(e => e.cap.scores[type]))
    const adjusted = effective(ordered[0]) > top
    return {
      pick: ordered[0],
      reason: (hit ? '' : `minScore ${configured} excluded every candidate, relaxed; `)
        + `research task (${type}): best rating ${top}${adjusted ? ', preference applied' : ''}`,
      kind: 'research',
      considered,
    }
  }

  if (casual.includes(type)) {
    const floor = config?.casual?.minScore ?? 3
    const { list, hit } = applyFloor(usable, floor)
    const pool2 = config?.casual?.preferFree === false ? list : freeFirst(list)
    const ordered = cheapest(pool2)
    const chosen = ordered[0]
    return {
      pick: chosen,
      reason: !hit
        ? `small talk (${type}): no model reached score ${floor}, relaxed to the best available`
        : `small talk (${type}): ${ordered.length} model(s) at score >= ${floor}; `
          + `${isFree(chosen.cap) ? 'free' : 'paid'} — `
          + `${chosen.cap?.measured?.reachable === true ? 'probe-verified' : 'never successfully probed'}`,
      kind: hit ? 'casual' : 'casual-relaxed',
      considered,
    }
  }

  if (balanced.includes(type)) {
    const floor = config?.balanced?.minScore
    const { list } = applyFloor(usable, typeof floor === 'number' ? floor : Number.NEGATIVE_INFINITY)
    const drop = config?.balanced?.maxScoreDrop ?? 0
    const top = Math.max(...list.map(e => e.cap.scores[type]))
    const near = list.filter(e => e.cap.scores[type] >= top - drop)
    const ordered = byQuality(near)
    return {
      pick: ordered[0],
      reason: `balanced task (${type}): within ${drop} of the top rating ${top}, then by preference, price and latency`,
      kind: 'balanced',
      considered,
    }
  }

  // No configured policy for this type. `translation` lands here by design: 32 of its
  // ratings are tier inference with `confidence: "low"`, so the matrix genuinely
  // cannot rank translation quality, and the type's own caveats say not to route on
  // it. Price is therefore the only honest tie-break available — but "cheapest" on
  // its own would happily pick a model rated 1 at everything, which is not a
  // defensible reading of "cheapest". A floor makes the trade explicit.
  const defaultFloor = typeof config?.defaultPolicy?.minScore === 'number' ? config.defaultPolicy.minScore : 2
  const { list: eligibleDefaults } = applyFloor(usable, defaultFloor)
  const ordered = cheapest(eligibleDefaults)
  return {
    pick: ordered[0],
    reason: `no configured policy for ${type}, and the matrix cannot rank it on evidence; `
      + `cheapest qualifying candidate (score >= ${defaultFloor})`,
    kind: 'default',
    considered,
  }
}

/**
 * Cooldown bookkeeping, at two granularities and with escalation.
 *
 * The original map was keyed on `provider/model` alone, which is the wrong unit:
 * rate limits are enforced per account or gateway, so five free models sharing one
 * gateway key each entered their own cooldown and then took turns hitting the same
 * wall. A provider-level entry now blocks all of them together.
 *
 * Each consecutive failure at the provider doubles its window (capped), so a route
 * that keeps failing is pushed further out instead of being retried on every turn,
 * and one success resets the streak. Expiry is the half-open probe: the first
 * request after it is admitted precisely so the streak can extend if the limit is
 * still in force.
 *
 * @param options - a number is read as `{ ttlMs }`, as callers have always passed it.
 * @returns the cooldown accessor `decide` consults.
 */
export function makeCooldowns(options = {}) {
  const opts = typeof options === 'number' ? { ttlMs: options } : (options ?? {})
  const ttlMs = opts.ttlMs ?? 120_000
  const providerTtlMs = opts.providerTtlMs ?? ttlMs
  const maxTtlMs = opts.maxTtlMs ?? providerTtlMs * 5
  const quotaTtlMs = opts.quotaTtlMs ?? ttlMs
  const models = new Map()
  const providers = new Map()
  return {
    ttlMs,
    /**
     * Mark a route unavailable. The provider is optional and deliberately NOT
     * inferred from the key: a caller that means only this one model should not
     * knock out its siblings.
     *
     * `kind` is the distinction that matters, and it is three-way rather than two.
     *
     * `rate` escalates: a gateway throttling now is likely to throttle again.
     * `quota` takes one flat window: an exhausted daily allowance resets on a
     * schedule, so doubling on every attempt walks the whole provider out of
     * service for hours. `exhausted` takes the LONGEST window: `insufficient_quota`
     * means a billing balance is gone, which does not come back on its own, and
     * retrying it on a short cycle is an unbounded bill on a metered account —
     * strictly worse than the escalating case this replaced.
     */
    mark(key, provider = null, at = Date.now(), kind = 'rate') {
      const flat = kind === 'quota'
      const longest = kind === 'exhausted'
      const own = at + (longest ? maxTtlMs : flat ? quotaTtlMs : ttlMs)
      models.set(key, { until: own, kind })
      if (typeof provider === 'string' && provider.length > 0) {
        const previous = providers.get(provider)
        const streak = flat || longest ? 0 : (previous?.streak ?? 0) + 1
        const window = longest
          ? maxTtlMs
          : flat ? quotaTtlMs : Math.min(maxTtlMs, providerTtlMs * 2 ** (streak - 1))
        providers.set(provider, { streak, until: at + window, kind })
      }
      return Math.max(own, typeof provider === 'string' ? providers.get(provider).until : 0)
    },
    /** When this route becomes usable again, accounting for its provider. */
    get(key, provider = null) {
      const own = models.get(key)?.until ?? 0
      const shared = typeof provider === 'string' ? (providers.get(provider)?.until ?? 0) : 0
      return Math.max(own, shared)
    },
    /**
     * A completed stream proves THIS ROUTE works. It does not prove the provider's
     * cooldown was unwarranted — five free models share one gateway key, so a
     * sibling succeeding would clear the block on a model that is still throttling
     * and send it straight back into the same 429, burning an extra failed turn on
     * every single turn. Provider entries therefore expire on their own TTL.
     */
    succeed(key) {
      if (key !== null && key !== undefined) models.delete(key)
    },
    entries() {
      return { models: new Map(models), providers: new Map(providers) }
    },
    clear() { models.clear(); providers.clear() },
    size: () => models.size,
  }
}

/**
 * Classify a terminal failure as throttling, a scheduled allowance, a spent
 * balance, or none of those.
 *
 * These were one boolean, and merging them hides three behaviours that need
 * opposite treatment.
 *
 * The most important split is `exhausted`. `insufficient_quota` and
 * `insufficient_balance` mean the billing balance is gone; that does not restore
 * itself, and retrying on a short cycle is an unbounded bill on a metered account.
 * It takes the longest window available, not the shortest.
 *
 * Ordering matters: a message can name both ("rate limit exceeded, quota
 * exceeded"), and the slowest-resetting cause is the one that governs.
 *
 * `429` is matched as a whole token rather than a substring — a response carrying
 * a request id like `req-42981` is not a throttled request, and treating it as one
 * parks a working route in a cooldown nobody can explain.
 *
 * @returns `'exhausted'`, `'quota'`, `'rate'`, or `false`.
 */
export function isRateLimitFailure(failure) {
  const all = `${failure?.code ?? ''} ${failure?.message ?? ''}`
  if (/insufficient[_-]?(quota|balance|credit)|billing|欠费|余额不足/i.test(all)) return 'exhausted'
  if (/quota|配额|额度/i.test(all)) return 'quota'
  if (/RATE_LIMIT|rate ?limit|too many requests|\b429\b|限流|请求过于频繁/i.test(all)) return 'rate'
  return false
}