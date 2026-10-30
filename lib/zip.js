/**
 * 极简 ZIP 打包器（stored，不压缩）。
 *
 * 资料库里多是 pdf/office/图片这类本身已压缩的格式，再 deflate 一遍只会白烧 CPU，
 * 所以这里用 method=0 直接搬字节；实现只用 node 内置，不引依赖。
 *
 * 文件用 streaming 写：本地头先写占位 CRC/长度，数据写完补一个 data descriptor，
 * 中央目录最后一次性写。这样即使打包几百 MB 也不会把内存吃满。
 */
import { createReadStream } from 'node:fs'

const SIG_LOCAL = 0x04034b50
const SIG_DESCRIPTOR = 0x08074b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

/** flags 第 3 位＝用 data descriptor；第 11 位＝文件名为 UTF-8。 */
const FLAGS = 0x0808

let CRC_TABLE = null

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  CRC_TABLE = table
  return table
}

function crc32Update(crc, buf) {
  const table = crcTable()
  let c = crc ^ -1
  for (let i = 0; i < buf.length; i += 1) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function dosDateTime(date = new Date()) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f)
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
  return { time, day }
}

function localHeader(nameBuf, dos) {
  const buf = Buffer.alloc(30)
  buf.writeUInt32LE(SIG_LOCAL, 0)
  buf.writeUInt16LE(20, 4)
  buf.writeUInt16LE(FLAGS, 6)
  buf.writeUInt16LE(0, 8)
  buf.writeUInt16LE(dos.time, 10)
  buf.writeUInt16LE(dos.day, 12)
  // crc / csize / usize 留 0，靠 data descriptor 补
  buf.writeUInt16LE(nameBuf.length, 26)
  buf.writeUInt16LE(0, 28)
  return buf
}

function descriptor(crc, size) {
  const buf = Buffer.alloc(16)
  buf.writeUInt32LE(SIG_DESCRIPTOR, 0)
  buf.writeUInt32LE(crc, 4)
  buf.writeUInt32LE(size, 8)
  buf.writeUInt32LE(size, 12)
  return buf
}

function centralHeader(nameBuf, dos, crc, size, offset) {
  const buf = Buffer.alloc(46)
  buf.writeUInt32LE(SIG_CENTRAL, 0)
  buf.writeUInt16LE(20, 4)
  buf.writeUInt16LE(20, 6)
  buf.writeUInt16LE(FLAGS, 8)
  buf.writeUInt16LE(0, 10)
  buf.writeUInt16LE(dos.time, 12)
  buf.writeUInt16LE(dos.day, 14)
  buf.writeUInt32LE(crc, 16)
  buf.writeUInt32LE(size, 20)
  buf.writeUInt32LE(size, 24)
  buf.writeUInt16LE(nameBuf.length, 28)
  buf.writeUInt16LE(0, 30)
  buf.writeUInt16LE(0, 32)
  buf.writeUInt16LE(0, 34)
  buf.writeUInt16LE(0, 36)
  buf.writeUInt32LE(0, 38)
  buf.writeUInt32LE(offset, 42)
  return buf
}

function endOfCentralDir(count, cdSize, cdOffset) {
  const buf = Buffer.alloc(22)
  buf.writeUInt32LE(SIG_EOCD, 0)
  buf.writeUInt16LE(0, 4)
  buf.writeUInt16LE(0, 6)
  buf.writeUInt16LE(count, 8)
  buf.writeUInt16LE(count, 10)
  buf.writeUInt32LE(cdSize, 12)
  buf.writeUInt32LE(cdOffset, 16)
  buf.writeUInt16LE(0, 20)
  return buf
}

/** 背压安全的写：res.write 返回 false 时等 drain。 */
function writeChunk(res, chunk) {
  return new Promise((resolve, reject) => {
    if (res.destroyed || res.writableEnded) {
      // 客户端中途关掉下载时，别再傻等一个永远不会来的 drain。
      reject(new Error('response closed'))
      return
    }
    let flushed = false
    try {
      flushed = res.write(chunk)
    } catch (error) {
      reject(error)
      return
    }
    if (flushed) {
      resolve()
      return
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const onClose = () => {
      cleanup()
      reject(new Error('response closed'))
    }
    const cleanup = () => {
      res.off('drain', onDrain)
      res.off('error', onError)
      res.off('close', onClose)
    }
    res.on('drain', onDrain)
    res.on('error', onError)
    res.on('close', onClose)
  })
}

/**
 * 把文件依次写进 res。文件按 stored 存，文件名重复时自动加序号后缀。
 * @param {import('node:http').ServerResponse} res
 * @param {{name: string, path: string, size: number}[]} files
 * @returns {Promise<{count: number, bytes: number}>}
 */
export async function writeZip(res, files) {
  const dos = dosDateTime()
  const central = []
  const usedNames = new Set()
  let offset = 0
  let total = 0

  for (const file of files) {
    let name = file.name || 'file'
    if (usedNames.has(name)) {
      const dot = name.lastIndexOf('.')
      const stem = dot > 0 ? name.slice(0, dot) : name
      const ext = dot > 0 ? name.slice(dot) : ''
      let n = 2
      while (usedNames.has(`${stem} (${n})${ext}`)) n += 1
      name = `${stem} (${n})${ext}`
    }
    usedNames.add(name)
    const nameBuf = Buffer.from(name, 'utf8')

    const headerOffset = offset
    const header = localHeader(nameBuf, dos)
    await writeChunk(res, header)
    await writeChunk(res, nameBuf)
    offset += header.length + nameBuf.length

    let crc = 0
    let size = 0
    for await (const chunk of createReadStream(file.path)) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      crc = crc32Update(crc, buf)
      size += buf.length
      await writeChunk(res, buf)
      offset += buf.length
    }
    total += size

    await writeChunk(res, descriptor(crc, size))
    offset += 16
    central.push(centralHeader(nameBuf, dos, crc, size, headerOffset))
  }

  const cdOffset = offset
  let cdSize = 0
  for (const entry of central) {
    await writeChunk(res, entry)
    cdSize += entry.length
  }
  await writeChunk(res, endOfCentralDir(central.length, cdSize, cdOffset))
  return { count: central.length, bytes: total }
}
