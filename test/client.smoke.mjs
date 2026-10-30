/**
 * 客户端半侧冒烟测试：把 lib/client.js 当普通脚本跑起来，拿它的工厂函数，
 * 用假 ctx 调 apply()，再把设置页组件 SSR 渲一次，确认结构没崩。
 *
 * react / react-dom 从 DSH profile 的 node_modules 里取（就是浏览器里用的那一份）。
 * 运行：node test/client.smoke.mjs
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const profileModules = 'C:/Users/89220/AppData/Roaming/dsh-desktop/harness/profiles/web/package.json'
const profileRequire = createRequire(profileModules)

let failures = 0
const check = (name, condition, detail) => {
  if (condition) console.log(`PASS ${name}`)
  else {
    failures += 1
    console.log(`FAIL ${name}${detail ? ` → ${detail}` : ''}`)
  }
}

let React
let jsxRuntime
let reactDomServer
try {
  React = profileRequire('react')
  jsxRuntime = profileRequire('react/jsx-runtime')
  reactDomServer = profileRequire('react-dom/server')
} catch (error) {
  console.log(`SKIP 无法从 profile 解析 react：${error.message}`)
  process.exit(0)
}

// ── 最小 DOM 垫片（只为 injectCss / installNavIcon 不炸）────────────────
const createdStyles = []
const fakeDoc = {
  head: {
    appendChild(node) {
      createdStyles.push(node)
    }
  },
  body: null,
  createElement() {
    return { dataset: {}, textContent: '' }
  },
  querySelector() {
    return null
  },
  querySelectorAll() {
    return []
  }
}
globalThis.document = fakeDoc
// Node 24 自带 navigator（只读 getter），必须用 defineProperty 覆盖。
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'zh-CN' },
  configurable: true,
  writable: true
})

// ── 跑客户端脚本，截获模块 ───────────────────────────────────────────────
const code = await readFile(join(here, '..', 'lib', 'client.js'), 'utf8')
let loaded
globalThis.window = {
  __ModuleLoader__: {
    load(options) {
      loaded = options
    }
  }
}

try {
  vm.runInThisContext(code, { filename: 'client.js' })
} catch (error) {
  check('client.js 可执行', false, error.stack || error.message)
  process.exit(1)
}
check('脚本调用了 __ModuleLoader__.load', Boolean(loaded), JSON.stringify(loaded))
check('模块 id 是 dsh-local-library', loaded && loaded.id === 'dsh-local-library', String(loaded && loaded.id))

let moduleExports
try {
  moduleExports = loaded.factory((name) => {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`unexpected require(${name})`)
  })
} catch (error) {
  check('工厂函数可执行', false, error.stack || error.message)
  process.exit(1)
}
check('工厂返回 apply/inject/name', Boolean(moduleExports && moduleExports.apply && Array.isArray(moduleExports.inject)))
check('客户端 inject 含 slots', moduleExports.inject.includes('slots'), moduleExports.inject.join(','))

// ── 假 ctx：记录槽位注册 ────────────────────────────────────────────────
const registered = []
const ctx = {
  effect(fn) {
    const dispose = fn()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  locale: {
    register() {
      return () => {}
    }
  },
  slots: {
    inject(name, generator) {
      for (const entry of generator()) {
        registered.push({ slot: name, entry })
      }
    },
    register(options, component) {
      return { options, component }
    }
  }
}

try {
  moduleExports.apply(ctx)
} catch (error) {
  check('apply() 不抛异常', false, error.stack || error.message)
  process.exit(1)
}
check('apply() 不抛异常', true, '')
check('注入了设置页样式', createdStyles.length >= 1, `styles=${createdStyles.length}`)

const section = registered.find((row) => row.slot === 'settings.section')
check('注册了 settings.section', Boolean(section), JSON.stringify(registered.map((r) => r.slot)))
check('分区 id 是 local-library', section && section.entry.options.id === 'local-library', String(section && section.entry.options.id))
check('分区有 order 与 label', Boolean(section && typeof section.entry.options.order === 'number' && section.entry.options.label()), JSON.stringify(section && section.entry.options.order))
check('分区通过 inject 传了 t', Boolean(section && typeof section.entry.options.inject === 'function' && typeof section.entry.options.inject().t === 'function'))

// ── SSR 渲染设置页组件 ───────────────────────────────────────────────────
const Section = section && section.entry.component
check('分区组件是个函数组件', typeof Section === 'function')

if (typeof Section === 'function') {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      items: [
        {
          id: 'll-test-1',
          name: '植物学笔记.md',
          kind: 'text',
          size: 2048,
          textChars: 128,
          indexed: true,
          createdAt: new Date().toISOString(),
          addedBy: 'upload',
          snippet: '…光合作用的暗反应…'
        }
      ],
      stats: { root: 'C:/tmp/local-library', count: 1, bytes: 2048, bytesText: '2.0 KB', indexed: 1 },
      pending: 0
    })
  })

  let html = ''
  try {
    html = reactDomServer.renderToStaticMarkup(
      React.createElement(Section, { t: (key) => key, close: () => {} })
    )
  } catch (error) {
    check('设置页可渲染', false, error.stack || error.message)
  }
  check('设置页可渲染', html.length > 0, `${html.length} chars`)
  check('渲染出标题', html.includes('本地资料库'), html.slice(0, 200))
  check('渲染出拖拽上传区', html.includes('ll-drop'), html.slice(0, 120))
  check('渲染出检索输入框', html.includes('ll-input'), '')
  // SSR 不跑 useEffect，所以列表此时是空态；这正好验证空态与上传区都在。
  check('渲染出空态提示', html.includes('ll-empty'), '')
  check('渲染出检索按钮', html.includes('ll-btn'), '')
  check('没有出现 undefined 文本', !/>undefined</.test(html), (html.match(/>undefined</g) || []).length + ' 处')
}

// ── 带数据的列表渲染：用假 hooks 直接喂 state，绕过 SSR 不跑 effect 的限制 ──
const seededItems = [
  {
    id: 'll-test-1',
    name: '植物学笔记.md',
    kind: 'text',
    size: 2048,
    textChars: 128,
    indexed: true,
    createdAt: '2026-10-30T09:00:00.000Z',
    addedBy: 'upload',
    tags: ['财务', '2026预算'],
    snippet: '…光合作用的暗反应…'
  },
  {
    id: 'll-test-2',
    name: '2026 年度预算.xlsx',
    kind: 'sheet',
    size: 51200,
    textChars: 0,
    indexed: false,
    createdAt: '2026-10-29T09:00:00.000Z',
    addedBy: 'agent',
    snippet: ''
  }
]

const seededStats = { root: 'C:/tmp/local-library', count: 2, bytes: 53248, bytesText: '52.0 KB', indexed: 1 }
// makeSettings 里 useState 的调用顺序：
// items stats query over error banner queue pendingDelete copied selected tagEdit dupPrompt filter reindexing
const seededState = [
  seededItems,
  seededStats,
  '',
  false,
  '',
  '',
  [],
  '',
  false,
  ['ll-test-1'],
  null,
  { fileName: '2026 年度预算.xlsx', existing: { id: 'll-old', name: '旧版预算.xlsx' }, answer() {} },
  '',
  false
]
let stateCursor = 0
const fakeReact = {
  ...React,
  useState(initial) {
    const index = stateCursor
    stateCursor += 1
    const value = index < seededState.length ? seededState[index] : initial
    return [value, () => {}]
  },
  useEffect() {},
  useCallback(fn) {
    return fn
  },
  useRef(initial) {
    return { current: initial === undefined ? null : initial }
  }
}

let registered2 = []
const ctx2 = {
  effect(fn) {
    fn()
  },
  locale: { register: () => () => {} },
  slots: {
    inject(_name, generator) {
      for (const entry of generator()) registered2.push(entry)
    },
    register(options, component) {
      return { options, component }
    }
  }
}

try {
  const exports2 = loaded.factory((name) => {
    if (name === 'react') return fakeReact
    if (name === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`unexpected require(${name})`)
  })
  exports2.apply(ctx2)
  stateCursor = 0
  const Section2 = registered2[0].component
  const html2 = reactDomServer.renderToStaticMarkup(React.createElement(Section2, { t: (key) => key, close: () => {} }))

  const seedText = {
    植物学笔记: html2.includes('植物学笔记.md'),
    预算表: html2.includes('2026 年度预算.xlsx'),
    kind徽章: html2.includes('ll-kind') && html2.includes('sheet'),
    命中片段: html2.includes('光合作用的暗反应'),
    agent来源: html2.includes('agent 存入'),
    下载链接: html2.includes('/dsh-local-library/download?id=ll-test-1'),
    删除按钮: html2.includes('删除'),
    统计行: html2.includes('52.0 KB'),
    存储路径: html2.includes('C:/tmp/local-library'),
    索引状态: html2.includes('128 字 已建索引') && html2.includes('索引中'),
    多选菜单: html2.includes('ll-selbar') && html2.includes('打包下载'),
    选择框: html2.includes('ll-sel'),
    标签展示: html2.includes('ll-tag') && html2.includes('财务'),
    标签按钮: html2.includes('>标签<'),
    重复提示: html2.includes('ll-dupe') && html2.includes('覆盖旧的') && html2.includes('再存一份'),
    过滤条: html2.includes('ll-chip') && html2.includes('>PDF<') && html2.includes('>表格<'),
    重建索引: html2.includes('>重建索引<')
  }
  for (const [name, ok] of Object.entries(seedText)) {
    check(`列表渲染：${name}`, ok, ok ? '' : html2.slice(0, 400))
  }
  // 回归：正在编辑某一行标签时，别的行标签不能跟着消失（C1）
  seededState[10] = { id: 'll-test-2', value: '' }
  stateCursor = 0
  const html3 = reactDomServer.renderToStaticMarkup(React.createElement(Section2, { t: (key) => key, close: () => {} }))
  check('编辑一行标签时其它行标签仍在', html3.includes('ll-taggedit') && html3.includes('财务'), html3.includes('ll-taggedit') ? '标签被隐藏' : '没有渲染编辑框')

  check('列表渲染没有 undefined 文本', !/>undefined</.test(html2), (html2.match(/>undefined</g) || []).length + ' 处')
} catch (error) {
  check('带数据渲染列表', false, error.stack || error.message)
}

console.log('')
if (failures === 0) {
  console.log('全部通过')
  process.exit(0)
} else {
  console.log(`失败 ${failures} 项`)
  process.exit(1)
}
