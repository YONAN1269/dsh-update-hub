// Offline checks for the host half. No DSH, no installs — this only proves the
// parts the plugin's correctness rests on: which profile it targets, which
// pnpm it would call, how it compares versions, and what it reads off disk.
import { compareVersions, findTool, __internals } from '../lib/index.js'

const fails = []
function check(name, actual, expected) {
  const ok = actual === expected
  if (!ok) fails.push(`${name}: 期望 ${expected}，实际 ${actual}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} = ${actual}`)
}

check('0.32.0 < 0.32.1', compareVersions('0.32.1', '0.32.0'), 1)
check('1.24.3 > 1.23.0', compareVersions('1.24.3', '1.23.0'), 1)
check('相同版本', compareVersions('1.2.3', '1.2.3'), 0)
check('1.10.0 > 1.9.9', compareVersions('1.10.0', '1.9.9'), 1)
check('正式版压过预发布', compareVersions('2.0.0', '2.0.0-beta.1'), 1)
check('脏版本号不炸', compareVersions('file:C:/x.tgz', '1.0.0'), 0)

console.log('\n--- 目标 profile ---')
const profile = __internals.profileDir()
console.log(profile)

console.log('\n--- pnpm 定位 ---')
const tool = findTool()
console.log(tool)

console.log('\n--- 磁盘上的实装版本 ---')
for (const name of ['dsh-bottom-info-bar', 'dsh-better-sidebar', '@michengai/dsh-btw']) {
  console.log(name, '=', __internals.installedVersion(name))
}

console.log('\n--- 清单里的声明 ---')
const deps = __internals.profileDeps()
for (const name of ['dsh-bottom-info-bar', 'dsh-better-sidebar', '@michengai/dsh-btw']) {
  console.log(name, '=', deps[name])
}

console.log('\n--- registry 最新版（网络） ---')
for (const name of ['dsh-better-sidebar', '@michengai/dsh-btw']) {
  const result = await __internals.latestFor(name, true)
  console.log(name, '=', JSON.stringify(result))
}

if (fails.length > 0) {
  console.log('\n有 ' + fails.length + ' 条不对：\n' + fails.join('\n'))
  process.exitCode = 1
} else {
  console.log('\n全部通过')
}
