/**
 * Zero-dependency text extraction for the local library.
 *
 * Everything here uses Node.js built-ins only (fs/promises, path, zlib).
 * The goal is "good enough to search", not perfect format restoration:
 *
 *   text  – UTF-8 (UTF-16 BOM aware), bounded to 4 MiB
 *   docx  – read word/document.xml (+ headers/footers) from the ZIP container
 *   xlsx  – sharedStrings + sheet XML, rendered as approximate TSV
 *   pptx  – ppt/slides/slideN.xml in numeric slide order
 *   pdf   – scan stream objects, inflate FlateDecode, tokenise text operators
 *
 * extractText() never throws: on any failure it resolves to
 * `{ text: '', kind, note: '<short-english-reason>' }`.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'

const DEFAULT_MAX_CHARS = 2_000_000
const MAX_TEXT_BYTES = 4 * 1024 * 1024
const MAX_BINARY_BYTES = 128 * 1024 * 1024
const MAX_PDF_BYTES = 64 * 1024 * 1024
const MAX_INFLATE_BYTES = 128 * 1024 * 1024

/** Text-like extensions (lower case, leading dot). Public whitelist. */
export const TEXT_LIKE_EXT = new Set([
  '.txt', '.text', '.md', '.markdown', '.mdx',
  '.json', '.jsonl', '.ndjson', '.csv', '.tsv',
  '.log', '.yaml', '.yml', '.xml', '.html', '.htm', '.xhtml',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.py', '.ps1', '.psm1', '.sh', '.bash', '.zsh', '.bat', '.cmd',
  '.css', '.scss', '.less', '.ini', '.cfg', '.conf', '.toml',
  '.sql', '.srt', '.vtt', '.tex', '.env', '.properties', '.reg',
  '.gitignore', '.gitattributes', '.editorconfig',
  '.r', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp',
  '.cs', '.php', '.lua', '.pl', '.swift', '.kt', '.gradle', '.svg',
])

const BINARY_KIND_EXT = new Map([
  ['.docx', 'docx'],
  ['.xlsx', 'xlsx'],
  ['.pptx', 'pptx'],
  ['.pdf', 'pdf'],
])

/** Return 'text' | 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'other'. */
export function guessKind(name, mime) {
  const base = typeof name === 'string' ? name.trim().toLowerCase() : ''
  const mimeText = mimeLooksLikeText(mime)

  if (!base) return mimeText ? 'text' : 'other'

  // Dotfiles such as ".env", ".env.local" and ".gitignore".
  if (base === '.env' || base.startsWith('.env.')) return 'text'

  const ext = path.extname(base)
  const binary = BINARY_KIND_EXT.get(ext)
  if (binary) return binary
  if (TEXT_LIKE_EXT.has(ext) || TEXT_LIKE_EXT.has(base)) return 'text'
  if (mimeText) return 'text'
  return 'other'
}

function mimeLooksLikeText(mime) {
  if (typeof mime !== 'string') return false
  const normalized = mime.split(';')[0].trim().toLowerCase()
  if (!normalized) return false
  if (normalized.startsWith('text/')) return true
  if (normalized === 'application/json' || normalized.endsWith('+json')) return true
  if (normalized === 'application/xml' || normalized.endsWith('+xml')) return true
  if (normalized === 'application/javascript' || normalized === 'application/x-javascript') return true
  if (normalized === 'application/x-sh' || normalized === 'application/sql') return true
  return false
}

/**
 * Extract searchable plain text from a file.
 *
 * @param {{ path: string, name: string, mime?: string }} input
 * @param {{ maxChars?: number }} [opts] default maxChars = 2_000_000
 * @returns {Promise<{ text: string, kind: string, note?: string }>}
 */
