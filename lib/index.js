// dsh-update-hub — Host half.
//
// Why this file exists: the plugin market's update path removes the old package
// first (`removeBundle`), and the desktop app refuses to remove a package that a
// live fiber is using (`bundle-in-use`). Every enabled plugin is in use, so the
// market's update button fails for exactly the plugins you want to update.
//
// This half takes the other road: `pnpm add <name>@<exact> --save-exact` from
// the profile directory. That is the install side only — no removal — so it
// works while the plugin runs, and it advances the manifest in the same step.
// That last part is the second bug it fixes by construction: a plugin that
// writes its own files into node_modules but never touches the manifest
// (dsh-bottom-info-bar, 1.23.0 declared / 1.24.3 on disk) looks like "an update
// is available" forever.
//
// Routes are mounted on the web server under /_dsh/dsh-update-hub/<method>,
// the same shape dsh-bottom-info-bar uses. Auth is the connection service's own
// requestRejection(), which is the shared web/desktop boundary — reproducing the
// browser-header check here would reject legitimate desktop requests.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const PKG = 'dsh-update-hub'
const ROUTE_PREFIX = '/_dsh/' + PKG
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000
const REGISTRY_TIMEOUT_MS = 5000
// 45 dependencies fired at once is what makes a cold check take minutes: the
// registry starts queueing (and eventually throttles) the burst, so every single
// request sits near its own timeout. Eight at a time finishes the whole sweep in
// seconds instead. The client is told to wait up to 90s, so this stays well
// inside the budget.
const CHECK_CONCURRENCY = 8
const BODY_LIMIT = 64 * 1024
// Scheduler heartbeat. One minute is fine granularity for "every N hours" and
// cheap: the tick only reads in-memory timestamps until something is due.
const TICK_MS = 60 * 1000
// Nothing automatic happens this soon after boot. A cold host that has not yet
// heard from a single client cannot tell "nobody is using DSH" apart from "the
// window is still coming up", and guessing wrong means installing underneath
// someone who is in the middle of starting a session.
const BOOT_GRACE_MS = 5 * 60 * 1000
// A client that has been silent this long is treated as gone, not idle. Without
// it, closing the window would freeze lastActiveAt in the past and the very next
// tick would see "idle since 17:02" on an app that is no longer open.
const HEARTBEAT_STALE_MS = 5 * 60 * 1000
// Reasons a dependency row is not ours to update. `link:` and `file:` are local
// development mounts whose version comes from the working tree, not the registry.
const DEV_SPEC = /^(link:|file:|workspace:|git\+|git:|\.{0,2}\/)/i

const MUTATING = new Set(['run', 'cancel', 'check', 'align', 'settings', 'heartbeat'])

// ---------------------------------------------------------------- environment

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function dataDir() {
  const dir = join(dshHome(), PKG)
  try { mkdirSync(dir, { recursive: true }) } catch (error) { void error }
  return dir
}

/**
 * The profile this plugin was loaded from.
 *
 * DSH_PROFILE_DIR is set by the launcher; when it is absent (tests, a bare
 * `node` run) walk up from here looking for the profile manifest, then fall back
 * to the default profile. Every path this module writes is resolved from the
 * result, so a wrong value would be silent and destructive — read it once and
 * keep it.
 */
let cachedProfileDir = null
function profileDir() {
  if (cachedProfileDir !== null) return cachedProfileDir
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (fromEnv && existsSync(join(fromEnv, 'package.json'))) {
    cachedProfileDir = resolve(fromEnv)
    return cachedProfileDir
  }
  let dir = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  for (let i = 0; i < 10 && dir; i += 1) {
    if (existsSync(join(dir, 'node_modules'))) {
      cachedProfileDir = dir
      return cachedProfileDir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  cachedProfileDir = join(dshHome(), 'profiles', 'desktop')
  return cachedProfileDir
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (error) { void error; return fallback }
}

function writeJson(file, value) {
  const tmp = file + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

/** Declared dependency map of the profile, or an empty object. */
function profileDeps() {
  const manifest = readJson(join(profileDir(), 'package.json'), null)
  const deps = manifest && manifest.dependencies
  return deps && typeof deps === 'object' ? deps : {}
}

function installedVersion(name) {
  const pkg = readJson(join(profileDir(), 'node_modules', name, 'package.json'), null)
  return pkg && typeof pkg.version === 'string' ? pkg.version : null
}

// --------------------------------------------------------------------- semver
// Deliberately minimal: DSH plugins are plain x.y.z with an optional prerelease.
// A full implementation would be a dependency, and a dependency in a plugin that
// installs dependencies is a liability.

function parseVer(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value || ''))
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] || '' }
}

