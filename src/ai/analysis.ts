import type { AiConfig } from './config'
import type { AnalysisSnapshot } from './snapshot'

/**
 * 提示词与输出解析。
 *
 * 两个硬约束写死在 system 里：
 * 1. **不许自己算数**——所有数字必须原样引用快照，算错了没人能发现；
 * 2. **不许给买卖建议**——这是估值工具，不是投顾。
 *
 * 输出用 JSON 而不是 markdown：前端要把「结论 / 归因 / 风险 / 待核对」分块渲染，
 * 让模型吐自由文本再解析标题，等于把格式稳定性交给概率。
 */

export interface AnalysisDriver {
  label: string
  detail: string
}

export interface Analysis {
  headline: string
  summary: string[]
  drivers: AnalysisDriver[]
  risks: string[]
  watch: string[]
}

export const DISCLAIMER = '以上是对估算数据的解读，不构成投资建议；申赎请以基金公司公告为准。'

const SYSTEM_PROMPT = [
  '你是「QDII 估值」看板里的持仓复盘助手。用户持有的是投资美股/海外市场的 QDII 基金。',
  '你只会收到一份 JSON 快照，里面的数字都由估值引擎算好。规则：',
  '1. 只解读快照，不引入任何外部事实（不要提快照里没有的股价、新闻或宏观数据）。',
  '2. 所有数字必须原样引用快照字段，不要做新的计算或换算；需要比较时只做定性描述。',
  '3. 快照里 coveredWeight=0 的基金表示当天没有可用行情，必须说明“无行情”，不能当成 0%。',
  '4. phase=pre 表示盘前、live 表示盘中、settled 表示美股已收盘待公布净值；措辞要与相位一致。',
  '5. 数据不足时写“数据不足”，不要猜。',
  '6. 不做买卖建议、不给目标价、不预测涨跌。',
  '7. 只输出 JSON，不要 markdown 代码块，不要多余解释。',
  '',
  'JSON 结构：',
  '{"headline":"一句话结论，40字以内",',
  ' "summary":["3-5条要点，每条40字以内"],',
  ' "drivers":[{"label":"贡献或拖累来源","detail":"引用快照数字说明，60字以内"}],',
  ' "risks":["1-3条风险，40字以内"],',
  ' "watch":["1-3条接下来值得核对的事，40字以内"]}',
].join('\n')

/** 把快照铺成给模型看的文本；保持字段名，方便它在回答里引用 */
export function buildMessages(snapshot: AnalysisSnapshot): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `这是当前持仓快照（JSON）：\n${JSON.stringify(snapshot, null, 2)}\n\n请按结构输出 JSON。`,
    },
  ]
}

function asStringArray(value: unknown, limit: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, maxLen))
    .filter((item) => item !== '')
    .slice(0, limit)
}

function asDrivers(value: unknown, limit: number): AnalysisDriver[] {
  if (!Array.isArray(value)) return []
  const out: AnalysisDriver[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const label = typeof row.label === 'string' ? row.label.trim().slice(0, 30) : ''
    const detail = typeof row.detail === 'string' ? row.detail.trim().slice(0, 120) : ''
    if (label === '' || detail === '') continue
    out.push({ label, detail })
    if (out.length >= limit) break
  }
  return out
}

/**
 * 解析模型输出。允许外面裹着 ```json 代码块（不少兼容端点会自作主张加），
 * 其余情况一律按「不合规」处理——宁可让界面显示"分析暂不可用"，
 * 也不要把半截 JSON 或一段散文塞进结构化卡片。
 */
export function parseAnalysis(text: string): Analysis | null {
  const trimmed = text.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return null

  let payload: unknown
  try {
    payload = JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null) return null
  const raw = payload as Record<string, unknown>

  const headline = typeof raw.headline === 'string' ? raw.headline.trim().slice(0, 120) : ''
  const summary = asStringArray(raw.summary, 6, 120)
  if (headline === '' && summary.length === 0) return null

  return {
    headline,
    summary,
    drivers: asDrivers(raw.drivers, 6),
    risks: asStringArray(raw.risks, 5, 120),
    watch: asStringArray(raw.watch, 5, 120),
  }
}

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

export interface ChatOptions {
  maxTokens?: number
  /** 兼容端点不一定支持 response_format，第一次 400 后会自动去掉重试 */
  jsonMode?: boolean
  timeoutMs?: number
  /** 输出被截断（finish_reason=length）时是否自动翻倍重试；ping 这类小请求可关掉 */
  retryOnTruncation?: boolean
  fetchFn?: typeof fetch
}

/**
 * 调 OpenAI 兼容的 /chat/completions。
 *
 * 只接受 `choices[0].message.content` 为字符串（或内容分段数组）的常规形状；
 * 超时用 AbortSignal.timeout，绝不无限挂起——分析卡可以转圈，服务不能被拖住。
 */
const MAX_OUTPUT_TOKENS = 8192

function extractContent(payload: unknown): string {
  const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices
  const content = choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('')
  }
  return ''
}

export async function chatCompletion(
  config: AiConfig,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<string> {
  const fetchFn = options.fetchFn ?? fetch
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`

  async function call(maxTokens: number): Promise<{ content: string; finish: string }> {
    const baseBody: Record<string, unknown> = {
      model: config.model,
      messages,
      temperature: 0.2,
      max_tokens: maxTokens,
    }
    const withJsonMode = options.jsonMode === false ? baseBody : { ...baseBody, response_format: { type: 'json_object' } }

    let res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(withJsonMode),
      signal: AbortSignal.timeout(options.timeoutMs ?? 45_000),
    })
    if (!res.ok && res.status === 400 && options.jsonMode !== false) {
      // 端点不认 response_format：去掉再来一次。很多自建服务就是这样。
      res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(baseBody),
        signal: AbortSignal.timeout(options.timeoutMs ?? 45_000),
      })
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`AI 接口 HTTP ${res.status}${detail === '' ? '' : `：${detail.slice(0, 160)}`}`)
    }
    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>
    }
    return {
      content: extractContent(payload),
      finish: payload.choices?.[0]?.finish_reason ?? '',
    }
  }

  const maxTokens = options.maxTokens ?? 4096
  const first = await call(maxTokens)
  /**
   * 推理型模型（deepseek-v4.1-flash 这类）会先把 token 花在 reasoning_content 上：
   * max_tokens 只给 1100 时，思考正好把它吃满，`content` 是空串、finish_reason=length。
   * 这不是「模型不听话」，是预算不够。翻倍重试一次，仍不行再报明确的错。
   */
  const truncated = first.finish === 'length' || first.content.trim() === ''
  if (options.retryOnTruncation !== false && truncated && maxTokens < MAX_OUTPUT_TOKENS) {
    const second = await call(Math.min(MAX_OUTPUT_TOKENS, maxTokens * 2))
    if (second.content.trim() !== '' && second.finish !== 'length') return second.content
    if (second.content.trim() === '') {
      throw new Error('模型只输出了思考过程（输出上限被推理用尽）；换一个非推理模型再试')
    }
    return second.content
  }
  if (first.content.trim() === '') {
    throw new Error('模型没有返回正文（可能把输出上限都用在思考上）；换一个非推理模型再试')
  }
  return first.content
}