export async function extractText(input, opts) {
  const name = input && typeof input.name === 'string' ? input.name : ''
  const mime = input && typeof input.mime === 'string' ? input.mime : ''
  const kind = guessKind(name, mime)
  const maxChars = normalizeMaxChars(opts)

  if (!input || typeof input.path !== 'string' || input.path.length === 0) {
    return { text: '', kind, note: 'invalid-input' }
  }
  if (kind === 'other') {
    return { text: '', kind, note: 'unsupported-type' }
  }

  try {
    const stat = await fsp.stat(input.path)
    if (!stat.isFile()) return { text: '', kind, note: 'not-a-file' }

    let result
    switch (kind) {
      case 'text':
        result = await extractPlainText(input.path, stat.size, maxChars)
        break
      case 'docx':
        result = await extractDocx(input.path, stat.size, maxChars)
        break
      case 'xlsx':
        result = await extractXlsx(input.path, stat.size, maxChars)
        break
      case 'pptx':
        result = await extractPptx(input.path, stat.size, maxChars)
        break
      case 'pdf':
        result = await extractPdf(input.path, stat.size, maxChars)
        break
      default:
        result = { text: '', note: 'unsupported-type' }
    }

    const text = result && typeof result.text === 'string' ? result.text : ''
    const note = result && typeof result.note === 'string' && result.note ? result.note : undefined
    return note ? { text, kind, note } : { text, kind }
  } catch (error) {
    return { text: '', kind, note: noteForError(error) }
  }
}

function normalizeMaxChars(opts) {
  const value = opts && typeof opts.maxChars === 'number' ? opts.maxChars : NaN
  if (!Number.isFinite(value) || value < 0) return DEFAULT_MAX_CHARS
  return Math.floor(value)
}

function noteForError(error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  if (code && /^[a-z][a-z0-9-]{2,39}$/.test(code)) return code
  switch (code) {
    case 'ENOENT':
      return 'not-found'
    case 'EACCES':
    case 'EPERM':
      return 'permission-denied'
    case 'EISDIR':
      return 'not-a-file'
    case 'ENOTDIR':
      return 'not-found'
    case 'EMFILE':
    case 'ENFILE':
      return 'too-many-open-files'
    case 'ERR_FS_FILE_TOO_LARGE':
      return 'file-too-large'
    default:
      return 'read-error'
  }
}

// ── bounded file reads ───────────────────────────────────────────────────────

async function readFilePrefix(filePath, limit) {
  if (limit <= 0) return Buffer.alloc(0)
  const handle = await fsp.open(filePath, 'r')
  try {
    const chunks = []
    let total = 0
    const chunkSize = Math.min(64 * 1024, limit)
    while (total < limit) {
      const toRead = Math.min(chunkSize, limit - total)
      const buffer = Buffer.allocUnsafe(toRead)
      const { bytesRead } = await handle.read(buffer, 0, toRead, total)
      if (bytesRead === 0) break
      chunks.push(bytesRead === toRead ? buffer : buffer.subarray(0, bytesRead))
      total += bytesRead
    }
    return Buffer.concat(chunks, total)
  } finally {
    await handle.close()
  }
}

async function readWholeBounded(filePath, size, cap) {
  if (size > cap) throw new ZipError('file-too-large')
  if (size <= 0) return Buffer.alloc(0)
  const handle = await fsp.open(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, offset, size - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return offset === size ? buffer : buffer.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

// ── plain text ───────────────────────────────────────────────────────────────

async function extractPlainText(filePath, size, maxChars) {
  const limit = Math.min(size, MAX_TEXT_BYTES)
  const buffer = await readFilePrefix(filePath, limit)
  const decoded = decodeText(buffer)
  const byteTruncated = size > limit
  let text = decoded
  let truncated = byteTruncated

  if (text.length > maxChars) {
    text = text.slice(0, maxChars)
    truncated = true
  }
  if (truncated) {
    text += '\n...[truncated]'
  }
  return truncated ? { text, note: 'truncated' } : { text }
}

function decodeText(buffer) {
  if (!buffer || buffer.length === 0) return ''

  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      return buffer.subarray(2).toString('utf16le')
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      const body = buffer.subarray(2)
      const length = body.length & ~1
      const swapped = Buffer.allocUnsafe(length)
      for (let i = 0; i < length; i += 2) {
        swapped[i] = body[i + 1]
        swapped[i + 1] = body[i]
      }
      return swapped.toString('utf16le')
    }
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8')
  }
  return buffer.toString('utf8')
}

// ── shared text helpers ──────────────────────────────────────────────────────