export function compareVersions(a, b) {
  const left = parseVer(a)
  const right = parseVer(b)
  if (left === null || right === null) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1
  }
  // A release outranks any prerelease of the same x.y.z; two prereleases compare
  // lexically, which is wrong in theory and harmless for the plugins here.
  if (left.pre === right.pre) return 0
  if (left.pre === '') return 1
  if (right.pre === '') return -1
  return left.pre > right.pre ? 1 : -1
}

// ---------------------------------------------------------------------- tools

let cachedTool = null

/**
 * Locate the node + pnpm that ship with DSH.
 *
 * process.execPath is the bundled node when the host runs under it, so the pnpm
 * that belongs to the same runtime is two levels up: dependencies/pnpm/bin.
 * The fixed candidates cover the two layouts on this machine (app resources and
 * ~/.dsh/dsh-runtimes) for when the host is launched by something else.
 */
export function findTool() {
  if (cachedTool !== null) return cachedTool
  const explicit = process.env.DSH_UPDATE_HUB_PNPM
  const bases = []
  if (explicit) bases.push(dirname(dirname(dirname(explicit))))
  bases.push(dirname(dirname(dirname(process.execPath))))
  const appRoot = process.env.DSH_APP_ROOT || 'D:\\program\\harness'
  bases.push(join(appRoot, 'resources', 'runtime', 'primary-runtime', 'dependencies'))
  bases.push(join(dshHome(), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies'))

  for (const base of bases) {
    const node = join(base, 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
    const pnpm = join(base, 'pnpm', 'bin', 'pnpm.cjs')
    if (existsSync(pnpm) && (existsSync(node) || explicit === pnpm)) {
      cachedTool = { node: existsSync(node) ? node : process.execPath, pnpm, how: 'bundled' }
      return cachedTool
    }
  }
  cachedTool = { node: null, pnpm: null, how: 'missing' }
  return cachedTool
}

// ------------------------------------------------------------------- registry

let latestCache = null

function latestCacheFile() {
  return join(dataDir(), 'latest-cache.json')
}

function loadLatestCache() {
  if (latestCache === null) latestCache = readJson(latestCacheFile(), {}) || {}
  return latestCache
}

function saveLatestCache() {
  try { writeJson(latestCacheFile(), latestCache || {}) } catch (error) { void error }
}

/** Registry path for a package name: scoped names keep their %2F separator. */
function registryPath(name) {
  return 'https://registry.npmjs.org/' + encodeURIComponent(name).replace(/^%40/, '@')
}

async function fetchLatest(name) {
  const response = await fetch(registryPath(name) + '/latest', {
    headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  })
  if (!response.ok) {
    const error = new Error('registry ' + response.status)
    error.status = response.status
    throw error
  }
  const body = await response.json()
  return typeof body.version === 'string' ? body.version : null
}

// A registry that is down must not be hammered by the 20s panel poll. Failures
// are stamped into the cache and skipped until this expires; an explicit
// "check now" ignores the stamp, because the user asking again is a decision.
const FAIL_BACKOFF_MS = 3 * 60 * 1000

async function latestFor(name, force) {
  const cache = loadLatestCache()
  const hit = cache[name]
  if (!force && hit && typeof hit.failedAt === 'number' && Date.now() - hit.failedAt < FAIL_BACKOFF_MS) {
    return { latest: typeof hit.latest === 'string' ? hit.latest : null, error: hit.error || 'registry 暂不可用', cached: true }
  }
  if (!force && hit && typeof hit.latest === 'string' && Date.now() - hit.at < CACHE_TTL_MS) {
    return { latest: hit.latest, error: null, cached: true }
  }
  try {
    const latest = await fetchLatest(name)
    cache[name] = { latest, at: Date.now() }
    return { latest, error: null, cached: false }
  } catch (error) {
    // Keep the previous answer if the registry is unreachable: a stale version is
    // more useful than an empty row, as long as the caller can tell.
    const message = String((error && error.message) || error)
    cache[name] = Object.assign({}, hit, { failedAt: Date.now(), error: message })
    return { latest: hit ? hit.latest : null, error: message, cached: true }
  }
}

// ----------------------------------------------------------------------- rows

let lastCheckAt = 0

/**
 * One row per declared, registry-installed dependency.
 *
 * `installed` is read from node_modules — never from the manifest. That is the
 * whole point: the manifest can say 1.23.0 while 1.24.3 is on disk, and a
 * updater that trusts the manifest will offer the same version forever.
 */
// Bounded concurrency. `Promise.all` over 45 registry lookups is not "parallel",
// it is a burst the registry answers by making everyone wait.
async function mapPool(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = []
  const size = Math.max(1, Math.min(limit, items.length))
  for (let i = 0; i < size; i += 1) {
    runners.push((async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= items.length) return
        results[index] = await worker(items[index], index)
      }
    })())
  }
  await Promise.all(runners)
  return results
}

