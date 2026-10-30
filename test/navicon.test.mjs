/**
 * installNavIcon 的回归测试。
 *
 * 这段代码只在真浏览器里跑（client.smoke 里没有 document 会直接跳过），
 * 所以单独用假 DOM + 假 MutationObserver 覆盖三件事：
 *   1. 设置弹窗没打开时不去查 DOM；
 *   2. 流式输出连续触发 mutation 时只跑一次（250ms 防抖）；
 *   3. 认得出自己的那一行、只标它，disposer 能停掉观察器。
 *
 * 运行：$env:ELECTRON_NO_ASAR='1'; & ...\.desktop-bin\node.cmd test\navicon.test.mjs
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const profileRequire = createRequire('C:/Users/89220/AppData/Roaming/dsh-desktop/harness/profiles/web/package.json')
const React = profileRequire('react')
const jsxRuntime = profileRequire('react/jsx-runtime')

let failures = 0
const check = (name, condition, detail) => {
  if (condition) console.log(`PASS ${name}`)
  else {
    failures += 1
    console.log(`FAIL ${name}${detail ? ` → ${detail}` : ''}`)
  }
}

// ── 假 DOM ────────────────────────────────────────────────────────────
const makeCell = (text) => {
  const attrs = new Set()
  const label = { textContent: text }
  return {
    attrs,
    hasAttribute: (name) => attrs.has(name),
    setAttribute: (name) => attrs.add(name),
    querySelector: (selector) => (selector.includes('navLabel') ? label : null)
  }
}

const cellSettings = makeCell('通用设置')
const cellLibrary = makeCell('本地资料库')
const cellPet = makeCell('桌宠配置')

let modalPresent = false
let navCellQueries = 0
const modal = {
  querySelectorAll: (selector) => {
    if (!selector.includes('navCell')) return []
    navCellQueries += 1
    return [cellSettings, cellLibrary, cellPet]
  }
}

const inserted = []
const document = {
  body: {},
  head: { appendChild: (node) => inserted.push(node) },
  createElement: () => ({ dataset: {}, textContent: '' }),
  querySelector: (selector) => {
    if (selector.startsWith('style[')) return null
    if (selector.includes('data-shortcut-modal')) return modalPresent ? modal : null
    return null
  }
}

const observers = []
class FakeObserver {
  constructor(callback) {
    this.callback = callback
    this.disconnected = false
    observers.push(this)
  }
  observe() {}
  disconnect() {
    this.disconnected = true
  }
}

globalThis.document = document
globalThis.MutationObserver = FakeObserver
let loaded
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      loaded = entry
    }
  }
}

await vm.runInThisContext(await readFile(join(here, '..', 'lib', 'client.js'), 'utf8'), {
  filename: 'lib/client.js'
})

// ── 载入插件并 apply ──────────────────────────────────────────────────
const exports = loaded.factory((name) => {
  if (name === 'react') return React
  if (name === 'react/jsx-runtime') return jsxRuntime
  throw new Error(`unexpected require(${name})`)
})

const disposers = []
const ctx = {
  effect(fn) {
    disposers.push(fn())
  },
  locale: { register: () => () => {} },
  slots: {
    inject(_name, generator) {
      for (const entry of generator()) void entry
    },
    register: (options, component) => ({ options, component })
  }
}
exports.apply(ctx)

// apply 时先注入设置页样式、再注入导航图标样式，所以这里会有两条 style。
const navStyle = inserted.find((node) => String(node.textContent || '').includes('data-dsh-ll-nav'))
check('注入了导航图标样式', Boolean(navStyle) && inserted.length === 2, `inserted=${inserted.length}`)
check('装了 MutationObserver', observers.length === 1, `count=${observers.length}`)

const observer = observers[0]

// 1. 弹窗没打开：一个查询都不该发生
observer.callback()
await new Promise((resolve) => setTimeout(resolve, 320))
check('设置弹窗没开时不查导航行', navCellQueries === 0, `queries=${navCellQueries}`)

// 2. 弹窗打开，模拟聊天流式输出：连打 20 次 mutation，只应跑一次
modalPresent = true
for (let i = 0; i < 20; i += 1) observer.callback()
await new Promise((resolve) => setTimeout(resolve, 320))
check('连续 mutation 只跑一次（防抖）', navCellQueries === 1, `queries=${navCellQueries}`)
check('只标了自己的那一行', cellLibrary.attrs.has('data-dsh-ll-nav') && !cellSettings.attrs.has('data-dsh-ll-nav') && !cellPet.attrs.has('data-dsh-ll-nav'), JSON.stringify({
  通用设置: [...cellSettings.attrs],
  本地资料库: [...cellLibrary.attrs],
  桌宠配置: [...cellPet.attrs]
}))

// 3. 已标记的行不再重复处理：再触发一次，查询照跑但属性不变
observer.callback()
await new Promise((resolve) => setTimeout(resolve, 320))
check('重复触发不会重复标记', cellLibrary.attrs.size === 1, JSON.stringify([...cellLibrary.attrs]))

// 4. disposer 必须停掉观察器
for (const dispose of disposers) if (typeof dispose === 'function') dispose()
check('disposer 断开了观察器', observer.disconnected === true, `disconnected=${observer.disconnected}`)

console.log('')
if (failures === 0) {
  console.log('全部通过')
  process.exit(0)
} else {
  console.log(`失败 ${failures} 项`)
  process.exit(1)
}