function clampText(raw, maxChars) {
  let text = raw == null ? '' : String(raw)
  let truncated = false
  if (text.length > maxChars) {
    text = text.slice(0, maxChars)
    truncated = true
  }
  if (truncated) {
    text += '\n...[truncated]'
  }
  return truncated ? { text, note: 'truncated' } : { text }
}

function decodeXmlEntities(value) {
  if (!value || value.indexOf('&') === -1) return value || ''
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0',
  }
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const code = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10)
      if (!Number.isFinite(code) || code < 0) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    const lowered = body.toLowerCase()
    return Object.prototype.hasOwnProperty.call(named, lowered) ? named[lowered] : match
  })
}

function normalizeExtractedText(value) {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── ZIP (store + deflate) ────────────────────────────────────────────────────

class ZipError extends Error {
  constructor(code) {
    super(code)
    this.name = 'ZipError'
    this.code = code
  }
}

function openZip(buffer) {
  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd < 0) throw new ZipError('zip-eocd-not-found')

  const entryCount = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ZipError('zip64-unsupported')
  }
  if (centralOffset + centralSize > buffer.length) {
    throw new ZipError('zip-central-dir-invalid')
  }

  const entries = new Map()
  let pointer = centralOffset
  for (let i = 0; i < entryCount; i += 1) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== 0x02014b50) {
      throw new ZipError('zip-central-dir-invalid')
    }
    const flags = buffer.readUInt16LE(pointer + 8)
    const method = buffer.readUInt16LE(pointer + 10)
    const compressedSize = buffer.readUInt32LE(pointer + 20)
    const uncompressedSize = buffer.readUInt32LE(pointer + 24)
    const nameLength = buffer.readUInt16LE(pointer + 28)
    const extraLength = buffer.readUInt16LE(pointer + 30)
    const commentLength = buffer.readUInt16LE(pointer + 32)
    const localOffset = buffer.readUInt32LE(pointer + 42)

    if (pointer + 46 + nameLength > buffer.length) {
      throw new ZipError('zip-central-dir-invalid')
    }
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength)

    entries.set(name.toLowerCase(), {
      name,
      flags,
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
    })
    pointer += 46 + nameLength + extraLength + commentLength
  }

  const cache = new Map()
  return {
    list() {
      return Array.from(entries.values(), (entry) => entry.name)
    },
    get(name) {
      return entries.get(String(name).toLowerCase()) || null
    },
    read(name) {
      const key = String(name).toLowerCase()
      const entry = entries.get(key)
      if (!entry) return null
      if (cache.has(key)) return cache.get(key)
      const data = inflateZipEntry(buffer, entry)
      cache.set(key, data)
      return data
    },
  }
}

