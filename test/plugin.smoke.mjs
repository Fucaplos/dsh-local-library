/**
 * 宿主半侧冒烟测试：用假 ctx 把 lib/index.js 装起来，走一遍
 * 上传 → 列表 → 检索 → 下载 → 删除 → 工具调用 → 提示词段。
 *
 * 不依赖 DSH 运行时，只用 Node 内置模块 + 本包的 lib。
 * 运行：node test/plugin.smoke.mjs
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

const home = await mkdtemp(join(tmpdir(), 'll-smoke-'))
process.env.DSH_HOME = home

let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    console.log(`PASS ${name}`)
  } else {
    failures += 1
    console.log(`FAIL ${name}${detail ? ` → ${detail}` : ''}`)
  }
}

const mod = await import('../lib/index.js')

check('导出 inject 含 webServer/tools/systemPrompt', ['webServer', 'tools', 'systemPrompt'].every((s) => mod.inject.includes(s)))

const routes = []
const tools = []
const sections = []
const disposers = []

const ctx = {
  effect(fn, label) {
    const dispose = fn()
    disposers.push({ label, dispose })
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    }
  },
  tools: {
    register(definition) {
      tools.push(definition)
      return () => {}
    }
  },
  systemPrompt: {
    section(options) {
      sections.push(options)
      return () => {}
    }
  }
}

mod.apply(ctx)

check('注册了 1 条路由', routes.length === 1, `routes=${routes.length}`)
check('路由是 prefix 且路径正确', routes[0] && routes[0].kind === 'prefix' && routes[0].path === '/dsh-local-library', JSON.stringify(routes[0]?.path))
check('注册了 4 个工具', tools.length === 4, tools.map((t) => t.name).join(','))
check('注册了提示词段', sections.length === 1 && String(sections[0].text).includes('本地资料库'), JSON.stringify(sections[0]?.name))
check('提示词段设了 interpolate:false', sections[0]?.interpolate === false)

for (const tool of tools) {
  check(`工具 ${tool.name} 声明 output.schema + render`, Boolean(tool.output && tool.output.schema && typeof tool.output.render === 'function'))
  check(`工具 ${tool.name} parameters 是 object`, tool.parameters && tool.parameters.type === 'object')
  check(`工具 ${tool.name} 有 execute`, typeof tool.execute === 'function')
  const allowed = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title'])
  const walk = (schema, path) => {
    if (!schema || typeof schema !== 'object') return []
    const bad = []
    for (const key of Object.keys(schema)) {
      if (!allowed.has(key)) bad.push(`${path}.${key}`)
    }
    for (const [key, value] of Object.entries(schema.properties || {})) bad.push(...walk(value, `${path}.properties.${key}`))
    if (schema.items) bad.push(...walk(schema.items, `${path}.items`))
    for (const [i, variant] of (schema.oneOf || []).entries()) bad.push(...walk(variant, `${path}.oneOf[${i}]`))
    return bad
  }
  const badParams = walk(tool.parameters, 'parameters')
  const badOutput = walk(tool.output.schema, 'output')
  check(`工具 ${tool.name} 只用了受支持的 schema 关键字`, badParams.length === 0 && badOutput.length === 0, [...badParams, ...badOutput].join(','))
}

/**
 * 假的 res：必须是一个真正的 Writable，否则下载路由里的 createReadStream().pipe(res)
 * 会因为没有 once/emit 而抛错（真实 ServerResponse 是流，这里要同构）。
 */
class FakeRes extends Writable {
  constructor() {
    super()
    this.state = { status: 0, headers: {}, chunks: [], ended: false }
    this.headersSent = false
    this.on('finish', () => {
      this.state.ended = true
    })
  }

  writeHead(status, headers) {
    this.state.status = status
    this.state.headers = headers || {}
    this.headersSent = true
    return this
  }

  _write(chunk, _encoding, callback) {
    if (chunk) this.state.chunks.push(Buffer.from(chunk))
    callback()
  }

  destroy(error) {
    this.state.ended = true
    return super.destroy(error)
  }
}

async function call(method, url, { body, headers = {} } = {}) {
  const req = Readable.from(body === undefined ? [] : [body])
  req.method = method
  req.url = url
  req.headers = { 'content-type': 'application/octet-stream', ...headers }
  const res = new FakeRes()
  await routes[0].handler(req, res)
  // 流式响应（下载）要等 finish 才算写完；普通响应 end() 之后也会 finish。
  if (!res.state.ended) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 500)
      res.once('finish', () => {
        clearTimeout(timer)
        resolve()
      })
      res.once('error', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
  const buffer = Buffer.concat(res.state.chunks)
  let json
  try {
    json = JSON.parse(buffer.toString('utf8'))
  } catch {
    json = undefined
  }
  return { status: res.state.status, headers: res.state.headers, body: buffer, json }
}

