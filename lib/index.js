/**
 * dsh-local-library —— 宿主半侧（Cordis 插件）。
 *
 * 三件事：
 *   1. 注册 HTTP 路由 /dsh-local-library/*，给设置页做上传 / 列表 / 下载 / 删除；
 *   2. 注册 4 个工具（library_list / library_search / library_read / library_save），
 *      让任何会话里的 agent 都能直接查这份资料库；
 *   3. 注册一段全局系统提示词，说明"本机有资料库、先查再问"，于是每个新对话天然知道它。
 *
 * 只用 Node 内置模块：profile 的 node_modules 里没有 @deepseek-ai/* 的运行时副本。
 */
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LibraryStore, MAX_UPLOAD_BYTES, sanitizeName, safeExt, queryWarnings } from './store.js'
import { extractText, guessKind } from './extract.js'
import { pdfTextViaPython } from './pdftext.js'
import { describeImage, normalizeVisionConfig } from './vision.js'
import { writeZip } from './zip.js'

export const name = 'local-library'
export const inject = ['webServer', 'tools', 'systemPrompt']

/** 路由前缀（与包名一致，方便在日志里认）。 */
const ROUTE_PREFIX = '/dsh-local-library'
/** 上传响应体上限 = 单文件上限 + 一点余量（按流式写入，内存占用与文件大小无关）。 */
const UPLOAD_LIMIT = MAX_UPLOAD_BYTES + 1024 * 1024
/** 一次打包下载最多多少个文件。 */
const BUNDLE_MAX = 300

/** 内置流抽取对这种 PDF 明显没抽到东西，值得再让 PyMuPDF 试一次。 */
function looksUnusablePdfText(text) {
  const body = String(text || '')
  const trimmed = body.trim()
  if (trimmed.length < 200) return true
  const replacements = (body.match(/\uFFFD/g) || []).length
  if (replacements > 5) return true
  // 控制字符占比高，通常是字体码没映射出来的乱码
  const controls = (body.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g) || []).length
  return controls > trimmed.length * 0.02
}

function isImageMime(mime) {
  return String(mime || '').toLowerCase().startsWith('image/')
}

function resolveDshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  return join(homedir(), '.dsh')
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(text)
}