function findEndOfCentralDirectory(buffer) {
  if (buffer.length < 22) return -1
  const minimum = Math.max(0, buffer.length - 22 - 0xffff)
  for (let i = buffer.length - 22; i >= minimum; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

function inflateZipEntry(buffer, entry) {
  const localOffset = entry.localOffset
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new ZipError('zip-entry-invalid')
  }
  // Sizes come from the central directory: streamed writers may leave the
  // local header sizes at zero.
  const nameLength = buffer.readUInt16LE(localOffset + 26)
  const extraLength = buffer.readUInt16LE(localOffset + 28)
  const start = localOffset + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (start > buffer.length || end > buffer.length) {
    throw new ZipError('zip-entry-invalid')
  }
  const compressed = buffer.subarray(start, end)

  if (entry.flags & 0x0001) throw new ZipError('zip-encrypted')
  if (entry.method === 0) return compressed
  if (entry.method === 8) {
    try {
      const inflated = zlib.inflateRawSync(compressed, { maxOutputLength: MAX_INFLATE_BYTES })
      if (entry.uncompressedSize > 0 && inflated.length > entry.uncompressedSize) {
        return inflated.subarray(0, entry.uncompressedSize)
      }
      return inflated
    } catch {
      throw new ZipError('zip-inflate-failed')
    }
  }
  throw new ZipError('unsupported-compression')
}

// ── DOCX ─────────────────────────────────────────────────────────────────────

async function extractDocx(filePath, size, maxChars) {
  const buffer = await readWholeBounded(filePath, size, MAX_BINARY_BYTES)
  const zip = openZip(buffer)

  if (!zip.get('word/document.xml')) throw new ZipError('docx-document-missing')

  const parts = []
  const body = docxXmlToText(zip.read('word/document.xml').toString('utf8'))
  if (body) parts.push(body)

  const extraNames = zip
    .list()
    .filter((name) => /^word\/(?:header|footer)\d*\.xml$/i.test(name))
    .sort()
  for (const name of extraNames) {
    try {
      const optional = docxXmlToText(zip.read(name).toString('utf8'))
      if (optional) parts.push(optional)
    } catch {
      // headers/footers are optional: ignore a broken one
    }
  }

  return clampText(parts.join('\n\n'), maxChars)
}

function docxXmlToText(xml) {
  if (!xml) return ''
  let text = String(xml)
  text = text.replace(/<w:tab\b[^>]*\/?>/gi, '\t')
  text = text.replace(/<w:(?:br|cr)\b[^>]*\/?>/gi, '\n')
  text = text.replace(/<w:noBreakHyphen\b[^>]*\/?>/gi, '-')
  text = text.replace(/<\/w:p\s*>/gi, '\n')
  text = text.replace(/<w:p\b[^>]*\/>/gi, '\n')
  text = text.replace(/<[^>]*>/g, '')
  text = decodeXmlEntities(text)
  return normalizeExtractedText(text)
}

// ── XLSX ─────────────────────────────────────────────────────────────────────

async function extractXlsx(filePath, size, maxChars) {
  const buffer = await readWholeBounded(filePath, size, MAX_BINARY_BYTES)
  const zip = openZip(buffer)

  const shared = []
  const sharedBuffer = zip.read('xl/sharedStrings.xml')
  if (sharedBuffer) {
    shared.push(...parseSharedStrings(sharedBuffer.toString('utf8')))
  }

  const sheetNames = readSheetNames(zip)
  const sheetEntries = zip
    .list()
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => sheetNumber(a) - sheetNumber(b))
  if (sheetEntries.length === 0) throw new ZipError('xlsx-no-sheets')

  const blocks = []
  for (let i = 0; i < sheetEntries.length; i += 1) {
    let rows
    try {
      rows = parseWorksheetXml(zip.read(sheetEntries[i]).toString('utf8'), shared)
    } catch {
      continue
    }
    const title = sheetNames[i] || `sheet${sheetNumber(sheetEntries[i]) || i + 1}`
    blocks.push(`--- sheet: ${title} ---\n${rows.join('\n')}`)
  }
  if (blocks.length === 0) throw new ZipError('xlsx-unreadable')

  return clampText(blocks.join('\n\n'), maxChars)
}

function sheetNumber(name) {
  const match = /sheet(\d+)\.xml$/i.exec(name)
  return match ? Number(match[1]) : 0
}

function readSheetNames(zip) {
  const buffer = zip.read('xl/workbook.xml')
  if (!buffer) return []
  const xml = buffer.toString('utf8')
  const names = []
  const re = /<sheet\b[^>]*?\bname="([^"]*)"/gi
  let match
  while ((match = re.exec(xml)) !== null) {
    names.push(decodeXmlEntities(match[1]))
  }
  return names
}

function parseSharedStrings(xml) {
  const values = []
  // The self-closing form <si/> is legal; keep it in the list so shared-string
  // indexes after it stay aligned with the sheet's <v> values.
  const re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/gi
  let match
  while ((match = re.exec(xml)) !== null) {
    values.push(match[1] ? collectTText(match[1]) : '')
  }
  return values
}

function collectTText(xml) {
  let out = ''
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>/gi
  let match
  while ((match = re.exec(xml)) !== null) {
    out += decodeXmlEntities(match[1])
  }
  return out
}

function parseWorksheetXml(xml, sharedStrings) {
  const lines = []
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/gi
  let rowMatch
  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const cells = []
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gi
    let cellMatch
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
      const attrs = cellMatch[1] || ''
      const inner = cellMatch[2] || ''
      const typeMatch = /\bt="([^"]*)"/i.exec(attrs)
      const type = typeMatch ? typeMatch[1] : 'n'
      let value = ''

      if (type === 'inlineStr') {
        value = collectTText(inner)
      } else {
        const valueMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(inner)
        const rawValue = valueMatch ? decodeXmlEntities(valueMatch[1]) : ''
        if (type === 's') {
          const index = parseInt(rawValue, 10)
          value = Number.isInteger(index) && index >= 0 && index < sharedStrings.length
            ? sharedStrings[index]
            : ''
        } else {
          value = rawValue
        }
      }
      cells.push(value)
    }
    if (cells.length > 0) lines.push(cells.join('\t'))
  }
  return lines
}

