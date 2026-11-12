import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * AI 分析的本地配置。
 *
 * 为什么写文件而不是写库：`ai.json` 里会有 API Key，而 app.db 是会被备份、
 * 会被打包脚本检查的东西；把密钥混进持仓库，早晚会在某次 zip 里泄露。
 * 这里单独一个 0600 的文件，放在数据目录（与 db 同级），不进仓库。
 *
 * 优先级：文件 > 环境变量。文件为空时用 AI_BASE_URL / AI_MODEL / AI_API_KEY 兜底，
 * 方便 CI 或临时容器里不改设置页也能跑。
 */
export interface AiConfig {
  /** OpenAI 兼容端点，例如 https://api.deepseek.com/v1 */
  baseUrl: string
  /** 模型名，例如 deepseek-chat / gpt-4o-mini */
  model: string
  apiKey: string
}

const EMPTY: AiConfig = { baseUrl: '', model: '', apiKey: '' }

export function defaultAiConfigPath(dbPath: string): string {
  return join(dirname(dbPath), 'ai.json')
}

export function readAiConfig(file: string): AiConfig {
  let stored: Partial<AiConfig> = {}
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (typeof parsed === 'object' && parsed !== null) stored = parsed as Partial<AiConfig>
    } catch {
      // 文件坏了就当没配：分析面板会提示重新填，而不是让整个服务起不来
      stored = {}
    }
  }
  const pick = (key: keyof AiConfig, envKey: string): string => {
    const fromFile = stored[key]
    if (typeof fromFile === 'string' && fromFile.trim() !== '') return fromFile.trim()
    const fromEnv = process.env[envKey]
    return typeof fromEnv === 'string' ? fromEnv.trim() : ''
  }
  return {
    baseUrl: pick('baseUrl', 'AI_BASE_URL'),
    model: pick('model', 'AI_MODEL'),
    apiKey: pick('apiKey', 'AI_API_KEY'),
  }
}

/**
 * 写入配置。`apiKey` 传 undefined = 保留原值，传空串 = 清空。
 * 原子写（tmp → rename）+ 0600：中途断电不会留下半个 JSON，也不会被别人读到。
 */
export function writeAiConfig(file: string, patch: Partial<AiConfig>): AiConfig {
  const current = readAiConfig(file)
  const next: AiConfig = {
    baseUrl: (patch.baseUrl ?? current.baseUrl).trim(),
    model: (patch.model ?? current.model).trim(),
    apiKey: (patch.apiKey ?? current.apiKey).trim(),
  }
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
  return next
}

/** 密钥回显只给「前 3 + 后 4」，绝不整串返回给前端 */
export function maskKey(key: string): string {
  if (key === '') return ''
  if (key.length <= 8) return '••••••'
  return `${key.slice(0, 3)}…${key.slice(-4)}`
}

export function isConfigured(config: AiConfig): boolean {
  return config.baseUrl !== '' && config.model !== '' && config.apiKey !== ''
}

/** 端点清洗：去掉末尾斜杠，只接受 http/https */
export function normalizeBaseUrl(raw: string): string | null {
  const text = raw.trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s]+$/i.test(text)) return null
  return text
}

export { EMPTY as EMPTY_AI_CONFIG }
