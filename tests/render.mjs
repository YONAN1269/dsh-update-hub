// Render smoke test — runs the client half outside DSH.
//
// There is no react-dom in the profile (the host bundles its own renderer), so
// this uses a minimal React stand-in: createElement builds a plain object tree,
// hooks are inert. That is enough to catch the failures that actually happen in
// this file — undefined references, a hook called conditionally, a component
// that throws on real rows — without pretending to be a browser.
//
// Usage: DSH_PROFILE_DIR=... node tests/render.mjs
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const requireFromProfile = createRequire(join(process.env.DSH_PROFILE_DIR || 'C:/Users/12691/.dsh/profiles/desktop', 'package.json'))

const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat() }
  },
  useReducer(init, initial) { return [initial, function () {}] },
  useEffect() {},
  useState(initial) { return [initial, function () {}] },
  useMemo(fn) { return fn() },
}

globalThis.window = {
  __ModuleLoader__: {
    load(config) {
      globalThis.__loaded = config.factory(function (name) {
        if (name === 'react') return React
        return requireFromProfile(name)
      })
    },
  },
  addEventListener() {},
  removeEventListener() {},
  setTimeout,
  clearTimeout,
}
globalThis.document = {
  querySelector() { return null },
  createElement() { return { setAttribute() {}, remove() {}, textContent: '' } },
  head: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
  visibilityState: 'visible',
}
globalThis.location = { pathname: '/', reload() { globalThis.__reloaded = true } }
globalThis.localStorage = {
  store: {},
  getItem(key) { return this.store[key] ?? null },
  setItem(key, value) { this.store[key] = String(value) },
}

const host = await import('../lib/index.js')
// Importing the client is what triggers `window.__ModuleLoader__.load`, which is
// the same entry point DSH uses.
await import('../lib/client.js')
const rows = await host.__internals.buildRows(false)
const pending = rows.filter((row) => row.available === true)
// Force a realistic mix: pretend the first two rows have an update and the
// third one has manifest drift, so the row component is exercised both ways.
const fixture = rows.map((row, index) => {
  if (index === 0) return { ...row, available: true, installed: '0.1.0', latest: '0.2.0' }
  if (index === 1) return { ...row, available: true, installed: '1.0.0', latest: '1.1.0' }
  if (index === 2) return { ...row, drift: true, declared: '1.0.0', installed: '1.0.3' }
  return row
})

globalThis.fetch = async function (url, options) {
  const method = String(url).split('/').pop()
  const body = {
    ok: true,
    rows: fixture,
    checkedAt: Date.now(),
    job: { state: 'idle', total: 0, index: 0, current: null, results: [], auto: false },
    settings: { checkOnBoot: true, checkIntervalHours: 12, idleUpdateMinutes: 0, reloadAfterIdleUpdate: true },
    presence: { online: true, idleSeconds: 12, lastActiveAt: Date.now() - 12000 },
    autoFinishedAt: 0,
    nextCheckAt: Date.now() + 3600000,
  }
  if (method === 'heartbeat') body.job = { state: 'running', total: 2, index: 1, current: 'dsh-better-sidebar', results: [], auto: true }
  return { ok: true, status: 200, text: async () => JSON.stringify(body) }
}

const client = globalThis.__loaded
const registered = []
const fakeCtx = {
  slots: {
    inject(name, callback) { callback() },
    register(spec, component) { registered.push({ spec, component }); return function () {} },
  },
  effect(fn) { fn() },
  get() { return this.slots },
}

await client.apply(fakeCtx)
console.log('注册的挂载点：', registered.map((entry) => entry.spec.name + (entry.spec.key ? ':' + entry.spec.key : '')).join(', '))

function render(node, depth) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => render(child, depth)).join('')
  if (typeof node.type === 'function') return render(node.type(Object.assign({}, node.props, { children: node.children })), depth + 1)
  const children = (node.children || []).concat(node.props && node.props.children ? node.props.children : [])
  return render(children, depth + 1)
}

let failures = 0
// The client refreshes 800ms after apply; wait past it so the components below
// render real rows rather than the boot state.
await new Promise((resolve) => setTimeout(resolve, 950))

for (const entry of registered) {
  try {
    const tree = entry.component({ size: 18, active: true, view: 'full' })
    const text = render(tree, 0).replace(/\s+/g, ' ').trim()
    console.log(`\n[${entry.spec.name}] 渲染成功，文本：`)
    console.log(text.slice(0, 320) || '(无文本)')
    const badge = JSON.stringify(tree).includes('duh-badge')
    console.log('含角标节点：', badge)
  } catch (error) {
    failures += 1
    console.error(`\n[${entry.spec.name}] 渲染失败：`, error && error.stack || error)
  }
}

// The store is warm by now; the summary view is what the plugin card shows.
const summary = registered.find((entry) => entry.spec.name === 'plugins.bundle.config')
if (summary) {
  try {
    console.log('\n插件卡摘要视图：', render(summary.component({ view: 'summary' }), 0))
  } catch (error) {
    failures += 1
    console.error('摘要视图渲染失败：', error && error.stack || error)
  }
}

console.log('\n结论：', failures === 0 ? '全部渲染通过' : failures + ' 处失败')
process.exit(failures === 0 ? 0 : 1)