// ── PPTX ─────────────────────────────────────────────────────────────────────

async function extractPptx(filePath, size, maxChars) {
  const buffer = await readWholeBounded(filePath, size, MAX_BINARY_BYTES)
  const zip = openZip(buffer)

  const slides = zip
    .list()
    .map((name) => ({ name, number: slideNumber(name) }))
    .filter((slide) => slide.number > 0)
    .sort((a, b) => a.number - b.number)
  if (slides.length === 0) throw new ZipError('pptx-no-slides')

  const parts = []
  for (const slide of slides) {
    try {
      const text = pptxXmlToText(zip.read(slide.name).toString('utf8'))
      parts.push(`--- slide ${slide.number} ---${text ? `\n${text}` : ''}`)
    } catch {
      // one broken slide should not discard the rest of the deck
    }
  }
  if (parts.length === 0) throw new ZipError('pptx-unreadable')

  return clampText(parts.join('\n\n'), maxChars)
}

function slideNumber(name) {
  const match = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(name)
  return match ? Number(match[1]) : 0
}

function pptxXmlToText(xml) {
  if (!xml) return ''
  let text = String(xml)
  text = text.replace(/<\/a:p\s*>/gi, '\n')
  text = text.replace(/<a:br\b[^>]*\/?>/gi, '\n')
  text = text.replace(/<a:tab\b[^>]*\/?>/gi, '\t')
  text = text.replace(/<a:p\b[^>]*\/>/gi, '\n')
  text = text.replace(/<[^>]*>/g, '')
  text = decodeXmlEntities(text)
  return normalizeExtractedText(text)
}

// ── PDF (best effort, no font/CID mapping) ───────────────────────────────────

async function extractPdf(filePath, size, maxChars) {
  const limit = Math.min(size, MAX_PDF_BYTES)
  const buffer = await readFilePrefix(filePath, limit)
  let text = ''
  try {
    text = extractPdfText(buffer)
  } catch {
    text = ''
  }
  if (!text) return { text: '', note: 'no-extractable-text' }
  return clampText(text, maxChars)
}

function extractPdfText(buffer) {
  const pdf = buffer.toString('latin1')
  const pieces = []
  const streamRe = /\bstream(?:\r\n|\n|\r)/g
  let match
  while ((match = streamRe.exec(pdf)) !== null) {
    const dataStart = match.index + match[0].length
    const dictStart = pdf.lastIndexOf('<<', match.index)
    const dict = dictStart >= 0 ? pdf.slice(dictStart, match.index) : ''

    let end = -1
    let after = -1
    const lengthMatch = /\/Length\s+(\d+)\b/.exec(dict)
    if (lengthMatch) {
      const candidate = dataStart + Number(lengthMatch[1])
      if (candidate <= pdf.length) {
        let cursor = candidate
        while (cursor < pdf.length && (pdf[cursor] === '\r' || pdf[cursor] === '\n')) cursor += 1
        if (pdf.startsWith('endstream', cursor)) {
          end = candidate
          after = cursor
        }
      }
    }
    if (end < 0) {
      end = pdf.indexOf('endstream', dataStart)
      if (end < 0) break
      after = end
    }

    streamRe.lastIndex = Math.max(streamRe.lastIndex, after + 'endstream'.length)
    if (/\/Subtype\s*\/Image\b/.test(dict)) continue

    let data = pdf.slice(dataStart, end)
    if (data.endsWith('\r\n')) data = data.slice(0, -2)
    else if (data.endsWith('\n') || data.endsWith('\r')) data = data.slice(0, -1)

    const isFlate = /\/(?:FlateDecode|Fl)\b/.test(dict)
    let content
    if (isFlate) {
      const inflated = tryInflatePdf(Buffer.from(data, 'latin1'))
      if (!inflated) continue
      content = inflated.toString('latin1')
    } else {
      content = data
    }

    const extracted = extractPdfContentText(content)
    if (extracted) pieces.push(extracted)
  }
  return cleanupPdfText(pieces.join('\n'))
}