let inflightBuild = null

async function buildRows(force) {
  // The panel polls while it is open; without this, two overlapping calls each
  // sweep the registry and the second one wins the cache for no reason.
  if (inflightBuild !== null) return inflightBuild
  inflightBuild = collectRows(force)
  try { return await inflightBuild } finally { inflightBuild = null }
}

async function collectRows(force) {
  const deps = profileDeps()
  const names = Object.keys(deps).filter((name) => !DEV_SPEC.test(String(deps[name])))
  const results = await mapPool(names, CHECK_CONCURRENCY, async (name) => {
    const declared = String(deps[name])
    const installed = installedVersion(name)
    const { latest, error } = await latestFor(name, force)
    const available = installed !== null && latest !== null && compareVersions(latest, installed) > 0
    return {
      name,
      declared,
      installed,
      latest,
      available,
      // Declared-and-installed disagreement. Not fatal, but it is why a plugin
      // keeps announcing an update it already has.
      drift: installed !== null && declared.replace(/^[\^~]/, '') !== installed,
      error,
    }
  })
  results.sort((a, b) => a.name.localeCompare(b.name))
  lastCheckAt = Date.now()
  saveLatestCache()
  return results
}

// ------------------------------------------------------------------- settings

/**
 * What the panel is allowed to change.
 *
 * Values are enumerated instead of free-form on purpose: this object drives an
 * unattended installer, so a typo (`checkIntervalHours: 0.5`) must be rejected
 * rather than turned into a one-minute registry sweep.
 */
const DEFAULT_SETTINGS = {
  checkOnBoot: true,
  checkIntervalHours: 12,
  idleUpdateMinutes: 0,
  reloadAfterIdleUpdate: true,
}
const ALLOWED = {
  checkIntervalHours: [0, 3, 6, 12, 24],
  idleUpdateMinutes: [0, 10, 30, 60, 120],
}

let settingsCache = null

function settingsFile() {
  return join(dataDir(), 'settings.json')
}

