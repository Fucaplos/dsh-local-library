/**
 * 中文 PDF 的兜底抽取：交给本机 python 的 PyMuPDF（fitz）。
 *
 * 自己解析 PDF 只能拿到 /ToUnicode 健全的简单字体；国内 PDF 大量用子集 CID 字体，
 * 文本串是 2 字节字形码，没有 CMap 就是一堆乱码。PyMuPDF 内部带完整 CMap 处理，
 * 直接子进程调它比自己写 ToUnicode 解析可靠得多。
 *
 * 找不到 python / 没有 fitz / 超时 / 报错，一律返回 null，由调用方回退到内置流抽取。
 */
import { spawn } from 'node:child_process'
import { access, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

const TIMEOUT_MS = 25000
const MAX_PAGES = 600
const MAX_CHARS = 2_000_000

const PY_CODE = `
import json, sys
try:
    import fitz
except Exception as exc:
    print(json.dumps({"ok": False, "error": "no-fitz: %s" % exc}))
    sys.exit(0)
path = sys.argv[1]
max_pages = int(sys.argv[2])
max_chars = int(sys.argv[3])
try:
    doc = fitz.open(path)
    parts = []
    total = 0
    for index, page in enumerate(doc):
        if index >= max_pages:
            parts.append("\\n--- 页数超过上限，已截断 ---")
            break
        try:
            text = page.get_text("text") or ""
        except Exception:
            text = ""
        if text.strip():
            parts.append("--- 第 %d 页 ---\\n%s" % (index + 1, text.rstrip()))
            total += len(text)
        if total > max_chars:
            parts.append("\\n--- 文本超过上限，已截断 ---")
            break
    meta = doc.metadata or {}
    body = "\\n\\n".join(parts)
    print(json.dumps({"ok": True, "text": body[:max_chars], "pages": doc.page_count, "title": meta.get("title") or ""}))
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc)}))
`

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** 找一个能跑 fitz 的 python：环境变量 > 桌面端自带 > python-envs > PATH。 */
async function resolvePython(known) {
  if (known !== undefined) return known
  const home = dshHome()
  const candidates = []
  if (process.env.DSH_PYTHON) candidates.push(process.env.DSH_PYTHON)
  candidates.push(join(home, '.desktop-bin', 'python.exe'), join(home, '.desktop-bin', 'python.cmd'))
  try {
    const envs = await readdir(join(home, 'python-envs'), { withFileTypes: true })
    for (const entry of envs) {
      if (!entry.isDirectory()) continue
      candidates.push(join(home, 'python-envs', entry.name, 'Scripts', 'python.exe'))
      candidates.push(join(home, 'python-envs', entry.name, 'bin', 'python3'))
    }
  } catch {
    /* 没有 python-envs 就跳过 */
  }
  candidates.push('python', 'python3')

  for (const candidate of candidates) {
    if (candidate.includes('\\') || candidate.includes('/')) {
      if (!(await exists(candidate))) continue
    }
    const probe = await runPython(candidate, ['-c', "import fitz,sys;sys.stdout.write('ok')"], 12000)
    if (probe.ok && probe.stdout.trim() === 'ok') return candidate
  }
  return null
}

/** python 脚本落到临时目录：走 -c 传多行代码会被 cmd 的引号规则啃掉，落盘最稳。 */
let scriptPromise = null

async function ensureScript() {
  if (scriptPromise) return scriptPromise
  scriptPromise = (async () => {
    const dir = join(tmpdir(), 'dsh-local-library')
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'pdftext.py')
    await writeFile(path, PY_CODE, 'utf8')
    return path
  })()
  return scriptPromise
}

function runPython(command, args, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child
    try {
      // .cmd 垫片不能直接 spawn（Node 22+ 禁止无 shell 启动），走 cmd.exe /c。
      if (/\.(cmd|bat)$/i.test(command)) {
        child = spawn(process.env.ComSpec || 'cmd.exe', ['/c', command, ...args], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } else {
        child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      }
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: String(error?.message || error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({ ok: false, stdout, stderr: `timeout after ${timeoutMs}ms` })
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr: String(error?.message || error) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout, stderr })
    })
  })
}

let pythonPromise = null

export function resetPdfPythonCache() {
  pythonPromise = null
}

/**
 * @param {string} filePath 磁盘上的 pdf 绝对路径
 * @returns {Promise<{text: string, pages: number, title: string}|null>}
 */
export async function pdfTextViaPython(filePath) {
  if (pythonPromise === null) pythonPromise = resolvePython(undefined)
  const python = await pythonPromise
  if (!python) return null
  const script = await ensureScript()
  const result = await runPython(python, [script, filePath, String(MAX_PAGES), String(MAX_CHARS)])
  if (!result.ok || !result.stdout) return null
  let parsed
  try {
    const line = result.stdout.trim().split('\n').pop()
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed?.ok || typeof parsed.text !== 'string') return null
  return { text: parsed.text, pages: Number(parsed.pages) || 0, title: parsed.title || '' }
}

export function pdfPythonAvailable() {
  return pythonPromise !== null
}
