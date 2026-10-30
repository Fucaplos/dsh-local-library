/**
 * 图片入库时生成一段文字描述，让"搜文字"也能搜到图片。
 *
 * 走 OpenAI 兼容的 chat/completions（默认智谱 glm-4v-flash，免费档），
 * 端点、模型、key 全部来自插件配置；没配就不启用，上传照常但只按文件名检索。
 *
 * 返回 null 表示"这次没生成描述"，调用方只在 note 里记一句，不影响入库。
 */

const DEFAULT_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
const DEFAULT_MODEL = 'glm-4v-flash'
/** 各家 base64 都有上限，超过就直接放弃（图片本身仍然能下载）。 */
const MAX_INLINE_BYTES = 4 * 1024 * 1024
const TIMEOUT_MS = 45000

const MIME_OK = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'])

const PROMPT = [
  '你在给一个本地资料库做图片索引。请用中文描述这张图片，供别人只用关键词检索时能搜到它。',
  '要求：',
  '1. 第一句说清它是什么（照片/截图/表格/图表/流程图/海报/手写等）和主题。',
  '2. 有文字就把文字原样抄下来（尤其是标题、表头、关键数字、按钮文案），不要总结成"一些文字"。',
  '3. 有数据就说明指标与关键数值；有结构就说明分了几块、各块是什么。',
  '4. 4 到 12 句，不要客套，不要 Markdown 标题。'
].join('\n')

export function normalizeVisionConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const apiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : ''
  return {
    enabled: cfg.enabled === true && apiKey.length > 0,
    endpoint: typeof cfg.endpoint === 'string' && cfg.endpoint ? cfg.endpoint : DEFAULT_ENDPOINT,
    model: typeof cfg.model === 'string' && cfg.model ? cfg.model : DEFAULT_MODEL,
    apiKey,
    timeoutMs: Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : TIMEOUT_MS,
    prompt: typeof cfg.prompt === 'string' && cfg.prompt ? cfg.prompt : PROMPT
  }
}

/**
 * @param {Buffer} data 图片原始字节
 * @param {string} mime
 * @param {object} cfg normalizeVisionConfig 的返回值
 * @returns {Promise<{text: string}|{error: string}|null>}
 */
export async function describeImage(data, mime, cfg) {
  if (!cfg?.enabled) return null
  if (!Buffer.isBuffer(data) || data.length === 0) return { error: '图片为空' }
  if (data.length > MAX_INLINE_BYTES) {
    return { error: `图片超过 ${Math.round(MAX_INLINE_BYTES / 1048576)}MB，未做视觉描述` }
  }
  if (!MIME_OK.has(String(mime || '').toLowerCase())) {
    return { error: `暂不支持为该类型生成描述（${mime || '未知'}）` }
  }

  const body = {
    model: cfg.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mime};base64,${data.toString('base64')}` } },
          { type: 'text', text: cfg.prompt }
        ]
      }
    ]
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
  try {
    const response = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    const text = await response.text()
    if (!response.ok) return { error: `视觉接口 ${response.status}：${text.slice(0, 200)}` }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return { error: '视觉接口返回的不是 JSON' }
    }
    const content = parsed?.choices?.[0]?.message?.content
    const joined = Array.isArray(content)
      ? content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('')
      : String(content || '')
    const clean = joined.trim()
    if (!clean) return { error: '视觉接口返回空描述' }
    return { text: clean }
  } catch (error) {
    if (error?.name === 'AbortError') return { error: '视觉接口超时' }
    return { error: `视觉接口失败：${String(error?.message || error).slice(0, 200)}` }
  } finally {
    clearTimeout(timer)
  }
}
