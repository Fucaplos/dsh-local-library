/**
 * Self-contained tests for lib/extract.js.
 *
 * Every fixture is generated in a temp directory with Node built-ins only:
 * no npm packages, no network, no checked-in binary files.
 *
 * Run with:
 *   <node> test/extract.test.mjs
 * Exit code 0 = all pass, 1 = failures.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { TEXT_LIKE_EXT, extractText, guessKind } from '../lib/extract.js'

const results = { pass: 0, fail: 0, failures: [] }

async function test(name, fn) {
  try {
    await fn()
    results.pass += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    results.fail += 1
    results.failures.push({ name, error })
    console.log(`FAIL  ${name}: ${error && error.message ? error.message : String(error)}`)
  }
}

// ── fixture helpers ─────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Build a real ZIP archive. Each entry: { name, data, method?, zeroLocalSizes? }.
 * method 0 = store, method 8 = raw deflate. Central-directory sizes are always
 * correct; local sizes can be zeroed to simulate streamed writers.
 */
function makeZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8')
    const method = entry.method === 0 ? 0 : 8
    const payload = method === 8 ? zlib.deflateRawSync(data) : data
    const crc = crc32(data)
    const zeroLocal = Boolean(entry.zeroLocalSizes)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(zeroLocal ? 0 : crc, 14)
    local.writeUInt32LE(zeroLocal ? 0 : payload.length, 18)
    local.writeUInt32LE(zeroLocal ? 0 : data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)

    localParts.push(local, name, payload)
    centralParts.push(central, name)
    offset += local.length + name.length + payload.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralDirectory, eocd])
}

function makeDocxBuffer({ zeroLocalSizes = false } = {}) {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一段：资料库项目</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r><w:r><w:tab/><w:t>after tab</w:t></w:r></w:p><w:p><w:r><w:t>AT&amp;T &lt;tag&gt; &quot;quoted&quot; &apos;single&apos; &#20013;&#x6587;</w:t></w:r></w:p></w:body></w:document>`
  const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>页眉 Header Text</w:t></w:r></w:p></w:hdr>`

  return makeZip([
    { name: '[Content_Types].xml', data: contentTypes, method: 0 },
    { name: 'word/document.xml', data: documentXml, method: 8, zeroLocalSizes },
    // Store this one too, so both ZIP methods are actually exercised.
    { name: 'word/header1.xml', data: headerXml, method: 0 },
  ])
}

function makeXlsxBuffer() {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`
  const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4"><si><t>姓名</t></si><si><t>张三</t></si><si><t>部门</t></si><si><t>研发部</t></si></sst>`
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="员工表" sheetId="1" r:id="rId1"/></sheets></workbook>`
  const sheet1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>42</v></c><c r="D2" t="inlineStr"><is><t>内联文本</t></is></c></row></sheetData></worksheet>`

  return makeZip([
    { name: '[Content_Types].xml', data: contentTypes, method: 0 },
    { name: 'xl/sharedStrings.xml', data: sharedStrings, method: 8 },
    { name: 'xl/workbook.xml', data: workbook, method: 8 },
    { name: 'xl/worksheets/sheet1.xml', data: sheet1, method: 8 },
  ])
}

function makePptxBuffer() {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`
  const slide1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:p><a:r><a:t>第一页标题</a:t></a:r></a:p><a:p><a:r><a:t>Slide one body</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
  const slide2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:p><a:r><a:t>第二页标题</a:t></a:r></a:p><a:p><a:r><a:t>Slide two body</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`

  // Deliberately out of order on disk: the extractor must sort by slide number.
  return makeZip([
    { name: '[Content_Types].xml', data: contentTypes, method: 0 },
    { name: 'ppt/slides/slide2.xml', data: slide2, method: 8 },
    { name: 'ppt/slides/slide1.xml', data: slide1, method: 8 },
  ])
}