function tryInflatePdf(buffer) {
  try {
    return zlib.inflateSync(buffer, { maxOutputLength: 32 * 1024 * 1024 })
  } catch {
    // Some writers produce raw deflate data without a zlib wrapper.
  }
  try {
    return zlib.inflateRawSync(buffer, { maxOutputLength: 32 * 1024 * 1024 })
  } catch {
    return null
  }
}

function extractPdfContentText(content) {
  const blocks = []
  const btRe = /\bBT\b([\s\S]*?)\bET\b/g
  let match
  while ((match = btRe.exec(content)) !== null) {
    const text = parsePdfContentOps(match[1])
    if (text) blocks.push(text)
  }
  if (blocks.length === 0) {
    // Content without explicit BT/ET is unusual but cheap to try.
    const text = parsePdfContentOps(content)
    if (text) blocks.push(text)
  }
  return blocks.join('\n')
}

function parsePdfContentOps(source) {
  const stack = []
  const parts = []
  let i = 0
  const length = source.length

  while (i < length) {
    const char = source[i]

    if (isPdfWhitespace(char)) {
      i += 1
      continue
    }
    if (char === '%') {
      while (i < length && source[i] !== '\n' && source[i] !== '\r') i += 1
      continue
    }
    if (char === '(') {
      const [value, next] = readPdfLiteral(source, i)
      stack.push({ type: 'string', value: decodePdfString(value) })
      i = next
      continue
    }
    if (char === '<') {
      if (source[i + 1] === '<') {
        i = skipPdfDictionary(source, i)
        continue
      }
      const [value, next] = readPdfHexString(source, i)
      stack.push({ type: 'string', value: decodePdfString(value) })
      i = next
      continue
    }
    if (char === '[') {
      const [items, next] = readPdfArray(source, i)
      stack.push({ type: 'array', items })
      i = next
      continue
    }
    if (char === '/') {
      i = skipPdfName(source, i)
      continue
    }
    if (isPdfDelimiter(char)) {
      i += 1
      continue
    }

    let j = i
    while (j < length && !isPdfWhitespace(source[j]) && !isPdfDelimiter(source[j])) j += 1
    if (j === i) {
      i += 1
      continue
    }
    const token = source.slice(i, j)
    i = j

    if (isPdfNumber(token)) {
      if (stack.length < 64) stack.push({ type: 'number', value: Number(token) })
      continue
    }

    if (token === 'Tj' || token === "'" || token === '"') {
      const text = lastPdfString(stack)
      if (text !== null) {
        if (token !== 'Tj') parts.push('\n')
        parts.push(text)
      }
      stack.length = 0
    } else if (token === 'TJ') {
      const items = lastPdfArray(stack)
      if (items) {
        let line = ''
        for (const item of items) {
          if (item.type === 'string') line += item.value
          else if (item.type === 'number' && item.value <= -200) line += ' '
        }
        if (line) parts.push(line)
      }
      stack.length = 0
    } else if (token === 'Td' || token === 'TD' || token === 'T*' || token === 'Tm' || token === 'ET') {
      parts.push('\n')
      stack.length = 0
    } else {
      stack.length = 0
    }
  }

  return cleanupPdfText(parts.join(''))
}

function lastPdfString(stack) {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i].type === 'string') return stack[i].value
  }
  return null
}

function lastPdfArray(stack) {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i].type === 'array') return stack[i].items
  }
  return null
}

