/**
 * Small-talk style control.
 *
 * The router already bounds small-talk length at the wire level (`maxTokens`),
 * which is a hard guarantee. This module adds the part a bound cannot express:
 * tone. It contributes a system-prompt section that appears ONLY on turns the
 * classifier calls small talk, so nothing else in the deployment is affected.
 *
 * Correlating the section with the current turn is the whole trick. The
 * assembly hook's `AssembleContext` carries no conversation, but its `scope` is
 * the Agent (see `assembleContextFor` in @deepseek-ai/dsh-agent), and an Agent
 * exposes `.session`. Reading the latest user message off that session is
 * therefore turn-accurate, with no cross-session bookkeeping.
 *
 * @module dsh-model-router/chitchat-style
 */
import { classify, messageText } from './classify.mjs'
import { sessionEvents } from './session-events.mjs'

/** Section name; stable so a deployment can shadow or replace it. */
export const STYLE_SECTION = 'model-router:chitchat-style'

/** Rendered after the tool-guidance band, as a final formatting instruction. */
export const STYLE_ORDER = 180

/** The directive itself: brief, spoken, no document furniture. */
export const STYLE_DIRECTIVE = [
  '闲聊模式：本轮是日常闲聊，不是任务。像在微信上跟朋友聊天那样回答——一两句话、口语化、直接说结论。',
  '不要用标题、编号、项目符号、表格或加粗；不要写「首先/其次/总的来说」；不要主动扩写成文章或罗列方案。',
  '除非对方明确要求展开，否则控制在 100 字以内。',
].join('\n')

/**
 * The most recent genuine user message in a session.
 *
 * Skips plugin-authored context and tool results: both are user-role messages
 * on this harness, but neither is the human talking.
 * @param session - the agent's session, if reachable.
 * @returns the latest user text, or '' when there is none.
 */
export function latestUserText(session) {
  const events = sessionEvents(session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    if (event.data?.source?.kind !== 'user') continue
    return messageText(event.data)
  }
  return ''
}

/**
 * The section text for one assembly: the directive on small talk, empty otherwise.
 *
 * Returning '' is what keeps the section out of every other prompt — the
 * renderer drops empty sections, so a task turn's prompt is byte-identical to
 * one assembled without this plugin.
 *
 * @param assemblyContext - the hook's context; `scope` is the Agent.
 * @param config - the router config.
 * @returns the directive, or '' when this turn is not small talk.
 */
export function chitchatStyleFor(assemblyContext, config) {
  const settings = config?.chitchatStyle
  if (settings?.enabled === false) return ''
  const text = latestUserText(assemblyContext?.scope?.session)
  if (text.length === 0) return ''
  const casual = config?.casual?.types ?? ['daily_chat']
  const verdict = classify({ messages: [], userText: text })
  if (!casual.includes(verdict.type)) return ''
  // A small-talk turn that still needs tools is not small talk.
  if (verdict.needsTools) return ''
  return settings?.directive ?? STYLE_DIRECTIVE
}

/**
 * Register the section on a context that owns `systemPrompt`.
 *
 * Kept separate from `apply` so the router still works in a deployment with no
 * system-prompt service: the style feature degrades to absent, not fatal.
 *
 * @param ctx - a context whose `systemPrompt.section` is callable.
 * @param config - the router config.
 * @returns the disposer, or undefined when no service was reachable.
 */
export function installChitchatStyle(ctx, config) {
  const prompt = ctx?.systemPrompt
  if (typeof prompt?.section !== 'function') return undefined
  return prompt.section({
    name: STYLE_SECTION,
    order: STYLE_ORDER,
    text: assemblyContext => chitchatStyleFor(assemblyContext, config),
  })
}
