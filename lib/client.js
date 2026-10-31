/**
 * dsh-local-library —— 客户端半侧（浏览器）。
 *
 * 这个文件必须是一段**普通副作用脚本**：没有顶层 import/export，
 * 由 DSH 的模块加载器把 require 注入进来（见 makeFactory）。
 *
 * 它只做一件事：在「设置」左栏加一个「本地资料库」分区，页面是
 * 上传区 + 检索框 + 文件列表（下载 / 删除）+ 存储信息。
 * 宿主半侧在 lib/index.js，两者通过 /dsh-local-library/* 通信。
 */
;(() => {
  const NS = 'local-library'
  const ROUTE = '/dsh-local-library'
  const STYLE_TAG = 'dsh-local-library/settings.css'
  const NAV_STYLE_TAG = 'dsh-local-library/nav-icon.css'
  const NAV_MARK = 'data-dsh-ll-nav'

  // makeSettings 在 IIFE 作用域里定义，而 jsx 工厂（h）是 makeFactory 拿到的。
  // 用一个外层可变绑定把它们串起来：工厂里赋值，组件渲染时才有 h 可用。
  let h = null

  const zh = {
    nav: '本地资料库',
    title: '本地资料库',
    subtitle: '文件存在本机，所有对话共用；新会话里的 agent 会自动看到这套工具，不用再提醒它。',
    drop: '把文件拖到这里，或点击选择',
    dropHint: '支持 PDF / Word / Excel / PPT / 文本 / 图片，单文件上限 512MB，可多选',
    search: '在资料库里检索…',
    searchBtn: '检索',
    refresh: '刷新',
    uploading: '上传中',
    indexed: '已建索引',
    indexing: '索引中…',
    noText: '无可抽取文本',
    download: '下载',
    remove: '删除',
    confirmRemove: '确认删除？',
    empty: '资料库还是空的，先传几个文件进来。',
    emptySearch: '没有命中，换个关键词试试。',
    count: (n) => `共 ${n} 个文件`,
    storage: '存储位置',
    copyPath: '复制路径',
    copied: '已复制',
    errorPrefix: '出错了：',
    uploaded: (n) => `已上传 ${n} 个文件`,
    refused: '有文件超过 512MB，已跳过：',
    refusedOnly: '以下文件超过 512MB，已跳过：',
    uploadStalled: '上传卡住了（60 秒没有进度），已自动放弃，请检查网络后重试',
    agentSaved: 'agent 存入',
    snippet: '命中片段',
    hitByName: '按文件名/标签命中（正文里没有这个词）',
    strict: '严格匹配',
    strictHint: '只保留关键词命中率高的结果；关掉则按相关度宽松返回',
    strictOn: '已开启严格匹配：擦边的结果不再返回',
    strictOff: '已切回宽松匹配：按相关度返回更多结果',
    selectOne: '选择这个文件',
    selectedCount: (n) => `已选 ${n} 个`,
    zipSelected: '打包下载',
    clearSelection: '取消选择',
    zipDone: (n) => `已打包下载 ${n} 个文件`,
    zipCapped: (used, limit) => `已打包 ${used} 个（一次最多 ${limit} 个，超出的没有打包）`,
    tags: '标签',
    editTags: '编辑标签（逗号分隔）',
    tagsPlaceholder: '例如：财务, 2026预算',
    dupeTitle: (file, existing) => `「${file}」库里已经有一模一样的内容了${existing ? `（${existing}）` : ''}，怎么办？`,
    dupeReplace: '覆盖旧的',
    dupeKeep: '再存一份',
    dupeSkip: '跳过',
    filterAll: '全部',
    filterPdf: 'PDF',
    filterWord: 'Word',
    filterSheet: '表格',
    filterPpt: 'PPT',
    filterImage: '图片',
    filterText: '文本',
    reindex: '重建索引',
    reindexing: '重建中…',
    reindexQueued: (n) => `已排队重建 ${n} 个索引`,
    usage: (size) => `占用 ${size}`,
    indexedCount: (n) => `${n} 个已建索引`
  }

  const en = {
    nav: 'Local library',
    title: 'Local library',
    subtitle: 'Files live on this machine and every conversation shares them. New sessions already know about the tools.',
    drop: 'Drop files here, or click to choose',
    dropHint: 'PDF / Word / Excel / PPT / text / images, up to 512MB per file',
    search: 'Search the library…',
    searchBtn: 'Search',
    refresh: 'Refresh',
    uploading: 'Uploading',
    indexed: 'indexed',
    indexing: 'indexing…',
    noText: 'no text',
    download: 'Download',
    remove: 'Delete',
    confirmRemove: 'Confirm delete?',
    empty: 'The library is empty — upload something first.',
    emptySearch: 'No match. Try another keyword.',
    count: (n) => `${n} file(s)`,
    storage: 'Location',
    copyPath: 'Copy path',
    copied: 'Copied',
    errorPrefix: 'Error: ',
    uploaded: (n) => `Uploaded ${n} file(s)`,
    refused: 'Skipped files above 512MB: ',
    refusedOnly: 'Skipped files above 512MB: ',
    uploadStalled: 'Upload stalled (no progress for 60s); gave up — check your connection and retry.',
    agentSaved: 'saved by agent',
    snippet: 'match',
    hitByName: 'Matched by file name or tag (not present in the body text)',
    strict: 'Strict match',
    strictHint: 'Keep only results whose keywords really match; turn off for broader relevance ranking',
    strictOn: 'Strict match on: weak matches are hidden',
    strictOff: 'Back to loose match: more results by relevance',
    selectOne: 'Select this file',
    selectedCount: (n) => `${n} selected`,
    zipSelected: 'Download as ZIP',
    clearSelection: 'Clear selection',
    zipDone: (n) => `Bundled ${n} file(s)`,
    zipCapped: (used, limit) => `Bundled ${used} file(s) (max ${limit} at a time; the rest were skipped)`,
    tags: 'Tags',
    editTags: 'Edit tags (comma separated)',
    tagsPlaceholder: 'e.g. finance, budget-2026',
    dupeTitle: (file, existing) => `Identical content already exists for “${file}”${existing ? ` (${existing})` : ''}. What now?`,
    dupeReplace: 'Replace',
    dupeKeep: 'Keep both',
    dupeSkip: 'Skip',
    filterAll: 'All',
    filterPdf: 'PDF',
    filterWord: 'Word',
    filterSheet: 'Sheet',
    filterPpt: 'PPT',
    filterImage: 'Image',
    filterText: 'Text',
    reindex: 'Rebuild index',
    reindexing: 'Rebuilding…',
    reindexQueued: (n) => `Queued ${n} index rebuild(s)`,
    usage: (size) => `${size} used`,
    indexedCount: (n) => `${n} indexed`
  }

  const MAX_BYTES = 512 * 1024 * 1024
  /** 一次打包的条目上限，要和宿主侧 BUNDLE_MAX 保持一致，否则服务端会静默截断。 */
  const MAX_BUNDLE = 300
  /** 上传多久没有任何进度就算卡死：XHR 自己不会超时，队列会永远停在"上传中"。 */
  const UPLOAD_STALL_MS = 60000
  /** 进度条刷新节流：512MB 文件每秒几十个 progress 事件，全 setState 会把页面拖卡。 */
  const PROGRESS_THROTTLE_MS = 150

  // 类型过滤条：[kind, i18n key]。kind 直接对应宿主侧解析出的 item.kind
  const FILTER_KINDS = [
    ['', 'filterAll'],
    ['pdf', 'filterPdf'],
    ['docx', 'filterWord'],
    ['xlsx', 'filterSheet'],
    ['pptx', 'filterPpt'],
    ['image', 'filterImage'],
    ['text', 'filterText']
  ]

  function formatBytes(n) {
    const v = Number(n) || 0
    if (v < 1024) return `${v} B`
    const units = ['KB', 'MB', 'GB']
    let value = v / 1024
    let i = 0
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024
      i += 1
    }
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`
  }

  function formatDate(iso) {
    try {
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return ''
      const pad = (x) => String(x).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    } catch {
      return ''
    }
  }

  function cssText() {
    return [
      '.ll-root{display:flex;flex-direction:column;gap:16px;font-size:14px;line-height:1.55;padding:2px 0 24px;max-width:860px}',
      '.ll-head{display:flex;flex-direction:column;gap:4px}',
      '.ll-title{font-size:16px;font-weight:600;margin:0}',
      '.ll-sub{opacity:.62;font-size:13px;margin:0}',
      '.ll-drop{border:1px dashed rgba(127,127,127,.42);border-radius:12px;padding:26px 18px;text-align:center;cursor:pointer;transition:background .15s,border-color .15s;display:flex;flex-direction:column;gap:6px}',
      '.ll-drop:hover{background:rgba(127,127,127,.07)}',
      '.ll-drop.over{background:rgba(76,110,245,.10);border-color:rgba(76,110,245,.65)}',
      '.ll-drop-main{font-size:14px;font-weight:500}',
      '.ll-drop-hint{font-size:12px;opacity:.6}',
      '.ll-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      '.ll-input{flex:1 1 220px;min-width:160px;font:inherit;font-size:13px;padding:8px 12px;border-radius:9px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;outline:none}',
      '.ll-input:focus{border-color:rgba(76,110,245,.7)}',
      '.ll-btn{font:inherit;font-size:13px;padding:6px 13px;border-radius:9px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;cursor:pointer;transition:background .15s,border-color .15s;white-space:nowrap;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}',
      '.ll-btn:hover{background:rgba(127,127,127,.12)}',
      '.ll-btn:disabled{opacity:.45;cursor:default}',
      '.ll-btn.primary{background:#4c6ef5;border-color:#4c6ef5;color:#fff}',
      '.ll-btn.primary:hover{background:#3b5bdb}',
      '.ll-btn.danger{color:#e5484d;border-color:rgba(229,72,77,.45)}',
      '.ll-btn.danger:hover{background:rgba(229,72,77,.10)}',
      '.ll-btn.tiny{font-size:12px;padding:3px 9px;border-radius:7px}',
      '.ll-list{display:flex;flex-direction:column;border-top:1px solid rgba(127,127,127,.18)}',
      '.ll-row{display:flex;align-items:center;gap:12px;padding:10px 4px;border-bottom:1px solid rgba(127,127,127,.18)}',
      '.ll-row:hover{background:rgba(127,127,127,.06)}',
      '.ll-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.ll-name{font-size:13.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ll-meta{font-size:12px;opacity:.6;display:flex;gap:8px;flex-wrap:wrap}',
      '.ll-kind{font-size:11px;padding:1px 6px;border-radius:5px;background:rgba(127,127,127,.16);text-transform:uppercase;letter-spacing:.3px}',
      '.ll-snippet{font-size:12px;opacity:.72;margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.ll-snippet-tag{font-style:italic;opacity:.55}',
      '.ll-actions{display:flex;gap:6px;flex:none}',
      '.ll-empty{padding:26px 4px;opacity:.6;font-size:13px;text-align:center}',
      '.ll-foot{display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:12px;opacity:.62;border-top:1px solid rgba(127,127,127,.18);padding-top:10px}',
      '.ll-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;opacity:.85;word-break:break-all}',
      '.ll-queue{display:flex;flex-direction:column;gap:6px;font-size:12.5px}',
      '.ll-track{height:4px;border-radius:3px;background:rgba(127,127,127,.22);overflow:hidden}',
      '.ll-fill{height:100%;background:#4c6ef5;transition:width .18s}',
      '.ll-err{color:#e5484d;font-size:12.5px}',
      '.ll-sel{flex:none;width:14px;height:14px;margin:0;cursor:pointer;accent-color:#4c6ef5}',
      '.ll-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:2px}',
      '.ll-tag{font-size:11px;padding:1px 7px;border-radius:999px;background:rgba(76,110,245,.14);color:inherit;opacity:.9}',
      '.ll-taggedit{flex:1 1 100%;margin-top:4px;padding:5px 9px;font-size:12.5px}',
      '.ll-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
      '.ll-strict{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:12px;opacity:.7;cursor:pointer;user-select:none}',
      '.ll-strict.on{opacity:1;font-weight:600}',
      '.ll-strict input{margin:0;cursor:pointer}',
      '.ll-chip{font:inherit;font-size:12px;padding:3px 11px;border-radius:999px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;cursor:pointer}',
      '.ll-chip:hover{background:rgba(127,127,127,.12)}',
      '.ll-chip.on{background:rgba(76,110,245,.16);border-color:rgba(76,110,245,.6)}',
      '.ll-selbar{padding:8px 10px;border-radius:10px;background:rgba(76,110,245,.08)}',
      '.ll-dupe{border:1px solid rgba(255,169,64,.55);background:rgba(255,169,64,.10);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;font-size:12.5px}'
    ].join('\n')
  }

  function injectCss(doc) {
    if (!doc || doc.head === null) return
    if (doc.querySelector(`style[data-plugin-css="${STYLE_TAG}"]`) !== null) return
    const tag = doc.createElement('style')
    tag.dataset.plugin = 'dsh-local-library'
    tag.dataset.pluginCss = STYLE_TAG
    tag.textContent = cssText()
    doc.head.appendChild(tag)
  }

  /** 设置面板导航行图标的 DOM 补丁（DSH 没有给第三方分区配图标的入口）。 */
  function navCss(glyph) {
    return [
      `[${NAV_MARK}] [class*="navIcon"]{display:none}`,
      `[${NAV_MARK}]::before{content:"";flex:none;width:16px;height:16px;background-color:currentColor;-webkit-mask:${glyph} center/16px 16px no-repeat;mask:${glyph} center/16px 16px no-repeat}`
    ].join('\n')
  }

  function svgMaskUri(svg) {
    const source = String(svg || '').trim()
    if (source === '') return ''
    const namespaced = /<svg[^>]*\sxmlns=/i.test(source) ? source : source.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"')
    return `url("data:image/svg+xml,${encodeURIComponent(namespaced.split('currentColor').join('#000'))}")`
  }

  const NAV_GLYPH =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H9v16H5.5A1.5 1.5 0 0 1 4 18.5z"/>' +
    '<path d="M9 4h4.5A1.5 1.5 0 0 1 15 5.5v13a1.5 1.5 0 0 1-1.5 1.5H9z"/>' +
    '<path d="M16 6.2l2.6-.7 3 12.4-2.6.7z"/>' +
    '</svg>'

  function installNavIcon(labelOf) {
    const doc = typeof document === 'undefined' ? undefined : document
    const Observer = typeof MutationObserver === 'undefined' ? undefined : MutationObserver
    if (doc === undefined || Observer === undefined || doc.body === null) return () => {}
    const glyph = svgMaskUri(NAV_GLYPH)
    if (glyph === '') return () => {}

    if (doc.querySelector(`style[data-plugin-css="${NAV_STYLE_TAG}"]`) === null) {
      const tag = doc.createElement('style')
      tag.dataset.plugin = 'dsh-local-library'
      tag.dataset.pluginCss = NAV_STYLE_TAG
      tag.textContent = navCss(glyph)
      doc.head.appendChild(tag)
    }

    const mark = () => {
      try {
        const wanted = labelOf()
        if (!wanted) return
        // DSH 聊天流式输出时整个 body 都在变，先确认设置弹窗开着再查，
        // 否则每次 token 渲染都要在全局 DOM 里跑一遍选择器。
        const modal = doc.querySelector('[data-shortcut-modal="settings"]')
        if (modal === null) return
        const cells = modal.querySelectorAll('[class*="navCell"]')
        for (const cell of cells) {
          if (cell.hasAttribute(NAV_MARK)) continue
          const label = cell.querySelector('[class*="navLabel"]')
          if (label === null) continue
          if ((label.textContent || '').trim() === wanted) cell.setAttribute(NAV_MARK, '')
        }
      } catch {
        /* 认不出行就不管，齿轮照旧 */
      }
    }

    // 用 250ms 防抖而不是 microtask：流式输出会持续触发 mutation，
    // microtask 只在同一个任务内合并，照样会被打成高频调用。
    let timer
    const schedule = () => {
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        mark()
      }, 250)
    }
    const observer = new Observer(schedule)
    observer.observe(doc.body, { childList: true, subtree: true })
    mark()
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      observer.disconnect()
    }
  }

  /**
   * 设置分区本体。
   *
   * 状态顺序（client.smoke 用假 hooks 依赖这个顺序，改顺序要同步改测试）：
   * items stats query over error banner queue pendingDelete copied
   * selected tagEdit dupPrompt filter reindexing
   */
  function makeSettings({ useState, useEffect, useCallback, useRef, t }) {
    return function LocalLibrarySection() {
      const [items, setItems] = useState([])
      const [stats, setStats] = useState(null)
      const [query, setQuery] = useState('')
      const [over, setOver] = useState(false)
      const [error, setError] = useState('')
      const [banner, setBanner] = useState('')
      const [queue, setQueue] = useState([])
      const [pendingDelete, setPendingDelete] = useState('')
      const [copied, setCopied] = useState(false)
      const [selected, setSelected] = useState([])
      const [tagEdit, setTagEdit] = useState(null)
      const [dupPrompt, setDupPrompt] = useState(null)
      const [filter, setFilter] = useState('')
      const [reindexing, setReindexing] = useState(false)
      // 严格匹配：默认宽松，可在设置页打开；值同时保存在库目录的 settings.json 里。
      const [matchMode, setMatchMode] = useState('loose')
      const inputRef = useRef(null)
      const alive = useRef(true)
      /** 按了 Esc 要取消编辑，但卸载 input 会触发 blur —— 用这个标记让 blur 不要保存。 */
      const tagAbort = useRef(false)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const load = useCallback(async (keyword, kind) => {
        const kindFilter = kind === undefined ? '' : kind
        const composed = [keyword || '', kindFilter ? `kind:${kindFilter}` : ''].filter(Boolean).join(' ')
        try {
          const res = await fetch(`${ROUTE}/list?q=${encodeURIComponent(composed)}&limit=300`, {
            headers: { accept: 'application/json' }
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = await res.json()
          if (!alive.current) return
          setItems(Array.isArray(data.items) ? data.items : [])
          setStats(data.stats || null)
          // 过滤条件写错（after:2026-13-99）时服务端会回 warnings，得让用户看见，
          // 不然他以为按日期筛过了。
          setBanner(Array.isArray(data.warnings) && data.warnings.length > 0 ? data.warnings.join('；') : '')
          setError('')
        } catch (err) {
          if (alive.current) setError(t('errorPrefix') + (err && err.message ? err.message : String(err)))
        }
      }, [])

      useEffect(() => {
        void load('', '')
      }, [load])

      // 读设置（只有 matchMode 一项）：失败就当宽松匹配，不打断页面。
      useEffect(() => {
        let cancelled = false
        fetch(`${ROUTE}/config`, { headers: { accept: 'application/json' } })
          .then((res) => (res.ok ? res.json() : null))
          .then((cfg) => {
            if (cancelled || !cfg) return
            setMatchMode(cfg.matchMode === 'strict' ? 'strict' : 'loose')
          })
          .catch(() => {})
        return () => {
          cancelled = true
        }
      }, [])

      /** 切换严格匹配：先乐观更新，写回失败再退回原值并报错。 */
      const toggleStrict = useCallback(() => {
        const next = matchMode === 'strict' ? 'loose' : 'strict'
        const previous = matchMode
        setMatchMode(next)
        fetch(`${ROUTE}/config`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ matchMode: next })
        })
          .then(async (res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            if (!alive.current) return
            setBanner(t(next === 'strict' ? 'strictOn' : 'strictOff'))
            await load(query, filter)
          })
          .catch((err) => {
            if (!alive.current) return
            setMatchMode(previous)
            setError(t('errorPrefix') + (err && err.message ? err.message : String(err)))
          })
      }, [matchMode, query, filter, load])

      /** 解析上传响应；409 表示"库里已有同一份内容"，交给用户决定怎么办。 */
      const sendUpload = useCallback(
        (file, key, dupMode, folder) =>
          new Promise((resolve) => {
            const xhr = new XMLHttpRequest()
            const suffix = dupMode ? `&dup=${encodeURIComponent(dupMode)}` : ''
            // 拖文件夹时把顶层文件夹名挂成标签，方便以后按来源筛
            const tagPart = folder ? `&tags=${encodeURIComponent(folder)}` : ''
            xhr.open('POST', `${ROUTE}/upload?name=${encodeURIComponent(file.name)}${suffix}${tagPart}`)
            xhr.setRequestHeader('content-type', file.type || 'application/octet-stream')
            let lastBeat = Date.now()
            let lastTick = 0
            let lastPct = -1
            let stalled = false
            // XHR 没有内置超时：网络断了但连接还挂着时 Promise 永不 settle，
            // 队列项就一直显示"上传中"。这里做心跳看门狗，60 秒没进度直接放弃。
            const watchdog = setInterval(() => {
              if (Date.now() - lastBeat < UPLOAD_STALL_MS) return
              stalled = true
              try {
                xhr.abort()
              } catch {
                /* ignore */
              }
            }, 5000)
            const finish = (result) => {
              clearInterval(watchdog)
              resolve(result)
            }
            xhr.upload.onprogress = (event) => {
              lastBeat = Date.now()
              if (!event.lengthComputable) return
              const pct = Math.min(99, Math.round((event.loaded / event.total) * 100))
              if (pct === lastPct) return
              const now = Date.now()
              // 节流：最多每 PROGRESS_THROTTLE_MS 刷一次进度
              if (now - lastTick < PROGRESS_THROTTLE_MS) return
              lastPct = pct
              lastTick = now
              if (!alive.current) return
              setQueue((prev) => prev.map((entry) => (entry.key === key ? { ...entry, pct } : entry)))
            }
            const parse = () => {
              try {
                return JSON.parse(xhr.responseText || '{}')
              } catch {
                return {}
              }
            }
            xhr.onload = () =>
              finish({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, body: parse() })
            xhr.onerror = () => finish({ ok: false, status: 0, body: { error: 'network error' } })
            xhr.onabort = () =>
              finish({ ok: false, status: 0, body: { error: stalled ? 'stalled' : 'aborted' } })
            xhr.send(file)
          }),
        []
      )

      const askDuplicate = useCallback(
        (file, info) =>
          new Promise((resolve) => {
            setDupPrompt({
              fileName: file.name,
              existing: info || null,
              answer: (choice) => {
                setDupPrompt(null)
                resolve(choice)
              }
            })
          }),
        []
      )

      const uploadOne = useCallback(
        async (pair) => {
          const file = pair && pair.file ? pair.file : pair
          const folder = pair && pair.folder ? pair.folder : ''
          const key = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
          if (alive.current) setQueue((prev) => [...prev, { key, name: file.name, pct: 0 }])
          try {
            let res = await sendUpload(file, key, '', folder)
            if (res.status === 409 && res.body && res.body.duplicate) {
              const choice = await askDuplicate(file, res.body.duplicate)
              if (!choice || choice === 'skip') return false
              res = await sendUpload(file, key, choice, folder)
            }
            if (res.ok) return true
            const code = res.body && res.body.error
            const message = code === 'stalled' ? t('uploadStalled') : code || `HTTP ${res.status}`
            if (alive.current) setError(t('errorPrefix') + `${file.name}: ${message}`)
            return false
          } finally {
            if (alive.current) setQueue((prev) => prev.filter((entry) => entry.key !== key))
          }
        },
        [askDuplicate, sendUpload, t]
      )

      /**
       * 把 drop 事件里的东西摊平成文件列表。
       * 拖文件夹时浏览器只在 webkitGetAsEntry 里给目录句柄，要递归读。
       */
      const collectDropped = useCallback(async (dataTransfer) => {
        const out = []
        const dt = dataTransfer
        if (!dt) return out
        const items = dt.items ? Array.from(dt.items) : []
        const supportsEntries = items.length > 0 && typeof items[0].webkitGetAsEntry === 'function'
        if (!supportsEntries) {
          return Array.from(dt.files || []).map((file) => ({ file, folder: '' }))
        }

        const readEntry = async (entry, folder) => {
          if (!entry) return
          if (entry.isFile) {
            const file = await new Promise((resolve) => {
              try {
                entry.file(resolve, () => resolve(null))
              } catch {
                resolve(null)
              }
            })
            if (file) out.push({ file, folder })
            return
          }
          if (entry.isDirectory) {
            const reader = entry.createReader()
            const children = []
            // readEntries 一次最多返回一批（Chrome 100 条），要一直读到空为止
            for (;;) {
              const batch = await new Promise((resolve) => {
                try {
                  reader.readEntries(resolve, () => resolve([]))
                } catch {
                  resolve([])
                }
              })
              if (!batch || batch.length === 0) break
              children.push(...batch)
            }
            const name = folder || entry.name || ''
            for (const child of children) await readEntry(child, name)
          }
        }

        for (const item of items) {
          if (typeof item.webkitGetAsEntry !== 'function') continue
          const entry = item.webkitGetAsEntry()
          await readEntry(entry, '')
        }
        if (out.length === 0) return Array.from(dt.files || []).map((file) => ({ file, folder: '' }))
        return out
      }, [])

      const uploadFiles = useCallback(
        async (pairs) => {
          const list = Array.isArray(pairs) ? pairs : []
          if (list.length === 0) return
          const tooBig = list.filter((pair) => pair.file.size > MAX_BYTES)
          const ok = list.filter((pair) => pair.file.size <= MAX_BYTES)
          const refused = tooBig.length > 0 ? `${t('refusedOnly')}${tooBig.map((pair) => pair.file.name).join('、')}` : ''
          if (refused) setBanner(refused)
          let done = 0
          for (const pair of ok) {
            const success = await uploadOne(pair)
            if (success) done += 1
          }
          if (alive.current) {
            // 「已上传 N 个」不能把「这些文件太大被跳过」盖掉，两条拼起来显示。
            const uploaded = ok.length > 0 ? t('uploaded', done) : ''
            if (refused || uploaded) setBanner([refused, uploaded].filter(Boolean).join('　·　'))
            setQuery('')
            setFilter('')
            await load('', '')
          }
        },
        [load, uploadOne, t]
      )

      const onPick = useCallback(
        (event) => {
          const files = Array.from(event.target.files || []).map((file) => ({ file, folder: '' }))
          void uploadFiles(files)
          if (inputRef.current) inputRef.current.value = ''
        },
        [uploadFiles]
      )

      const onDrop = useCallback(
        (event) => {
          event.preventDefault()
          setOver(false)
          void (async () => {
            const pairs = await collectDropped(event.dataTransfer)
            await uploadFiles(pairs)
          })()
        },
        [collectDropped, uploadFiles]
      )

      const remove = useCallback(async (id) => {
        try {
          const res = await fetch(`${ROUTE}/item?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          if (alive.current) {
            setPendingDelete('')
            setSelected((prev) => prev.filter((entry) => entry !== id))
          }
          await load(query, filter)
        } catch (err) {
          if (alive.current) setError(t('errorPrefix') + (err && err.message ? err.message : String(err)))
        }
      }, [filter, load, query])

      const saveTags = useCallback(async (id, raw) => {
        const tags = String(raw || '')
          .split(/[,，]/)
          .map((tag) => tag.trim())
          .filter(Boolean)
        try {
          const res = await fetch(`${ROUTE}/item?id=${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tags })
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          if (alive.current) setTagEdit(null)
          await load(query, filter)
        } catch (err) {
          if (alive.current) setError(t('errorPrefix') + (err && err.message ? err.message : String(err)))
        }
      }, [filter, load, query])

      const toggleSelected = useCallback((id) => {
        setSelected((prev) => (prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id]))
      }, [])

      const downloadSelected = useCallback(async () => {
        const all = selected.slice()
        if (all.length === 0) return
        // 服务端一次最多打包 MAX_BUNDLE 个，这里先截断并说清楚，别让人以为全打进去了。
        const ids = all.slice(0, MAX_BUNDLE)
        try {
          const res = await fetch(`${ROUTE}/bundle`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ids })
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const blob = await res.blob()
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = `本地资料库-${new Date().toISOString().slice(0, 10)}.zip`
          document.body.appendChild(link)
          link.click()
          link.remove()
          setTimeout(() => URL.revokeObjectURL(url), 4000)
          if (alive.current) setBanner(all.length > ids.length ? t('zipCapped', ids.length, MAX_BUNDLE) : t('zipDone', ids.length))
        } catch (err) {
          if (alive.current) setError(t('errorPrefix') + (err && err.message ? err.message : String(err)))
        }
      }, [selected, t])

      const reindexAll = useCallback(async () => {
        setReindexing(true)
        try {
          const res = await fetch(`${ROUTE}/reindex?all=1`, { method: 'POST' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = await res.json()
          if (alive.current) setBanner(t('reindexQueued', Number(data.queued) || 0))
        } catch (err) {
          if (alive.current) setError(t('errorPrefix') + (err && err.message ? err.message : String(err)))
        } finally {
          if (alive.current) setReindexing(false)
        }
      }, [t])

      const copyPath = useCallback(async () => {
        const path = stats && stats.root ? stats.root : ''
        if (!path) return
        try {
          await navigator.clipboard.writeText(path)
          setCopied(true)
          setTimeout(() => {
            if (alive.current) setCopied(false)
          }, 1500)
        } catch {
          /* 剪贴板不可用就静默 */
        }
      }, [stats])

      const submitSearch = useCallback(
        (event) => {
          event.preventDefault()
          void load(query, filter)
        },
        [filter, load, query]
      )

      const pickFilter = useCallback(
        (kind) => {
          setFilter(kind)
          void load(query, kind)
        },
        [load, query]
      )

      const rows = items.map((item) => {
        const metaBits = [
          formatBytes(item.size),
          item.indexed ? (item.textChars > 0 ? `${item.textChars} 字 ${t('indexed')}` : t('noText')) : t('indexing'),
          formatDate(item.createdAt)
        ].filter(Boolean)
        const checked = selected.indexOf(item.id) >= 0
        const tags = Array.isArray(item.tags) ? item.tags : []
        return h(
          'div',
          { className: 'll-row', key: item.id },
          h('input', {
            className: 'll-sel',
            type: 'checkbox',
            checked: checked,
            title: t('selectOne'),
            onChange: () => toggleSelected(item.id)
          }),
          h(
            'div',
            { className: 'll-main' },
            h('div', { className: 'll-name', title: item.name }, item.name),
            h(
              'div',
              { className: 'll-meta' },
              h('span', { className: 'll-kind' }, String(item.kind || 'file')),
              metaBits.map((bit, index) => h('span', { key: `m${index}` }, bit)),
              item.addedBy === 'agent' ? h('span', null, t('agentSaved')) : null
            ),
            tags.length > 0 && !(tagEdit && tagEdit.id === item.id)
              ? h(
                  'div',
                  { className: 'll-tags' },
                  tags.map((tag, index) => h('span', { className: 'll-tag', key: `t${index}` }, tag))
                )
              : null,
            tagEdit && tagEdit.id === item.id
              ? h('input', {
                  className: 'll-input ll-taggedit',
                  value: tagEdit.value,
                  autoFocus: true,
                  placeholder: t('tagsPlaceholder'),
                  onChange: (event) => setTagEdit({ id: item.id, value: event.target.value }),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      tagAbort.current = false
                      void saveTags(item.id, tagEdit.value)
                    }
                    if (event.key === 'Escape') {
                      // 取消：先立标记，blur 就不会把旧值存回去
                      tagAbort.current = true
                      setTagEdit(null)
                    }
                  },
                  onBlur: () => {
                    if (tagAbort.current) {
                      tagAbort.current = false
                      return
                    }
                    void saveTags(item.id, tagEdit.value)
                  }
                })
              : null,
            item.snippet
              ? h('div', { className: 'll-snippet' }, item.snippet)
              : item.matchedBy === 'name'
                ? h('div', { className: 'll-snippet ll-snippet-tag' }, t('hitByName'))
                : null
          ),
          h(
            'div',
            { className: 'll-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'll-btn tiny',
                title: t('editTags'),
                onClick: () => setTagEdit({ id: item.id, value: tags.join(', ') })
              },
              t('tags')
            ),
            h(
              'a',
              {
                className: 'll-btn tiny',
                href: `${ROUTE}/download?id=${encodeURIComponent(item.id)}`,
                download: item.name,
                title: t('download')
              },
              t('download')
            ),
            h(
              'button',
              {
                type: 'button',
                className: pendingDelete === item.id ? 'll-btn tiny danger' : 'll-btn tiny',
                onClick: () => {
                  if (pendingDelete === item.id) void remove(item.id)
                  else setPendingDelete(item.id)
                }
              },
              pendingDelete === item.id ? t('confirmRemove') : t('remove')
            )
          )
        )
      })

      const filterChips = FILTER_KINDS.map(([kind, label]) =>
        h(
          'button',
          {
            type: 'button',
            key: kind || 'all',
            className: filter === kind ? 'll-chip on' : 'll-chip',
            onClick: () => pickFilter(kind)
          },
          t(label)
        )
      )

      return h(
        'div',
        { className: 'll-root' },
        h(
          'div',
          { className: 'll-head' },
          h('h2', { className: 'll-title' }, t('title')),
          h('p', { className: 'll-sub' }, t('subtitle'))
        ),

        h(
          'div',
          {
            className: over ? 'll-drop over' : 'll-drop',
            onClick: () => inputRef.current && inputRef.current.click(),
            onDragOver: (event) => {
              event.preventDefault()
              setOver(true)
            },
            onDragLeave: () => setOver(false),
            onDrop: onDrop,
            role: 'button',
            tabIndex: 0
          },
          h('div', { className: 'll-drop-main' }, t('drop')),
          h('div', { className: 'll-drop-hint' }, t('dropHint')),
          h('input', {
            ref: inputRef,
            type: 'file',
            multiple: true,
            style: { display: 'none' },
            onChange: onPick
          })
        ),

        queue.length > 0
          ? h(
              'div',
              { className: 'll-queue' },
              queue.map((entry) =>
                h(
                  'div',
                  { key: entry.key },
                  h('div', { className: 'll-meta' }, `${t('uploading')} · ${entry.name} · ${entry.pct}%`),
                  h('div', { className: 'll-track' }, h('div', { className: 'll-fill', style: { width: `${entry.pct}%` } }))
                )
              )
            )
          : null,

        dupPrompt
          ? h(
              'div',
              { className: 'll-dupe' },
              h('div', null, t('dupeTitle', dupPrompt.fileName, dupPrompt.existing ? dupPrompt.existing.name : '')),
              h(
                'div',
                { className: 'll-bar' },
                h('button', { type: 'button', className: 'll-btn tiny primary', onClick: () => dupPrompt.answer('replace') }, t('dupeReplace')),
                h('button', { type: 'button', className: 'll-btn tiny', onClick: () => dupPrompt.answer('keep') }, t('dupeKeep')),
                h('button', { type: 'button', className: 'll-btn tiny', onClick: () => dupPrompt.answer('skip') }, t('dupeSkip'))
              )
            )
          : null,

        h(
          'form',
          { className: 'll-bar', onSubmit: submitSearch },
          h('input', {
            className: 'll-input',
            value: query,
            placeholder: t('search'),
            onChange: (event) => setQuery(event.target.value)
          }),
          h('button', { className: 'll-btn primary', type: 'submit' }, t('searchBtn')),
          h(
            'button',
            {
              className: 'll-btn',
              type: 'button',
              onClick: () => {
                setQuery('')
                setFilter('')
                setBanner('')
                void load('', '')
              }
            },
            t('refresh')
          )
        ),

        h(
          'div',
          { className: 'll-chips' },
          filterChips,
          h(
            'label',
            {
              className: `ll-strict${matchMode === 'strict' ? ' on' : ''}`,
              title: t('strictHint')
            },
            h('input', { type: 'checkbox', checked: matchMode === 'strict', onChange: () => toggleStrict() }),
            h('span', null, t('strict'))
          )
        ),

        selected.length > 0
          ? h(
              'div',
              { className: 'll-bar ll-selbar' },
              h('span', { className: 'll-meta' }, t('selectedCount', selected.length)),
              h('button', { type: 'button', className: 'll-btn tiny primary', onClick: () => void downloadSelected() }, t('zipSelected')),
              h('button', { type: 'button', className: 'll-btn tiny', onClick: () => setSelected([]) }, t('clearSelection'))
            )
          : null,

        error ? h('div', { className: 'll-err' }, error) : null,
        banner ? h('div', { className: 'll-meta' }, banner) : null,

        rows.length > 0
          ? h('div', { className: 'll-list' }, rows)
          : h('div', { className: 'll-empty' }, query || filter ? t('emptySearch') : t('empty')),

        h(
          'div',
          { className: 'll-foot' },
          h('span', null, stats ? t('count', stats.count) : ''),
          h('span', null, stats ? t('usage', stats.bytesText) : ''),
          h('span', null, stats ? t('indexedCount', stats.indexed) : ''),
          h(
            'button',
            { type: 'button', className: 'll-btn tiny', disabled: reindexing, onClick: () => void reindexAll() },
            reindexing ? t('reindexing') : t('reindex')
          ),
          stats && stats.root
            ? h(
                'span',
                null,
                `${t('storage')}：`,
                h('span', { className: 'll-path' }, stats.root),
                ' ',
                h('button', { className: 'll-btn tiny', type: 'button', onClick: copyPath }, copied ? t('copied') : t('copyPath'))
              )
            : null
        )
      )
    }
  }

  function makeFactory() {
    return (require) => {
      const module = { exports: {} }
      const react = require('react')
      const { useState, useEffect, useCallback, useRef } = react
      // 用 React.createElement 而不是 react/jsx-runtime 的 jsx：
      // jsx(type, props, key) 第三个参数是 key，写成 h(type, props, child1, child2) 会把
      // 第一个孩子当成 key、其余孩子全部丢掉，而且 props 传 null 在 dev 构建里还会抛错。
      // createElement 才有 (type, props, ...children) 的语义，和下面所有调用点一致。
      // 也不能用 const 局部变量遮蔽：makeSettings 定义在 IIFE 作用域，要读外层这个 h。
      h = react.createElement
      if (typeof h !== 'function') throw new Error('dsh-local-library: react 没有导出 createElement')

      const name = 'local-library'
      const inject = ['slots', 'locale']

      function apply(ctx) {
        injectCss(typeof document === 'undefined' ? undefined : document)

        // 界面语言：只看浏览器语言，不走 locale 服务的 bind（它的返回契约随版本变，
        // 这里不能赌；字典仍然注册给 DSH，供别处误用不到也不影响本页）。
        const language =
          typeof navigator !== 'undefined' && String(navigator.language || '').toLowerCase().startsWith('en') ? 'en' : 'zh'
        const dict = language === 'en' ? en : zh
        const t = (key, ...args) => {
          const value = dict[key]
          if (typeof value === 'function') return value(...args)
          return value !== undefined ? value : key
        }

        // 注册字典只是「免得别处复用接口时查不到」，失败绝不能连累设置分区本身。
        ctx.effect(() => {
          if (!ctx.locale || typeof ctx.locale.register !== 'function') return () => {}
          let dispose = undefined
          try {
            dispose = ctx.locale.register(NS, { zh, en })
          } catch (error) {
            console.warn('[dsh-local-library] locale.register failed:', error)
            return () => {}
          }
          return () => {
            try {
              if (typeof dispose === 'function') dispose()
            } catch {
              /* 语言包释放失败无副作用 */
            }
          }
        }, 'dsh-local-library: locale')

        const Section = makeSettings({ useState, useEffect, useCallback, useRef, t })

        ctx.slots.inject('settings.section', function* () {
          yield ctx.slots.register(
            {
              name: 'settings.section',
              id: 'local-library',
              order: 35,
              label: () => t('nav'),
              inject: () => ({ t })
            },
            Section
          )
        })

        ctx.effect(() => {
          try {
            return installNavIcon(() => t('nav'))
          } catch (error) {
            // 图标只是锦上添花，DOM 结构和 DSH 版本相关，失败就沿用默认齿轮。
            console.warn('[dsh-local-library] nav icon skipped:', error)
            return () => {}
          }
        }, 'dsh-local-library: settings nav icon')
      }

      module.exports = { apply, inject, name }
      return module.exports
    }
  }

  window.__ModuleLoader__.load({ id: 'dsh-local-library', factory: makeFactory() })
})()