function makeFlatePdfBuffer(content) {
  const compressed = zlib.deflateSync(Buffer.from(content, 'latin1'))
  const head = Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`,
    'latin1',
  )
  const tail = Buffer.from(
    '\nendstream\nendobj\ntrailer\n<< /Size 2 /Root 2 0 R >>\nstartxref\n0\n%%EOF\n',
    'latin1',
  )
  return Buffer.concat([head, compressed, tail])
}

function makeRawPdfBuffer(content) {
  const length = Buffer.byteLength(content, 'latin1')
  const head = `%PDF-1.4\n1 0 obj\n<< /Length ${length} >>\nstream\n`
  const tail = `\nendstream\nendobj\ntrailer\n<< /Size 2 /Root 2 0 R >>\nstartxref\n0\n%%EOF\n`
  return Buffer.concat([
    Buffer.from(head, 'latin1'),
    Buffer.from(content, 'latin1'),
    Buffer.from(tail, 'latin1'),
  ])
}

// ── fixtures on disk ────────────────────────────────────────────────────────

const tempDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-extract-test-'))
const fixtures = {}
let setupError = null

try {
  fixtures.markdown = path.join(tempDirectory, 'notes.md')
  fixtures.markdownText = '# 资料库说明\n\n这是第一段中文。\nSecond line with ASCII.\n'
  await fsp.writeFile(fixtures.markdown, fixtures.markdownText, 'utf8')

  fixtures.utf16le = path.join(tempDirectory, 'utf16le.txt')
  fixtures.utf16leText = 'UTF16 LE 中文内容'
  await fsp.writeFile(
    fixtures.utf16le,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(fixtures.utf16leText, 'utf16le')]),
  )

  fixtures.utf16be = path.join(tempDirectory, 'utf16be.txt')
  fixtures.utf16beText = 'UTF16 BE 中文内容'
  const beBody = Buffer.from(fixtures.utf16beText, 'utf16le')
  const beSwapped = Buffer.alloc(beBody.length)
  for (let i = 0; i < beBody.length; i += 2) {
    beSwapped[i] = beBody[i + 1]
    beSwapped[i + 1] = beBody[i]
  }
  await fsp.writeFile(fixtures.utf16be, Buffer.concat([Buffer.from([0xfe, 0xff]), beSwapped]))

  fixtures.big = path.join(tempDirectory, 'big.txt')
  fixtures.bigHead = 'BEGIN-BIG-FILE\n'
  await fsp.writeFile(
    fixtures.big,
    Buffer.concat([Buffer.from(fixtures.bigHead, 'utf8'), Buffer.alloc(5 * 1024 * 1024, 0x78)]),
  )

  fixtures.docx = path.join(tempDirectory, 'sample.docx')
  await fsp.writeFile(fixtures.docx, makeDocxBuffer())

  fixtures.docxZeroLocal = path.join(tempDirectory, 'zero-local.docx')
  await fsp.writeFile(fixtures.docxZeroLocal, makeDocxBuffer({ zeroLocalSizes: true }))

  fixtures.xlsx = path.join(tempDirectory, 'sample.xlsx')
  await fsp.writeFile(fixtures.xlsx, makeXlsxBuffer())

  fixtures.pptx = path.join(tempDirectory, 'sample.pptx')
  await fsp.writeFile(fixtures.pptx, makePptxBuffer())

  fixtures.pdfFlate = path.join(tempDirectory, 'flate.pdf')
  await fsp.writeFile(fixtures.pdfFlate, makeFlatePdfBuffer('BT /F1 12 Tf 72 712 Td (Hello Library) Tj ET'))

  fixtures.pdfRaw = path.join(tempDirectory, 'raw.pdf')
  await fsp.writeFile(
    fixtures.pdfRaw,
    makeRawPdfBuffer(
      "BT /F1 12 Tf 72 712 Td [(Hello) -300 (Library)] TJ T* (Second line) Tj T* (It's \\(fine\\) \\101) ' 1 0 (Quoted operator) \" ET",
    ),
  )

  fixtures.brokenDocx = path.join(tempDirectory, 'broken.docx')
  fixtures.brokenPdf = path.join(tempDirectory, 'broken.pdf')
  await fsp.writeFile(fixtures.brokenDocx, Buffer.alloc(4096, 0xab))
  await fsp.writeFile(fixtures.brokenPdf, Buffer.alloc(4096, 0xab))
} catch (error) {
  setupError = error
}

// ── tests ───────────────────────────────────────────────────────────────────

try {
  if (setupError) throw setupError

  await test('text: .md decodes UTF-8 exactly (including Chinese)', async () => {
    const result = await extractText({ path: fixtures.markdown, name: 'notes.md' })
    assert.equal(result.kind, 'text')
    assert.equal(result.text, fixtures.markdownText)
    assert.equal(result.note, undefined)
  })

  await test('text: UTF-16 BOM (LE and BE) is decoded', async () => {
    const le = await extractText({ path: fixtures.utf16le, name: 'utf16le.txt' })
    assert.equal(le.kind, 'text')
    assert.equal(le.text, fixtures.utf16leText)

    const be = await extractText({ path: fixtures.utf16be, name: 'utf16be.txt' })
    assert.equal(be.kind, 'text')
    assert.equal(be.text, fixtures.utf16beText)
  })

  await test('text: 5 MB file is read bounded and fast', async () => {
    const started = Date.now()
    const result = await extractText({ path: fixtures.big, name: 'big.txt' })
    const elapsed = Date.now() - started

    assert.equal(result.kind, 'text')
    assert.ok(result.text.startsWith(fixtures.bigHead), 'content should start with the marker')
    assert.equal(result.note, 'truncated')
    assert.ok(result.text.endsWith('\n...[truncated]'), 'truncation marker should be present')
    assert.equal(result.text.length, 2_000_000 + 15, 'text should be capped at the default maxChars')
    assert.ok(elapsed < 5000, `bounded read took too long: ${elapsed}ms`)
  })

  await test('text: maxChars option truncates and marks the text', async () => {
    const result = await extractText({ path: fixtures.markdown, name: 'notes.md' }, { maxChars: 10 })
    assert.equal(result.note, 'truncated')
    assert.equal(result.text, `${fixtures.markdownText.slice(0, 10)}\n...[truncated]`)
  })

  await test('docx: store and deflate entries, paragraphs, entities, header', async () => {
    const result = await extractText({ path: fixtures.docx, name: 'sample.docx' })
    assert.equal(result.kind, 'docx')
    assert.ok(result.text.includes('第一段：资料库项目'), 'expected Chinese paragraph')
    assert.ok(
      result.text.includes('第一段：资料库项目\nSecond paragraph'),
      'paragraph boundary should become a newline',
    )
    assert.ok(result.text.includes('Second paragraph\tafter tab'), 'tab should be preserved')
    assert.ok(result.text.includes('AT&T <tag> "quoted" \'single\' 中文'), 'XML entities should decode')
    assert.ok(result.text.includes('页眉 Header Text'), 'stored header part should be appended')
  })

  await test('docx: central directory is authoritative when local sizes are zero', async () => {
    const result = await extractText({ path: fixtures.docxZeroLocal, name: 'zero-local.docx' })
    assert.equal(result.kind, 'docx')
    assert.ok(result.text.includes('第一段：资料库项目'))
    assert.ok(result.text.includes('页眉 Header Text'))
  })

  await test('xlsx: shared strings, numeric and inline cells, sheet name', async () => {
    const result = await extractText({ path: fixtures.xlsx, name: 'sample.xlsx' })
    assert.equal(result.kind, 'xlsx')
    assert.ok(result.text.includes('--- sheet: 员工表 ---'), 'sheet name from workbook.xml')
    assert.ok(result.text.includes('姓名'), 'shared string header')
    assert.ok(result.text.includes('张三'), 'shared string cell')
    assert.ok(result.text.includes('研发部\t42\t内联文本'), 'row cells should be tab separated')
  })

  await test('pptx: slides are ordered by number and labelled', async () => {
    const result = await extractText({ path: fixtures.pptx, name: 'sample.pptx' })
    assert.equal(result.kind, 'pptx')
    assert.ok(result.text.includes('--- slide 1 ---'))
    assert.ok(result.text.includes('--- slide 2 ---'))
    assert.ok(
      result.text.indexOf('第一页标题') < result.text.indexOf('第二页标题'),
      'slide 1 must come before slide 2 even when the ZIP order is reversed',
    )
    assert.ok(result.text.includes('Slide one body'))
    assert.ok(result.text.includes('Slide two body'))
  })

  await test('pdf: FlateDecode stream with Tj is extracted', async () => {
    const result = await extractText({ path: fixtures.pdfFlate, name: 'flate.pdf' })
    assert.equal(result.kind, 'pdf')
    assert.ok(result.text.includes('Hello Library'), `unexpected PDF text: ${JSON.stringify(result.text)}`)
  })

  await test('pdf: uncompressed stream, TJ arrays and T* are extracted', async () => {
    const result = await extractText({ path: fixtures.pdfRaw, name: 'raw.pdf' })
    assert.equal(result.kind, 'pdf')
    assert.ok(result.text.includes('Hello Library'), `unexpected PDF text: ${JSON.stringify(result.text)}`)
    assert.ok(result.text.includes('Second line'))
    assert.ok(result.text.includes("It's (fine) A"), `escape decoding failed: ${JSON.stringify(result.text)}`)
    assert.ok(result.text.includes('Quoted operator'), `double-quote operator failed: ${JSON.stringify(result.text)}`)
  })

  await test('corrupt .docx/.pdf return empty text without throwing', async () => {
    const docx = await extractText({ path: fixtures.brokenDocx, name: 'broken.docx' })
    assert.equal(docx.kind, 'docx')
    assert.equal(docx.text, '')
    assert.equal(typeof docx.note, 'string')
    assert.ok(docx.note.length > 0)

    const pdf = await extractText({ path: fixtures.brokenPdf, name: 'broken.pdf' })
    assert.equal(pdf.kind, 'pdf')
    assert.equal(pdf.text, '')
    assert.equal(pdf.note, 'no-extractable-text')
  })

  await test('missing file returns not-found instead of throwing', async () => {
    const result = await extractText({ path: path.join(tempDirectory, 'does-not-exist.md'), name: 'x.md' })
    assert.equal(result.kind, 'text')
    assert.equal(result.text, '')
    assert.equal(result.note, 'not-found')
  })

  await test('guessKind: extensions, dotfiles, mime fallback, extension priority', () => {
    assert.equal(guessKind('notes.md'), 'text')
    assert.equal(guessKind('NOTES.MD'), 'text')
    assert.equal(guessKind('report.docx'), 'docx')
    assert.equal(guessKind('data.XLSX'), 'xlsx')
    assert.equal(guessKind('deck.pptx'), 'pptx')
    assert.equal(guessKind('paper.PDF'), 'pdf')
    assert.equal(guessKind('photo.png'), 'other')
    assert.equal(guessKind('archive.7z'), 'other')
    assert.equal(guessKind('README'), 'other')
    assert.equal(guessKind('.gitignore'), 'text')
    assert.equal(guessKind('.env.local'), 'text')
    assert.equal(guessKind('blob.bin', 'text/plain'), 'text')
    assert.equal(guessKind('blob.bin', 'application/json; charset=utf-8'), 'text')
    assert.equal(guessKind('blob.bin', 'application/xml'), 'text')
    assert.equal(guessKind('blob.docx', 'text/plain'), 'docx')
    assert.equal(guessKind('blob.bin', 'image/png'), 'other')
    assert.equal(guessKind('', ''), 'other')
  })

  await test('TEXT_LIKE_EXT is a lower-case dotted whitelist', () => {
    assert.ok(TEXT_LIKE_EXT.has('.md'))
    assert.ok(TEXT_LIKE_EXT.has('.markdown'))
    assert.ok(TEXT_LIKE_EXT.has('.tsv'))
    assert.ok(TEXT_LIKE_EXT.has('.gitignore'))
    assert.ok(!TEXT_LIKE_EXT.has('.docx'))
    for (const extension of TEXT_LIKE_EXT) {
      assert.ok(extension.startsWith('.'), `${extension} should start with a dot`)
      assert.equal(extension, extension.toLowerCase(), `${extension} should be lower case`)
    }
  })

  await test('other: unsupported type is not read', async () => {
    const result = await extractText({ path: fixtures.markdown, name: 'photo.png' })
    assert.equal(result.kind, 'other')
    assert.equal(result.text, '')
    assert.equal(result.note, 'unsupported-type')
  })
} catch (error) {
  results.fail += 1
  results.failures.push({ name: 'fixture setup / top-level', error })
  console.log(`FAIL  fixture setup / top-level: ${error && error.message ? error.message : String(error)}`)
} finally {
  await fsp.rm(tempDirectory, { recursive: true, force: true }).catch(() => {})
}

for (const failure of results.failures) {
  console.log(`\n--- ${failure.name} ---`)
  console.log(failure.error && failure.error.stack ? failure.error.stack : String(failure.error))
}

console.log(`\nPASS ${results.pass} / FAIL ${results.fail}`)
process.exitCode = results.fail === 0 ? 0 : 1