const text = '光合作用的暗反应阶段不需要光照，但需要 ATP 与 NADPH。'.repeat(3)
const up = await call('POST', `/dsh-local-library/upload?name=${encodeURIComponent('植物学笔记.md')}`, {
  body: Buffer.from(text, 'utf8'),
  headers: { 'content-type': 'text/markdown' }
})
check('上传返回 200', up.status === 200, `status=${up.status} body=${up.body.toString().slice(0, 200)}`)
check('上传返回条目 id', Boolean(up.json?.item?.id), JSON.stringify(up.json))

const entryId = up.json?.item?.id
// 后台抽取是异步的，等它落盘
await new Promise((resolve) => setTimeout(resolve, 300))

const list = await call('GET', '/dsh-local-library/list')
check('列表返回 1 条', list.json?.items?.length === 1, JSON.stringify(list.json?.stats))
check('列表条目已建索引并带正文字数', list.json?.items?.[0]?.indexed === true && list.json?.items?.[0]?.textChars > 0, JSON.stringify(list.json?.items?.[0]?.textChars))
check('列表带 root 路径', typeof list.json?.stats?.root === 'string' && list.json.stats.root.startsWith(home), list.json?.stats?.root)

const search = await call('GET', `/dsh-local-library/list?q=${encodeURIComponent('ATP')}`)
check('检索命中 1 条', search.json?.items?.length === 1, JSON.stringify(search.json?.items?.map((i) => i.name)))
check('检索带命中片段', String(search.json?.items?.[0]?.snippet || '').includes('ATP'), JSON.stringify(search.json?.items?.[0]?.snippet))

const empty = await call('GET', `/dsh-local-library/list?q=${encodeURIComponent('量子纠缠')}`)
check('无命中返回空列表', Array.isArray(empty.json?.items) && empty.json.items.length === 0, JSON.stringify(empty.json?.items?.length))

const download = await call('GET', `/dsh-local-library/download?id=${encodeURIComponent(entryId)}`)
check('下载状态 200', download.status === 200, `status=${download.status}`)
check('下载内容与上传一致', download.body.toString('utf8') === text, `${download.body.length} vs ${Buffer.byteLength(text)}`)
check('下载带 content-disposition', String(download.headers['content-disposition'] || '').includes('attachment'), String(download.headers['content-disposition']))

const notFound = await call('GET', '/dsh-local-library/download?id=ll-nope')
check('下载不存在的 id 返回 404', notFound.status === 404, `status=${notFound.status}`)

// 工具调用
const listTool = tools.find((tool) => tool.name === 'library_list')
const listValue = await listTool.execute({})
check('library_list 工具看到 1 条', listValue.count === 1 && listValue.items.length === 1, JSON.stringify(listValue))
const listRender = listTool.output.render({}, listValue)
check('library_list render 返回文本', Array.isArray(listRender) && listRender[0].type === 'text' && listRender[0].text.includes('植物学笔记.md'), String(listRender?.[0]?.text).slice(0, 120))

const searchTool = tools.find((tool) => tool.name === 'library_search')
const searchValue = await searchTool.execute({ query: '暗反应' })
check('library_search 命中片段含关键词', searchValue.hits === 1 && String(searchValue.results[0].snippet).includes('暗反应'), JSON.stringify(searchValue.results?.[0]?.snippet))

const readTool = tools.find((tool) => tool.name === 'library_read')
const readValue = await readTool.execute({ id: entryId, maxChars: 20 })
check(
  'library_read 分段读并提示续读',
  readValue.found &&
    readValue.text.startsWith(readValue.text.slice(0, 20)) &&
    readValue.offset === 0 &&
    readValue.remaining > 0 &&
    readValue.nextOffset === 20 &&
    readValue.text.includes('offset 设成 20'),
  JSON.stringify({ total: readValue.total, remaining: readValue.remaining, nextOffset: readValue.nextOffset, len: readValue.text.length })
)
const readTail = await readTool.execute({ id: entryId, maxChars: 200000, offset: readValue.total })
check('library_read offset 超长时返回空且不报错', readTail.found === true && readTail.remaining === 0, JSON.stringify({ len: readTail.text.length }))

// 渲染出来的区间必须是真实读到的字数（readText 会给正文尾巴拼续读提示，不能拿 text.length 算）
const readRender = readTool.output.render({}, readValue)
check(
  'library_read render 的区间按 nextOffset 算',
  readRender[0].text.includes('第 1–20 字'),
  String(readRender[0].text).slice(0, 160)
)
const readMiss = await readTool.execute({ id: 'll-nope' })
check('library_read 找不到时 found=false', readMiss.found === false)

