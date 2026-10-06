/**
 * Browser half of dsh-model-router: a "工作 / 闲聊" toggle in the composer.
 *
 * The toggle sits in the `conversation.input.activity` seat (between the model
 * selector and the send button) and submits the `/mode` slash command, which the
 * HOST half turns into a durable `model-router/mode` session event. The host's
 * routing reads that event; this bundle only owns the visible switch and keeps a
 * per-session optimistic copy in localStorage so a reload does not reset it.
 *
 * The routed model itself is reflected by the HOST half (it appends
 * `model/selection`), so the composer's model seat switches without any browser
 * code here.
 *
 * @module dsh-model-router/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-router',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var react = require('react')
    var jsx_runtime = require('react/jsx-runtime')

    var MODE_KEY = 'dsh-model-router.mode'

    function readStored(sessionId) {
      try {
        var raw = localStorage.getItem(MODE_KEY)
        if (!raw) return 'work'
        var map = JSON.parse(raw)
        return map[sessionId] === 'chat' ? 'chat' : 'work'
      } catch { return 'work' }
    }
    function writeStored(sessionId, mode) {
      try {
        var map = {}
        try { map = JSON.parse(localStorage.getItem(MODE_KEY) || '{}') } catch { /* reset */ }
        map[sessionId] = mode
        localStorage.setItem(MODE_KEY, JSON.stringify(map))
      } catch { /* never fatal */ }
    }

    function ModeToggle(props) {
      var sessionId = props.sessionId
      var select = props.select
      var initial = readStored(sessionId)
      var state = react.useState(initial)
      var mode = state[0]
      var setMode = state[1]
      var toggle = function () {
        var next = mode === 'chat' ? 'work' : 'chat'
        setMode(next)
        writeStored(sessionId, next)
        if (select) select(next)
      }
      return jsx_runtime.jsx('button', {
        type: 'button',
        onClick: toggle,
        title: mode === 'chat'
          ? '闲聊模式：优先免费模型（Space Bunny Free 优先）'
          : '工作模式：按问题类型选择最合适的模型',
        children: '⚡ ' + (mode === 'chat' ? '闲聊' : '工作'),
      })
    }

    var inject = ['sessions', 'slots']

    function apply(ctx) {
      var sessions = ctx.sessions
      var slots = ctx.slots
      var submit = async function (sessionId, mode) {
        try {
          var live = sessions.binding(sessionId)?.session
          if (live === void 0) return
          await live.command('/mode ' + mode)
        } catch { /* the host owns the durable write; never fatal */ }
      }
      slots.inject('conversation.input.activity', function () {
        return slots.register({
          name: 'conversation.input.activity',
          inject: function (sessionId) {
            return { select: function (mode) { submit(sessionId, mode) } }
          },
        }, ModeToggle)
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