/** RFC 5987 的 filename*，中文名下载不乱码。 */
function contentDisposition(name) {
  const ascii = String(name || 'download').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

function readQuery(req) {
  const url = new URL(req.url || '/', 'http://localhost')
  return { url, query: url.searchParams }
}

/** 读小 JSON 请求体（只用于 PATCH / bundle 这类控制请求，限 1MB）。 */
const BODY_LIMIT = 1024 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * 索引条目 → 给前端 / 工具的公开视图。
 * 索引里存着 sha256（去重用的内部字段）和磁盘布局细节，不该顺着 HTTP 吐出去。
 */
function publicItem(item) {
  return {
    id: String(item.id || ''),
    name: String(item.name || ''),
    ext: String(item.ext || ''),
    mime: String(item.mime || ''),
    kind: String(item.kind || 'other'),
    size: Number(item.size) || 0,
    textChars: Number(item.textChars) || 0,
    indexed: Boolean(item.indexed),
    createdAt: String(item.createdAt || ''),
    addedBy: String(item.addedBy || ''),
    tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
    note: String(item.note || '')
  }
}

export function apply(ctx, config) {
  const root = join(resolveDshHome(), 'local-library')
  const store = new LibraryStore(root)
  const vision = normalizeVisionConfig(config?.vision)
  const initPromise = store.init().catch((error) => {
    console.error('[dsh-local-library] 资料库初始化失败：', error)
    throw error
  })

  /**
   * 后台建索引：先响应上传，抽取慢慢做。
   * PDF 先用内置流抽取；抽不出东西（中文子集字体）时再用 PyMuPDF 兜底；
   * 图片走视觉模型生成一段描述，于是"搜文字"也能搜到截图。
   */
  const indexInBackground = (item) =>
    (async () => {
      const path = store.filePath(item)
      try {
        let result = await extractText({ path, name: item.name, mime: item.mime })
        let note = result.note || ''

        if (result.kind === 'pdf' && looksUnusablePdfText(result.text)) {
          const better = await pdfTextViaPython(path)
          if (better && better.text.trim().length > String(result.text || '').trim().length) {
            result = { text: better.text, kind: 'pdf', note: `PyMuPDF 抽取 ${better.pages} 页` }
            note = result.note
          }
        }

        if (isImageMime(item.mime)) {
          const described = await describeImage(await readFile(path), item.mime, vision)
          if (described?.text) {
            const head = `图片内容描述：${described.text}`
            const merged = result.text.trim() ? `${result.text}\n\n${head}` : head
            result = { text: merged, kind: 'image', note: '' }
            note = ''
          } else if (described?.error) {
            note = `${described.error}（可另配视觉模型；不影响下载）`
          } else if (!vision.enabled) {
            note = '未配置视觉模型描述，只能按文件名检索'
          }
        }

        await store.applyExtraction(item.id, { text: result.text, kind: result.kind, note })
      } catch (error) {
        await store
          .applyExtraction(item.id, { text: '', kind: item.kind, note: `extract-failed: ${String(error?.message || error)}` })
          .catch(() => {})
      }
    })()

  /**
   * 抽取任务队列：一次上传/重建索引可能排几十上百个文件，
   * 而每个抽取都会把整份文件读进内存，所以限制同时只跑 2 个。
   * 同一个条目重复入队只保留一次（连点两次"重建索引"不会跑两遍）。
   */
  const indexQueue = []
  const indexPending = new Set()
  let indexRunning = 0
  const INDEX_CONCURRENCY = 2
  const pumpIndexQueue = () => {
    while (indexRunning < INDEX_CONCURRENCY && indexQueue.length > 0) {
      const item = indexQueue.shift()
      indexRunning += 1
      indexInBackground(item)
        .catch(() => {})
        .finally(() => {
          indexRunning -= 1
          indexPending.delete(item.id)
          pumpIndexQueue()
        })
    }
  }
  const queueIndex = (item) => {
    if (!item || !item.id || indexPending.has(item.id)) return
    indexPending.add(item.id)
    indexQueue.push(item)
    pumpIndexQueue()
  }

  // ── HTTP 路由 ────────────────────────────────────────────────────────────
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          try {
            await initPromise
          } catch {
            sendJson(res, 500, { error: 'store-init-failed' })
            return
          }
          const { url, query } = readQuery(req)
          const route = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')
          const method = (req.method || 'GET').toUpperCase()

          try {
            if (route === 'list' && method === 'GET') {
              const q = query.get('q') || ''
              const limit = Math.max(1, Math.min(Number(query.get('limit')) || 200, 1000))
              // 不带关键词时也要按 limit 截断，并且只吐出前端需要的字段：
              // 索引里的 sha256 是内部去重用的，没必要（也不应该）发给页面。
              const items = q
                ? (await store.search(q, limit)).map((hit) => ({
                    ...publicItem(hit.item),
                    score: hit.score,
                    snippet: hit.snippet,
                    matchedBy: hit.matchedBy || ''
                  }))
                : store.items().slice(0, limit).map(publicItem)
              const stats = await store.stats()
              sendJson(res, 200, { items, stats, pending: store.pending(), warnings: q ? queryWarnings(q) : [] })
              return
            }

            if (route === 'stats' && method === 'GET') {
              sendJson(res, 200, await store.stats())
              return
            }

            // 设置页的「严格匹配」开关：loose（默认，宽松） / strict（要求关键词命中率高）。
            if (route === 'config' && method === 'GET') {
              sendJson(res, 200, await store.getSettings())
              return
            }

            if (route === 'config' && (method === 'PUT' || method === 'POST')) {
              const raw = await readBody(req)
              let parsed
              try {
                parsed = JSON.parse(raw.toString('utf8') || '{}')
              } catch {
                sendJson(res, 400, { error: 'invalid-json' })
                return
              }
              const mode = parsed?.matchMode
              if (mode !== undefined && mode !== 'loose' && mode !== 'strict') {
                sendJson(res, 400, { error: 'invalid-match-mode', allowed: ['loose', 'strict'] })
                return
              }
              sendJson(res, 200, await store.updateSettings(mode === undefined ? {} : { matchMode: mode }))
              return
            }

            if (route === 'upload' && method === 'POST') {
              const declared = Number(req.headers['content-length']) || 0
              if (declared > UPLOAD_LIMIT) {
                sendJson(res, 413, { error: 'too-large', limit: MAX_UPLOAD_BYTES })
                return
              }
              // query.get() 拿到的已经是解码后的值，这里不能再 decodeURIComponent：
              // 文件名里带 % 的文件（"完成度 100%.md"）会被二次解码抛 URIError，上传直接 500。
              const rawName = query.get('name') || '未命名'
              const fileName = sanitizeName(rawName)
              const kind = guessKind(fileName, req.headers['content-type'] || '')
              const asked = String(query.get('dup') || 'reject').toLowerCase()
              const duplicatePolicy = ['keep', 'replace', 'reject'].includes(asked) ? asked : 'reject'
              const tags = String(query.get('tags') || '')
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean)
              const { item, duplicate } = await store.addFile({
                name: fileName,
                stream: req,
                kind,
                addedBy: 'upload',
                tags,
                duplicatePolicy
              })
              if (!item) {
                // 内容完全一样：把已有条目告诉界面，让它问用户"覆盖 / 再存一份 / 跳过"。
                sendJson(res, 409, {
                  error: 'duplicate',
                  duplicate: duplicate
                    ? {
                        id: duplicate.id,
                        name: duplicate.name,
                        size: Number(duplicate.size) || 0,
                        createdAt: duplicate.createdAt
                      }
                    : null
                })
                return
              }
              queueIndex(item)
              sendJson(res, 200, { item, replaced: duplicate ? duplicate.id : '' })
              return
            }

            if (route === 'item' && method === 'PATCH') {
              const id = query.get('id') || ''
              const raw = await readBody(req)
              let patch = {}
              try {
                patch = raw ? JSON.parse(raw.toString('utf8')) : {}
              } catch {
                sendJson(res, 400, { error: 'bad-json' })
                return
              }
              const item = await store.updateMeta(id, { name: patch?.name, tags: patch?.tags })
              if (!item) {
                sendJson(res, 404, { error: 'not-found' })
                return
              }
              sendJson(res, 200, { item })
              return
            }

            if (route === 'bundle' && method === 'POST') {
              const raw = await readBody(req)
              let ids = []
              try {
                const parsed = raw ? JSON.parse(raw.toString('utf8')) : {}
                ids = Array.isArray(parsed?.ids) ? parsed.ids.map(String) : []
              } catch {
                sendJson(res, 400, { error: 'bad-json' })
                return
              }
              if (ids.length === 0) {
                sendJson(res, 400, { error: 'empty-selection' })
                return
              }
              // 0 字节的文件也要能进 zip（listForBundle 里已经 stat 过，存在的文件就收）。
              const files = await store.listForBundle(ids.slice(0, BUNDLE_MAX))
              if (files.length === 0) {
                sendJson(res, 404, { error: 'not-found' })
                return
              }
              const stamp = new Date().toISOString().slice(0, 10)
              res.writeHead(200, {
                'content-type': 'application/zip',
                'content-disposition': contentDisposition(`本地资料库-${stamp}.zip`),
                'cache-control': 'no-store'
              })
              const written = await writeZip(res, files)
              res.end()
              if (written.count === 0) console.warn('[dsh-local-library] 打包内容为空')
              return
            }

            if (route === 'download' && method === 'GET') {
              const id = query.get('id') || ''
              const resolved = await store.resolveFile(id)
              if (!resolved) {
                sendJson(res, 404, { error: 'not-found' })
                return
              }
              res.writeHead(200, {
                'content-type': resolved.item.mime || 'application/octet-stream',
                'content-length': resolved.size,
                'content-disposition': contentDisposition(resolved.item.name),
                'cache-control': 'no-store'
              })
              const stream = createReadStream(resolved.path)
              stream.on('error', () => res.destroy())
              stream.pipe(res)
              return
            }

            if (route === 'item' && method === 'DELETE') {
              const id = query.get('id') || ''
              const removed = await store.remove(id)
              if (!removed) {
                sendJson(res, 404, { error: 'not-found' })
                return
              }
              sendJson(res, 200, { removed: removed.id })
              return
            }

            if (route === 'reindex' && method === 'POST') {
              const force = ['1', 'true', 'yes'].includes(String(query.get('all') || '').toLowerCase())
              const targets = force ? store.items() : store.items().filter((item) => !item.indexed)
              for (const item of targets) queueIndex(item)
              sendJson(res, 200, { queued: targets.length, forced: force })
              return
            }

            sendJson(res, 404, { error: 'no-route', route, method })
          } catch (error) {
            console.error('[dsh-local-library] 路由异常：', error)
            if (!res.headersSent) sendJson(res, 500, { error: String(error?.message || error) })
            else res.destroy()
          }
        }
      }),
    'dsh-local-library: routes'
  )

  // ── 工具 ────────────────────────────────────────────────────────────────
  const itemLine = (item) => {
    const bits = [item.name, `[${item.kind}]`, `${(Number(item.size) || 0).toString()}B`]
    if (item.indexed && item.textChars > 0) bits.push(`正文${item.textChars}字`)
    else if (!item.indexed) bits.push('索引中')
    else bits.push('无正文')
    if (item.addedBy === 'agent') bits.push('agent 存入')
    bits.push(item.createdAt)
    return `${item.id}  ${bits.join('  ')}`
  }

  const withPaths = (store, item) => ({ ...item, path: store.filePath(item) })

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'library_list',
        description:
          '列出本机「本地资料库」里的全部资料（用户自己上传的、跨会话共享的文件）。想确认库里有没有相关材料时先调它；也可以用关键词调 library_search。',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '最多返回多少条，默认 50' }
          },
          additionalProperties: false
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              count: { type: 'number' },
              bytesText: { type: 'string' },
              root: { type: 'string' },
              empty: { type: 'boolean' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    kind: { type: 'string' },
                    size: { type: 'number' },
                    textChars: { type: 'number' },
                    indexed: { type: 'boolean' },
                    createdAt: { type: 'string' },
                    path: { type: 'string' }
                  }
                }
              }
            }
          },
          render: (_args, value) => [
            {
              type: 'text',
              text:
                value.count === 0
                  ? `本地资料库是空的（目录 ${value.root}）。可以让用户在 设置 → 本地资料库 里上传文件。`
                  : `本地资料库共 ${value.count} 个文件（${value.bytesText}），目录 ${value.root}：\n${value.items
                      .map((item) => itemLine(item))
                      .join('\n')}`
            }
          ]
        },
        async execute(args) {
          await initPromise
          const limit = Math.max(1, Math.min(Number(args?.limit) || 50, 500))
          const items = store.items().slice(0, limit).map((item) => withPaths(store, item))
          const stats = await store.stats()
          return {
            count: store.items().length,
            bytesText: stats.bytesText,
            root: root,
            empty: store.items().length === 0,
            items: items.map((item) => ({
              id: item.id,
              name: item.name,
              kind: item.kind,
              size: Number(item.size) || 0,
              textChars: Number(item.textChars) || 0,
              indexed: Boolean(item.indexed),
              createdAt: item.createdAt,
              path: item.path
            }))
          }
        }
      }),
    'dsh-local-library: library_list'
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'library_search',
        description:
          '在本机「本地资料库」里按关键词检索文件名与正文（PDF/Word/Excel/PPT 已抽取成纯文本，图片若配了视觉模型则按其内容描述检索）。用户提到"我之前给你的那份资料""我的文档里有没有…"这类说法时，先检索这里，不要要求用户重新上传。中文按两字组合匹配，所以"预算表里的差旅费"也能搜到含"差旅费"的文档。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '关键词，多个用空格分隔；留空则按上传时间倒序返回最近的资料' },
            kind: {
              type: 'string',
              description: '只看某类：pdf / docx / xlsx / pptx / text / image 等（也接受 .pdf 这种扩展名）'
            },
            tag: { type: 'string', description: '只看带某个标签的资料' },
            limit: { type: 'number', description: '最多返回几条，默认 8' },
            strict: {
              type: 'boolean',
              description: '严格匹配：只返回关键词命中率高（或整句原样出现）的结果，减少擦边命中。不传则用资料库设置里的开关'
            }
          },
          required: ['query'],
          additionalProperties: false
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string' },
              hits: { type: 'number' },
              total: { type: 'number' },
              warnings: {
                type: 'array',
                description: '查询里被忽略的过滤条件（例如日期写错），需要转告用户',
                items: { type: 'string' }
              },
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    kind: { type: 'string' },
                    size: { type: 'number' },
                    textChars: { type: 'number' },
                    score: { type: 'number' },
                    snippet: { type: 'string' },
                    matchedBy: { type: 'string' },
                    path: { type: 'string' }
                  }
                }
              }
            }
          },
          render: (_args, value) => {
            const warn = (value.warnings || []).length > 0 ? `⚠ ${value.warnings.join('；')}\n` : ''
            const body =
              value.hits === 0
                ? `本地资料库里没有命中「${value.query}」的资料（库里共 ${value.total} 个文件）。可以换关键词，或用 library_list 看全貌。`
                : `命中 ${value.hits} 条（库内共 ${value.total} 个文件）：\n${value.results
                    .map(
                      (hit) =>
                        `· ${hit.id}  ${hit.name}  [${hit.kind}]  ${hit.size}B${hit.textChars ? `  正文${hit.textChars}字` : ''}\n  路径：${hit.path}${
                          hit.snippet
                            ? `\n  片段：${hit.snippet}`
                            : hit.matchedBy === 'name'
                              ? '\n  命中：按文件名/标签（正文里没有这个词）'
                              : ''
                        }`
                    )
                    .join('\n')}`
            return [{ type: 'text', text: warn + body }]
          }
        },
        async execute(args) {
          await initPromise
          const query = String(args?.query || '').trim()
          const kind = String(args?.kind || '').trim()
          const tag = String(args?.tag || '').trim()
          const composed = [query, kind ? `kind:${kind.replace(/^\./, '')}` : '', tag ? `tag:${tag}` : '']
            .filter(Boolean)
            .join(' ')
          const strict = typeof args?.strict === 'boolean' ? args.strict : undefined
          const hits = await store.search(composed, Number(args?.limit) || 8, strict === undefined ? {} : { strict })
          return {
            query: composed,
            hits: hits.length,
            total: store.items().length,
            warnings: queryWarnings(composed),
            results: hits.map((hit) => ({
              id: hit.item.id,
              name: hit.item.name,
              kind: hit.item.kind,
              size: Number(hit.item.size) || 0,
              textChars: Number(hit.item.textChars) || 0,
              score: hit.score,
              snippet: hit.snippet,
              matchedBy: hit.matchedBy || '',
              path: store.filePath(hit.item)
            }))
          }
        }
      }),
    'dsh-local-library: library_search'
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'library_read',
        description:
          '读取「本地资料库」里某个文件的正文（PDF/Word/Excel/PPT 抽取后的纯文本）。用 library_search / library_list 拿到 id 后再调它。二进制文件（图片等）没有正文，会返回磁盘路径，可再用读图工具打开该路径。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '条目 id（ll-…）。也可以改用 name 精确匹配。' },
            name: { type: 'string', description: '文件名（精确匹配，二选一）' },
            maxChars: { type: 'number', description: '本次最多返回多少字符，默认 20000' },
            offset: { type: 'number', description: '从第几个字符开始读，默认 0。返回里会给 nextOffset，长文档可接着读下一段。' }
          },
          additionalProperties: false
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              found: { type: 'boolean' },
              id: { type: 'string' },
              name: { type: 'string' },
              kind: { type: 'string' },
              path: { type: 'string' },
              text: { type: 'string' },
              total: { type: 'number' },
              offset: { type: 'number' },
              nextOffset: { type: 'number' },
              remaining: { type: 'number' },
              truncated: { type: 'boolean' },
              note: { type: 'string' }
            }
          },
          render: (_args, value) => {
            if (!value.found) return [{ type: 'text', text: '本地资料库里没有这个文件；先用 library_list 或 library_search 确认 id。' }]
            if (!value.text) {
              // 有正文但这次一个字都没读到，说明 offset 已经越过末尾，别说成"没有可读正文"。
              if (value.total > 0) {
                return [
                  {
                    type: 'text',
                    text: `${value.name} 已经读到末尾了（全文 ${value.total} 字符）。要看开头请把 offset 设成 0，或换一个更小的 offset。`
                  }
                ]
              }
              return [
                {
                  type: 'text',
                  text: `${value.name}（${value.kind}，${value.path}）没有可读正文${value.note ? `：${value.note}` : ''}。图片等二进制文件可以直接打开上面的路径。`
                }
              ]
            }
            // 注意：readText 可能已经给正文尾巴拼了续读提示，value.text.length 会偏大，
            // 这里用 nextOffset 反推真正读到的位置。
            const endPos = value.nextOffset > 0 ? value.nextOffset : value.offset + value.text.length
            const range =
              value.offset > 0 || value.remaining > 0
                ? `\n\n（第 ${value.offset + 1}–${endPos} 字 / 全文 ${value.total} 字符${value.remaining > 0 ? `，还有 ${value.remaining} 字未读：再调一次 library_read 并设 offset=${value.nextOffset}` : '，已到末尾'}）`
                : ''
            return [{ type: 'text', text: `# ${value.name}（${value.kind}）\n路径：${value.path}${range}\n\n${value.text}` }]
          }
        },
        async execute(args) {
          await initPromise
          const id = String(args?.id || '').trim()
          const wantedName = String(args?.name || '').trim()
          const item = id ? store.get(id) : wantedName ? store.items().find((it) => it.name === wantedName) : undefined
          if (!item) {
            return {
              found: false,
              id,
              name: wantedName,
              kind: '',
              path: '',
              text: '',
              total: 0,
              offset: 0,
              nextOffset: 0,
              remaining: 0,
              truncated: false,
              note: 'not-found'
            }
          }
          const read = await store.readText(item.id, Number(args?.maxChars) || 20000, Number(args?.offset) || 0)
          return {
            found: true,
            id: item.id,
            name: item.name,
            kind: item.kind,
            path: store.filePath(item),
            text: read?.text || '',
            total: read?.total || 0,
            offset: read?.offset || 0,
            nextOffset: read?.nextOffset || 0,
            remaining: read?.remaining || 0,
            truncated: Boolean(read?.truncated),
            note: item.note || ''
          }
        }
      }),
    'dsh-local-library: library_read'
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'library_save',
        description:
          '把一段文本（整理好的结论、笔记、抓下来的网页正文、报告草稿）存进「本地资料库」，之后任何会话都能检索到。文件名请带上扩展名，例如 2026-10-30-SDK调研.md。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '文件名（含扩展名，如 xxx.md）' },
            content: { type: 'string', description: '正文内容' },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: '可选标签，便于检索'
            }
          },
          required: ['name', 'content'],
          additionalProperties: false
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              saved: { type: 'boolean' },
              id: { type: 'string' },
              name: { type: 'string' },
              path: { type: 'string' },
              textChars: { type: 'number' }
            }
          },
          render: (_args, value) => [
            {
              type: 'text',
              text: value.saved
                ? `已存入本地资料库：${value.name}（${value.textChars} 字）\n路径：${value.path}`
                : '没有存成功：文件名或正文为空。'
            }
          ]
        },
        async execute(args) {
          await initPromise
          // 注意：sanitizeName('') 会返回「未命名」，所以必须先判原始文件名，
          // 否则传一个空名字会静默存成「未命名」而不是返回 saved:false。
          const rawName = String(args?.name ?? '').trim()
          const fileName = rawName ? sanitizeName(rawName) : ''
          const content = String(args?.content ?? '')
          if (!rawName || content.trim() === '') {
            return { saved: false, id: '', name: fileName, path: '', textChars: 0 }
          }
          const { item } = await store.addFile({
            name: fileName,
            buffer: Buffer.from(content, 'utf8'),
            kind: guessKind(fileName, 'text/plain'),
            addedBy: 'agent',
            tags: Array.isArray(args?.tags) ? args.tags : []
          })
          if (!item) return { saved: false, id: '', name: fileName, path: '', textChars: 0 }
          await store.applyExtraction(item.id, { text: content, kind: 'text', note: '' })
          return { saved: true, id: item.id, name: item.name, path: store.filePath(item), textChars: content.length }
        }
      }),
    'dsh-local-library: library_save'
  )

  // ── 系统提示词：让每个新会话都知道资料库的存在 ────────────────────────
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'tool:local-library',
        order: 950,
        text: [
          '## 本地资料库',
          '',
          '本机有一份由用户维护的「本地资料库」，跨会话共享，磁盘目录会随工具结果给出。当任务可能涉及用户已有的材料——论文、公司文档、报表、笔记、截图、聊天导出——先用 library_search（关键词）或 library_list（全貌）查一遍，不要一上来就要求用户重新上传文件。',
          '',
          '- library_list：列出库里有什么（id / 名称 / 类型 / 大小 / 上传时间 / 磁盘路径）。',
          '- library_search：按关键词检索文件名与正文（PDF、Word、Excel、PPT 已抽取为纯文本；图片在配了视觉模型时按其内容描述检索）。中文按两字组合匹配，长句也能命中。可用 kind= / tag= 过滤。',
          '- library_read：读某条目的正文，支持 offset 分段读长文档；图片等二进制文件会返回磁盘路径，可直接用读图工具打开那个路径。',
          '- library_save：把这次整理的结论或抓下来的长文存回库里，供以后的会话复用。',
          '',
          '检索结果太杂（擦边命中多）时，给 library_search 加 strict: true 走严格匹配；用户也可以在 设置 → 本地资料库 里把「严格匹配」默认打开。',
          '',
          '用户说"我之前给你的那份资料""看下我的文档""根据我的笔记"时，指的就是这里。反过来，当用户的请求会用到他们自己的材料（写周报、做方案、引用数据、沿用上次的结论），而你还不确定库里有没有相关文件时，先 library_list 看一眼——一次调用成本很低，比让用户重新上传、或者凭猜测作答要好。'
        ].join('\n'),
        interpolate: false
      }),
    'dsh-local-library: prompt section'
  )
}
