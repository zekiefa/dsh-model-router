/**
 * Deterministic question classifier. No model call, no network, no state:
 * the same request always yields the same verdict, which is what makes the
 * router's decisions reviewable and its tests meaningful.
 *
 * Types are not a difficulty ladder — "learning", "coding" and "small talk"
 * are different KINDS of request that want different models, and difficulty
 * only orders candidates within one kind.
 *
 * @module dsh-model-router/classify
 */

/** The task kinds the router distinguishes. */
export const TYPES = [
  'daily_chat',
  'knowledge_qa',
  'learning_tutor',
  'coding',
  'math_reasoning',
  'writing_literature',
  'translation',
  'long_context',
  'agentic_tools',
]

/**
 * Types that are never "repetitive execution", whatever the surface signals.
 *
 * The policy uses difficulty to decide whether a configured specialty
 * preference applies at all. Gating that on a length heuristic used to send a
 * ten-word but genuinely hard bug report to the cheapest model, so these types
 * now bypass the gate entirely: writing code and doing mathematics are brain
 * work even when they are one line long.
 */
export const ALWAYS_BRAIN = new Set(['coding', 'math_reasoning', 'learning_tutor'])

/** Weighted lexical evidence per type. Order in the table is the tie-break order. */
const SIGNALS = [
  ['translation', [
    [6, /翻译|译成|译为|中译英|英译中|\btranslate\b|\btranslation\b/i],
  ]],
  ['coding', [
    [5, /```/],
    [4, /报错|异常|堆栈|崩溃|编译不过|跑不起来|\berror\b|\bexception\b|stack ?trace/i],
    [4, /重构|单元测试|正则|接口|函数签名|\brefactor\b|\bunit test\b|\bregex\b/i],
    [3, /代码|函数|变量|类|方法|模块|依赖|仓库|数据库|查询|接口文档|\bcode\b|\bfunction\b|\bclass\b|\bapi\b|\bsql\b|\bbug\b/i],
    [3, /\.[a-z]{1,4}\b(?=[\s,，。)]|$)/i],
    [2, /实现|写个|写一个|改成|优化|性能|内存|并发|\bimplement\b|\boptimize\b/i],
  ]],
  ['math_reasoning', [
    [6, /证明|求解|推导|积分|导数|微分|概率|期望|排列组合|数论|数学|几何|方程|不等式/i],
    [5, /[∑∫√≈≠≤≥π]|\^\d|\b\d+\s*[+\-*/]\s*\d+\b/i],
    [3, /计算|等于多少|结果是多少|\bprove\b|\bderive\b|\bprobability\b/i],
  ]],
  ['agentic_tools', [
    [6, /运行|执行命令|跑一下|部署|安装|提交|拉取|推送|重启|启动服务|\brun\b|\bexecute\b|\bdeploy\b|\binstall\b|\bcommit\b/i],
    [5, /帮我改|帮我写(?!一)|帮我查|帮我找|帮我建|帮我删|读取文件|写文件|打开文件|搜索(一下)?(代码|文件|仓库)/i],
    [4, /文件|目录|文件夹|命令行|终端|仓库(里|中)|\brepo\b|\bdirectory\b|\bterminal\b/i],
  ]],
  ['writing_literature', [
    [6, /写(一篇|一段|个)?(作文|文章|诗|小说|故事|散文|文案|脚本|演讲稿|邮件|信)/i],
    [5, /润色|改写|续写|仿写|文风|文学|修辞|押韵|对仗/i],
    [4, /\bwrite (an? )?(essay|article|poem|story|novel|email|copy)\b|\bpolish\b|\brewrite\b/i],
  ]],
  ['learning_tutor', [
    [5, /讲解|解释|教我|入门|原理|为什么|怎么理解|如何理解|通俗|举个例子|搞懂|搞明白|区别是什么|是什么意思/i],
    [4, /讲一下|讲讲|说说|介绍(一下|下)?|科普|带我(看|学)|从头(讲|说)/i],
    [4, /\bexplain\b|\bteach me\b|\bhow does .* work\b|\bwhat'?s the difference\b|\bintuition\b|\bwalk me through\b/i],
    [2, /学习|理解|概念|基础|进阶/i],
  ]],
  ['long_context', [
    [5, /总结|归纳|概括|提炼|全文|这篇文章|上面(说|提到)|前面(说|提到)|以下内容/i],
    [4, /\bsummar(y|ize|ise)\b|\btl;?dr\b|\bthe (above|following) (text|document)\b/i],
    [3, /文档|长文|报告|材料/i],
  ]],
  ['knowledge_qa', [
    [4, /是什么|有哪些|哪个|哪一个|什么时候|谁(是|的)|多少|在哪|\bwhat is\b|\bwhich\b|\bwhen\b|\bwho\b|\bwhere\b/i],
    [2, /[?？]\s*$/],
  ]],
  ['daily_chat', [
    [6, /^(你好|您好|hi|hello|hey|在吗|早上好|晚上好|哈喽|嗨)/i],
    [5, /^(谢谢|多谢|感谢|好的|收到|明白|嗯|哈哈|嘿嘿|ok|thanks|thank you)[!！。.~～]*$/i],
    [3, /天气|吃了吗|最近怎么样|在忙吗|干嘛呢|无聊|聊聊|随便聊|好累|好烦|辛苦|不想干|不想做|难受|无语|离谱|摸鱼|摆烂|累了|烦死|\bhow are you\b|\bjust chatting\b/i],
  ]],
]

/** Pre-resolved type order; rebuilding it per call was pure overhead. */
const TYPE_ORDER = SIGNALS.map(([type]) => type)

const CODE_EXT = /\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|c|h|cpp|cs|rb|php|swift|sql|json|ya?ml|toml|md|sh|ps1|html|css|vue)\b/i
/**
 * Verbs that name an action on an object.
 *
 * Every entry here is a way of asking for the tool loop to run. A verb that is
 * missing is worse than a wrong classification: `needsTools` false disables the
 * tool-capability gate entirely, so a model that cannot call tools becomes
 * eligible for a turn that is about to edit a file. The list previously omitted
 * 优化 / 看看 / 检查 / 保存 / 调一下, so "优化下这段代码" asked for a code change
 * without asking for tools.
 */
const ACTION_VERB = /运行|执行|跑一下|跑个|改(一下|成|为)|重写|优化(一下|下)?|重构(一下)?|写(入|到)|读(取|一下)|打开|关闭|保存|检查(一下|下)?|看看|看一下|搜(索)?(一下)?|查(一下|下)?|查找|安装|部署|提交|删除|创建|新建|重命名|移动|修复|调试|调(一下|试)|更新|加上|去掉|替换|翻译成文件|导出|导入|\brun\b|\bexecute\b|\bedit\b|\bwrite to\b|\bread\b|\bsearch\b|\bdelete\b|\bcreate\b|\bfix\b|\bopen\b|\bcheck\b|\boptimi[sz]e\b|\brefactor\b|\bdebug\b/i

/** Explicit demand for rigour; the strongest single difficulty tell. */
const RIGOUR = /详细|深入|全面|系统|严谨|严格|证明|推导|分析|完整|逐步|彻底/g

/** Language that asks for reasoning rather than for a fact or an action. */
const REASONING_DEMAND = /为什么|为何|如何|怎么|怎样|该不该|是否|权衡|取舍|本质|原理|区别|差异|对比|评估|\bwhy\b|\bhow (do|does|should|can)\b|\btrade-?offs?\b|\bcompare\b|\bshould we\b/i

/** Math notation, independent of how many words wrap it. */
const MATHY = /[∑∫√≈≠≤≥π]|\^\d|\b\d+\s*[+\-*/]\s*\d+\b/g

/**
 * Undiagnosed symptoms. Reporting a failure is not the same as asking for a change:
 * "优化下这段代码" is a transformation anyone can do, while "这行报错了" is a
 * question whose answer is not visible in the prompt. The type table already
 * treated these as coding; difficulty did not, so a one-word error report scored
 * zero and was treated as trivial work.
 */
const DIAGNOSTIC = /报错|异常|堆栈|崩溃|编译不过|跑不起来|死循环|不生效|没反应|报错啦|\berror\b|\bexception\b|\btraceback\b|\bfailed\b|\bfailing\b|\bnot work(ing)?\b|\bundefined\b|\bnull\b|\boom\b/i

/**
 * What a short, zero-hit line has to look like to count as small talk.
 *
 * The bare fallback used to classify anything of 12 characters or fewer as
 * chatter, so a dense short question ("这个方案可行吗") was handed to a free
 * small model. Tightening it to "must look conversational" fixed that but
 * created a worse one: an emotional aside that matched no table ("今天好累")
 * fell through to `knowledge_qa`, which is quality-first — so expressing
 * tiredness cost more than writing code. The everyday-register words now live in
 * the `daily_chat` signal table, where they carry real weight; this regex is the
 * last resort for greetings, sign-offs and interjections.
 */
const CHATTER = /^(你好|您好|在吗|在忙吗|干嘛呢|睡了吗|哈喽|嗨|早上好|晚上好|hi|hello|hey|谢谢|多谢|感谢|好的|好|收到|明白|嗯+|哈+|嘿+|哦+|啊+|emm?|嗯哼|ok|okay|thanks|thank you|bye|晚安)[!！。.~～？?]*$/i

/**
 * Earlier turns count for nothing. They used to contribute a quarter of every
 * matching pattern's weight, which never decayed: one code question at the start
 * of a session left a residue that classified every later vague remark as coding
 * for the rest of the conversation. History is now only allowed to act as an
 * anchor, through the continuation gate below.
 *
 * What a legitimate follow-up actually says. A BARE 「这个」 is excluded on
 * purpose — it is far too common, and admitting it would reopen exactly the
 * ratchet this replaces ("这个价位合理吗" would inherit coding).
 */
const CONTINUATION = /(这段代码|这段|这个项目|这个函数|这个文件|这个接口|这个类|上述|上面那段|前面|刚才|刚刚|接着|继续|按这个|基于这个|针对这个|照这个|同样问题)/

/** The anchor message must itself have classified confidently on its own. */
const ANCHOR_MIN_SCORE = 5

/**
 * The dead zone: any real signal in the current message beats inheritance. This is
 * a threshold rather than "inherit unless this is the highest score", which would
 * hand a turn to history whenever history happened to edge it out.
 */
const ANCHOR_DEAD_ZONE = 1

/** How many user messages back an anchor may be, counted in user messages. */
const ANCHOR_LOOKBACK = 5

/**
 * Topic-switch abort. Between the anchor and the current message, any user message
 * that classifies on its own at this confidence means the conversation moved on and
 * the anchor no longer applies.
 *
 * This is the rule that a lookback window alone cannot supply. A five-message
 * window limits how far the drift travels but not whether it drifted: "这段代码
 * 报错了" → two turns of pricing discussion → "有什么建议" keeps the code anchor
 * inside the window and would inherit anyway. The anchor's own threshold does not
 * catch it either, since the scan stops at the first strong message.
 *
 * Deliberately lower than ANCHOR_MIN_SCORE: an intervening message only has to be
 * recognisable as a different topic, not as strongly typed as the anchor.
 */
const ANCHOR_ABORT_SCORE = 3

/** Bounds the signal-score memo so a long-lived session cannot grow it forever. */
const SCORE_CACHE_LIMIT = 256

/**
 * Past this combined size a pair is not memoised: a pasted stack trace makes a
 * terrible Map key, because the cache would pin the text for its whole life.
 */
const CACHEABLE_TEXT = 20_000

/**
 * Memo-key separator. Both texts are length-prefixed, so the split is pinned
 * regardless of the separator; a visible character keeps the source free of the
 * literal NUL that most tooling then reads as a binary file.
 */
const KEY_SEP = '|'

/** Flatten one message's content blocks into plain text. */
export function messageText(message) {
  const parts = []
  for (const block of message?.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Whether this request is executing a concrete task rather than asking a question.
 *
 * Two independent tells, either sufficient: the conversation is already inside a
 * tool cycle (a tool result is in flight), or the user's own words name an action
 * on an object. A model measured as unable to call tools is barred from every
 * such turn — see `toolSupport` in the policy module, which is where that
 * measurement is actually enforced.
 *
 * @param messages - the request's conversation.
 * @param userText - the latest user message text.
 * @returns whether tools must be usable for this turn.
 */
export function needsToolExecution(messages, userText) {
  for (const message of messages) {
    // A tool result is a USER-role message tagged with a tool source; the
    // harness has no 'tool' role, so role alone would never detect it.
    if (message?.source?.kind === 'tool') return true
    for (const block of message?.content ?? []) {
      if (block?.type === 'tool-result' || block?.type === 'tool-call') return true
    }
  }
  if (ACTION_VERB.test(userText)) return true
  if (CODE_EXT.test(userText) && /(文件|目录|读|改|写|看|检查|file|open|check)/i.test(userText)) return true
  return false
}

/** Message content may carry an image; a text-only model must not serve it. */
export function hasImage(messages) {
  for (const message of messages) {
    for (const block of message?.content ?? []) if (block?.type === 'image') return true
  }
  return false
}

/**
 * Per-message-array token accounting, scanned incrementally.
 *
 * The context-window gate needs an estimate of the whole prompt, but rescanning
 * a 500 KB conversation on every turn of a tool loop is quadratic in the loop.
 * A WeakMap keyed on the array remembers how far the last scan reached, so each
 * turn pays only for the messages appended since. The harness appends rather
 * than rewrites, so the prefix figure is exact, not an approximation.
 */
const tokenCache = new WeakMap()

/** Tokens in one text, splitting CJK from latin. */
function tokensOf(text) {
  let cjk = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x2e80) cjk += 1
  }
  return cjk + (text.length - cjk) / 4
}

/**
 * Estimated prompt tokens for a conversation.
 *
 * Deliberately biased HIGH (latin /4, CJK /1 rather than a tighter guess):
 * under-estimating selects a model that cannot hold the conversation, which
 * fails the turn outright, while over-estimating only costs a route that would
 * have worked. The asymmetry is not subtle — the first loses all of the turn's
 * work, the second loses some money.
 *
 * It counts the three things that actually dominate an agentic turn, which an
 * earlier version missed: tool-call arguments, images, and — via `extraTokens` —
 * the system prompt and tool schemas. Those last two are identical for every
 * candidate in a given turn, so they cannot change the ranking, but they decide
 * absolute feasibility and the gate is absolute.
 *
 * @param messages - the request's conversation.
 * @param extraTokens - system prompt plus tool schemas, supplied by the caller.
 * @returns an estimated token count.
 */
export function estimateTokens(messages, extraTokens = 0) {
  const base = Number.isFinite(extraTokens) && extraTokens > 0 ? extraTokens : 0
  if (!Array.isArray(messages) || messages.length === 0) return base
  const cached = tokenCache.get(messages)
  if (cached && cached.count === messages.length) return cached.tokens + base

  const from = cached && cached.count < messages.length ? cached.count : 0
  let tokens = cached ? cached.tokens : 0
  for (let index = from; index < messages.length; index += 1) {
    const message = messages[index]
    if (!message) continue
    for (const block of message.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') tokens += tokensOf(block.text)
      else if (block?.type === 'tool-result') tokens += 64 // framing around the payload
      else if (block?.type === 'tool-call') tokens += 32 + tokensOf(JSON.stringify(block.arguments ?? {}))
      else if (block?.type === 'image') tokens += 2000 // a page screenshot, conservatively
    }
    tokens += 4 // role and authorship metadata the provider still tokenizes
  }
  const total = Math.ceil(tokens)
  tokenCache.set(messages, { count: messages.length, tokens: total })
  return total + base
}

/**
 * Effort estimate: only orders candidates inside one kind.
 *
 * The previous version scored mostly on character count, which conflated "how
 * much did the user type" with "how hard is this": a one-line bug report that
 * took an afternoon read as trivial, while a 600-word ramble about nothing read
 * as hard. These signals ask what the request demands — explicit rigour, a
 * request to reason rather than to look something up, and material that is
 * inherently hard to produce (code, mathematics). Length survives as one weak
 * signal rather than the dominant one.
 *
 * @param userText - the latest user message text.
 * @param messages - the request's conversation.
 * @returns `'trivial' | 'moderate' | 'hard'`.
 */
export function difficultyOf(userText, messages) {
  let score = 0

  const rigour = userText.match(RIGOUR)?.length ?? 0
  score += rigour >= 2 ? 3 : rigour === 1 ? 1 : 0
  const symptoms = userText.match(DIAGNOSTIC)?.length ?? 0
  score += symptoms >= 2 ? 2 : symptoms === 1 ? 1 : 0
  if (REASONING_DEMAND.test(userText)) score += 1
  if (/```/.test(userText)) score += 1
  if (MATHY.test(userText)) score += 1

  // One weak signal, not two: length is evidence of effort spent writing, which
  // is at best a loose proxy for the work itself.
  if (userText.length > 300) score += 1

  if ((userText.match(/[?？]/g) ?? []).length > 1) score += 1
  if (messages.length > 12) score += 1

  return score >= 3 ? 'hard' : score >= 1 ? 'moderate' : 'trivial'
}

/** Bounded FIFO memo of the signal scores — the classifier's only hot loop. */
const scoreCache = new Map()

/**
 * Score one message on its own, with no history of any kind.
 *
 * @returns `{ scores, evidence }` keyed by type.
 */
function scoreUncached(userText) {
  const scores = new Map()
  const evidence = new Map()
  for (const [type, patterns] of SIGNALS) {
    let total = 0
    const hits = []
    for (const [weight, re] of patterns) {
      if (re.test(userText)) { total += weight; hits.push(re.source.slice(0, 40)) }
    }
    scores.set(type, total)
    evidence.set(type, hits)
  }
  return { scores, evidence }
}

/**
 * Score one message, memoised.
 *
 * The memo matters because a tool loop re-enters here many times with a
 * byte-identical message, and because the anchor scan below re-scores the same
 * recent messages on every turn. This turns the dominant cost of routing into a
 * Map lookup.
 */
function scoreSignals(userText) {
  if (userText.length > CACHEABLE_TEXT) return scoreUncached(userText)

  const hit = scoreCache.get(userText)
  if (hit !== undefined) {
    // Refresh recency: a Map preserves insertion order, so re-inserting makes the
    // eviction below drop the genuinely old entries rather than active ones.
    scoreCache.delete(userText)
    scoreCache.set(userText, hit)
    return hit
  }

  const result = scoreUncached(userText)
  if (scoreCache.size >= SCORE_CACHE_LIMIT) {
    const oldest = scoreCache.keys().next().value
    if (oldest !== undefined) scoreCache.delete(oldest)
  }
  scoreCache.set(userText, result)
  return result
}

/** The highest-scoring type for one message, and that score. */
function bestOf(scores) {
  let best = 'knowledge_qa'
  let bestScore = 0
  for (const type of TYPE_ORDER) {
    const score = scores.get(type) ?? 0
    if (score > bestScore) { best = type; bestScore = score }
  }
  return { type: best, score: bestScore }
}

/**
 * Find a topic anchor among the user messages BEFORE the current one.
 *
 * Scans backwards over at most ANCHOR_LOOKBACK user messages and returns the most
 * recent one that classified confidently on its own, together with whether the
 * conversation drifted onto a different topic in between.
 *
 * Derived from `messages` on every call rather than kept in a session map, and
 * that is the whole point. `messages` is an input, so this stays a pure function
 * of the request: replaying a session reproduces it exactly. A mutable per-session
 * map would not — a counter that advances on every classify call moves on retries
 * and replays too, so the same session would route differently the second time it
 * ran, and `/route` could no longer be checked against the request that produced it.
 *
 * @param earlierTexts - user message texts, oldest first, excluding the current one.
 * @returns `{ type, score, index, aborted }`.
 */
function findAnchor(earlierTexts) {
  const window = earlierTexts.slice(-ANCHOR_LOOKBACK)
  for (let offset = window.length - 1; offset >= 0; offset -= 1) {
    const { type, score } = bestOf(scoreSignals(window[offset]).scores)
    if (score < ANCHOR_MIN_SCORE) continue
    // Small talk is the highest-weighted type in the table — a greeting scores 6 —
    // and it carries no topic at all. Allowing it to anchor would make "谢谢" the
    // thing a continuation inherits, so it is never an anchor source.
    if (type === 'daily_chat') continue
    // Everything between this anchor and the current turn must be either the same
    // topic or unremarkable. Only a confident turn of a DIFFERENT type retires it:
    // a turn that is confidently the same type is the topic continuing, and
    // aborting on it would throw away exactly the continuity this exists to keep.
    for (let between = offset + 1; between < window.length; between += 1) {
      const middle = bestOf(scoreSignals(window[between]).scores)
      if (middle.type !== type && middle.score >= ANCHOR_ABORT_SCORE) {
        return { type, score, index: offset, aborted: true }
      }
    }
    return { type, score, index: offset, aborted: false }
  }
  return { type: null, score: 0, index: -1, aborted: false }
}

/** Drop the memo; used by tests and by a config reload. */
export function resetClassifierCaches() {
  scoreCache.clear()
}

/**
 * Classify one request.
 * @param request - `messages` (required) and optional `hasImage` override.
 * @returns the task type, its confidence, difficulty, tool need, and the evidence.
 */
export function classify(request = {}) {
  const messages = request.messages ?? []
  // Only genuine human turns count. Tool results and plugin-authored context are
  // user-ROLE on this harness, so role alone would misread them as the question.
  const userTurns = messages.filter(m => m?.role === 'user'
    && (m?.source?.kind === undefined || m.source.kind === 'user'))
  const userText = request.userText ?? messageText(userTurns.at(-1) ?? {})

  const current = scoreSignals(userText)
  const leader = bestOf(current.scores)
  let best = leader.type
  let bestScore = leader.score

  // History never votes. It can only supply a topic anchor, and only when the
  // current message says nothing on its own AND reads as a continuation AND the
  // conversation has not moved to a different subject since.
  let typeSource = 'current'
  let anchor = { type: null, score: 0, index: -1 }
  if (bestScore < ANCHOR_DEAD_ZONE) {
    const earlier = userTurns.slice(0, -1).map(messageText)
    if (earlier.length > 0 && CONTINUATION.test(userText)) {
      const found = findAnchor(earlier)
      if (found.type !== null) {
        best = found.type
        bestScore = found.score
        anchor = found
        typeSource = 'anchor'
      }
    }
  }

  // Nothing matched and nothing could be inherited. A SHORT line is small talk
  // only if it also reads like chatter; a short but dense question is a question.
  if (bestScore === 0) {
    const trimmed = userText.trim()
    best = trimmed.length <= 12 && CHATTER.test(trimmed) ? 'daily_chat' : 'knowledge_qa'
    typeSource = 'fallback'
  }

  const runnerUp = TYPE_ORDER.filter(t => t !== best)
    .reduce((max, t) => Math.max(max, current.scores.get(t) ?? 0), 0)
  const confidence = bestScore >= 5 && bestScore - runnerUp >= 3 ? 'high'
    : bestScore >= 3 ? 'medium' : 'low'

  const needsTools = request.needsTools ?? needsToolExecution(messages, userText)
  const difficulty = difficultyOf(userText, messages)

  return {
    type: best,
    confidence,
    difficulty,
    needsTools,
    hasImage: request.hasImage ?? hasImage(messages),
    scores: Object.fromEntries(current.scores),
    evidence: current.evidence.get(best) ?? [],
    userText,
    // Where the type came from. `anchor` means an earlier message supplied it, and
    // the recorded index is verifiable against the request that produced it — the
    // property a session-scoped cache could not offer.
    typeSource,
    anchorIndex: typeSource === 'anchor' ? anchor.index : -1,
    anchorScore: typeSource === 'anchor' ? anchor.score : 0,
    // Whether a configured specialty preference should apply to this turn.
    //
    // This used to read `difficulty !== 'trivial' || ALWAYS_BRAIN.has(type)`, and
    // the second clause was a mistake: it sent "优化下这段代码" — correctly judged
    // trivial — to the most expensive coder, a 33x price jump on a six-character
    // request. Difficulty cannot reliably separate a one-line hard bug from a
    // one-line easy one, and the honest response to that is to trust the cheap
    // default rather than override the user's price discipline with a brand list.
    // A deployment that wants the old behaviour opts into `config.alwaysBrainTypes`.
    brain: difficulty !== 'trivial',
  }
}