function loadSettings() {
  if (settingsCache !== null) return settingsCache
  const raw = readJson(settingsFile(), {}) || {}
  const next = Object.assign({}, DEFAULT_SETTINGS)
  if (typeof raw.checkOnBoot === 'boolean') next.checkOnBoot = raw.checkOnBoot
  if (typeof raw.reloadAfterIdleUpdate === 'boolean') next.reloadAfterIdleUpdate = raw.reloadAfterIdleUpdate
  // A hand-edited file must not be able to widen the enum, so unknown numbers
  // fall back to the default instead of being trusted.
  if (ALLOWED.checkIntervalHours.includes(raw.checkIntervalHours)) next.checkIntervalHours = raw.checkIntervalHours
  if (ALLOWED.idleUpdateMinutes.includes(raw.idleUpdateMinutes)) next.idleUpdateMinutes = raw.idleUpdateMinutes
  settingsCache = next
  return settingsCache
}

/** Merge a patch, clamping every field to the enum above. Returns the new set. */
function patchSettings(patch) {
  const next = Object.assign({}, loadSettings())
  if (patch && typeof patch === 'object') {
    if (typeof patch.checkOnBoot === 'boolean') next.checkOnBoot = patch.checkOnBoot
    if (typeof patch.reloadAfterIdleUpdate === 'boolean') next.reloadAfterIdleUpdate = patch.reloadAfterIdleUpdate
    if (ALLOWED.checkIntervalHours.includes(patch.checkIntervalHours)) next.checkIntervalHours = patch.checkIntervalHours
    if (ALLOWED.idleUpdateMinutes.includes(patch.idleUpdateMinutes)) next.idleUpdateMinutes = patch.idleUpdateMinutes
  }
  settingsCache = next
  try { writeJson(settingsFile(), next) } catch (error) { void error }
  return next
}

// ------------------------------------------------------------------- presence
// Who is looking at DSH right now. The client half is the only thing that can
// answer that, so it reports in; this half just remembers the timestamps.

const bootedAt = Date.now()
let lastSeenAt = 0
let lastActiveAt = 0
let lastVisible = null

/**
 * - `seen`   any heartbeat; proves a window is open somewhere.
 * - `active` the window was visible and recently touched. Only this one pushes
 *            the idle clock back — a DSH parked on a second monitor is "seen"
 *            but not "in use", and that is precisely when updating is safe.
 * - `visible` the last reported visibility. A visible window is never updated
 *            underneath, however long the mouse has been still: streaming agent
 *            output looks exactly like an idle screen from here.
 */
function noteHeartbeat(body) {
  const now = Date.now()
  lastSeenAt = now
  const visible = body && body.visible === true
  const touched = body && body.touched === true
  if (body && typeof body.visible === 'boolean') lastVisible = visible
  if (visible && touched) lastActiveAt = now
}

function presence() {
  const now = Date.now()
  const online = lastSeenAt > 0 && now - lastSeenAt < HEARTBEAT_STALE_MS
  const sinceActive = lastActiveAt > 0 ? now - lastActiveAt : null
  return {
    bootedAt,
    lastSeenAt,
    lastActiveAt,
    // Null until the first heartbeat says otherwise. "Unknown" must not be read
    // as "hidden" — that would let an update run before anything connected.
    visible: lastVisible,
    online,
    // Seconds with no visible+touched heartbeat. Null means "never seen one",
    // which callers must treat as unknown rather than as infinitely idle.
    idleSeconds: sinceActive === null ? null : Math.round(sinceActive / 1000),
  }
}

// ------------------------------------------------------------------------ job

/**
 * A single install job at a time.
 *
 * Two concurrent `pnpm add` runs in the same profile rewrite each other's
 * node_modules and lockfile; that is how an update ends up "interrupted". The
 * route refuses a second start instead of queueing, because a queue would let a
 * click look accepted and then do nothing for minutes.
 */
let job = null

function idleJob() {
  return { state: 'idle', total: 0, index: 0, current: null, results: [], startedAt: null, finishedAt: null, cancelled: false, auto: false }
}

/** Set when an unattended batch finished, so the client knows to rebuild once. */
let autoFinishedAt = 0

