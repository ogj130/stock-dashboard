import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  analysisClock,
  buildAnalysisSnapshot,
  type AiConfigView,
  type AiProfileView,
  type AnalysisFundInput,
  type AnalysisResult,
  type AnalysisStockInput,
  type AnalysisTotals,
  sessionClock,
} from './analysis'

/**
 * 「AI 复盘」卡片。
 *
 * 三个刻意的边界：
 * 1. **按需触发**：不参与 5 秒轮询，点一下才调模型（一次调用可能几十秒、要花钱）。
 * 2. **配置在前**：没填 Base URL / 模型 / 密钥时只显示一段说明与设置入口，
 *    不发注定失败的请求。
 * 3. **失败只降级这一块**：接口 4xx/5xx 都变成卡片里的文案，不影响估值。
 *
 * 配置是多档案的：下拉切换「当前使用」，编辑只影响选中的那一条；
 * 密钥只存在服务端数据目录的 ai.json（0600），这里拿到的永远是掩码。
 */

const NEWS_LIMIT = 6

type StepState = 'running' | 'done' | 'error'

interface AnalysisStep {
  key: string
  label: string
  detail?: string
  state: StepState
}

/** 只显示 host，别把带路径的完整地址铺在卡片里 */
function endpointLabel(baseUrl: string): string {
  if (baseUrl.trim() === '') return '未配置'
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

interface Props {
  phase: 'pre' | 'live' | 'settled'
  totals: AnalysisTotals
  fx: { pair: string; rate: number; pct: number } | null
  indices: Array<{ name: string; pct: number }>
  funds: readonly AnalysisFundInput[]
  stocks: readonly AnalysisStockInput[]
}

interface NewsResponse {
  items: Array<{ title: string; tsMs: number; important: boolean }>
}

interface ModelsResponse {
  models: string[]
  count: number
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const payload = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`)
  return payload
}

export default function AnalysisCard({ phase, totals, fx, indices, funds, stocks }: Props) {
  const [config, setConfig] = useState<AiConfigView | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  /** 正在编辑的档案；creating=true 表示还没保存的新档案 */
  const [selectedId, setSelectedId] = useState('')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [modelNotice, setModelNotice] = useState<string | null>(null)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 处理过程：每一步都真的发生了才写，不做装饰性假动画 */
  const [steps, setSteps] = useState<AnalysisStep[]>([])
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [lastMs, setLastMs] = useState<number | null>(null)

  function applyProfile(profile: AiProfileView | null): void {
    setName(profile?.name ?? '')
    setBaseUrl(profile?.baseUrl ?? '')
    setModel(profile?.model ?? '')
    setApiKey('')
    setModels([])
    setModelNotice(null)
  }

  useEffect(() => {
    let alive = true
    getJson<AiConfigView>('/api/ai/config')
      .then((cfg) => {
        if (!alive) return
        setConfig(cfg)
        const active = cfg.profiles.find((p) => p.id === cfg.activeId) ?? cfg.profiles[0] ?? null
        if (active !== null) {
          setSelectedId(active.id)
          applyProfile(active)
          setCreating(false)
        } else {
          setCreating(true)
          setName('默认')
        }
        // 没配过就把设置展开，省一次点击
        if (!cfg.configured) setSettingsOpen(true)
      })
      .catch(() => {
        if (alive) {
          setConfig({ activeId: '', profiles: [], configured: false })
          setCreating(true)
          setName('默认')
        }
      })
    return () => {
      alive = false
    }
  }, [])

  // 生成过程中每 0.5 秒刷一次已用时长：没有它，30 秒的等待看起来像卡死
  useEffect(() => {
    if (!loading || startedAt === null) return
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 100) / 10), 500)
    return () => clearInterval(timer)
  }, [loading, startedAt])

  function patchStep(key: string, patch: Partial<AnalysisStep>): void {
    setSteps((prev) => prev.map((step) => (step.key === key ? { ...step, ...patch } : step)))
  }

  const activeProfile = config?.profiles.find((p) => p.id === config.activeId) ?? null
  const selectedProfile = config?.profiles.find((p) => p.id === selectedId) ?? null
  const configured = config?.configured === true && activeProfile !== null

  const generate = useCallback(
    async (refresh: boolean) => {
      if (loading) return
      setLoading(true)
      setError(null)
      setResult(null)
      setLastMs(null)
      const started = Date.now()
      setStartedAt(started)
      setElapsed(0)
      setSteps([{ key: 'snapshot', label: '整理当前估算快照', state: 'running' }])
      try {
        // 快讯失败不影响分析：只是少一个上下文
        const news = await getJson<NewsResponse>(`/api/news?limit=${NEWS_LIMIT}`).catch(() => null)
        const clock = sessionClock(phase, started)
        patchStep('snapshot', {
          state: 'done',
          detail: `${funds.length} 只基金 · ${stocks.length} 只个股 · ${news?.items.length ?? 0} 条快讯 · ${clock.et}`,
        })
        const snapshot = buildAnalysisSnapshot({
          phase,
          atMs: Date.now(),
          totals,
          fx,
          indices,
          funds,
          stocks,
          news: news?.items ?? [],
        })

        setSteps((prev) => [
          ...prev,
          {
            key: 'request',
            label: '发送给模型',
            detail: `${endpointLabel(activeProfile?.baseUrl ?? '')} · ${activeProfile?.model ?? ''}`,
            state: 'running',
          },
        ])
        const payload = await getJson<AnalysisResult>('/api/analysis', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ snapshot, refresh }),
        })
        const waited = Date.now() - started
        patchStep('request', { state: 'done', detail: `${(waited / 1000).toFixed(1)} 秒` })

        setSteps((prev) => [...prev, { key: 'parse', label: '校验返回结构', state: 'running' }])
        patchStep('parse', { state: 'done', detail: payload.cached ? '命中缓存' : '结构合规' })

        setResult(payload)
        setLastMs(waited)
      } catch (err) {
        const message = err instanceof Error ? err.message : '分析失败'
        setSteps((prev) =>
          prev.map((step) => (step.state === 'running' ? { ...step, state: 'error', detail: message } : step)),
        )
        setError(message)
      } finally {
        setLoading(false)
      }
    },
    [loading, phase, totals, fx, indices, funds, stocks, activeProfile],
  )

  async function selectProfile(id: string): Promise<void> {
    setNotice(null)
    try {
      const next = await getJson<AiConfigView>('/api/ai/active', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      setConfig(next)
      const profile = next.profiles.find((p) => p.id === id) ?? null
      setSelectedId(id)
      setCreating(false)
      applyProfile(profile)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '切换失败')
    }
  }

  function startNew(): void {
    setCreating(true)
    setSelectedId('')
    setNotice(null)
    setName(`配置 ${(config?.profiles.length ?? 0) + 1}`)
    setBaseUrl(activeProfile?.baseUrl ?? '')
    setModel('')
    setApiKey('')
    setModels([])
    setModelNotice(null)
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setSaving(true)
    setNotice(null)
    try {
      const body: Record<string, string> = { name, baseUrl, model }
      if (apiKey.trim() !== '') body.apiKey = apiKey.trim()
      if (creating) {
        const created = await getJson<AiConfigView & { id: string }>('/api/ai/profiles', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        setConfig({ activeId: created.activeId, profiles: created.profiles, configured: created.configured })
        setSelectedId(created.id)
        setCreating(false)
        const profile = created.profiles.find((p) => p.id === created.id) ?? null
        applyProfile(profile)
        setNotice(created.configured ? '已保存并切换' : '已保存，还差一项没填')
      } else {
        const next = await getJson<AiConfigView>(`/api/ai/profiles/${encodeURIComponent(selectedId)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        setConfig(next)
        applyProfile(next.profiles.find((p) => p.id === selectedId) ?? null)
        setNotice(next.configured ? '已保存' : '已保存，还差一项没填')
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function deleteProfile(): Promise<void> {
    if (selectedProfile === null) return
    if (!window.confirm(`删除配置「${selectedProfile.name}」？`)) return
    setSaving(true)
    try {
      const next = await getJson<AiConfigView>(`/api/ai/profiles/${encodeURIComponent(selectedProfile.id)}`, {
        method: 'DELETE',
      })
      setConfig(next)
      const active = next.profiles.find((p) => p.id === next.activeId) ?? next.profiles[0] ?? null
      if (active === null) {
        setCreating(true)
        setSelectedId('')
        applyProfile(null)
        setName('默认')
      } else {
        setSelectedId(active.id)
        setCreating(false)
        applyProfile(active)
      }
      setNotice('已删除')
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '删除失败')
    } finally {
      setSaving(false)
    }
  }

  async function fetchModels(): Promise<void> {
    setFetchingModels(true)
    setModelNotice(null)
    try {
      const body: Record<string, string | undefined> = {
        baseUrl,
        profileId: creating ? undefined : selectedId,
      }
      if (apiKey.trim() !== '') body.apiKey = apiKey.trim()
      const res = await getJson<ModelsResponse>('/api/ai/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      setModels(res.models)
      setModelNotice(res.count === 0 ? '端点没有返回模型列表，可手动填写模型名' : `拉到 ${res.count} 个模型`)
    } catch (err) {
      setModels([])
      setModelNotice(err instanceof Error ? err.message : '获取模型列表失败')
    } finally {
      setFetchingModels(false)
    }
  }

  async function clearKey(): Promise<void> {
    if (creating) {
      setApiKey('')
      return
    }
    setSaving(true)
    try {
      const next = await getJson<AiConfigView>(`/api/ai/profiles/${encodeURIComponent(selectedId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: '' }),
      })
      setConfig(next)
      applyProfile(next.profiles.find((p) => p.id === selectedId) ?? null)
      setNotice('已清除密钥')
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '清除失败')
    } finally {
      setSaving(false)
    }
  }

  async function testConnection(): Promise<void> {
    setTesting(true)
    setNotice(null)
    try {
      const res = await getJson<{ ok: boolean; ms?: number; error?: string }>('/api/ai/test', { method: 'POST' })
      setNotice(res.ok ? `连接正常（${res.ms ?? 0} ms）` : `连接失败：${res.error ?? '未知错误'}`)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '连接失败')
    } finally {
      setTesting(false)
    }
  }

  return (
    <section className="glass card ai-card" aria-label="AI 复盘">
      <div className="ai-head">
        <div className="ai-title">
          AI 复盘
          <span className="ai-sub">
            读今天的估算，给出归因与风险
            {activeProfile !== null && ` · ${activeProfile.name}`}
          </span>
        </div>
        <div className="ai-actions">
          {configured && (
            <button
              type="button"
              className="ai-range"
              onClick={() => void generate(result !== null)}
              disabled={loading}
            >
              {loading ? '分析中…' : result === null ? '生成今日复盘' : '重新分析'}
            </button>
          )}
          <button
            type="button"
            className={`ai-gear${settingsOpen ? ' on' : ''}`}
            aria-expanded={settingsOpen}
            aria-controls="ai-settings"
            onClick={() => setSettingsOpen((open) => !open)}
          >
            设置
          </button>
        </div>
      </div>

      {settingsOpen && (
        <form className="ai-settings" id="ai-settings" onSubmit={(event) => void saveSettings(event)}>
          <p className="ai-hint">
            填一个兼容 OpenAI 协议的端点即可。支持保存多个配置并随时切换；密钥只存在本机数据目录的{' '}
            <code>ai.json</code>（0600），不会回显、也不会进仓库。
          </p>

          <div className="ai-profile-row">
            <label>
              <span>配置</span>
              <select
                value={creating ? '' : selectedId}
                onChange={(event) => void selectProfile(event.target.value)}
                disabled={creating || (config?.profiles.length ?? 0) === 0}
              >
                {creating && <option value="">新建配置</option>}
                {(config?.profiles ?? []).map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                    {profile.model !== '' ? ` · ${profile.model}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="ai-range" onClick={startNew} disabled={saving}>
              新建
            </button>
            {!creating && selectedProfile !== null && (
              <button type="button" className="ai-clear" onClick={() => void deleteProfile()} disabled={saving}>
                删除
              </button>
            )}
          </div>

          <div className="ai-fields">
            <label>
              <span>名称</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="DeepSeek"
                autoComplete="off"
              />
            </label>
            <label>
              <span>Base URL</span>
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://api.deepseek.com/v1"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              <span>模型</span>
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="deepseek-chat"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              <span>API Key</span>
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={
                  selectedProfile?.hasKey === true
                    ? `已保存 ${selectedProfile.maskedKey}，留空不改`
                    : 'sk-...'
                }
                autoComplete="new-password"
              />
            </label>
          </div>

          {models.length > 0 && (
            <label className="ai-model-pick">
              <span>可用模型（{models.length}）</span>
              <select value={models.includes(model) ? model : ''} onChange={(event) => setModel(event.target.value)}>
                <option value="">选择一个…</option>
                {models.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="ai-settings-actions">
            <button type="submit" className="ai-primary" disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
            <button type="button" className="ai-range" onClick={() => void fetchModels()} disabled={fetchingModels}>
              {fetchingModels ? '获取中…' : '获取模型列表'}
            </button>
            <button
              type="button"
              className="ai-range"
              onClick={() => void testConnection()}
              disabled={testing || creating || !configured}
            >
              {testing ? '测试中…' : '测试连接'}
            </button>
            {selectedProfile?.hasKey === true && !creating && (
              <button type="button" className="ai-clear" onClick={() => void clearKey()} disabled={saving}>
                清除密钥
              </button>
            )}
            {notice !== null && <span className="ai-msg">{notice}</span>}
            {modelNotice !== null && <span className="ai-msg">{modelNotice}</span>}
          </div>
        </form>
      )}

      {!settingsOpen && !configured && (
        <p className="ai-hint">还没有配置 AI。点「设置」填入 Base URL、模型与密钥即可。</p>
      )}

      {(loading || steps.length > 0) && (
        <div className="ai-progress" role="status" aria-live="polite">
          <div className="ai-progress-head">
            <span>处理过程</span>
            <span className="num">{elapsed.toFixed(1)} s</span>
          </div>
          <ol className="ai-steps">
            {steps.map((step) => (
              <li className={`ai-step ${step.state}`} key={step.key}>
                <i className="ai-step-dot" aria-hidden="true">
                  {step.state === 'done' ? '✓' : step.state === 'error' ? '!' : ''}
                </i>
                <span>
                  {step.label}
                  {step.detail !== undefined && <em className="ai-step-detail">{step.detail}</em>}
                </span>
              </li>
            ))}
          </ol>
          {loading && (
            <div className="ai-progress-bar" aria-hidden="true">
              <span />
            </div>
          )}
        </div>
      )}

      {error !== null && (
        <p className="ai-error" role="alert">
          {error}
        </p>
      )}

      {result !== null && (
        <div className="ai-result">
          {result.headline !== '' && <p className="ai-headline">{result.headline}</p>}

          {result.summary.length > 0 && (
            <ul className="ai-list">
              {result.summary.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}

          {result.drivers.length > 0 && (
            <div className="ai-drivers">
              {result.drivers.map((driver) => (
                <div className="ai-driver" key={`${driver.label}-${driver.detail}`}>
                  <span>{driver.label}</span>
                  <p>{driver.detail}</p>
                </div>
              ))}
            </div>
          )}

          {result.events.length > 0 && (
            <div className="ai-events">
              <h3>事件与持仓</h3>
              {result.events.map((event) => (
                <div className="ai-event" key={`${event.title}-${event.impact}`}>
                  <span>{event.title}</span>
                  <p>{event.impact}</p>
                </div>
              ))}
            </div>
          )}

          {result.scenarios.length > 0 && (
            <div className="ai-scenarios">
              <h3>情景推演</h3>
              <div className="ai-scenario-grid">
                {result.scenarios.map((scenario) => (
                  <div className="ai-scenario" key={`${scenario.name}-${scenario.trigger}`}>
                    <span className="ai-scenario-name">{scenario.name}</span>
                    <p className="ai-scenario-trigger">{scenario.trigger}</p>
                    <p className="ai-scenario-impl">{scenario.implication}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {result.dataGaps.length > 0 && (
            <section className="ai-gaps">
              <h3>数据盲区</h3>
              <ul>
                {result.dataGaps.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          )}

          {(result.risks.length > 0 || result.watch.length > 0) && (
            <div className="ai-cols">
              {result.risks.length > 0 && (
                <section>
                  <h3>风险</h3>
                  <ul>
                    {result.risks.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </section>
              )}
              {result.watch.length > 0 && (
                <section>
                  <h3>接下来核对</h3>
                  <ul>
                    {result.watch.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}

          <p className="ai-meta">
            {result.model} · {analysisClock(result.generatedAt)}
            {lastMs !== null ? ` · ${(lastMs / 1000).toFixed(1)}s` : ''}
            {result.cached ? ' · 缓存' : ''}
            {result.confidence !== null && (
              <span className="ai-confidence" title={result.confidence.reason}>
                {' · '}置信度 {result.confidence.level}
              </span>
            )}
          </p>
          <p className="ai-disclaimer">{result.disclaimer}</p>
        </div>
      )}
    </section>
  )
}
