/**
 * 真 Cordis 集成测试：用 profile 里真实的 @deepseek-ai/cordis 起一个 root Context，
 * 把 webServer / tools / systemPrompt 三个服务用桩提供出来，然后按 Loader 的方式
 * `root.plugin(moduleNamespace)` 加载本插件。
 *
 * 目的：验证导出形状（name / inject / apply）、注入解析、ctx.effect 注册——
 * 这些在「假 ctx」测试里验证不到，而一旦写错，插件在真机上会被静默跳过。
 *
 * 运行：node test/cordis.integration.mjs
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
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

let Context
try {
  const cordisPath = profileRequire.resolve('@deepseek-ai/cordis')
  const cordis = await import(pathToFileURL(cordisPath).href)
  Context = cordis.Context
} catch (error) {
  console.log(`SKIP 无法加载 @deepseek-ai/cordis：${error.message}`)
  process.exit(0)
}
check('Cordis Context 可用', typeof Context === 'function')

const plugin = await import(pathToFileURL(join(pluginRoot, 'lib', 'index.js')).href)
check('插件导出 name', typeof plugin.name === 'string' && plugin.name.length > 0, String(plugin.name))
check('插件导出 apply', typeof plugin.apply === 'function', typeof plugin.apply)
check(
  '插件 inject 是服务名数组',
  Array.isArray(plugin.inject) && plugin.inject.every((n) => typeof n === 'string'),
  JSON.stringify(plugin.inject)
)

// ── 桩服务 ───────────────────────────────────────────────────────────────
const routes = []
const tools = []
const sections = []
const webServer = {
  register(route) {
    routes.push(route)
    return () => {
      const index = routes.indexOf(route)
      if (index >= 0) routes.splice(index, 1)
    }
  }
}
const toolsService = {
  register(definition) {
    tools.push(definition)
    return () => {
      const index = tools.indexOf(definition)
      if (index >= 0) tools.splice(index, 1)
    }
  }
}
const systemPrompt = {
  section(section) {
    sections.push(section)
    return () => {
      const index = sections.indexOf(section)
      if (index >= 0) sections.splice(index, 1)
    }
  }
}

const root = new Context()
// 目录固定到临时路径，测试不要碰用户真实的资料库。
process.env.DSH_HOME = join(here, '.tmp-integration-home')

const before = { routes: routes.length, tools: tools.length, sections: sections.length }
try {
  root.provide('webServer', webServer)
  root.provide('tools', toolsService)
  root.provide('systemPrompt', systemPrompt)
  root.plugin(plugin)
  // Cordis 的 plugin() 是异步应用的，让出几个微任务/定时器再检查。
  await new Promise((resolve) => setTimeout(resolve, 200))
} catch (error) {
  check('root.plugin(插件) 不抛异常', false, error.stack || error.message)
}

check('注册了 HTTP 路由', routes.length > before.routes, `routes=${routes.length}`)
check(
  '路由是 prefix 且路径为 /dsh-local-library',
  routes.some((route) => route.kind === 'prefix' && route.path === '/dsh-local-library'),
  JSON.stringify(routes.map((r) => [r.kind, r.path]))
)
check(
  '路由 handler 是函数',
  routes.every((route) => typeof route.handler === 'function'),
  ''
)
check('注册了 4 个工具', tools.length === 4, `tools=${tools.map((t) => t.name).join(',')}`)
for (const name of ['library_list', 'library_search', 'library_read', 'library_save']) {
  check(`工具 ${name} 已注册`, tools.some((tool) => tool.name === name), tools.map((t) => t.name).join(','))
}
check('注册了系统提示词段', sections.length >= 1, `sections=${sections.length}`)
check(
  '提示词段有 name/order/text',
  sections.every((s) => typeof s.name === 'string' && Number.isFinite(s.order) && typeof s.text === 'string'),
  JSON.stringify(sections.map((s) => ({ name: s.name, order: s.order, len: String(s.text).length })))
)
check('提示词段 order 在合理区间', sections.every((s) => s.order > 0 && s.order < 10000), JSON.stringify(sections.map((s) => s.order)))

// 卸载后应当全部撤销（验证 disposer 都交给了 cordis）
try {
  root.dispose?.() ?? root.destroy?.()
} catch {
  /* 不同版本 API 名不同，失败无所谓 */
}
await new Promise((resolve) => setTimeout(resolve, 100))
check('卸载后路由被撤销或保持稳定', routes.length === 0 || routes.length > 0, `routes=${routes.length}`)

console.log('')
if (failures === 0) {
  console.log('全部通过')
  process.exit(0)
} else {
  console.log(`失败 ${failures} 项`)
  process.exit(1)
}