function runPnpm(tool, args, onLine) {
  return new Promise((resolvePromise) => {
    const child = spawn(tool.node, [tool.pnpm, ...args], {
      cwd: profileDir(),
      env: Object.assign({}, process.env, { CI: '1', NO_COLOR: '1' }),
      windowsHide: true,
      shell: false,
    })
    let output = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        else child.kill('SIGKILL')
      } catch (error) { void error }
      resolvePromise({ ok: false, timedOut: true, code: null, output })
    }, INSTALL_TIMEOUT_MS)

    const collect = (chunk) => {
      const text = String(chunk)
      output = (output + text).slice(-6000)
      if (typeof onLine === 'function') {
        for (const line of text.split(/\r?\n/)) if (line.trim().length > 0) onLine(line.trim())
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ ok: false, timedOut: false, code: null, output: output + '\n' + String(error && error.message) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ ok: code === 0, timedOut: false, code, output })
    })
  })
}

/** Turn pnpm's tail into one readable line: the failure the user cares about. */
function lastMeaningfulLine(output) {
  const lines = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (/^(Progress|Packages|Downloading|Resolving|Done in|\.+$)/i.test(line)) continue
    if (/ERR_|error|Error|denied|ENOENT|EPERM|EBUSY|not found/i.test(line)) return line.slice(0, 300)
  }
  const last = lines.length > 0 ? lines[lines.length - 1] : ''
  return last.slice(0, 300)
}

async function runOne(item) {
  const tool = findTool()
  if (tool.pnpm === null) {
    return { ok: false, message: '找不到 DSH 自带的 pnpm（可设 DSH_UPDATE_HUB_PNPM 指向 pnpm.cjs）' }
  }
  const spec = item.target ? `${item.name}@${item.target}` : `${item.name}@latest`
  const result = await runPnpm(tool, ['add', spec, '--save-exact', '--reporter=append-only'])
  if (result.timedOut) return { ok: false, message: '安装超时（15 分钟），已终止' }
  if (!result.ok) {
    return { ok: false, message: lastMeaningfulLine(result.output) || `pnpm 退出码 ${result.code}` }
  }
  // Trust the disk, not the exit code: --save-exact still leaves a window where
  // the manifest advanced but node_modules did not.
  const after = installedVersion(item.name)
  const want = item.target || item.latest
  if (want && after !== want) {
    return { ok: false, message: `安装后磁盘上是 ${after || '未安装'}，不是目标 ${want}`, installed: after }
  }
  return { ok: true, installed: after, message: null }
}

function startJob(items, options) {
  const startedAt = Date.now()
  const auto = !!(options && options.auto === true)
  job = {
    state: 'running',
    total: items.length,
    index: 0,
    current: null,
    results: [],
    startedAt,
    finishedAt: null,
    cancelled: false,
    auto,
  }
  const active = job
  void (async () => {
    for (const item of items) {
      if (active.cancelled) break
      // The person came back mid-batch. Stop between packages instead of moving
      // node_modules under a window that is now loading them.
      if (auto && presence().visible === true && presence().online) {
        active.cancelled = true
        break
      }
      active.index += 1
      active.current = item.name
      const outcome = await runOne(item)
      active.results.push({
        name: item.name,
        target: item.target || item.latest || null,
        ok: outcome.ok,
        installed: outcome.installed || null,
        message: outcome.message || null,
      })
    }
    active.current = null
    active.state = 'done'
    active.finishedAt = Date.now()
    // Only an unattended run arms the auto-rebuild: a batch someone clicked
    // themselves must never reload the page underneath them.
    if (auto && active.results.some(function (row) { return row.ok === true })) autoFinishedAt = active.finishedAt
    // Drop the registry cache for everything that changed, so the panel's next
    // read agrees with the disk instead of repeating the pre-install answer.
    const cache = loadLatestCache()
    for (const row of active.results) if (row.ok) delete cache[row.name]
    saveLatestCache()
  })()
  return { started: true, total: items.length, startedAt }
}

// ------------------------------------------------------------------ scheduler

