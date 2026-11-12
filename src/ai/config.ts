import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * AI 端点的本地配置（多配置档案）。
 *
 * 为什么写文件而不是写库：`ai.json` 里会有 API Key，而 app.db 会被备份、会被
 * 打包脚本检查；把密钥混进持仓库，早晚会在某次 zip 里泄露。这里单独一个 0600
 * 的文件，与 db 同级，不进仓库。
 *
 * 结构（v2）：
 *   { activeId, profiles: [{ id, name, baseUrl, model, apiKey }] }
 * 旧版是扁平的单配置 `{ baseUrl, model, apiKey }`，读取时自动包成一条「默认」档案；
 * 环境变量 AI_BASE_URL / AI_MODEL / AI_API_KEY 只在完全没有档案时兜底。
 */
export interface AiProfile {
  id: string
  name: string
  /** OpenAI 兼容端点，例如 https://api.deepseek.com/v1 */
  baseUrl: string
  model: string
  apiKey: string
}

export interface AiStore {
  activeId: string
  profiles: AiProfile[]
}

export function defaultAiConfigPath(dbPath: string): string {
  return join(dirname(dbPath), 'ai.json')
}

function sanitizeProfile(raw: unknown, index: number): AiProfile | null {
  if (typeof raw !== 'object' || raw === null) return null
  const row = raw as Record<string, unknown>
  const id = typeof row.id === 'string' && row.id.trim() !== '' ? row.id.trim() : `p-${index + 1}`
  const name =
    typeof row.name === 'string' && row.name.trim() !== '' ? row.name.trim().slice(0, 40) : `配置 ${index + 1}`
  const baseUrl = typeof row.baseUrl === 'string' ? row.baseUrl.trim() : ''
  const model = typeof row.model === 'string' ? row.model.trim() : ''
  const apiKey = typeof row.apiKey === 'string' ? row.apiKey.trim() : ''
  return { id, name, baseUrl, model, apiKey }
}

function fromEnv(): AiProfile | null {
  const baseUrl = (process.env.AI_BASE_URL ?? '').trim()
  const model = (process.env.AI_MODEL ?? '').trim()
  const apiKey = (process.env.AI_API_KEY ?? '').trim()
  if (baseUrl === '' && model === '' && apiKey === '') return null
  return { id: 'env', name: '环境变量', baseUrl, model, apiKey }
}

export function readAiStore(file: string): AiStore {
  let parsed: unknown = null
  if (existsSync(file)) {
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      // 文件坏了就当没配：分析面板提示重新填，而不是让服务起不来
      parsed = null
    }
  }

  if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { profiles?: unknown }).profiles)) {
    const raw = parsed as { profiles: unknown[]; activeId?: unknown }
    const profiles = raw.profiles
      .map((item, index) => sanitizeProfile(item, index))
      .filter((item): item is AiProfile => item !== null)
    if (profiles.length > 0) {
      const activeId =
        typeof raw.activeId === 'string' && profiles.some((p) => p.id === raw.activeId)
          ? raw.activeId
          : profiles[0]!.id
      return { activeId, profiles }
    }
  }

  // 旧版单配置 → 一条档案
  if (typeof parsed === 'object' && parsed !== null) {
    const legacy = parsed as Record<string, unknown>
    if (
      typeof legacy.baseUrl === 'string' ||
      typeof legacy.model === 'string' ||
      typeof legacy.apiKey === 'string'
    ) {
      const profile: AiProfile = {
        id: 'default',
        name: '默认',
        baseUrl: typeof legacy.baseUrl === 'string' ? legacy.baseUrl.trim() : '',
        model: typeof legacy.model === 'string' ? legacy.model.trim() : '',
        apiKey: typeof legacy.apiKey === 'string' ? legacy.apiKey.trim() : '',
      }
      if (profile.baseUrl !== '' || profile.model !== '' || profile.apiKey !== '') {
        return { activeId: profile.id, profiles: [profile] }
      }
    }
  }

  const env = fromEnv()
  return env === null ? { activeId: '', profiles: [] } : { activeId: env.id, profiles: [env] }
}

export function writeAiStore(file: string, store: AiStore): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}

export function activeProfile(store: AiStore): AiProfile | null {
  return store.profiles.find((profile) => profile.id === store.activeId) ?? store.profiles[0] ?? null
}

export function newProfileId(): string {
  return `p-${randomUUID().slice(0, 8)}`
}

/** 密钥回显只给「前 3 + 后 4」，绝不整串返回给前端 */
export function maskKey(key: string): string {
  if (key === '') return ''
  if (key.length <= 8) return '••••••'
  return `${key.slice(0, 3)}…${key.slice(-4)}`
}

export function isConfigured(config: Pick<AiProfile, 'baseUrl' | 'model' | 'apiKey'>): boolean {
  return config.baseUrl !== '' && config.model !== '' && config.apiKey !== ''
}

/** 端点清洗：去掉末尾斜杠，只接受 http/https */
export function normalizeBaseUrl(raw: string): string | null {
  const text = raw.trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s]+$/i.test(text)) return null
  return text
}
