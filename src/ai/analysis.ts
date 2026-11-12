import type { AiProfile } from './config'
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

export interface AnalysisEvent {
  title: string
  impact: string
}

export interface Analysis {
  headline: string
  summary: string[]
  drivers: AnalysisDriver[]
  /** 事件 → 持仓的关联（news[].related 已经算好命中哪些 symbol） */
  events: AnalysisEvent[]
  risks: string[]
  watch: string[]
}

export const DISCLAIMER = '以上是对估算数据的解读，不构成投资建议；申赎请以基金公司公告为准。'

const SYSTEM_PROMPT = [
  '你是「QDII 估值」看板里的持仓复盘助手。用户持有的是投资美股/海外市场的 QDII 基金。',
  '你只会收到一份 JSON 快照，里面的数字都由估值引擎算好。规则：',
  '1. 先读 clock 与 phase：clock.local 是北京时间、clock.et 是美东时间，clock.session 是阶段。',
  '2. 严格区分时段：indices[].asOf / stocks[].asOf 为「上一交易日收盘」时，那些涨跌属于上一场，',
  '   绝不能写成“今天盘前涨了 X%”。今天盘前的变动只在 funds[].pct（相对昨收）里。',
  '3. 只解读快照，不引入任何外部事实（不要提快照里没有的股价、新闻或宏观数据）。',
  '4. 所有数字必须原样引用快照字段，不要做新的计算或换算；需要比较时只做定性描述。',
  '   快照里的数字已按界面口径四舍五入，引用时保留两位小数即可，不要输出一长串浮点。',
  '5. coveredWeight=0 的基金表示当天没有可用行情，必须说明“无行情”，不能当成 0%；',
  '   coveredWeight 明显小于 1 的基金，要强调估值不完整。',
  '6. 事件归因：news[].related 已给出标题命中的持仓 symbol。优先挑 related 非空的新闻写进 events',
  '   （title 原样引用，impact 说明它影响哪些持仓、与哪些数字同向/反向）。',
  '   如果 related 都为空，但新闻与 boards 里的板块/指数明显相关（例如「费城半导体指数」对应纳指/半导体持仓），',
  '   也要写，并说明是板块层面而非个股直接命中；两者都没有才写“暂无与持仓直接相关的事件”，不要编造。',
  '7. 个股与指数要一起用：drivers 里优先解释“哪些个股/板块带动或拖累”，并引用权重与涨跌。',
  '8. 数据不足时写“数据不足”，不要猜。',
  '9. 不做买卖建议、不给目标价、不预测涨跌。',
  '10. 只输出 JSON，不要 markdown 代码块，不要多余解释。',
  '',
  'JSON 结构：',
  '{"headline":"一句话结论，40字以内",',
  ' "summary":["3-5条要点，每条40字以内"],',
  ' "drivers":[{"label":"贡献或拖累来源","detail":"引用快照数字说明，60字以内"}],',
  ' "events":[{"title":"news 里的标题原文","impact":"影响哪些持仓 symbol、与数字同向还是反向，60字以内"}],',
  ' "risks":["1-3条风险，40字以内"],',
  ' "watch":["1-3条接下来值得核对的事，40字以内"]}',
].join('\n')

/** 把快照铺成给模型看的文本；保持字段名，方便它在回答里引用 */
export function buildMessages(snapshot: AnalysisSnapshot): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `当前时间：${snapshot.clock.local}（北京）/ ${snapshot.clock.et}；阶段：${snapshot.clock.session}。`,
        snapshot.clock.note,
        '',
        '这是当前持仓快照（JSON）：',
        JSON.stringify(snapshot, null, 2),
        '',
        '请按结构输出 JSON。',
      ].join('\n'),
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

function asEvents(value: unknown, limit: number): AnalysisEvent[] {
  if (!Array.isArray(value)) return []
  const out: AnalysisEvent[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const title = typeof row.title === 'string' ? row.title.trim().slice(0, 120) : ''
    const impact = typeof row.impact === 'string' ? row.impact.trim().slice(0, 120) : ''
    if (title === '' || impact === '') continue
    out.push({ title, impact })
    if (out.length >= limit) break
  }
  return out
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
    events: asEvents(raw.events, 5),
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
  config: Pick<AiProfile, 'baseUrl' | 'model' | 'apiKey'>,
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

/**
 * 拉取端点声明的模型列表（GET /models，OpenAI 兼容）。
 *
 * 不同实现返回的形状不一样：标准是 `{data:[{id,...}]}`，也有直接给数组或字符串的。
 * 这里只做一件事——尽量把 id 捞出来、去重排序；捞不到就返回空数组，
 * 让界面提示「端点没有返回模型列表」，而不是报一个看不懂的解析错误。
 */
export async function listModels(
  config: Pick<AiProfile, 'baseUrl' | 'apiKey'>,
  options: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<string[]> {
  const fetchFn = options.fetchFn ?? fetch
  const url = `${config.baseUrl.replace(/\/+$/, '')}/models`
  const headers: Record<string, string> = {}
  if (config.apiKey !== '') headers.authorization = `Bearer ${config.apiKey}`
  const res = await fetchFn(url, {
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`获取模型列表失败：HTTP ${res.status}${detail === '' ? '' : `（${detail.slice(0, 120)}）`}`)
  }
  const payload = (await res.json()) as unknown
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown })?.data)
      ? ((payload as { data: unknown[] }).data)
      : []
  const ids: string[] = []
  for (const row of rows) {
    if (typeof row === 'string') {
      ids.push(row)
      continue
    }
    if (typeof row === 'object' && row !== null) {
      const id = (row as { id?: unknown }).id
      if (typeof id === 'string') ids.push(id)
    }
  }
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id !== ''))].sort((a, b) => a.localeCompare(b))
}
