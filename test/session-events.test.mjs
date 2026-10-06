// Locks the session-log access the mode switch depends on. The first test uses the
// REAL SessionStore + Session, because the original bug was exactly this seam:
// a wrong accessor silently yields no events, so the mode never left its default.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { MODE_EVENT, modeOf, sessionEvents } from '../lib/session-events.mjs'

const HOME = process.env.USERPROFILE.replace(/\\/g, '/')
const NM = `${HOME}/.dsh/profiles/node_modules`
const { Context } = await import(pathToFileURL(`${NM}/@deepseek-ai/cordis/lib/index.js`).href)
const { SessionStore } = await import(pathToFileURL(`${NM}/@deepseek-ai/dsh-session/lib/index.js`).href)

test('a real session reports the mode written to its log', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const sessions = ctx.get('sessions')
  assert.ok(sessions, 'the sessions service must resolve')

  const session = sessions.create('session-mode-probe', { meta: { cwd: process.cwd() } })
  assert.equal(modeOf(sessions.get(session.id), 'work'), 'work', 'no event means the default')

  session.append(MODE_EVENT, { mode: 'chat' })
  assert.equal(modeOf(sessions.get(session.id), 'work'), 'chat', 'the appended mode must be read back')

  // Most recent wins, so re-toggling back to work is observed too.
  session.append(MODE_EVENT, { mode: 'work' })
  assert.equal(modeOf(sessions.get(session.id), 'chat'), 'work')
})

test('sessionEvents reads every shape the harness has exposed', () => {
  const events = [{ type: 'user/message', data: {} }]
  assert.deepEqual(sessionEvents({ events }), events, 'the live Session exposes `events`')
  assert.deepEqual(sessionEvents({ snapshotEvents: () => events }), events, 'a view may expose snapshotEvents()')
  assert.deepEqual(sessionEvents({ log: events }), events, 'the raw log array also works')
  assert.deepEqual(sessionEvents(undefined), [], 'an unreachable session yields no events, never a throw')
  assert.deepEqual(sessionEvents({ events: 'nonsense' }), [], 'a non-array accessor yields no events')
})

test('modeOf falls back when the log carries no mode event', () => {
  assert.equal(modeOf(undefined, 'work'), 'work')
  assert.equal(modeOf(undefined, 'chat'), 'chat', 'the configured default is the fallback')
  assert.equal(modeOf({ events: [{ type: 'user/message', data: {} }] }, 'work'), 'work')
})

test('modeOf treats any value other than chat as work', () => {
  assert.equal(modeOf({ events: [{ type: MODE_EVENT, data: { mode: 'chat' } }] }), 'chat')
  assert.equal(modeOf({ events: [{ type: MODE_EVENT, data: { mode: 'WORK' } }] }), 'work')
  assert.equal(modeOf({ events: [{ type: MODE_EVENT, data: {} }] }), 'work')
})
