import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  defaultAiConfigPath,
  isConfigured,
  maskKey,
  normalizeBaseUrl,
  readAiConfig,
  writeAiConfig,
  type AiConfig,
} from '../ai/config'
import { DISCLAIMER, buildMessages, chatCompletion, parseAnalysis, type Analysis } from '../ai/analysis'
import { parseSnapshot } from '../ai/snapshot'

/**
 * AI 分析的 HTTP 面。
 *
 * 四个端点，都在本机（或带口令的局域网）：
 *   GET  /api/ai/config   读配置（密钥只回 masked，永不回原文）
 *   PUT  /api/ai/config   写入 baseUrl / model / apiKey（写到 0600 的 ai.json）
 *   POST /api/ai/test     用 8 个 token 发一次 ping，验证端点与密钥
 *   POST /api/analysis    把界面上的快照交给模型，返回结构化解读
 *
 * 语义上的两个「故意」：
 *   · 配置与调用分离：没有配置时分析端点返回 400，前端据此整块提示去填，
 *     而不是发一个注定失败的请求；
 *   · 分析结果按 10 分钟缓存：行情 5 秒一跳，但「今天的归因」不需要跟着跳，
 *     用户可手动 refresh 强制重算。
 */
export interface AiRouteDeps {
  configPath?: string
  fetchFn?: typeof fetch
  now?: () => number
  ttlMs?: number
}

interface PublicConfig {
  baseUrl: string
  model: string
  hasKey: boolean
  maskedKey: string
  configured: boolean
}

function publicConfig(config: AiConfig): PublicConfig {
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    hasKey: config.apiKey !== '',
    maskedKey: maskKey(config.apiKey),
    configured: isConfigured(config),
  }
}

interface AnalysisPayload extends Analysis {
  model: string
  generatedAt: number
  cached: boolean
  disclaimer: string
}

export function registerAiRoutes(app: FastifyInstance, dbPath: string, deps: AiRouteDeps = {}): void {
  const configPath = deps.configPath ?? defaultAiConfigPath(dbPath)
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? 10 * 60_000
  const fetchFn = deps.fetchFn
  let cache: { key: string; at: number; payload: AnalysisPayload } | null = null

  app.get('/api/ai/config', async () => publicConfig(readAiConfig(configPath)))

  app.put<{ Body: { baseUrl?: unknown; model?: unknown; apiKey?: unknown } }>(
    '/api/ai/config',
    async (req, reply: FastifyReply) => {
      const body = req.body ?? {}
      const patch: Partial<AiConfig> = {}
      if (body.baseUrl !== undefined) {
        if (typeof body.baseUrl !== 'string') return reply.code(400).send({ error: 'baseUrl 必须是字符串' })
        const text = body.baseUrl.trim()
        if (text === '') {
          patch.baseUrl = ''
        } else {
          const normalized = normalizeBaseUrl(text)
          if (normalized === null) {
            return reply.code(400).send({ error: 'Base URL 必须是 http(s):// 开头的地址' })
          }
          patch.baseUrl = normalized
        }
      }
      if (body.model !== undefined) {
        if (typeof body.model !== 'string') return reply.code(400).send({ error: 'model 必须是字符串' })
        patch.model = body.model.trim()
      }
      if (body.apiKey !== undefined) {
        if (typeof body.apiKey !== 'string') return reply.code(400).send({ error: 'apiKey 必须是字符串' })
        patch.apiKey = body.apiKey.trim()
      }
      try {
        writeAiConfig(configPath, patch)
      } catch (err) {
        app.log.warn({ err }, 'ai config write failed')
        return reply.code(500).send({ error: '配置写入失败（检查数据目录权限）' })
      }
      // 配置变了，缓存的分析一定过期
      cache = null
      return publicConfig(readAiConfig(configPath))
    },
  )

  app.post('/api/ai/test', async (_req, reply) => {
    const config = readAiConfig(configPath)
    if (!isConfigured(config)) {
      return reply.code(400).send({ error: '还没有配置完整的 Base URL / 模型 / 密钥' })
    }
    const started = now()
    try {
      await chatCompletion(
        config,
        [{ role: 'user', content: '只回复 OK' }],
        { fetchFn, maxTokens: 8, jsonMode: false, retryOnTruncation: false, timeoutMs: 15_000 },
      )
      return { ok: true, model: config.model, ms: now() - started }
    } catch (err) {
      const message = err instanceof Error ? err.message : '连接失败'
      app.log.warn({ err }, 'ai test failed')
      return { ok: false, error: message.slice(0, 200) }
    }
  })

  app.post<{ Body: { snapshot?: unknown; refresh?: boolean } }>(
    '/api/analysis',
    async (req, reply) => {
      const config = readAiConfig(configPath)
      if (!isConfigured(config)) {
        return reply.code(400).send({ error: '还没有配置 AI：先填 Base URL、模型与密钥' })
      }

      const parsed = parseSnapshot(req.body?.snapshot)
      if (parsed.snapshot === undefined) {
        return reply.code(400).send({ error: parsed.error ?? '快照不合法' })
      }
      const snapshot = parsed.snapshot
      const key = `${snapshot.phase}:${Math.floor(now() / ttlMs)}`
      if (req.body?.refresh !== true && cache !== null && cache.key === key) {
        return { ...cache.payload, cached: true }
      }

      try {
        const text = await chatCompletion(config, buildMessages(snapshot), {
          fetchFn,
          maxTokens: 4096,
          timeoutMs: 60_000,
        })
        const analysis = parseAnalysis(text)
        if (analysis === null) {
          app.log.warn('ai analysis returned unparsable content')
          return reply.code(502).send({ error: '模型返回的不是约定结构，请换一个模型或重试' })
        }
        const payload: AnalysisPayload = {
          ...analysis,
          model: config.model,
          generatedAt: now(),
          cached: false,
          disclaimer: DISCLAIMER,
        }
        cache = { key, at: now(), payload }
        return payload
      } catch (err) {
        const message = err instanceof Error ? err.message : '分析失败'
        app.log.warn({ err }, 'ai analysis failed')
        return reply.code(502).send({ error: `分析失败：${message.slice(0, 200)}` })
      }
    },
  )
}
