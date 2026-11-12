import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  activeProfile,
  defaultAiConfigPath,
  isConfigured,
  maskKey,
  newProfileId,
  normalizeBaseUrl,
  readAiStore,
  writeAiStore,
  type AiProfile,
  type AiStore,
} from '../ai/config'
import {
  DISCLAIMER,
  buildMessages,
  chatCompletion,
  listModels,
  parseAnalysis,
  type Analysis,
} from '../ai/analysis'
import { parseSnapshot } from '../ai/snapshot'

/**
 * AI 分析的 HTTP 面。
 *
 * 配置是**多档案**的：每个档案 = 名称 + Base URL + 模型 + 密钥，同一时间只有一个
 * 「当前使用」。这样 DeepSeek / OpenAI / 自建中转可以并存，切换只改 activeId。
 *
 *   GET    /api/ai/config          读配置（密钥只回 masked，永不回原文）
 *   PUT    /api/ai/config          兼容旧版的扁平写入（更新当前档案）
 *   POST   /api/ai/profiles        新建档案
 *   PUT    /api/ai/profiles/:id    修改档案
 *   DELETE /api/ai/profiles/:id    删除档案
 *   PUT    /api/ai/active          切换当前档案
 *   POST   /api/ai/models          用某个档案（或草稿端点）拉 /models 列表
 *   POST   /api/ai/test            用 8 个 token 发一次 ping
 *   POST   /api/analysis           用当前档案做持仓复盘（10 分钟缓存）
 *
 * 所有写操作都落在数据目录的 ai.json（0600）；任何配置变更都会清掉分析缓存。
 */
export interface AiRouteDeps {
  configPath?: string
  fetchFn?: typeof fetch
  now?: () => number
  ttlMs?: number
}

interface PublicProfile {
  id: string
  name: string
  baseUrl: string
  model: string
  hasKey: boolean
  maskedKey: string
}

interface PublicConfig {
  activeId: string
  profiles: PublicProfile[]
  configured: boolean
}

function publicConfig(store: AiStore): PublicConfig {
  const active = activeProfile(store)
  return {
    activeId: active?.id ?? '',
    profiles: store.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: profile.model,
      hasKey: profile.apiKey !== '',
      maskedKey: maskKey(profile.apiKey),
    })),
    configured: active !== null && isConfigured(active),
  }
}

interface AnalysisPayload extends Analysis {
  model: string
  generatedAt: number
  cached: boolean
  disclaimer: string
}

/** 校验可选的字符串字段；返回错误文案或 null */
function readString(value: unknown, label: string, max: number): { value?: string; error?: string } {
  if (value === undefined) return {}
  if (typeof value !== 'string') return { error: `${label} 必须是字符串` }
  return { value: value.trim().slice(0, max) }
}

