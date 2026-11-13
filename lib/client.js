window.__ModuleLoader__.load({
  id: 'dsh-update-hub',
  factory(require) {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports

    // dsh-update-hub — Client half.
    //
    // Three mounts, one store:
    //   1. sidebar.panellist — the rail icon. Always present, badge = pending
    //      count. Lives on the home screen too, unlike the composer dock.
    //   2. main — the page that icon navigates to.
    //   3. plugins.bundle.config — the same page on the plugin's own card.
    //
    // This half never installs anything and never decides when to install: the
    // host owns both. What it does own is presence — it is the only side that
    // can tell whether anyone is looking at DSH, which is what makes unattended
    // updating safe.

    var React = null
    try { React = require('react') } catch (error) { React = null }
    var RPC_BASE = '/_dsh/dsh-update-hub'
    var STYLE_ID = 'dsh-update-hub-style'
    var RAIL_ID = 'dsh-update-hub'
    var HEARTBEAT_MS = 30000
    // "Recently touched" window. Long enough that reading a paragraph does not
    // count as being away, short enough that a parked window does.
    var TOUCH_WINDOW_MS = 120000
    var RELOAD_STAMP_KEY = 'dsh-update-hub:auto-reload'

    var TEXT = {
      title: '插件更新',
      subtitle: function (pending, total) {
        return total === 0 ? '正在读取插件清单' : (pending > 0 ? pending + ' 个待更新 · 共 ' + total + ' 个' : '全部已是最新 · 共 ' + total + ' 个')
      },
      check: '重新检查',
      checking: '正在检查…',
      updateAll: '全部更新',
      cancel: '取消',
      reload: '重建界面',
      reloadTip: '重新加载界面，让刚装上的版本生效。正在跑的会话不受影响，进行中的任务会中断。',
      update: '更新',
      align: '对齐',
      alignTip: '把这版真实装着的版本写回清单，止住「反复提示有新版」',
      running: function (done, total, name) { return done + '/' + total + (name ? ' · 正在装 ' + name : '') },
      done: function (ok, fail) { return '成功 ' + ok + (fail > 0 ? ' · 失败 ' + fail : '') },
      doneHint: '装完点「重建界面」生效，不用重启 DSH',
      autoDoneHint: '空闲时已自动更新，点「重建界面」生效',
      failedNote: '商店提示「正在使用中」装不上的，用这里可以装上',
      latest: '已是最新',
      loadFailed: '读取失败：',
      retry: '重试',
      driftNote: '清单版本与磁盘不一致',
      updated: '已更新',
      failed: '失败：',
      confirmBusy: '已有任务在跑',
      lastCheck: function (text) { return '上次检查 ' + text },
      emptyPending: '没有待更新的插件',
      autoTitle: '自动化',
      autoHint: '自动更新的前提是没人用 DSH：有更新时才动手，装完等你回来再重建界面',
      bootCheck: '启动时检测',
      interval: '定时检测',
      idle: '空闲自动更新',
      idleRebuild: '空闲更新后自动重建',
      on: '开',
      off: '关',
      hours: function (n) { return n + ' 小时' },
      minutes: function (n) { return n + ' 分钟' },
      idleOff: '关',
      disabled: '关',
      presenceNow: function (s) {
        if (s === null) return '还没有界面连上来'
        if (s < 60) return '刚刚有人操作'
        var m = Math.round(s / 60)
        if (m < 60) return '已空闲 ' + m + ' 分钟'
        return '已空闲 ' + Math.round(m / 60) + ' 小时'
      },
      noTool: '找不到 DSH 自带的 pnpm，无法自动安装',
    }

    var INTERVAL_OPTIONS = [
      { value: 0, label: '关' },
      { value: 6, label: '6 小时' },
      { value: 12, label: '12 小时' },
      { value: 24, label: '24 小时' },
    ]
    var IDLE_OPTIONS = [
      { value: 0, label: '关' },
      { value: 10, label: '10 分钟' },
      { value: 30, label: '30 分钟' },
      { value: 60, label: '1 小时' },
      { value: 120, label: '2 小时' },
    ]

    // ------------------------------------------------------------------ styles

    function installStyles() {
      if (typeof document === 'undefined') return function () {}
      var existing = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')
      if (existing) return function () {}
      var style = document.createElement('style')
      style.setAttribute('data-plugin-css', STYLE_ID)
      // Every colour goes through a --dsw-alias-* variable with a translucent
      // fallback, so the panel follows the host theme instead of pinning its own
      // dark palette onto a light window.
      style.textContent = [
        // ---- rail icon + badge
        '.duh-rail{position:relative;display:inline-flex;align-items:center;justify-content:center;line-height:0}',
        '.duh-rail svg{display:block;transition:opacity .15s}',
        '.duh-badge{position:absolute;top:-5px;right:-6px;min-width:15px;height:15px;padding:0 4px;border-radius:8px;',
        'background:var(--dsw-alias-accent,#3F7DF6);color:#fff;font:600 9.5px/15px system-ui,sans-serif;',
        'text-align:center;font-variant-numeric:tabular-nums;pointer-events:none;',
        'box-shadow:0 0 0 1.5px var(--dsw-alias-bg-base,#15171c)}',
        '.duh-livedot{position:absolute;bottom:-2px;right:-2px;width:6px;height:6px;border-radius:50%;',
        'background:var(--dsw-alias-accent,#3F7DF6);animation:duh-pulse 1.4s ease-in-out infinite}',
        '@keyframes duh-pulse{0%,100%{opacity:1}50%{opacity:.3}}',

        // ---- page shell
        '.duh-main{display:block;box-sizing:border-box;width:100%;max-width:800px;padding:22px 24px 28px;margin:0 auto;',
        'color:var(--dsw-alias-text-1,inherit);font-size:13px}',
        '.duh-card{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));border-radius:14px;',
        'background:var(--dsw-alias-bg-subtle,rgba(127,127,127,.045));overflow:hidden}',
        '.duh-card + .duh-card{margin-top:14px}',

        // ---- header
        '.duh-head{display:flex;align-items:flex-start;gap:12px;padding:16px 18px 14px}',
        '.duh-headtext{min-width:0;flex:1 1 auto}',
        '.duh-title{font-size:15px;font-weight:600;letter-spacing:.01em}',
        '.duh-sub{margin-top:3px;font-size:12px;color:var(--dsw-alias-text-3,rgba(127,127,127,.9))}',
        '.duh-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto}',

        // ---- buttons
        '.duh-btn{font:inherit;font-size:12px;line-height:1.6;padding:5px 11px;border-radius:9px;cursor:pointer;',
        'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:transparent;color:inherit;',
        'white-space:nowrap;transition:background .12s,border-color .12s,opacity .12s}',
        '.duh-btn:hover:not(:disabled){background:var(--dsw-alias-bg-hover,rgba(127,127,127,.12))}',
        '.duh-btn:active:not(:disabled){transform:translateY(.5px)}',
        '.duh-btn:disabled{opacity:.4;cursor:default}',
        '.duh-btn[data-primary="true"]{border-color:transparent;background:var(--dsw-alias-accent,#3F7DF6);color:#fff}',
        '.duh-btn[data-primary="true"]:hover:not(:disabled){filter:brightness(1.08);background:var(--dsw-alias-accent,#3F7DF6)}',
        '.duh-btn[data-quiet="true"]{border-color:transparent;color:var(--dsw-alias-text-3,rgba(127,127,127,.95));padding:5px 7px}',
        '.duh-btn[data-small="true"]{padding:3px 9px;font-size:11.5px}',

        // ---- progress
        '.duh-progress{padding:0 18px 14px}',
        '.duh-progressrow{display:flex;align-items:baseline;gap:8px;font-size:12px;margin-bottom:7px}',
        '.duh-progressname{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11.5px;',
        'color:var(--dsw-alias-text-3,rgba(127,127,127,.9));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.duh-bar{height:5px;border-radius:3px;background:var(--dsw-alias-border-l2,rgba(127,127,127,.18));overflow:hidden}',
        '.duh-bar>i{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-accent,#3F7DF6);',
        'transition:width .35s ease}',

        // ---- list
        '.duh-list{display:flex;flex-direction:column}',
        '.duh-row{display:flex;align-items:center;gap:10px;padding:10px 18px;',
        'border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.13))}',
        '.duh-row:hover{background:var(--dsw-alias-bg-hover,rgba(127,127,127,.06))}',
        '.duh-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-accent,#3F7DF6)}',
        '.duh-dot[data-dim="true"]{background:var(--dsw-alias-border-l1,rgba(127,127,127,.4))}',
        '.duh-name{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;overflow:hidden;',
        'text-overflow:ellipsis;white-space:nowrap}',
        '.duh-vers{font-variant-numeric:tabular-nums;font-size:12px;color:var(--dsw-alias-text-3,rgba(127,127,127,.95));',
        'white-space:nowrap;flex:0 0 auto}',
        '.duh-arrow{color:var(--dsw-alias-text-3,rgba(127,127,127,.7));padding:0 3px}',
        '.duh-target{color:var(--dsw-alias-accent,#3F7DF6);font-weight:500}',
        '.duh-spacer{flex:1 1 auto;min-width:8px}',
        '.duh-state{font-size:11.5px;white-space:nowrap;flex:0 0 auto}',
        '.duh-ok{color:var(--dsw-alias-text-3,rgba(127,127,127,.9))}',
        '.duh-bad{color:var(--dsw-alias-danger,#D05252)}',
        '.duh-warn{color:var(--dsw-alias-warning,#C08A2E)}',

        // ---- footer notes
        '.duh-notes{padding:10px 18px 12px;display:flex;flex-direction:column;gap:4px;',
        'border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.13))}',
        '.duh-note{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-text-3,rgba(127,127,127,.9))}',
        '.duh-empty{padding:22px 18px;text-align:center;font-size:12px;',
        'color:var(--dsw-alias-text-3,rgba(127,127,127,.9))}',

        // ---- settings
        '.duh-sec{padding:15px 18px 16px}',
        '.duh-sectitle{font-size:12px;font-weight:600;letter-spacing:.02em;',
        'color:var(--dsw-alias-text-2,rgba(127,127,127,1));text-transform:none}',
        '.duh-sechint{margin-top:4px;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-text-3,rgba(127,127,127,.85))}',
        '.duh-field{display:flex;align-items:center;gap:10px;padding:9px 0 0}',
        '.duh-fieldlabel{font-size:12px;flex:0 0 108px}',
        '.duh-fieldhint{font-size:11px;color:var(--dsw-alias-text-3,rgba(127,127,127,.85));text-align:right;',
        'flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.duh-seg{display:inline-flex;flex:0 0 auto;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));',
        'border-radius:9px;overflow:hidden}',
        '.duh-seg>button{font:inherit;font-size:11.5px;line-height:1.5;padding:3px 9px;border:0;cursor:pointer;',
        'background:transparent;color:var(--dsw-alias-text-3,rgba(127,127,127,.95));',
        'border-left:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18))}',
        '.duh-seg>button:first-child{border-left:0}',
        '.duh-seg>button[data-on="true"]{background:var(--dsw-alias-accent,#3F7DF6);color:#fff}',
        '.duh-seg>button:hover:not([data-on="true"]){background:var(--dsw-alias-bg-hover,rgba(127,127,127,.12))}',
        '.duh-seg>button:disabled{opacity:.4;cursor:default}',

        // ---- compact variant used inside the plugin card
        '.duh-inline .duh-main{padding:0;max-width:none}',
      ].join('')
      document.head.appendChild(style)
      return function () { try { style.remove() } catch (error) { void error } }
    }

    // --------------------------------------------------------------------- rpc

    function rpc(method, body) {
      var controller = typeof AbortController === 'function' ? new AbortController() : null
      var timer = controller ? setTimeout(function () { controller.abort() }, 90000) : null
      return fetch(RPC_BASE + '/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: controller ? controller.signal : undefined,
      }).then(function (response) {
        return response.text().then(function (raw) {
          var parsed = null
          try { parsed = JSON.parse(raw) } catch (error) { parsed = null }
          if (!response.ok) throw new Error((parsed && parsed.error) || ('HTTP ' + response.status))
          if (parsed === null) throw new Error('响应解析失败')
          return parsed
        })
      }).finally(function () { if (timer !== null) clearTimeout(timer) })
    }

    // -------------------------------------------------------------------- diag

    // The browser half has no log. Capped and only sent on transitions: the
    // first version reported every poll and turned the file into 40KB of
    // identical lines within an hour.
    var diagSent = 0
    var diagLast = ''
    function diag(payload) {
      if (diagSent >= 40) return
      diagSent += 1
      try {
        rpc('diag', Object.assign({
          page: String(location && location.pathname || ''),
          hasReact: React !== null,
        }, payload)).catch(function () {})
      } catch (error) { void error }
    }
    function diagOnce(key, payload) {
      if (key === diagLast) return
      diagLast = key
      diag(payload)
    }

    // ------------------------------------------------------------------- store

    var store = {
      phase: 'loading',
      error: null,
      rows: [],
      job: null,
      checkedAt: 0,
      settings: null,
      presence: null,
      autoFinishedAt: 0,
      nextCheckAt: null,
      acting: false,
      notice: null,
      saving: false,
    }
    var listeners = new Set()
    var pollTimer = null
    var pollDelay = 0
    var heartbeatTimer = null

    function emit() { listeners.forEach(function (listener) { try { listener() } catch (error) { void error } }) }

    function pendingRows() {
      return store.rows.filter(function (row) { return row.available === true })
    }

    function driftRows() {
      return store.rows.filter(function (row) { return row.drift === true })
    }

    function applyState(payload) {
      if (!payload || payload.ok !== true) {
        store.phase = 'error'
        store.error = (payload && payload.message) || '读取失败'
        return
      }
      if (Array.isArray(payload.rows)) {
        store.rows = payload.rows
        store.checkedAt = payload.checkedAt || Date.now()
        store.phase = 'ready'
        store.error = null
        var pending = pendingRows().length
        diagOnce('ready:' + store.rows.length + ':' + pending, { step: 'state-ready', rows: store.rows.length, pending: pending })
      }
      if (payload.settings) store.settings = payload.settings
      if (payload.presence) store.presence = payload.presence
      if (typeof payload.autoFinishedAt === 'number') store.autoFinishedAt = payload.autoFinishedAt
      if (payload.nextCheckAt !== undefined) store.nextCheckAt = payload.nextCheckAt
      if (payload.job) store.job = payload.job
    }

    function refresh(silent) {
      if (!silent) { store.phase = store.rows.length > 0 ? 'ready' : 'loading' }
      return rpc('state', {}).then(function (payload) {
        applyState(payload)
        emit()
        maybeAutoReload()
      }).catch(function (error) {
        if (!silent) {
          store.phase = 'error'
          store.error = String((error && error.message) || error)
          emit()
        }
      })
    }

    function schedulePoll() {
      if (typeof window === 'undefined') return
      var running = store.job !== null && store.job.state === 'running'
      // Open panel polls often; a closed one only needs to keep the badge honest.
      var next = running ? 1500 : (store.open ? 20000 : 300000)
      if (pollTimer !== null && pollDelay === next) return
      if (pollTimer !== null) clearInterval(pollTimer)
      pollDelay = next
      pollTimer = setInterval(function () { refresh(true) }, next)
    }

    // ---------------------------------------------------------------- presence

    var lastTouchAt = 0

    function markTouch() { lastTouchAt = Date.now() }

    function attachActivity() {
      if (typeof window === 'undefined' || typeof document === 'undefined') return function () {}
      var targets = ['pointerdown', 'keydown', 'wheel', 'touchstart']
      var onActivity = function () { markTouch() }
      var onVisible = function () { if (document.visibilityState === 'visible') markTouch() }
      targets.forEach(function (name) { window.addEventListener(name, onActivity, { passive: true, capture: true }) })
      document.addEventListener('visibilitychange', onVisible)
      markTouch()
      return function () {
        targets.forEach(function (name) { window.removeEventListener(name, onActivity, { capture: true }) })
        document.removeEventListener('visibilitychange', onVisible)
      }
    }

    function presenceNow() {
      var visible = true
      try { visible = document.visibilityState !== 'hidden' } catch (error) { visible = true }
      return {
        visible: visible,
        touched: visible && (Date.now() - lastTouchAt < TOUCH_WINDOW_MS),
      }
    }

    /**
     * An unattended batch finished. Rebuild the page so the new code is what is
     * actually running — but only if nobody is in the middle of something, and
     * only once per batch (the stamp lives in localStorage, which survives the
     * reload this is about to trigger).
     */
    function maybeAutoReload() {
      if (!store.autoFinishedAt) return
      if (!store.settings || store.settings.reloadAfterIdleUpdate !== true) return
      var seen = null
      try { seen = localStorage.getItem(RELOAD_STAMP_KEY) } catch (error) { seen = null }
      if (seen !== null && Number(seen) >= store.autoFinishedAt) return
      // Only rebuild while the window is out of sight. A visible page might be
      // showing a streaming answer, and reloading it would cut that off — the
      // same reason the host refuses to install while visible.
      if (presenceNow().visible) return
      try { localStorage.setItem(RELOAD_STAMP_KEY, String(store.autoFinishedAt)) } catch (error) { void error }
      try { location.reload() } catch (error) { void error }
    }

    function startHeartbeat() {
      if (typeof window === 'undefined') return
      var beat = function () {
        var here = presenceNow()
        rpc('heartbeat', here).then(function (payload) {
          if (!payload || payload.ok !== true) return
          if (payload.job) store.job = payload.job
          if (payload.presence) store.presence = payload.presence
          if (typeof payload.autoFinishedAt === 'number') store.autoFinishedAt = payload.autoFinishedAt
          // A host-side batch can start without any click in this window; the
          // pulse of a running job is what tells the panel to start polling fast.
          if (payload.job && payload.job.state === 'running' && store.phase === 'ready') schedulePoll()
          emit()
          maybeAutoReload()
        }).catch(function () {})
      }
      beat()
      heartbeatTimer = setInterval(beat, HEARTBEAT_MS)
    }

    // ------------------------------------------------------------------ actions

    function start(payload) {
      store.acting = true
      store.notice = null
      emit()
      return rpc('run', payload).then(function (result) {
        store.acting = false
        if (result && result.job) store.job = result.job
        if (!result || result.ok !== true) {
          store.notice = (result && result.message) || '没能开始'
          emit()
          return
        }
        emit()
        schedulePoll()
        refresh(true)
      }).catch(function (error) {
        store.acting = false
        store.notice = String((error && error.message) || error)
        emit()
      })
    }

    function saveSettings(patch) {
      store.saving = true
      emit()
      return rpc('settings', patch).then(function (result) {
        store.saving = false
        if (result && result.settings) store.settings = result.settings
        emit()
      }).catch(function (error) {
        store.saving = false
        store.notice = String((error && error.message) || error)
        emit()
      })
    }

    function checkNow() {
      store.phase = 'loading'
      emit()
      rpc('check', {}).then(function (payload) {
        applyState(payload)
        emit()
      }).catch(function (error) {
        store.phase = 'error'
        store.error = String((error && error.message) || error)
        emit()
      })
    }

    function alignRow(name) {
      store.acting = true
      emit()
      rpc('align', { name: name }).then(function (result) {
        store.acting = false
        if (result && result.job) store.job = result.job
        if (!result || result.ok !== true) store.notice = (result && result.message) || '对齐失败'
        emit()
        schedulePoll()
        refresh(true)
      }).catch(function (error) {
        store.acting = false
        store.notice = String((error && error.message) || error)
        emit()
      })
    }

    // --------------------------------------------------------------- components

    var h = React ? React.createElement : null

    function useStore() {
      var force = React.useReducer(function (value) { return value + 1 }, 0)[1]
      React.useEffect(function () {
        listeners.add(force)
        return function () { listeners.delete(force) }
      }, [])
      return store
    }

    function timeText(ts) {
      if (!ts) return ''
      var date = new Date(ts)
      var pad = function (n) { return n < 10 ? '0' + n : String(n) }
      return pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    function jobSummary(job) {
      if (!job) return null
      var results = Array.isArray(job.results) ? job.results : []
      if (results.length === 0) return null
      var ok = results.filter(function (row) { return row.ok === true }).length
      return { ok: ok, fail: results.length - ok, total: results.length, auto: job.auto === true }
    }

    function Seg(props) {
      var value = props.value
      return h('div', { className: 'duh-seg', role: 'group' },
        props.options.map(function (option) {
          return h('button', {
            key: String(option.value),
            type: 'button',
            'data-on': option.value === value ? 'true' : 'false',
            disabled: props.disabled === true,
            onClick: function () { if (option.value !== value) props.onChange(option.value) },
          }, option.label)
        }))
    }

    function Field(props) {
      return h('div', { className: 'duh-field' },
        h('span', { className: 'duh-fieldlabel' }, props.label),
        h('span', { className: 'duh-spacer' }),
        props.hint ? h('span', { className: 'duh-fieldhint', title: props.hint }, props.hint) : null,
        props.children,
      )
    }

    function Toggle(props) {
      return h(Seg, {
        value: props.value === true,
        disabled: props.disabled,
        onChange: function (next) { props.onChange(next === true) },
        options: [{ value: true, label: TEXT.on }, { value: false, label: TEXT.off }],
      })
    }

    function Settings() {
      var state = useStore()
      var settings = state.settings
      if (!settings) return null
      var save = function (patch) { saveSettings(patch) }
      var idleHint = state.presence ? TEXT.presenceNow(state.presence.idleSeconds) : ''
      return h('div', { className: 'duh-sec' },
        h('div', { className: 'duh-sectitle' }, TEXT.autoTitle),
        h('div', { className: 'duh-sechint' }, TEXT.autoHint),
        h(Field, {
          label: TEXT.bootCheck,
          hint: settings.checkOnBoot ? '每次打开 DSH 查一次新版' : '',
        }, h(Toggle, {
          value: settings.checkOnBoot,
          disabled: state.saving,
          onChange: function (next) { save({ checkOnBoot: next }) },
        })),
        h(Field, {
          label: TEXT.interval,
          hint: state.nextCheckAt && settings.checkIntervalHours > 0 ? '下次 ' + timeText(state.nextCheckAt) : '',
        }, h(Seg, {
          value: settings.checkIntervalHours,
          disabled: state.saving,
          options: INTERVAL_OPTIONS,
          onChange: function (next) { save({ checkIntervalHours: next }) },
        })),
        h(Field, {
          label: TEXT.idle,
          hint: settings.idleUpdateMinutes > 0 ? idleHint : '',
        }, h(Seg, {
          value: settings.idleUpdateMinutes,
          disabled: state.saving,
          options: IDLE_OPTIONS,
          onChange: function (next) { save({ idleUpdateMinutes: next }) },
        })),
        settings.idleUpdateMinutes > 0
          ? h(Field, {
            label: TEXT.idleRebuild,
            hint: '回来时自动刷新，不用重启 DSH',
          }, h(Toggle, {
            value: settings.reloadAfterIdleUpdate,
            disabled: state.saving,
            onChange: function (next) { save({ reloadAfterIdleUpdate: next }) },
          }))
          : null,
      )
    }

    function Row(props) {
      var row = props.row
      var result = props.result
      var busy = props.busy
      var stateNode = null
      if (result) {
        stateNode = h('span', { className: 'duh-state ' + (result.ok ? 'duh-ok' : 'duh-bad') },
          result.ok ? TEXT.updated : (TEXT.failed + (result.message || '')))
      } else if (props.running === row.name) {
        stateNode = h('span', { className: 'duh-state duh-ok' }, '安装中…')
      } else if (row.available) {
        stateNode = h('span', { className: 'duh-vers' },
          String(row.installed || '?'),
          h('span', { className: 'duh-arrow' }, '→'),
          h('span', { className: 'duh-target' }, String(row.latest || '?')))
      } else if (row.drift) {
        // Saying "已是最新" next to an "对齐" button reads as a contradiction —
        // the disk version is current, it is the manifest that is behind.
        stateNode = h('span', { className: 'duh-vers', title: TEXT.alignTip },
          '清单 ', String(row.declared || '?'),
          h('span', { className: 'duh-arrow' }, '/'),
          '磁盘 ', String(row.installed || '?'))
      } else {
        stateNode = h('span', { className: 'duh-state duh-ok' }, TEXT.latest)
      }
      var action = null
      if (row.available) {
        action = h('button', {
          className: 'duh-btn',
          type: 'button',
          'data-small': 'true',
          disabled: busy,
          onClick: function () { start({ items: [{ name: row.name }] }) },
        }, TEXT.update)
      } else if (row.drift) {
        action = h('button', {
          className: 'duh-btn',
          type: 'button',
          'data-small': 'true',
          title: TEXT.alignTip,
          disabled: busy,
          onClick: function () { alignRow(row.name) },
        }, TEXT.align)
      }
      return h('div', { className: 'duh-row' },
        h('span', { className: 'duh-dot', 'data-dim': row.available ? 'false' : 'true' }),
        h('span', { className: 'duh-name', title: row.name }, row.name),
        h('span', { className: 'duh-spacer' }),
        stateNode,
        action,
      )
    }

    function Panel(props) {
      var state = useStore()
      var job = state.job
      var running = job !== null && job.state === 'running'
      var summary = jobSummary(job)
      var pending = pendingRows()
      var drift = driftRows()
      var busy = running || state.acting === true
      var settings = state.settings
      var listRows = state.rows.filter(function (row) {
        return row.available || row.drift || (job && Array.isArray(job.results) && job.results.some(function (r) { return r.name === row.name }))
      })
      var resultOf = function (name) {
        if (!job || !Array.isArray(job.results)) return null
        for (var i = job.results.length - 1; i >= 0; i -= 1) if (job.results[i].name === name) return job.results[i]
        return null
      }

      var head = h('div', { className: 'duh-head' },
        h('div', { className: 'duh-headtext' },
          h('div', { className: 'duh-title' }, TEXT.title),
          h('div', { className: 'duh-sub' },
            state.phase === 'ready' ? TEXT.subtitle(pending.length, state.rows.length) : TEXT.checking,
            state.phase === 'ready' && state.checkedAt ? ' · ' + TEXT.lastCheck(timeText(state.checkedAt)) : '')),
        h('div', { className: 'duh-actions' },
          running
            ? h('button', { className: 'duh-btn', type: 'button', onClick: function () { rpc('cancel', {}).catch(function () {}) } }, TEXT.cancel)
            : h('button', {
              className: 'duh-btn',
              type: 'button',
              'data-primary': 'true',
              disabled: busy || pending.length === 0,
              onClick: function () { start({ items: pending.map(function (row) { return { name: row.name } }) }) },
            }, TEXT.updateAll),
          h('button', {
            className: 'duh-btn',
            type: 'button',
            disabled: busy || state.phase === 'loading',
            onClick: checkNow,
          }, state.phase === 'loading' ? TEXT.checking : TEXT.check),
          h('button', {
            className: 'duh-btn',
            type: 'button',
            title: TEXT.reloadTip,
            disabled: running,
            onClick: function () { try { location.reload() } catch (error) { void error } },
          }, TEXT.reload),
        ))

      var progress = null
      if (running) {
        var done = Math.max(0, Math.min(job.index, job.total))
        progress = h('div', { className: 'duh-progress' },
          h('div', { className: 'duh-progressrow' },
            h('span', null, TEXT.running(done, job.total, '')),
            h('span', { className: 'duh-spacer' }),
            h('span', { className: 'duh-progressname' }, job.current ? '正在装 ' + job.current : '准备中')),
          h('div', { className: 'duh-bar' },
            h('i', { style: { width: (job.total > 0 ? Math.round((done / job.total) * 100) : 0) + '%' } })))
      }

      var body
      if (state.phase === 'loading' && state.rows.length === 0) {
        body = h('div', { className: 'duh-empty' }, TEXT.checking)
      } else if (state.phase === 'error') {
        body = h('div', { className: 'duh-empty' },
          h('div', { className: 'duh-bad' }, TEXT.loadFailed + state.error),
          h('button', { className: 'duh-btn', type: 'button', style: { marginTop: '10px' }, onClick: function () { refresh(false) } }, TEXT.retry))
      } else if (listRows.length === 0) {
        body = h('div', { className: 'duh-empty' }, TEXT.emptyPending)
      } else {
        body = h('div', { className: 'duh-list' },
          listRows.map(function (row) {
            return h(Row, {
              key: row.name,
              row: row,
              result: resultOf(row.name),
              busy: busy,
              running: running ? job.current : null,
            })
          }))
      }

      var notes = []
      if (running) notes.push(h('div', { className: 'duh-note', key: 'run' }, TEXT.doneHint))
      if (summary && !running) notes.push(h('div', { className: 'duh-note', key: 'done' }, summary.auto ? TEXT.autoDoneHint : TEXT.doneHint))
      if (state.notice) notes.push(h('div', { className: 'duh-note duh-bad', key: 'notice' }, state.notice))
      if (pending.length > 0 && !running) notes.push(h('div', { className: 'duh-note', key: 'hint' }, TEXT.failedNote))
      if (drift.length > 0 && pending.length === 0) notes.push(h('div', { className: 'duh-note duh-warn', key: 'drift' }, '有 ' + drift.length + ' 个插件的清单版本和磁盘不一致'))

      return h('div', null,
        h('div', { className: 'duh-card' },
          head,
          progress,
          body,
          notes.length > 0 ? h('div', { className: 'duh-notes' }, notes) : null),
        settings ? h('div', { className: 'duh-card' }, h(Settings)) : null,
      )
    }

    /**
     * The sidebar rail icon.
     *
     * Always present, badge only when something is pending. A marker that hides
     * itself when there is nothing to report cannot be told apart from a broken
     * one — and the rail exists on the home screen too, unlike the composer dock,
     * which only renders inside a conversation that has content.
     */
    function RailIcon(props) {
      var state = useStore()
      React.useEffect(function () {
        diag({ step: 'rail-render', phase: state.phase, pending: pendingRows().length })
      }, [])
      var size = props && typeof props.size === 'number' ? props.size : 18
      var count = pendingRows().length
      var running = state.job !== null && state.job.state === 'running'
      var active = !!(props && props.active)
      return h('span', {
        className: 'duh-rail',
        style: { width: size + 'px', height: size + 'px' },
        title: count > 0 ? count + ' 个插件待更新' : (state.phase === 'loading' ? '正在检查插件更新' : '插件已是最新'),
      },
      h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        style: { opacity: active ? 1 : 0.75 },
      },
      h('path', { d: 'M8 2.8v6.3' }),
      h('path', { d: 'M5.1 6.3 8 9.2l2.9-2.9' }),
      h('path', { d: 'M3.2 12.6h9.6' })),
      count > 0 ? h('span', { className: 'duh-badge' }, count > 99 ? '99+' : String(count)) : null,
      running ? h('span', { className: 'duh-livedot' }) : null,
      )
    }

    /** The main-area page the rail icon navigates to. */
    function MainPanel() {
      // `store.open` means "somebody is looking at the panel". It is what makes
      // the poll fast while the page is up and slow when only the badge is.
      React.useEffect(function () {
        store.open = true
        schedulePoll()
        if (store.phase !== 'ready') refresh(false)
        return function () { store.open = false; schedulePoll() }
      }, [])
      return h('div', { className: 'duh-main' }, h(Panel, { closable: false }))
    }

    function BundleConfig(props) {
      var view = props && props.view
      // Hooks run before any early return: the same component is used for the
      // summary view and the full one, and a conditional hook would change the
      // order between the two renders.
      React.useEffect(function () {
        if (view === 'summary') return undefined
        store.open = true
        schedulePoll()
        if (store.phase !== 'ready') refresh(true)
        return function () { store.open = false; schedulePoll() }
      }, [view])
      if (view === 'summary') {
        var pending = pendingRows().length
        return h('span', null, pending > 0 ? pending + ' 个插件待更新' : '全部已是最新')
      }
      return h('div', { className: 'duh-main' }, h(Panel, { closable: false }))
    }

    // -------------------------------------------------------------------- apply

    var started = false

    module.exports = {
      inject: ['slots'],
      // async: `slots` can be injected after apply starts. Reading it once and
      // bailing out is a silent no-op — the panel never registers and nothing
      // ever tells the user why. Wait for it instead, like the other bundles do.
      async apply(ctx) {
        diag({ step: 'apply-enter' })
        var slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
        for (var wait = 0; (!slots || typeof slots.register !== 'function') && wait < 45; wait += 1) {
          await new Promise(function (resolve) { setTimeout(resolve, Math.min(300 + wait * 20, 1000)) })
          slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
        }
        if (!slots || typeof slots.register !== 'function') {
          try { console.warn('[dsh-update-hub] slots 服务 45s 内未就绪，面板未注册') } catch (error) { void error }
          diag({ step: 'no-slots', waited: wait })
          return
        }
        if (!React) {
          try { console.warn('[dsh-update-hub] react 不可用，面板未注册') } catch (error) { void error }
          diag({ step: 'no-react' })
          return
        }
        // A client bundle can be applied twice in one page (a hot reload after the
        // files change). The second run must not register a second marker.
        var ownerKey = '__dshUpdateHubOwner'
        if (started || window[ownerKey] === true) { diag({ step: 'already-applied' }); return }
        started = true
        try { window[ownerKey] = true } catch (error) { void error }

        var detachActivity = attachActivity()

        if (typeof ctx.effect === 'function') {
          ctx.effect(function () { return installStyles() }, 'dsh-update-hub: styles')
          ctx.effect(function () {
            return function () {
              if (pollTimer !== null) clearInterval(pollTimer)
              pollTimer = null
              if (heartbeatTimer !== null) clearInterval(heartbeatTimer)
              heartbeatTimer = null
              try { detachActivity() } catch (error) { void error }
              try { window[ownerKey] = false } catch (error) { void error }
              started = false
            }
          }, 'dsh-update-hub: presence')
        } else {
          installStyles()
        }

        // Presence first: the host's unattended-update policy depends on knowing
        // whether anybody is here, and that answer must exist before the first
        // read. The read itself is deliberately NOT silent — a failure here used
        // to leave `phase` at 'loading' forever, which renders no marker at all
        // and looks exactly like "the plugin did not install".
        startHeartbeat()
        setTimeout(function () {
          refresh(false).then(schedulePoll, schedulePoll)
        }, 800)

        // Registration failures are swallowed by the slot service (an unknown slot
        // name simply never fires), so each one reports itself.
        //
        // The rail icon is the primary entry: `sidebar.panellist` turns one entry
        // into a permanent sidebar icon, and pairing it with a `main` key is how
        // DSH navigates — clicking the icon opens the page on the right. The
        // composer dock is gone on purpose: it only exists inside a conversation
        // with content, so on the home screen the feature simply was not there.
        slots.inject('sidebar.panellist', function () {
          try {
            var disposeRail = slots.register(
              { name: 'sidebar.panellist', id: RAIL_ID, order: 40, label: function () { return TEXT.title } },
              RailIcon,
            )
            diag({ step: 'rail-registered' })
            return disposeRail
          } catch (error) {
            diag({ step: 'rail-failed', message: String((error && error.message) || error) })
            return undefined
          }
        })

        slots.inject('main', function () {
          try {
            var disposeMain = slots.register({ name: 'main', key: RAIL_ID, order: 40 }, MainPanel)
            diag({ step: 'main-registered' })
            return disposeMain
          } catch (error) {
            diag({ step: 'main-failed', message: String((error && error.message) || error) })
            return undefined
          }
        })

        slots.inject('plugins.bundle.config', function () {
          try {
            var disposeConfig = slots.register(
              // Keyed slot: DSH validates `key` (the bundle package name), not `id`.
              { name: 'plugins.bundle.config', key: 'dsh-update-hub', label: function () { return TEXT.title } },
              BundleConfig,
            )
            diag({ step: 'config-registered' })
            return disposeConfig
          } catch (error) {
            diag({ step: 'config-failed', message: String((error && error.message) || error) })
            return undefined
          }
        })

        diag({ step: 'apply-done' })
      },
    }

    void TEXT.noTool
    return module.exports
  },
})
