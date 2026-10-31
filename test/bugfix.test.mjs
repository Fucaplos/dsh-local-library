/**
 * 回归测试：把审计中发现的 bug 逐条复现成断言。
 *
 * 每条都以「修好之后应该成立」的形式写，所以修之前应当看到 FAIL。
 * 运行：$env:ELECTRON_NO_ASAR='1'; & ...\.desktop-bin\node.cmd test\bugfix.test.mjs
 */
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

const home = await mkdtemp(join(tmpdir(), 'll-bugfix-'))
process.env.DSH_HOME = home

let failures = 0
const check = (name, condition, detail) => {
  if (condition) console.log(`PASS ${name}`)
  else {
    failures += 1
    console.log(`FAIL ${name}${detail ? ` → ${detail}` : ''}`)
  }
}

const mod = await import('../lib/index.js')

const routes = []
const tools = []
const ctx = {
  effect(fn) {
    fn()
  },
  webServer: { register: (route) => (routes.push(route), () => {}) },
  tools: { register: (definition) => (tools.push(definition), () => {}) },
  systemPrompt: { section: () => () => {} }
}
mod.apply(ctx)

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
  _write(chunk, _enc, callback) {
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

const upload = (name, content) =>
  call('POST', `/dsh-local-library/upload?name=${encodeURIComponent(name)}`, {
    body: content === undefined ? undefined : Buffer.from(content),
    headers: { 'content-type': 'text/markdown' }
  })

// ── BUG 1：文件名里带 % 时上传 500 ──────────────────────────────────────
// query.get('name') 已经解码过一次，index.js 又 decodeURIComponent 了一次，
// 于是 "完成度 100%.md" 里的 % 被当成转义前缀 → URIError: URI malformed。
const percent = await upload('完成度 100%.md', '第一行\n第二行')
check(
  'BUG1 文件名含 % 能正常上传',
  percent.status === 200 && Boolean(percent.json?.item?.id),
  `status=${percent.status} body=${percent.body.toString().slice(0, 120)}`
)

// 顺带确认双重解码没有把 %41 变成 A
const percentLike = await upload('报告%A1.md', 'x')
check(
  'BUG1b 文件名里的 %41 不被二次解码',
  percentLike.status === 200 && percentLike.json?.item?.name === '报告%A1.md',
  `name=${percentLike.json?.item?.name}`
)

// ── BUG 2：library_save 传空白文件名会存成「未命名」─────────────────────
const saveTool = tools.find((tool) => tool.name === 'library_save')
const blank = await saveTool.execute({ name: '   ', content: '有些内容' })
check('BUG2 空白文件名不落库', blank.saved === false, JSON.stringify(blank))

// ── BUG 3：GET /list 不带 q 时 limit 被忽略 ────────────────────────────
await upload('limit-a.md', 'aaa')
await upload('limit-b.md', 'bbb')
const limited = await call('GET', '/dsh-local-library/list?limit=2')
check(
  'BUG3 /list?limit=2 只返回 2 条',
  Array.isArray(limited.json?.items) && limited.json.items.length === 2,
  `items=${limited.json?.items?.length}`
)

// ── BUG 4：library_read 的 offset 超过全文长度时，返回的是续读提示而不是空 ──
const readTool = tools.find((tool) => tool.name === 'library_read')
const savedForRead = await saveTool.execute({ name: 'readme-回归.md', content: '零一二三四五六七八九十' })
const beyond = await readTool.execute({ id: savedForRead.id, offset: 9999 })
check(
  'BUG4 offset 超出全文时正文为空',
  beyond.found === true && beyond.text === '' && beyond.remaining === 0,
  `text=${JSON.stringify(beyond.text)} remaining=${beyond.remaining}`
)
const beyondRender = readTool.output.render({}, beyond)
check(
  'BUG4b 渲染提示「已到末尾」而不是「没有可读正文」',
  String(beyondRender[0].text).includes('末尾'),
  String(beyondRender[0].text).slice(0, 160)
)
const first = await readTool.execute({ id: savedForRead.id, maxChars: 5 })
check(
  'BUG4c 正常分段读仍可用',
  first.found === true && first.nextOffset === 5 && first.text.startsWith('零一二三四'),
  JSON.stringify({ n: first.nextOffset, text: first.text })
)

// ── BUG 5：空文件（0 字节）打包时被过滤掉，选中全部空文件会 404 ─────────
const emptyUp = await upload('空的.txt', '')
check('BUG5a 空文件能上传', emptyUp.status === 200 && Boolean(emptyUp.json?.item?.id), `status=${emptyUp.status}`)
const bundle = await call('POST', '/dsh-local-library/bundle', {
  body: Buffer.from(JSON.stringify({ ids: [emptyUp.json?.item?.id] })),
  headers: { 'content-type': 'application/json' }
})
check(
  'BUG5b 只选空文件也能打包',
  bundle.status === 200 && bundle.body.subarray(0, 2).toString('utf8') === 'PK',
  `status=${bundle.status} body=${bundle.body.toString('utf8').slice(0, 80)}`
)

// ── BUG 6：reindex 一次把所有条目并发丢进抽取，没有并发上限 ─────────────
const reindex = await call('POST', '/dsh-local-library/reindex?all=1')
check(
  'BUG6 reindex 返回 queued 与 forced',
  reindex.status === 200 && Number(reindex.json?.queued) >= 4 && reindex.json?.forced === true,
  JSON.stringify(reindex.json)
)

// ── BUG 7：/list 不带 q 时把内部对象（含 sha256）原样吐给前端 ────────────
const plain = await call('GET', '/dsh-local-library/list?limit=1')
check(
  'BUG7 列表不泄露 sha256',
  plain.json?.items?.every((item) => item.sha256 === undefined),
  JSON.stringify(Object.keys(plain.json?.items?.[0] || {}))
)

// ── BUG 9：分段读按 UTF-16 切，emoji 会被切成半个字符 ──────────────────
const emojiSave = await saveTool.execute({ name: 'emoji.md', content: '一二三😀四五六七八九十' })
const emojiRead = await readTool.execute({ id: emojiSave.id, maxChars: 4 })
check(
  'BUG9 分段读不切断 emoji',
  emojiRead.text.startsWith('一二三') && !emojiRead.text.includes('\ud83d'),
  JSON.stringify(emojiRead.text.slice(0, 12))
)

// ── BUG 10：改名后 ext/mime 不跟着变，下载时 Content-Type 是旧的 ────────
const renameUp = await upload('原名.txt', '正文')
const renamed = await call('PATCH', `/dsh-local-library/item?id=${renameUp.json?.item?.id}`, {
  body: Buffer.from(JSON.stringify({ name: '改名后.md' })),
  headers: { 'content-type': 'application/json' }
})
check(
  'BUG10 改名后 ext 与 mime 跟着变',
  renamed.json?.item?.ext === '.md' && String(renamed.json?.item?.mime || '').includes('markdown'),
  JSON.stringify({ ext: renamed.json?.item?.ext, mime: renamed.json?.item?.mime })
)

// 正文索引是异步的（indexInBackground），等它抽完再检索，否则正文还是空的。
async function waitIndexed(id, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const listed = await call('GET', '/dsh-local-library/list?limit=1000')
    const item = (listed.json?.items || []).find((row) => row.id === id)
    if (item && Number(item.textChars) > 0) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

// ── BUG 11：只命中文件名时，工具里看不出「为什么命中」 ─────────────────
// 之前 snippet 为空就直接不显示任何说明，看起来像空结果。
const nameOnlyUp = await upload('季度汇报-只命中文件名.md', '正文里没有那个词，全是别的内容占位')
const searchTool = tools.find((tool) => tool.name === 'library_search')
const nameOnly = await searchTool.execute({ query: '只命中文件名', limit: 5 })
const hit = (nameOnly.results || []).find((item) => item.id === nameOnlyUp.json?.item?.id)
check(
  'BUG11 文件名命中时带 matchedBy 且片段为空',
  Boolean(hit) && hit.matchedBy === 'name' && hit.snippet === '',
  JSON.stringify({ matchedBy: hit?.matchedBy, snippet: hit?.snippet })
)
const nameOnlyText = searchTool.output.render({}, nameOnly)[0].text
check(
  'BUG11b 渲染里说明「按文件名/标签命中」',
  nameOnlyText.includes('按文件名/标签'),
  nameOnlyText.slice(0, 300)
)

// 设置页走的是 GET /list?q=，这条路径也必须带 matchedBy，否则客户端拿不到来源标记。
const nameOnlyList = await call('GET', `/dsh-local-library/list?q=${encodeURIComponent('只命中文件名')}&limit=5`)
const nameOnlyRow = (nameOnlyList.json?.items || []).find((row) => row.id === nameOnlyUp.json?.item?.id)
check(
  'BUG11d /list?q= 也返回 matchedBy',
  Boolean(nameOnlyRow) && nameOnlyRow.matchedBy === 'name',
  JSON.stringify({ matchedBy: nameOnlyRow?.matchedBy })
)

// 正文命中的仍然给片段，且 matchedBy 是 body
const bodyOnlyUp = await upload('正文命中示例.md', '这段正文里包含独有标记 蓝鲸协议 三个词')
await waitIndexed(bodyOnlyUp.json?.item?.id)
const bodyHitResult = await searchTool.execute({ query: '蓝鲸协议', limit: 5 })
const bodyHit = (bodyHitResult.results || []).find((item) => item.id === bodyOnlyUp.json?.item?.id)
check(
  'BUG11c 正文命中时给片段且 matchedBy 为 body',
  Boolean(bodyHit) && bodyHit.matchedBy === 'body' && bodyHit.snippet.includes('蓝鲸协议'),
  JSON.stringify({ matchedBy: bodyHit?.matchedBy, snippet: bodyHit?.snippet })
)

// ── BUG 12：中文 bigram 让「擦边」也命中，需要严格匹配开关 ───────────────
// "预算表里的差旅费" 切成 7 个 bigram；正文里只出现 "差旅费" 的文件命中率只有 2/7，
// 宽松模式仍会返回（用户看到的就是"搜什么都有一堆结果"），严格模式应当滤掉。
const strictFull = await upload('严格-完整句.md', '本次会议讨论预算表里的差旅费标准，并给出上限。')
const strictPartial = await upload('严格-部分词.md', '差旅费 报销 流程 说明')
await waitIndexed(strictFull.json?.item?.id)
await waitIndexed(strictPartial.json?.item?.id)

const looseHits = await searchTool.execute({ query: '预算表里的差旅费', limit: 20 })
const looseIds = (looseHits.results || []).map((row) => row.id)
check(
  'BUG12a 宽松模式两份都命中',
  looseIds.includes(strictFull.json?.item?.id) && looseIds.includes(strictPartial.json?.item?.id),
  JSON.stringify(looseIds)
)

const strictHits = await searchTool.execute({ query: '预算表里的差旅费', limit: 20, strict: true })
const strictIds = (strictHits.results || []).map((row) => row.id)
check(
  'BUG12b 严格模式只留整句命中的那份',
  strictIds.includes(strictFull.json?.item?.id) && !strictIds.includes(strictPartial.json?.item?.id),
  JSON.stringify(strictIds)
)

const noSuch = await searchTool.execute({ query: 'zzzmarker', limit: 20, strict: true })
check('BUG12c 严格模式下纯拉丁无命中的查询返回空', (noSuch.results || []).length === 0, JSON.stringify(noSuch.results))

// ── BUG 13：严格匹配需要能记住，否则每次都要手动传参数 ─────────────────
const configDefault = await call('GET', '/dsh-local-library/config')
check('BUG13a 默认是宽松匹配', configDefault.json?.matchMode === 'loose', JSON.stringify(configDefault.json))

const configBad = await call('PUT', '/dsh-local-library/config', {
  body: Buffer.from(JSON.stringify({ matchMode: 'dee' })),
  headers: { 'content-type': 'application/json' }
})
check('BUG13b 非法 matchMode 返回 400', configBad.status === 400 && configBad.json?.error === 'invalid-match-mode', JSON.stringify(configBad.json))

const configSet = await call('PUT', '/dsh-local-library/config', {
  body: Buffer.from(JSON.stringify({ matchMode: 'strict' })),
  headers: { 'content-type': 'application/json' }
})
check('BUG13c 写入严格模式', configSet.status === 200 && configSet.json?.matchMode === 'strict', JSON.stringify(configSet.json))

const persisted = await call('GET', `/dsh-local-library/list?q=${encodeURIComponent('预算表里的差旅费')}&limit=20`)
const persistedIds = (persisted.json?.items || []).map((row) => row.id)
check(
  'BUG13d 设置落盘后 /list 走严格模式',
  persistedIds.includes(strictFull.json?.item?.id) && !persistedIds.includes(strictPartial.json?.item?.id),
  JSON.stringify(persistedIds)
)

const configReset = await call('PUT', '/dsh-local-library/config', {
  body: Buffer.from(JSON.stringify({ matchMode: 'loose' })),
  headers: { 'content-type': 'application/json' }
})
check('BUG13e 能切回宽松模式', configReset.json?.matchMode === 'loose', JSON.stringify(configReset.json))

// ── BUG 14：`tag:` 是包含匹配，`tag:财务` 会把「财务部」也筛出来 ──────────
const tagExact = await upload('标签-财务.md', '无关正文')
const tagFuzzy = await upload('标签-财务部.md', '无关正文')
await call('PATCH', `/dsh-local-library/item?id=${tagExact.json?.item?.id}`, {
  body: Buffer.from(JSON.stringify({ tags: ['财务'] })),
  headers: { 'content-type': 'application/json' }
})
await call('PATCH', `/dsh-local-library/item?id=${tagFuzzy.json?.item?.id}`, {
  body: Buffer.from(JSON.stringify({ tags: ['财务部'] })),
  headers: { 'content-type': 'application/json' }
})
const tagHits = await searchTool.execute({ query: 'tag:财务', limit: 20 })
const tagIds = (tagHits.results || []).map((row) => row.id)
check(
  'BUG14 tag: 精确匹配整个标签，不命中「财务部」',
  tagIds.includes(tagExact.json?.item?.id) && !tagIds.includes(tagFuzzy.json?.item?.id),
  JSON.stringify(tagIds)
)

// ── BUG 15：`after:` 日期写错时静默失效，用户以为筛过了 ─────────────────
const { queryWarnings } = await import('../lib/store.js')
check('BUG15a queryWarnings 能认出非法日期', queryWarnings('after:2026-13-99').length === 1, JSON.stringify(queryWarnings('after:2026-13-99')))
check('BUG15b 合法日期不报警', queryWarnings('after:2026-10-01').length === 0, JSON.stringify(queryWarnings('after:2026-10-01')))
const warnList = await call('GET', `/dsh-local-library/list?q=${encodeURIComponent('after:2026-13-99')}&limit=5`)
check(
  'BUG15c /list 把被忽略的过滤条件带回来',
  Array.isArray(warnList.json?.warnings) && warnList.json.warnings.length === 1,
  JSON.stringify(warnList.json?.warnings)
)
const warnTool = await searchTool.execute({ query: 'after:2026-13-99', limit: 5 })
const warnText = searchTool.output.render({}, warnTool)[0].text
check(
  'BUG15d library_search 渲染里提示日期被忽略',
  Array.isArray(warnTool.warnings) && warnTool.warnings.length === 1 && warnText.includes('⚠'),
  JSON.stringify({ warnings: warnTool.warnings, head: warnText.slice(0, 40) })
)

// ── BUG 16：init() 失败一次就被永久记忆，整进程都不可用 ──────────────────
const { LibraryStore } = await import('../lib/store.js')
const retryRoot = await mkdtemp(join(tmpdir(), 'll-retry-'))
await writeFile(join(retryRoot, 'files'), 'not a directory')
const retryStore = new LibraryStore(retryRoot)
let firstInit = ''
try {
  await retryStore.init()
} catch (error) {
  firstInit = String(error?.code || error?.message || error)
}
await unlink(join(retryRoot, 'files'))
let secondInit = false
try {
  await retryStore.init()
  secondInit = true
} catch {
  secondInit = false
}
check('BUG16 init 失败后能重试成功，不被永久记忆', firstInit !== '' && secondInit, `first=${firstInit} second=${secondInit}`)
await rm(retryRoot, { recursive: true, force: true })

// ── BUG 17：offset 落在代理对中间时正文从半个 emoji 开始 ────────────────
const surrogateRead = await readTool.execute({ id: emojiSave.id, maxChars: 20, offset: 4 })
const surrogateText = String(surrogateRead.text || '')
check(
  'BUG17 offset 落在代理对中间时自动对齐到下一个字符',
  !/^[\uDC00-\uDFFF]/.test(surrogateText) && surrogateText.startsWith('四'),
  JSON.stringify(surrogateText.slice(0, 6))
)

// ── BUG 18：上传无超时 / 进度不节流 / Esc 取消却被 blur 存回（客户端源码守卫）
const clientSrc = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
check('BUG18a 上传有心跳看门狗', clientSrc.includes('UPLOAD_STALL_MS') && clientSrc.includes('xhr.abort()'), '')
check('BUG18b 进度条按时间节流', clientSrc.includes('PROGRESS_THROTTLE_MS'), '')
check('BUG18c Esc 取消标签编辑不会被 blur 存回', clientSrc.includes('tagAbort.current'), '')

// ── BUG 8：下载方中途断开时 writeZip 不能永远等 drain ───────────────────
const { writeZip } = await import('../lib/zip.js')
const deadRes = new FakeRes()
deadRes.destroy()
let zipErr = ''
const outcome = await Promise.race([
  writeZip(deadRes, [{ name: 'a.txt', path: 'x', size: 1 }]).then(
    () => 'resolved',
    (error) => ((zipErr = String(error?.message || error)), 'rejected')
  ),
  new Promise((resolve) => setTimeout(() => resolve('hung'), 1500))
])
check('BUG8 客户端断开时打包及时失败而不是挂住', outcome === 'rejected' && zipErr.includes('closed'), `outcome=${outcome} err=${zipErr}`)

await new Promise((resolve) => setTimeout(resolve, 400))
await rm(home, { recursive: true, force: true })

console.log('')
if (failures === 0) {
  console.log('全部通过')
  process.exit(0)
} else {
  console.log(`失败 ${failures} 项`)
  process.exit(1)
}