const saveTool = tools.find((tool) => tool.name === 'library_save')
const saveValue = await saveTool.execute({ name: 'agent笔记.md', content: '这是 agent 存进来的结论：优先用关键词检索。', tags: ['测试'] })
check('library_save 存成功', saveValue.saved === true && saveValue.textChars > 0, JSON.stringify(saveValue))
const afterSave = await call('GET', `/dsh-local-library/list?q=${encodeURIComponent('agent 存')}`)
check('存进来的内容可被检索', afterSave.json?.items?.length >= 1, JSON.stringify(afterSave.json?.items?.map((i) => i.name)))

// 中文分词：整句里只出现"差旅费"，也要能靠 bigram 命中
const budget = '2026 年度预算表：差旅费 12 万，会议费 3 万，设备采购 8 万。'
const budgetUp = await call('POST', `/dsh-local-library/upload?name=${encodeURIComponent('预算表.txt')}`, {
  body: Buffer.from(budget, 'utf8'),
  headers: { 'content-type': 'text/plain' }
})
check('中文名文档上传成功', budgetUp.status === 200, JSON.stringify(budgetUp.json?.error))
const longQuery = await call('GET', `/dsh-local-library/list?q=${encodeURIComponent('预算表里的差旅费')}`)
check(
  '长句检索（bigram）命中预算表',
  (longQuery.json?.items || []).some((it) => it.name === '预算表.txt'),
  JSON.stringify((longQuery.json?.items || []).map((it) => it.name))
)

// 重复内容：默认 409 + duplicate 信息；dup=keep 再存一份
const dup = await call('POST', `/dsh-local-library/upload?name=${encodeURIComponent('预算表-副本.txt')}`, {
  body: Buffer.from(budget, 'utf8'),
  headers: { 'content-type': 'text/plain' }
})
check('重复内容返回 409', dup.status === 409 && dup.json?.error === 'duplicate', `status=${dup.status}`)
check('重复响应带已有条目信息', Boolean(dup.json?.duplicate?.id), JSON.stringify(dup.json?.duplicate))
const dupKeep = await call('POST', `/dsh-local-library/upload?name=${encodeURIComponent('预算表-副本.txt')}&dup=keep`, {
  body: Buffer.from(budget, 'utf8'),
  headers: { 'content-type': 'text/plain' }
})
check('dup=keep 允许再存一份', dupKeep.status === 200 && Boolean(dupKeep.json?.item?.id), `status=${dupKeep.status}`)

// 标签与改名
const budgetId = budgetUp.json?.item?.id
const patched = await call('PATCH', `/dsh-local-library/item?id=${encodeURIComponent(budgetId)}`, {
  body: Buffer.from(JSON.stringify({ tags: ['财务', '2026'], name: '2026预算表.txt' }), 'utf8'),
  headers: { 'content-type': 'application/json' }
})
check(
  'PATCH 改标签与文件名',
  patched.status === 200 && patched.json?.item?.name === '2026预算表.txt' && patched.json?.item?.tags?.includes('财务'),
  JSON.stringify(patched.json?.item?.tags)
)
const byTag = await call('GET', `/dsh-local-library/list?q=${encodeURIComponent('tag:财务')}`)
check('按标签过滤', (byTag.json?.items || []).some((it) => it.id === budgetId), JSON.stringify(byTag.json?.items?.length))

// 打包下载
const bundle = await call('POST', '/dsh-local-library/bundle', {
  body: Buffer.from(JSON.stringify({ ids: [budgetId, entryId] }), 'utf8'),
  headers: { 'content-type': 'application/json' }
})
const zipBuf = bundle.body || Buffer.alloc(0)
check('打包返回 zip', bundle.status === 200 && zipBuf.subarray(0, 2).toString('utf8') === 'PK', `status=${bundle.status} len=${zipBuf.length}`)
check(
  'zip 里有两个文件名',
  zipBuf.includes(Buffer.from('2026预算表.txt', 'utf8')) && zipBuf.includes(Buffer.from('植物学笔记.md', 'utf8')),
  `len=${zipBuf.length}`
)
check('打包带 content-disposition', String(bundle.headers['content-disposition'] || '').includes('filename*='))

// 删除
const del = await call('DELETE', `/dsh-local-library/item?id=${encodeURIComponent(entryId)}`)
check('删除返回 200', del.status === 200, `status=${del.status}`)
const afterDelete = await call('GET', '/dsh-local-library/list')
check('删除后只剩 3 条', afterDelete.json?.items?.length === 3, JSON.stringify(afterDelete.json?.items?.map((i) => i.name)))
const delFile = await readFile(join(home, 'local-library', 'index.json'), 'utf8').catch(() => '')
check('索引文件可读且是 JSON', delFile.startsWith('{'), delFile.slice(0, 80))

// 清理
for (const item of [...disposers].reverse()) {
  if (typeof item.dispose === 'function') item.dispose()
}
await rm(home, { recursive: true, force: true }).catch(() => {})

console.log('')
if (failures === 0) {
  console.log('全部通过')
  process.exit(0)
} else {
  console.log(`失败 ${failures} 项`)
  process.exit(1)
}
