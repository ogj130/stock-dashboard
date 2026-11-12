import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  analysisClock,
  buildAnalysisSnapshot,
  type AiConfigView,
  type AnalysisFundInput,
  type AnalysisResult,
  type AnalysisStockInput,
  type AnalysisTotals,
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
 * 密钥只存在服务端数据目录的 ai.json（0600），这里拿到的永远是掩码。
 */

const NEWS_LIMIT = 6

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

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const payload = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`)
  return payload
}

export default function AnalysisCard({ phase, totals, fx, indices, funds, stocks }: Props) {
  const [config, setConfig] = useState<AiConfigView | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    getJson<AiConfigView>('/api/ai/config')
      .then((cfg) => {
        if (!alive) return
        setConfig(cfg)
        setBaseUrl(cfg.baseUrl)
        setModel(cfg.model)
        // 没配过就把设置展开，省一次点击
        if (!cfg.configured) setSettingsOpen(true)
      })
      .catch(() => {
        if (alive) setConfig({ baseUrl: '', model: '', hasKey: false, maskedKey: '', configured: false })
      })
    return () => {
      alive = false
    }
  }, [])

  const generate = useCallback(
    async (refresh: boolean) => {
      if (loading) return
      setLoading(true)
      setError(null)
      try {
        // 快讯失败不影响分析：只是少一个上下文
        const news = await getJson<NewsResponse>(`/api/news?limit=${NEWS_LIMIT}`).catch(() => ({ items: [] }))
        const snapshot = buildAnalysisSnapshot({
          phase,
          atMs: Date.now(),
          totals,
          fx,
          indices,
          funds,
          stocks,
          news: news.items,
        })
        const payload = await getJson<AnalysisResult>('/api/analysis', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ snapshot, refresh }),
        })
        setResult(payload)
      } catch (err) {
        setError(err instanceof Error ? err.message : '分析失败')
      } finally {
        setLoading(false)
      }
    },
    [loading, phase, totals, fx, indices, funds, stocks],
  )

  async function saveSettings(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setSaving(true)
    setNotice(null)
    try {
      const body: Record<string, string> = { baseUrl, model }
      if (apiKey.trim() !== '') body.apiKey = apiKey.trim()
      const next = await getJson<AiConfigView>('/api/ai/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      setConfig(next)
      setApiKey('')
      setNotice(next.configured ? '已保存' : '已保存，还差一项没填')
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function clearKey(): Promise<void> {
    setSaving(true)
    try {
      const next = await getJson<AiConfigView>('/api/ai/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: '' }),
      })
      setConfig(next)
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

  const configured = config?.configured === true

  return (
    <section className="glass card ai-card" aria-label="AI 复盘">
      <div className="ai-head">
        <div className="ai-title">
          AI 复盘
          <span className="ai-sub">读今天的估算，给出归因与风险</span>
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
            填一个兼容 OpenAI 协议的端点即可。密钥只保存在本机数据目录的 <code>ai.json</code>（0600），
            不会回显、也不会进仓库。
          </p>
          <div className="ai-fields">
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
                placeholder={config?.hasKey ? `已保存 ${config.maskedKey}，留空不改` : 'sk-...'}
                autoComplete="new-password"
              />
            </label>
          </div>
          <div className="ai-settings-actions">
            <button type="submit" className="ai-primary" disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
            <button type="button" className="ai-range" onClick={() => void testConnection()} disabled={testing || !configured}>
              {testing ? '测试中…' : '测试连接'}
            </button>
            {config?.hasKey && (
              <button type="button" className="ai-clear" onClick={() => void clearKey()} disabled={saving}>
                清除密钥
              </button>
            )}
            {notice !== null && <span className="ai-msg">{notice}</span>}
          </div>
        </form>
      )}

      {!settingsOpen && !configured && (
        <p className="ai-hint">还没有配置 AI。点「设置」填入 Base URL、模型与密钥即可。</p>
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
            {result.cached ? ' · 缓存' : ''}
          </p>
          <p className="ai-disclaimer">{result.disclaimer}</p>
        </div>
      )}

      {loading && <p className="ai-hint">正在把当前估算交给模型，通常 10–30 秒…</p>}
    </section>
  )
}