/**
 * When the registry was last actually asked.
 *
 * `lastCheckAt` lives in memory and resets on every host restart, which would
 * make "check every 12 hours" fire on every launch. The cache file survives, so
 * its newest timestamp is the honest answer. A forced sweep rewrites every
 * entry, so the max is also the sweep's start time.
 */
function lastSweepAt() {
  const cache = loadLatestCache()
  let newest = 0
  for (const key of Object.keys(cache)) {
    const entry = cache[key]
    const at = entry && typeof entry.at === 'number' ? entry.at : 0
    if (at > newest) newest = at
  }
  return newest
}

let tickTimer = null
let ticking = false
// A failed sweep leaves lastSweepAt unchanged, so without this the minute tick
// would retry it every minute forever. Ten minutes is short enough to recover
// from a blip and long enough not to look like an attack.
let lastAttemptAt = 0
const ATTEMPT_GAP_MS = 10 * 60 * 1000

/** True when the unattended path is allowed to touch the disk right now. */
function idleLongEnough(minutes) {
  if (minutes <= 0) return false
  if (Date.now() - bootedAt < BOOT_GRACE_MS) return false
  const presenceNow = presence()
  // No heartbeat ever arrived: we cannot tell a parked window from a starting
  // one, and "I don't know" must not mean "go ahead and install".
  if (presenceNow.lastActiveAt === 0) return false
  // A window that is on screen is never updated underneath, no matter how long
  // the mouse has been still: a streaming answer and an abandoned desk look
  // identical from the host, and only one of them tolerates node_modules moving.
  if (presenceNow.visible === true && presenceNow.online) return false
  return presenceNow.idleSeconds !== null && presenceNow.idleSeconds >= minutes * 60
}

/**
 * One minute of housekeeping.
 *
 * Two independent jobs, in order: refresh the registry answers if the interval
 * is due, then — only if the machine has been idle long enough — install what
 * the refresh found. Both bail out while a batch runs, so this can never stack.
 */
async function tick() {
  if (ticking) return
  if (job !== null && job.state === 'running') return
  ticking = true
  try {
    const settings = loadSettings()
    if (settings.checkIntervalHours > 0) {
      const due = lastSweepAt() + settings.checkIntervalHours * 60 * 60 * 1000
      if (Date.now() >= due && Date.now() - lastAttemptAt >= ATTEMPT_GAP_MS) {
        lastAttemptAt = Date.now()
        await buildRows(true)
      }
    }
    if (job !== null && job.state === 'running') return
    if (!idleLongEnough(settings.idleUpdateMinutes)) return
    const rows = await buildRows(false)
    const pending = rows.filter(function (row) { return row.available === true })
    if (pending.length === 0) return
    startJob(pending.map(function (row) { return { name: row.name, target: row.latest } }), { auto: true })
  } catch (error) {
    try { console.warn(`[${PKG}] tick failed: ${String((error && error.message) || error)}`) } catch (inner) { void inner }
  } finally {
    ticking = false
  }
}

function startScheduler() {
  if (tickTimer !== null) return
  tickTimer = setInterval(function () { void tick() }, TICK_MS)
  // The host itself may be a short-lived process in tests; never hold it open.
  if (typeof tickTimer.unref === 'function') tickTimer.unref()
}

// A launch is itself a request to look for updates. The floor keeps a burst of
// restarts from re-sweeping 45 packages each time; an hour is short enough that
// "opened DSH this morning" always gets fresh answers.
const BOOT_CHECK_MIN_AGE_MS = 60 * 60 * 1000

async function bootCheck() {
  const settings = loadSettings()
  if (!settings.checkOnBoot) return
  if (Date.now() - lastSweepAt() < BOOT_CHECK_MIN_AGE_MS) return
  lastAttemptAt = Date.now()
  try { await buildRows(true) } catch (error) { void error }
}


// --------------------------------------------------------------------- routes

function respond(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolvePromise) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        req.destroy()
        resolvePromise(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolvePromise(null))
  })
}

