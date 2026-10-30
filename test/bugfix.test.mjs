/**
 * 回归测试：把审计中发现的 bug 逐条复现成断言。
 *
 * 每条都以「修好之后应该成立」的形式写，所以修之前应当看到 FAIL。
 * 运行：$env:ELECTRON_NO_ASAR='1'; & ...\.desktop-bin\node.cmd test\bugfix.test.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
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