function readPdfLiteral(source, start) {
  let i = start + 1
  let depth = 1
  let out = ''
  const length = source.length

  while (i < length) {
    const char = source[i]

    if (char === '\\') {
      const next = source[i + 1]
      if (next === undefined) {
        i += 1
        break
      }
      if (next === 'n') {
        out += '\n'
        i += 2
      } else if (next === 'r') {
        out += '\r'
        i += 2
      } else if (next === 't') {
        out += '\t'
        i += 2
      } else if (next === 'b') {
        out += '\b'
        i += 2
      } else if (next === 'f') {
        out += '\f'
        i += 2
      } else if (next === '\n') {
        i += 2
      } else if (next === '\r') {
        i += 2
        if (source[i] === '\n') i += 1
      } else if (next >= '0' && next <= '7') {
        let octal = next
        let cursor = i + 2
        let digits = 1
        while (digits < 3 && cursor < length && source[cursor] >= '0' && source[cursor] <= '7') {
          octal += source[cursor]
          cursor += 1
          digits += 1
        }
        out += String.fromCharCode(parseInt(octal, 8) & 0xff)
        i = cursor
      } else {
        out += next
        i += 2
      }
      continue
    }

    if (char === '(') {
      depth += 1
      out += char
      i += 1
      continue
    }
    if (char === ')') {
      depth -= 1
      i += 1
      if (depth === 0) break
      out += char
      continue
    }
    out += char
    i += 1
  }

  return [out, i]
}

function readPdfHexString(source, start) {
  let i = start + 1
  let hex = ''
  const length = source.length
  while (i < length && source[i] !== '>') {
    const char = source[i]
    if ((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
      hex += char
    }
    i += 1
  }
  if (i < length) i += 1
  if (hex.length % 2 === 1) hex += '0'
  let out = ''
  for (let k = 0; k < hex.length; k += 2) {
    out += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16))
  }
  return [out, i]
}

function skipPdfDictionary(source, start) {
  let i = start
  let depth = 0
  const length = source.length
  while (i < length) {
    if (source[i] === '<' && source[i + 1] === '<') {
      depth += 1
      i += 2
    } else if (source[i] === '>' && source[i + 1] === '>') {
      depth -= 1
      i += 2
      if (depth <= 0) return i
    } else if (source[i] === '(') {
      const [, next] = readPdfLiteral(source, i)
      i = next
    } else {
      i += 1
    }
  }
  return i
}

function skipPdfName(source, start) {
  let i = start + 1
  const length = source.length
  while (i < length && !isPdfWhitespace(source[i]) && !isPdfDelimiter(source[i])) i += 1
  return i
}

function readPdfArray(source, start) {
  const items = []
  let i = start + 1
  const length = source.length
  while (i < length) {
    const char = source[i]
    if (isPdfWhitespace(char)) {
      i += 1
      continue
    }
    if (char === ']') {
      i += 1
      break
    }
    if (char === '(') {
      const [value, next] = readPdfLiteral(source, i)
      items.push({ type: 'string', value: decodePdfString(value) })
      i = next
      continue
    }
    if (char === '<') {
      if (source[i + 1] === '<') {
        i = skipPdfDictionary(source, i)
        continue
      }
      const [value, next] = readPdfHexString(source, i)
      items.push({ type: 'string', value: decodePdfString(value) })
      i = next
      continue
    }
    if (char === '[') {
      const [, next] = readPdfArray(source, i)
      i = next
      continue
    }
    if (char === '/') {
      i = skipPdfName(source, i)
      continue
    }
    if (isPdfDelimiter(char)) {
      i += 1
      continue
    }
    let j = i
    while (j < length && !isPdfWhitespace(source[j]) && !isPdfDelimiter(source[j])) j += 1
    if (j === i) {
      i += 1
      continue
    }
    const token = source.slice(i, j)
    if (isPdfNumber(token)) items.push({ type: 'number', value: Number(token) })
    i = j
  }
  return [items, i]
}

function decodePdfString(value) {
  if (value.length >= 2 && value.charCodeAt(0) === 0xfe && value.charCodeAt(1) === 0xff) {
    let out = ''
    for (let i = 2; i + 1 < value.length; i += 2) {
      out += String.fromCharCode((value.charCodeAt(i) << 8) | value.charCodeAt(i + 1))
    }
    return out
  }
  return value
}

function isPdfWhitespace(char) {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f' || char === '\0'
}

function isPdfDelimiter(char) {
  return (
    char === '(' || char === ')' || char === '<' || char === '>' ||
    char === '[' || char === ']' || char === '{' || char === '}' ||
    char === '/' || char === '%'
  )
}

function isPdfNumber(token) {
  return /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token)
}

function cleanupPdfText(value) {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}
