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

export interface AnalysisScenario {
  name: string
  trigger: string
  implication: string
}

export interface AnalysisConfidence {
  level: '低' | '中' | '高'
  reason: string
}

export interface AnalysisVerdict {
  stance: '偏多' | '偏空' | '中性' | '谨慎'
  horizon: string
  reason: string
}

export interface AnalysisAdvice {
  action: string
  condition: string
  reason: string
}

export interface Analysis {
  headline: string
  summary: string[]
  drivers: AnalysisDriver[]
  /** 事件 → 持仓的关联（news[].related 已经算好命中哪些 symbol） */
  events: AnalysisEvent[]
  scenarios: AnalysisScenario[]
  risks: string[]
  dataGaps: string[]
  confidence: AnalysisConfidence | null
  watch: string[]
  /** 2-3 句总结：先给倾向，再给依据 */
  conclusion: string
  /** 倾向性判断（不是承诺） */
  verdict: AnalysisVerdict | null
  /** 条件化建议：action + 触发条件 + 依据 */
  advice: AnalysisAdvice[]
}

export const DISCLAIMER = '以上是对估算数据的解读，不构成投资建议；申赎请以基金公司公告为准。'

const SYSTEM_PROMPT = [
  '你是一名给基金经理写「盘前/盘中简报」的组合分析师。读者已经知道自己的持仓，',
  '他要的是：发生了什么、钱从哪来、哪里不对劲、接下来看什么。不要复述界面。',
  '',
  '分析框架（内部执行，不要输出步骤）：',
  '1. 先定基准：读 clock 与 phase；indices[].asOf / stocks[].asOf 为「上一交易日收盘」时，',
  '   那些涨跌属于上一场，绝不能写成今天盘前。今天盘前的变动只在 funds[].pct（相对昨收）。',
  '2. 组合层：看 analytics.concentration（前 3/前 5 权重）、analytics.coverage（覆盖基金数与市值占比）、',
  '   fxImpactPp（汇率对当日估算的 pp 贡献）、totalAmountPct 与 totalHoldingPct 的差异。',
  '3. 归因：用 analytics.topContributors / topDetractors 的 contributionPp 说明「谁贡献了几个 pp」，',
  '   再对应到板块（boards）与个股（stocks）；不要只说“半导体上涨”，要给出权重、涨跌与 pp。',
  '4. 事件：news[].related 是标题直接命中的持仓 symbol；没有命中但明显对应 boards 的，按板块层面写。',
  '   判断事件是利好/利空/中性，以及是否已经被上一场或盘前价格反映。',
  '5. 情景：基准/乐观/悲观三档，每档给一个可观察的触发条件（盘前幅度扩大、开盘方向、汇率、事件落地）。',
  '   在情景之上给一个倾向性判断（偏多/偏空/中性/谨慎）与时间尺度（今日开盘 / 未来 1-3 个交易日）。',
  '6. 证伪：列出会推翻当前判断的信号，以及数据缺口（coveredWeight 低、无行情的基金）。',
  '',
  '硬约束：',
  '- 只解读快照，不引入快照之外的事实（不要提快照里没有的股价、财报或宏观数据）。',
  '- 所有数字原样引用快照字段，不做新计算；引用保留两位小数。',
  '- coveredWeight=0 的基金必须说“无行情”；coveredWeight 明显小于 1 的基金要提示估值不完整。',
  '- 可以给倾向性判断与条件化建议，但必须：给出依据、写清触发条件、标注时间尺度；',
  '  不承诺收益、不编造目标价、不把情景当成确定性预测。',
  '- 数据不足写“数据不足”，不要猜。',
  '- 只输出 JSON，不要 markdown 代码块，不要多余解释。',
  '',
  'JSON 结构：',
  '{"headline":"一句话结论，40字以内，必须带方向与幅度",',
  ' "conclusion":"2-3句总结：先倾向，再最关键的两条依据，100字以内",',
  ' "verdict":{"stance":"偏多|偏空|中性|谨慎","horizon":"今日开盘|未来1-3个交易日","reason":"60字以内"},',
  ' "advice":[{"action":"观望|持有|分批减|分批加|对冲|设条件单","condition":"触发条件","reason":"依据，60字以内"}],',
  ' "summary":["5-7条要点，每条60字以内，至少三条带数字"],',
  ' "drivers":[{"label":"贡献/拖累来源（个股或板块）","detail":"权重、涨跌、贡献 pp，100字以内"}],',
  ' "events":[{"title":"news 标题原文","impact":"影响哪些持仓、方向、是否已被定价，80字以内"}],',
  ' "scenarios":[{"name":"基准|乐观|悲观","trigger":"可观察的触发条件","implication":"对组合的含义，60字以内"}],',
  ' "risks":["2-4条风险，每条60字以内"],',
  ' "dataGaps":["1-4条数据缺口，60字以内"],',
  ' "confidence":{"level":"低|中|高","reason":"为什么是这个置信度，60字以内"},',
  ' "watch":["2-4条接下来核对的事，每条60字以内"]}',
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

function asScenarios(value: unknown, limit: number): AnalysisScenario[] {
  if (!Array.isArray(value)) return []
  const out: AnalysisScenario[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const name = typeof row.name === 'string' ? row.name.trim().slice(0, 10) : ''
    const trigger = typeof row.trigger === 'string' ? row.trigger.trim().slice(0, 120) : ''
    const implication = typeof row.implication === 'string' ? row.implication.trim().slice(0, 100) : ''
    if (name === '' || trigger === '' || implication === '') continue
    out.push({ name, trigger, implication })
    if (out.length >= limit) break
  }
  return out
}

function asVerdict(value: unknown): AnalysisVerdict | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  const stance = typeof row.stance === 'string' ? row.stance.trim() : ''
  const horizon = typeof row.horizon === 'string' ? row.horizon.trim().slice(0, 30) : ''
  const reason = typeof row.reason === 'string' ? row.reason.trim().slice(0, 120) : ''
  if (stance !== '偏多' && stance !== '偏空' && stance !== '中性' && stance !== '谨慎') return null
  return { stance, horizon, reason }
}

function asAdvice(value: unknown, limit: number): AnalysisAdvice[] {
  if (!Array.isArray(value)) return []
  const out: AnalysisAdvice[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const action = typeof row.action === 'string' ? row.action.trim().slice(0, 20) : ''
    const condition = typeof row.condition === 'string' ? row.condition.trim().slice(0, 120) : ''
    const reason = typeof row.reason === 'string' ? row.reason.trim().slice(0, 120) : ''
    if (action === '' || condition === '' || reason === '') continue
    out.push({ action, condition, reason })
    if (out.length >= limit) break
  }
  return out
}

function asConfidence(value: unknown): AnalysisConfidence | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  const level = typeof row.level === 'string' ? row.level.trim() : ''
  const reason = typeof row.reason === 'string' ? row.reason.trim().slice(0, 120) : ''
  if (level !== '低' && level !== '中' && level !== '高') return null
  return { level, reason }
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
    scenarios: asScenarios(raw.scenarios, 4),
    risks: asStringArray(raw.risks, 5, 120),
    dataGaps: asStringArray(raw.dataGaps, 5, 120),
    confidence: asConfidence(raw.confidence),
    watch: asStringArray(raw.watch, 5, 120),
    conclusion: typeof raw.conclusion === 'string' ? raw.conclusion.trim().slice(0, 300) : '',
    verdict: asVerdict(raw.verdict),
    advice: asAdvice(raw.advice, 4),
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