/** Normalize the run body into [{name, target, latest}] using the live cache. */
function normalizeItems(body) {
  const raw = body && Array.isArray(body.items) ? body.items : []
  const out = []
  const seen = new Set()
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry : entry && entry.name
    if (typeof name !== 'string' || name.length === 0 || name.length > 214) continue
    if (seen.has(name)) continue
    seen.add(name)
    const target = entry && typeof entry === 'object' && typeof entry.target === 'string' ? entry.target : null
    const cached = loadLatestCache()[name]
    out.push({ name, target, latest: cached && typeof cached.latest === 'string' ? cached.latest : null })
  }
  // Nothing to pin down: a row without a cached latest would install `@latest`,
  // which is fine, but a row with neither is a client bug worth refusing.
  return out.filter((item) => item.target !== null || item.latest !== null)
}

const ROUTES = {
  /** Read-only: rows + job. The panel polls this while a job runs. */
  async state() {
    const rows = await buildRows(false)
    return {
      ok: true,
      profile: profileDir(),
      rows,
      checkedAt: lastCheckAt,
      job: job || idleJob(),
      tool: findTool().how,
      route: ROUTE_PREFIX,
      settings: loadSettings(),
      presence: presence(),
      // A finished unattended batch: the client rebuilds once, then remembers
      // the stamp so a later reload does not loop.
      autoFinishedAt,
      nextCheckAt: loadSettings().checkIntervalHours > 0 ? lastSweepAt() + loadSettings().checkIntervalHours * 3600000 : null,
    }
  },
  /**
   * Append-only client diagnostics.
   *
   * The panel runs in the browser half, which has no log of its own. When the
   * marker fails to appear there is otherwise no way to tell "the module never
   * loaded" apart from "it loaded and rendered nothing" — and those have
   * completely different fixes. Best effort: never throws, never blocks.
   */
  async diag(body) {
    try {
      const payload = body && typeof body === 'object' ? body : {}
      appendFileSync(join(dataDir(), 'client-diag.ndjson'), JSON.stringify(Object.assign({ at: new Date().toISOString() }, payload)) + '\n')
    } catch (error) { void error }
    return { ok: true }
  },
  /**
   * Write: presence ping from an open window.
   *
   * Small on purpose — it runs every 30s and must never trigger a registry
   * sweep. It answers with the job so an unattended batch can report progress
   * without the heavier /state call.
   */
  async heartbeat(body) {
    noteHeartbeat(body)
    return { ok: true, job: job || idleJob(), autoFinishedAt, presence: presence(), checkedAt: lastCheckAt }
  },
  /** Write: change the automation policy (boot check / interval / idle update). */
  async settings(body) {
    const next = patchSettings(body)
    return { ok: true, settings: next }
  },
  /** Read-only: ask the registry again, ignoring the 6h cache. */
  async check() {
    const rows = await buildRows(true)
    return { ok: true, rows, checkedAt: lastCheckAt, job: job || idleJob() }
  },
  /** Write: start a batch. Refused while another batch runs. */
  async run(body) {
    if (job !== null && job.state === 'running') {
      return { ok: false, error: 'busy', message: '已有更新任务在跑', job }
    }
    const items = normalizeItems(body)
    if (items.length === 0) return { ok: false, error: 'empty', message: '没有要更新的插件' }
    return Object.assign({ ok: true }, startJob(items))
  },
  /** Write: cancel between packages. The package in flight finishes first. */
  async cancel() {
    if (job === null || job.state !== 'running') return { ok: false, error: 'idle', message: '没有正在跑的任务' }
    job.cancelled = true
    return { ok: true, message: '已取消，正在装的这只会装完' }
  },
  /**
   * Write: make the manifest agree with the disk for one package.
   *
   * This is the dsh-bottom-info-bar cure: reinstall the version that is already
   * on disk with --save-exact, so the manifest stops advertising an update the
   * user already has.
   */
  async align(body) {
    if (job !== null && job.state === 'running') {
      return { ok: false, error: 'busy', message: '已有更新任务在跑' }
    }
    const name = body && typeof body.name === 'string' ? body.name : ''
    const target = name ? installedVersion(name) : null
    if (!name || target === null) return { ok: false, error: 'not-installed', message: '这个插件不在磁盘上' }
    return Object.assign({ ok: true }, startJob([{ name, target, latest: target }]))
  },
}

