/**
 * Session-log access shared by the router's features.
 *
 * Reading a session's committed events is the one thing both the mode switch and
 * the small-talk style need, and getting it wrong fails SILENTLY: a scan over
 * `undefined` yields no matches and the feature just never fires. This module
 * keeps that access in one place, tolerant of the shapes the harness has used.
 *
 * @module dsh-model-router/session-events
 */

/**
 * The custom session event the "工作/闲聊" toggle writes. It is deliberately NOT
 * in the harness's known-event vocabulary: as an out-of-repo plugin event the
 * session layer keeps it as opaque metadata (no core reducer claims it), so it is
 * durable without being interpreted by anything but this plugin.
 */
export const MODE_EVENT = 'model-router/mode'

/**
 * A session's committed events, whichever accessor this harness build exposes.
 *
 * The live `Session` exposes an `events` getter (a frozen copy of its log). Some
 * views expose `snapshotEvents()` instead. Both are accepted; anything else
 * yields an empty array rather than throwing.
 *
 * @param session - a session-like object, or undefined when unavailable.
 * @returns the events in log order, possibly empty.
 */
export function sessionEvents(session) {
  try {
    if (session === null || session === undefined) return []
    if (Array.isArray(session.events)) return session.events
    if (typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents()
      if (Array.isArray(events)) return events
    }
    if (Array.isArray(session.log)) return session.log
  } catch { /* never fatal */ }
  return []
}

/**
 * The mode in force for a session: the most recent `model-router/mode` event, or
 * the configured default when the log carries none (or is unreachable).
 *
 * @param session - the session to read, or undefined.
 * @param fallback - the mode a session uses before it has ever been toggled.
 * @returns `'work'` or `'chat'`.
 */
export function modeOf(session, fallback = 'work') {
  const events = sessionEvents(session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type !== MODE_EVENT) continue
    return events[index]?.data?.mode === 'chat' ? 'chat' : 'work'
  }
  return fallback
}
