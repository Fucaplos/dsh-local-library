/**
 * 本地资料库的存储层。
 *
 * 目录布局（root = $DSH_HOME/local-library）：
 *   index.json          条目元数据（原子写入：tmp + rename）
 *   files/<id><ext>     原始文件
 *   text/<id>.txt       抽取出来的可检索文本
 *
 * 所有写操作走同一条串行队列，避免并发 upload / 删除把 index.json 写乱。
 */
import { mkdir, readFile, writeFile, rename, stat, unlink, open } from 'node:fs/promises'
import { createWriteStream, createReadStream } from 'node:fs'
import { join, extname } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const INDEX_VERSION = 1

/** 正文缓存的字节上限：检索时不再每条都读盘，但也不能把整库塞进内存。 */
const TEXT_CACHE_MAX_BYTES = 48 * 1024 * 1024

/** CJK 之外的"词"：拉丁字母、数字连写算一个词。 */
const CJK_CLASS = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\uac00-\\ud7af'
const CJK_OR_OTHER = new RegExp(`[${CJK_CLASS}]+|[^${CJK_CLASS}]+`, 'g')
const STARTS_WITH_CJK = new RegExp(`^[${CJK_CLASS}]`)

/** 单文件上传上限（512MB）：再大就不是"资料"而是数据集了，先挡住避免把盘写满。 */
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024

/** 常见类型的 Content-Type，用于下载响应。 */
const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
}

export function mimeOfExt(ext) {
  return MIME_BY_EXT[String(ext || '').toLowerCase()] || 'application/octet-stream'
}