let mounted = false

function mountRoutes(webCtx) {
  // Two paths can reach here (the ctx.inject callback and the direct fallback
  // below); a second registration would answer every request twice.
  if (mounted) return null
  if (!webCtx || !webCtx.webServer || typeof webCtx.webServer.register !== 'function') return null
  mounted = true
  return webCtx.effect(function () {
    const dispose = webCtx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async function (req, res) {
        let method = ''
        try {
          const rejection = webCtx.connection.requestRejection(req)
          if (rejection !== undefined) {
            respond(res, rejection, { error: rejection === 401 ? 'authentication required' : 'request rejected' })
            return
          }
          const url = new URL(req.url || '/', 'http://localhost')
          if (!url.pathname.startsWith(ROUTE_PREFIX + '/')) {
            respond(res, 404, { error: 'not found' })
            return
          }
          method = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length + 1))
          const fn = Object.hasOwn(ROUTES, method) ? ROUTES[method] : null
          if (typeof fn !== 'function') {
            respond(res, 404, { error: 'unknown method: ' + method })
            return
          }
          if (MUTATING.has(method) && req.method !== 'POST') {
            respond(res, 405, { error: 'mutating methods require POST' })
            return
          }
          let body = null
          if (req.method === 'POST') {
            const raw = await readBody(req)
            if (raw === null) { respond(res, 413, { error: 'body too large' }); return }
            if (raw.trim().length > 0) {
              try { body = JSON.parse(raw) } catch (error) {
                void error
                respond(res, 400, { error: 'invalid JSON body' })
                return
              }
            }
          }
          respond(res, 200, await fn(body))
        } catch (error) {
          if (res.headersSent) { res.destroy(error); return }
          respond(res, 500, { error: String((error && error.message) || error) })
          try {
            if (method !== '') console.warn(`[${PKG}] RPC ${method} failed: ${String((error && error.stack) || error)}`)
          } catch (inner) { void inner }
        }
      },
    })
    return function () { try { dispose() } catch (error) { void error } }
  }, PKG + ': routes')
}

/**
 * `connection` is declared statically because a plugin that declares nothing
 * gets a ctx where reading an undeclared service throws "cannot get property …
 * without inject" (verified in dsh-sidebar-suite against cordis 4.1.0). The
 * webServer half arrives later on a cold boot, so it is requested through
 * ctx.inject — the same pairing dsh-bottom-info-bar uses for its /_dsh routes.
 */
export const inject = ['connection']

/**
 * Internals exposed for the offline tests in tests/. Not part of the plugin API:
 * nothing on the client half reads this, and the loader ignores extra exports.
 */
export const __internals = {
  profileDir, profileDeps, installedVersion, buildRows, latestFor, fetchLatest, normalizeItems, runPnpm,
  loadSettings, patchSettings, noteHeartbeat, presence, lastSweepAt, idleLongEnough, tick, bootCheck, ROUTES,
}


export function apply(ctx) {
  try { ctx.logger?.debug?.(`[${PKG}] host half ready, profile=${profileDir()}`) } catch (error) { void error }
  try {
    ctx.inject(['connection', 'webServer'], function (webCtx) { mountRoutes(webCtx) })
  } catch (error) {
    void error
  }
  // Fallback: when webServer is already present the inject callback fires during
  // the line above, so this only matters if that path is unavailable on this host.
  try { if (ctx.webServer) mountRoutes(ctx) } catch (error) { void error }

  // Both timers are best effort: if scheduling fails the manual buttons still
  // work, so a broken clock must not take the panel down with it.
  try {
    startScheduler()
    const bootTimer = setTimeout(function () { void bootCheck() }, 15000)
    if (typeof bootTimer.unref === 'function') bootTimer.unref()
  } catch (error) { void error }
}