export function registerAiRoutes(app: FastifyInstance, dbPath: string, deps: AiRouteDeps = {}): void {
  const configPath = deps.configPath ?? defaultAiConfigPath(dbPath)
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? 10 * 60_000
  const fetchFn = deps.fetchFn
  let cache: { key: string; at: number; payload: AnalysisPayload } | null = null

  function persist(store: AiStore): void {
    writeAiStore(configPath, store)
    cache = null
  }

  function applyPatch(profile: AiProfile, body: Record<string, unknown>): { profile?: AiProfile; error?: string } {
    const name = readString(body.name, '名称', 40)
    if (name.error !== undefined) return { error: name.error }
    const model = readString(body.model, 'model', 80)
    if (model.error !== undefined) return { error: model.error }
    const apiKey = readString(body.apiKey, 'apiKey', 400)
    if (apiKey.error !== undefined) return { error: apiKey.error }

    let baseUrl = profile.baseUrl
    if (body.baseUrl !== undefined) {
      if (typeof body.baseUrl !== 'string') return { error: 'Base URL 必须是字符串' }
      const text = body.baseUrl.trim()
      if (text === '') {
        baseUrl = ''
      } else {
        const normalized = normalizeBaseUrl(text)
        if (normalized === null) return { error: 'Base URL 必须是 http(s):// 开头的地址' }
        baseUrl = normalized
      }
    }

    return {
      profile: {
        ...profile,
        name: name.value !== undefined && name.value !== '' ? name.value : profile.name,
        baseUrl,
        model: model.value ?? profile.model,
        apiKey: apiKey.value ?? profile.apiKey,
      },
    }
  }

  app.get('/api/ai/config', async () => publicConfig(readAiStore(configPath)))

  // 兼容旧版：扁平写入当前档案；没有档案时建一个「默认」
  app.put<{ Body: { baseUrl?: unknown; model?: unknown; apiKey?: unknown; name?: unknown } }>(
    '/api/ai/config',
    async (req, reply: FastifyReply) => {
      const store = readAiStore(configPath)
      const active = activeProfile(store)
      const base: AiProfile = active ?? {
        id: 'default',
        name: '默认',
        baseUrl: '',
        model: '',
        apiKey: '',
      }
      const patched = applyPatch(base, req.body ?? {})
      if (patched.profile === undefined) return reply.code(400).send({ error: patched.error ?? '参数不合法' })
      const nextProfile = patched.profile
      const nextStore: AiStore = active
        ? { ...store, profiles: store.profiles.map((p) => (p.id === active.id ? nextProfile : p)) }
        : { activeId: nextProfile.id, profiles: [...store.profiles, nextProfile] }
      try {
        persist(nextStore)
      } catch (err) {
        app.log.warn({ err }, 'ai config write failed')
        return reply.code(500).send({ error: '配置写入失败（检查数据目录权限）' })
      }
      return publicConfig(nextStore)
    },
  )

  app.post<{ Body: { name?: unknown; baseUrl?: unknown; model?: unknown; apiKey?: unknown } }>(
    '/api/ai/profiles',
    async (req, reply: FastifyReply) => {
      const store = readAiStore(configPath)
      if (store.profiles.length >= 20) {
        return reply.code(400).send({ error: '最多保存 20 个配置' })
      }
      const base: AiProfile = {
        id: newProfileId(),
        name: `配置 ${store.profiles.length + 1}`,
        baseUrl: '',
        model: '',
        apiKey: '',
      }
      const patched = applyPatch(base, req.body ?? {})
      if (patched.profile === undefined) return reply.code(400).send({ error: patched.error ?? '参数不合法' })
      const nextStore: AiStore = {
        activeId: patched.profile.id,
        profiles: [...store.profiles, patched.profile],
      }
      try {
        persist(nextStore)
      } catch (err) {
        app.log.warn({ err }, 'ai profile write failed')
        return reply.code(500).send({ error: '配置写入失败（检查数据目录权限）' })
      }
      return { ...publicConfig(nextStore), id: patched.profile.id }
    },
  )

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/ai/profiles/:id',
    async (req, reply: FastifyReply) => {
      const store = readAiStore(configPath)
      const target = store.profiles.find((profile) => profile.id === req.params.id)
      if (target === undefined) return reply.code(404).send({ error: '配置不存在' })
      const patched = applyPatch(target, req.body ?? {})
      if (patched.profile === undefined) return reply.code(400).send({ error: patched.error ?? '参数不合法' })
      const nextStore: AiStore = {
        ...store,
        profiles: store.profiles.map((profile) => (profile.id === target.id ? patched.profile! : profile)),
      }
      try {
        persist(nextStore)
      } catch (err) {
        app.log.warn({ err }, 'ai profile write failed')
        return reply.code(500).send({ error: '配置写入失败（检查数据目录权限）' })
      }
      return publicConfig(nextStore)
    },
  )

  app.delete<{ Params: { id: string } }>('/api/ai/profiles/:id', async (req, reply: FastifyReply) => {
    const store = readAiStore(configPath)
    if (!store.profiles.some((profile) => profile.id === req.params.id)) {
      return reply.code(404).send({ error: '配置不存在' })
    }
    const profiles = store.profiles.filter((profile) => profile.id !== req.params.id)
    const nextStore: AiStore = {
      activeId: store.activeId === req.params.id ? (profiles[0]?.id ?? '') : store.activeId,
      profiles,
    }
    try {
      persist(nextStore)
    } catch (err) {
      app.log.warn({ err }, 'ai profile delete failed')
      return reply.code(500).send({ error: '配置写入失败（检查数据目录权限）' })
    }
    return publicConfig(nextStore)
  })

  app.put<{ Body: { id?: unknown } }>('/api/ai/active', async (req, reply: FastifyReply) => {
    const id = req.body?.id
    if (typeof id !== 'string') return reply.code(400).send({ error: 'id 必须是字符串' })
    const store = readAiStore(configPath)
    if (!store.profiles.some((profile) => profile.id === id)) {
      return reply.code(404).send({ error: '配置不存在' })
    }
    const nextStore: AiStore = { ...store, activeId: id }
    try {
      persist(nextStore)
    } catch (err) {
      app.log.warn({ err }, 'ai active switch failed')
      return reply.code(500).send({ error: '配置写入失败（检查数据目录权限）' })
    }
    return publicConfig(nextStore)
  })

  /** 拉模型列表：可以用已保存档案（profileId）也可以用草稿端点（baseUrl + apiKey） */
  app.post<{ Body: { profileId?: unknown; baseUrl?: unknown; apiKey?: unknown } }>(
    '/api/ai/models',
    async (req, reply: FastifyReply) => {
      const body = req.body ?? {}
      const store = readAiStore(configPath)
      const draftBase = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
      /**
       * 有草稿 Base URL 时**不**回落到当前档案的密钥：
       * 用户很可能在新建另一家端点，拿旧的 key 去试只会返回 401，
       * 看起来像新端点的错。只有「没给端点、按档案查」时才复用档案的密钥。
       */
      const profile =
        typeof body.profileId === 'string'
          ? store.profiles.find((item) => item.id === body.profileId)
          : draftBase === ''
            ? activeProfile(store)
            : null

      const baseUrl = draftBase !== '' ? normalizeBaseUrl(draftBase) : (profile?.baseUrl ?? '')
      if (baseUrl === null || baseUrl === '') {
        return reply.code(400).send({ error: '先填一个 http(s):// 的 Base URL' })
      }
      const draftKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
      const apiKey = draftKey !== '' ? draftKey : (profile?.apiKey ?? '')

      try {
        const models = await listModels({ baseUrl, apiKey }, { fetchFn })
        return { models, count: models.length }
      } catch (err) {
        const message = err instanceof Error ? err.message : '获取模型列表失败'
        app.log.warn({ err }, 'ai models failed')
        return reply.code(502).send({ error: message.slice(0, 200) })
      }
    },
  )

  app.post('/api/ai/test', async (_req, reply) => {
    const config = activeProfile(readAiStore(configPath))
    if (config === null || !isConfigured(config)) {
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
      const config = activeProfile(readAiStore(configPath))
      if (config === null || !isConfigured(config)) {
        return reply.code(400).send({ error: '还没有配置 AI：先填 Base URL、模型与密钥' })
      }

      const parsed = parseSnapshot(req.body?.snapshot)
      if (parsed.snapshot === undefined) {
        return reply.code(400).send({ error: parsed.error ?? '快照不合法' })
      }
      const snapshot = parsed.snapshot
      const key = `${config.id}:${snapshot.phase}:${Math.floor(now() / ttlMs)}`
      if (req.body?.refresh !== true && cache !== null && cache.key === key) {
        return { ...cache.payload, cached: true }
      }

      try {
        const text = await chatCompletion(config, buildMessages(snapshot), {
          fetchFn,
          maxTokens: 6000,
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