/** 文件名消毒：去掉路径与不可打印字符，长度截断。只影响元数据，不参与路径拼接。 */
export function sanitizeName(raw) {
  const base = String(raw ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  if (!base) return '未命名'
  if (base.length <= 180) return base
  // 不要把一个 emoji 的代理对切成半个字符。
  let cut = 180
  const code = base.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1
  return base.slice(0, cut)
}

/** 只保留安全的扩展名（点 + 字母数字，最多 12 个字符），否则返回空串。 */
export function safeExt(name) {
  const ext = extname(String(name || '')).toLowerCase()
  return /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : ''
}

export function formatBytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = v / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`
}

function nowIso() {
  return new Date().toISOString()
}

function newId() {
  return `ll-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

/**
 * 把查询切成可检索的词。
 *
 * 中文没有空格，按空白切会把整句当成一个词（"预算表里的差旅费" 永远匹配不到 "差旅费"），
 * 所以 CJK 连续段一律切成 bigram（差旅/旅费/差费），拉丁词保持整词。
 * 切分只发生在查询侧：正文用 includes 判断，不需要预先建 bigram。
 *
 * @returns {{terms: {text: string, weight: number}[], filters: object, phrase: string}}
 */
function parseQuery(query) {
  const raw = String(query || '').toLowerCase().trim()
  const filters = { kind: '', tag: '', after: 0, before: 0 }
  const terms = []
  const seen = new Set()
  const phraseParts = []

  const pushTerm = (text, weight) => {
    const value = text.trim()
    if (value.length === 0 || seen.has(value)) return
    seen.add(value)
    terms.push({ text: value, weight })
  }

  for (const chunk of raw.split(/[\s,，、;；/|+]+/)) {
    if (!chunk) continue
    // 过滤语法：kind:pdf tag:合同 after:2026-10-01（日期按字符串比较 ISO 前缀）
    const m = /^(kind|tag|after|before):(.+)$/.exec(chunk)
    if (m) {
      const [, key, value] = m
      if (key === 'kind') filters.kind = value.replace(/^\./, '')
      else if (key === 'tag') filters.tag = value
      else if (key === 'after') filters.after = Date.parse(value) || 0
      else filters.before = Date.parse(value) || 0
      continue
    }
    phraseParts.push(chunk)
    const runs = chunk.match(CJK_OR_OTHER) || []
    for (const run of runs) {
      if (STARTS_WITH_CJK.test(run)) {
        if (run.length === 1) pushTerm(run, 1)
        else for (let i = 0; i < run.length - 1; i += 1) pushTerm(run.slice(i, i + 2), 1)
      } else {
        const word = run.replace(/^[^0-9a-z]+|[^0-9a-z]+$/g, '')
        if (word.length >= 2) pushTerm(word, 1.5)
        else if (word.length === 1) pushTerm(word, 1)
      }
    }
  }

  return { terms, filters, phrase: phraseParts.join(' ') }
}

function tokenize(query) {
  return parseQuery(query).terms.map((t) => t.text)
}

function itemMatchesFilters(item, filters) {
  if (filters.kind) {
    const kind = String(item.kind || '').toLowerCase()
    const ext = String(item.ext || '').toLowerCase()
    if (kind !== filters.kind && ext !== `.${filters.kind}`) return false
  }
  if (filters.tag) {
    const tags = (item.tags || []).map((t) => String(t).toLowerCase())
    if (!tags.some((t) => t.includes(filters.tag))) return false
  }
  if (filters.after || filters.before) {
    const at = Date.parse(item.createdAt) || 0
    if (filters.after && at < filters.after) return false
    if (filters.before && at > filters.before) return false
  }
  return true
}

function emptyIndex() {
  return { version: INDEX_VERSION, seq: 0, items: [] }
}

export class LibraryStore {
  /** @param {string} root */
  constructor(root) {
    this.root = root
    this.filesDir = join(root, 'files')
    this.textDir = join(root, 'text')
    this.indexPath = join(root, 'index.json')
    this.index = emptyIndex()
    this.chain = Promise.resolve()
    this.ready = null
    /** id -> { raw, lower, size }；插入顺序即最近使用顺序（Map 保序）。 */
    this.textCache = new Map()
    this.textCacheBytes = 0
  }

  /** 串行化所有写操作。 */
  serial(fn) {
    const run = this.chain.then(fn, fn)
    this.chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  async init() {
    if (this.ready) return this.ready
    this.ready = (async () => {
      await mkdir(this.filesDir, { recursive: true })
      await mkdir(this.textDir, { recursive: true })
      try {
        const raw = await readFile(this.indexPath, 'utf8')
        const parsed = JSON.parse(raw)
        if (parsed && Array.isArray(parsed.items)) {
          this.index = {
            version: INDEX_VERSION,
            seq: Number(parsed.seq) || parsed.items.length,
            items: parsed.items.filter((it) => it && typeof it.id === 'string')
          }
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          // 索引坏了不能让资料库整个不可用：改名保留现场，从空索引继续。
          try {
            await rename(this.indexPath, `${this.indexPath}.broken-${Date.now()}`)
          } catch {
            /* ignore */
          }
        }
        this.index = emptyIndex()
      }
      return this
    })()
    return this.ready
  }

  async persist() {
    const tmp = `${this.indexPath}.tmp`
    await writeFile(tmp, JSON.stringify(this.index, null, 2), 'utf8')
    await rename(tmp, this.indexPath)
  }

  items() {
    return this.index.items
  }

  get(id) {
    return this.index.items.find((it) => it.id === id)
  }

  filePath(item) {
    return join(this.filesDir, `${item.id}${item.ext || ''}`)
  }

  textPath(item) {
    return join(this.textDir, `${item.id}.txt`)
  }

  /** 下载用的绝对路径（走 stat 确认还在）。 */
  async resolveFile(id) {
    const item = this.get(id)
    if (!item) return null
    const path = this.filePath(item)
    try {
      const info = await stat(path)
      if (!info.isFile()) return null
      return { item, path, size: info.size }
    } catch {
      return null
    }
  }

  /**
   * 落盘一个新文件。body 可以是 Buffer、可读流（上传）或字符串。
   * 只写文件 + 建索引，不抽文本（抽文本由调用方在后台做）。
   *
   * 同时算 sha256：同样的内容再传一次能被识别出来（duplicatePolicy 决定怎么办）。
   * 返回 { item, duplicate }；duplicate 为命中的旧条目（None 表示没有重复）。
   * policy=reject 时 item 为 null；policy=replace 会先删掉旧条目再落新条目。
   */
  async addFile({ name, buffer, stream, kind, addedBy = 'upload', mime, tags = [], duplicatePolicy = 'keep' }) {
    await this.init()
    const staging = join(this.root, `.incoming-${newId()}`)
    let size = 0
    let digest = ''

    // 先落到暂存文件：只有算完哈希、确认不是重复之后才进 files/ 建条目。
    if (stream) {
      const hash = createHash('sha256')
      const tap = new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length
          if (size > MAX_UPLOAD_BYTES) {
            callback(new Error('payload too large'))
            return
          }
          hash.update(chunk)
          callback(null, chunk)
        }
      })
      try {
        await pipeline(stream, tap, createWriteStream(staging))
      } catch (error) {
        await unlink(staging).catch(() => {})
        throw error
      }
      digest = hash.digest('hex')
    } else {
      const data = typeof buffer === 'string' ? Buffer.from(buffer, 'utf8') : buffer
      // 缓冲区分支同样要守上限，否则 library_save 传一段超大文本就能绕过 stream 分支的检查。
      if (data.length > MAX_UPLOAD_BYTES) throw new Error('payload too large')
      await writeFile(staging, data)
      size = data.length
      digest = createHash('sha256').update(data).digest('hex')
    }

    return this.serial(async () => {
      const existing = this.index.items.find((it) => it.sha256 && it.sha256 === digest)
      if (existing && duplicatePolicy === 'reject') {
        await unlink(staging).catch(() => {})
        return { item: null, duplicate: existing }
      }
      if (existing && duplicatePolicy === 'replace') {
        const idx = this.index.items.findIndex((it) => it.id === existing.id)
        if (idx >= 0) this.index.items.splice(idx, 1)
        await unlink(this.filePath(existing)).catch(() => {})
        await unlink(this.textPath(existing)).catch(() => {})
        this.forgetText(existing.id)
      }

      const safeName = sanitizeName(name)
      const ext = safeExt(safeName)
      const id = newId()
      const item = {
        id,
        name: safeName,
        ext,
        mime: mime || mimeOfExt(ext),
        size,
        sha256: digest,
        kind: kind || 'other',
        createdAt: nowIso(),
        addedBy,
        tags: Array.isArray(tags) ? tags.map(String).slice(0, 20) : [],
        textChars: 0,
        indexed: false,
        note: ''
      }
      await rename(staging, this.filePath(item))
      this.index.items.unshift(item)
      this.index.seq += 1
      await this.persist()
      return { item, duplicate: existing || null }
    })
  }

  /** 建索引后回写条目（文本长度 / kind / note）。 */
  async applyExtraction(id, { text, kind, note }) {
    await this.init()
    return this.serial(async () => {
      const item = this.get(id)
      if (!item) return null
      const body = typeof text === 'string' ? text : ''
      if (body.trim().length > 0) {
        await writeFile(this.textPath(item), body, 'utf8')
      } else {
        await unlink(this.textPath(item)).catch(() => {})
      }
      this.forgetText(id)
      item.textChars = body.length
      item.indexed = true
      if (kind) item.kind = kind
      item.note = note || (body.length === 0 ? '无可抽取文本' : '')
      await this.persist()
      return item
    })
  }

  /** 改文件名 / 标签（不动文件本身）。 */
  async updateMeta(id, patch = {}) {
    await this.init()
    return this.serial(async () => {
      const item = this.get(id)
      if (!item) return null
      if (typeof patch.name === 'string' && patch.name.trim().length > 0) {
        item.name = sanitizeName(patch.name)
        // 扩展名跟着名字走，否则下载时 Content-Type 还是老类型的。
        item.ext = safeExt(item.name)
        item.mime = mimeOfExt(item.ext)
      }
      if (Array.isArray(patch.tags)) {
        item.tags = patch.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20)
      }
      await this.persist()
      return item
    })
  }

  forgetText(id) {
    const cached = this.textCache.get(id)
    if (!cached) return
    this.textCacheBytes -= cached.size
    this.textCache.delete(id)
  }

  /**
   * 取正文（小写，供检索）。命中缓存直接返回，未命中读盘并放进 LRU。
   * 缓存按字节封顶，超过就淘汰最久未用的条目。
   */
  async bodyOf(item) {
    const cached = this.textCache.get(item.id)
    if (cached !== undefined) {
      this.textCache.delete(item.id)
      this.textCache.set(item.id, cached)
      return cached
    }
    let raw = ''
    try {
      raw = await readFile(this.textPath(item), 'utf8')
    } catch {
      raw = ''
    }
    const entry = { raw, lower: raw.toLowerCase(), size: raw.length * 2 }
    this.textCache.set(item.id, entry)
    this.textCacheBytes += entry.size
    while (this.textCacheBytes > TEXT_CACHE_MAX_BYTES && this.textCache.size > 1) {
      const oldest = this.textCache.keys().next().value
      const victim = this.textCache.get(oldest)
      this.textCacheBytes -= victim.size
      this.textCache.delete(oldest)
    }
    return entry
  }

  /**
   * 读正文片段。
   * @param {string} id 条目 id
   * @param {number} maxChars 本次最多返回多少字符
   * @param {number} offset 从第几个字符开始（长文档要能分次读完）
   */
  async readText(id, maxChars = 20000, offset = 0) {
    await this.init()
    const item = this.get(id)
    if (!item) return null
    let raw = ''
    try {
      raw = await readFile(this.textPath(item), 'utf8')
    } catch {
      raw = ''
    }
    const total = raw.length
    const limit = Math.max(1, Math.min(Number(maxChars) || 20000, 400000))
    const start = Math.max(0, Math.min(Number(offset) || 0, total))
    let end = Math.min(total, start + limit)
    // 按 UTF-16 切会切在代理对中间（emoji 变成半个字符），退一个 code unit。
    if (end > start && end < total) {
      const code = raw.charCodeAt(end - 1)
      if (code >= 0xd800 && code <= 0xdbff) end -= 1
    }
    const body = raw.slice(start, end)
    const remaining = total - end
    // 一个字都没取到（offset 已经越过末尾，或本来就没有正文）：
    // 不要返回"…第 12–11 字…"这种越界提示，那会被当成正文显示出来。
    if (body.length === 0) {
      return { item, text: '', total, start, end, remaining, offset: start, nextOffset: end, truncated: false }
    }
    let text = body
    if (remaining > 0) {
      text += `\n…（第 ${start + 1}–${end} 字，全文 ${total} 字符；还有 ${remaining} 字未读，把 offset 设成 ${end} 继续）`
    } else if (start > 0) {
      text += `\n…（第 ${start + 1}–${end} 字，已到全文末尾，共 ${total} 字符）`
    }
    return { item, text, total, start, end, remaining, offset: start, nextOffset: end, truncated: remaining > 0 }
  }

  /**
   * 检索：文件名命中权重高于正文；中文按 bigram 命中，另给整句短语加分。
   * 支持 kind:/tag:/after:/before: 过滤。
   */
  async search(query, limit = 8) {
    await this.init()
    const { terms, filters, phrase } = parseQuery(query)
    const max = Math.max(1, Math.min(Number(limit) || 8, 50))
    const pool = this.index.items.filter((it) => itemMatchesFilters(it, filters))

    if (terms.length === 0) {
      return pool
        .slice()
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, max)
        .map((item) => ({ item, score: 0, snippet: '' }))
    }

    const scored = []
    for (const item of pool) {
      const haystackName = `${item.name} ${(item.tags || []).join(' ')}`.toLowerCase()
      let nameWeight = 0
      for (const term of terms) {
        if (haystackName.includes(term.text)) nameWeight += term.weight
      }
      let score = nameWeight > 0 ? 40 + nameWeight * 12 : 0

      const body = await this.bodyOf(item)
      let snippet = ''
      let bodyHits = 0
      if (body.lower.length > 0) {
        for (const term of terms) {
          let from = 0
          let hits = 0
          while (hits < 3) {
            const at = body.lower.indexOf(term.text, from)
            if (at < 0) break
            hits += 1
            bodyHits += 1
            if (snippet === '') snippet = this.snippetAt(body.raw, at, term.text.length)
            from = at + term.text.length
          }
        }
      }
      score += bodyHits * 6

      // 整句（"年度预算表"）原样出现时额外加分，避免 bigram 把长词打散后就排到后面。
      if (phrase.length >= 2) {
        if (body.lower.includes(phrase)) {
          score += 25
          if (snippet === '') {
            const at = body.lower.indexOf(phrase)
            snippet = this.snippetAt(body.raw, at, phrase.length)
          }
        }
        if (haystackName.includes(phrase)) score += 15
      }

      if (score > 0) scored.push({ item, score, snippet })
    }
    scored.sort((a, b) => b.score - a.score || String(b.item.createdAt).localeCompare(String(a.item.createdAt)))
    return scored.slice(0, max)
  }

  snippetAt(text, at, len) {
    const start = Math.max(0, at - 60)
    const end = Math.min(text.length, at + len + 90)
    const head = start > 0 ? '…' : ''
    const tail = end < text.length ? '…' : ''
    return `${head}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${tail}`
  }

  async remove(id) {
    await this.init()
    return this.serial(async () => {
      const idx = this.index.items.findIndex((it) => it.id === id)
      if (idx < 0) return null
      const [item] = this.index.items.splice(idx, 1)
      await unlink(this.filePath(item)).catch(() => {})
      await unlink(this.textPath(item)).catch(() => {})
      this.forgetText(item.id)
      await this.persist()
      return item
    })
  }

  /** 把若干条目打成 zip（stored，不压缩：资料多是已压缩格式，省 CPU 更快）。 */
  async listForBundle(ids) {
    await this.init()
    const wanted = new Set(Array.isArray(ids) ? ids : [])
    const files = []
    for (const item of this.index.items) {
      if (!wanted.has(item.id)) continue
      const resolved = await this.resolveFile(item.id)
      if (resolved) files.push({ name: item.name, path: resolved.path, size: resolved.size })
    }
    return files
  }

  async stats() {
    await this.init()
    const totalBytes = this.index.items.reduce((sum, it) => sum + (Number(it.size) || 0), 0)
    return {
      root: this.root,
      count: this.index.items.length,
      bytes: totalBytes,
      bytesText: formatBytes(totalBytes),
      indexed: this.index.items.filter((it) => it.indexed && it.textChars > 0).length
    }
  }

  /** 是否存在可读文件但尚未建索引的条目（用于提示"正在索引"）。 */
  pending() {
    return this.index.items.filter((it) => !it.indexed).length
  }
}

/** 供宿主侧做"文件真的很长"判断时用：读前 N 字节。 */
export async function peekHead(path, bytes = 4096) {
  const handle = await open(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}
