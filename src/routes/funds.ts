import type { FastifyInstance } from 'fastify'
import type { Db } from '../store/db'
import { deleteFund, insertFund, listFunds } from '../store/queries'
import { fetchPosition, resolveHoldingsFrom, type ResolvedHoldings } from '../fund/holdings'

interface AddBody {
  code?: unknown
  marketValue?: unknown
  profit?: unknown
  shares?: unknown
  costBasis?: unknown
  /** 跟踪的指数键（如 'ndx'）。指数基金必填，否则只能退回前十大，覆盖率骤降到 40~70% */
  indexKey?: unknown
}

/** 依赖注入：默认走真实网络，单测传入桩函数即可完全离线运行 */
export interface FundRouteDeps {
  latestNav?: (code: string) => Promise<number>
  resolveHoldings?: (code: string) => Promise<ResolvedHoldings>
}

const EMPTY_HOLDINGS: ResolvedHoldings = { holdings: [], viaEtf: null, asOf: '' }

/**
 * 宽松但严格地取数字。
 *
 * Number('') === 0 且是有限数，所以空串必须先单独拦掉，否则「没填市值」会被
 * 当成「市值为 0」静默写库。非数字、NaN、Infinity 一律返回 null 让调用方报 400。
 */
function readNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '') return null
    const num = Number(text)
    return Number.isFinite(num) ? num : null
  }
  return null
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function registerFundRoutes(
  app: FastifyInstance,
  db: Db,
  deps: FundRouteDeps = {},
): void {
  const getNav = deps.latestNav ?? latestNav
  const getHoldings =
    deps.resolveHoldings ??
    ((code: string) =>
      resolveHoldingsFrom(code, fetchPosition).catch((): ResolvedHoldings => EMPTY_HOLDINGS))

  app.get('/api/funds', async () => ({ funds: listFunds(db) }))

  app.post<{ Body: AddBody }>('/api/funds', async (req, reply) => {
    const body = req.body ?? {}
    const code = readText(body.code)
    if (!code) return reply.code(400).send({ error: 'code required' })

    const marketValue = readNumber(body.marketValue)
    if (marketValue === null || marketValue < 0) {
      return reply.code(400).send({ error: 'marketValue must be a non-negative number' })
    }

    const profit = readNumber(body.profit) ?? 0
    const sharesIn = readNumber(body.shares)
    if (sharesIn !== null && sharesIn < 0) {
      return reply.code(400).send({ error: 'shares must be non-negative' })
    }
    const costBasisIn = readNumber(body.costBasis)
    if (costBasisIn !== null && costBasisIn < 0) {
      return reply.code(400).send({ error: 'costBasis must be non-negative' })
    }

    // 用户只填「市值 + 持有收益」，份额由市值/净值反推，避免长表单。
    // 只有真的需要反推时才查净值，显式给了 shares 就不该多打一次外网。
    let shares = sharesIn
    if (shares === null) {
      const nav = await getNav(code)
      if (!(nav > 0)) {
        return reply.code(502).send({ error: 'latest nav unavailable; pass shares explicitly' })
      }
      shares = marketValue / nav
    }
    // 成本 = 市值 − 持有收益；收益大于市值时夹到 0，schema 也不允许负成本
    const costBasis = costBasisIn ?? Math.max(0, marketValue - profit)

    const indexKey = readText(body.indexKey)
    const fund = insertFund(db, {
      code,
      shares,
      costBasis,
      indexKey: indexKey || null,
    })

    // 持仓解析失败不能回滚已录入的基金：下次估算会重新解析
    let resolved = EMPTY_HOLDINGS
    try {
      resolved = await getHoldings(code)
    } catch {
      resolved = EMPTY_HOLDINGS
    }

    return {
      fund,
      holdings: resolved.holdings.length,
      viaEtf: resolved.viaEtf,
      indexKey: fund.index_key,
    }
  })

  app.delete<{ Params: { id: string } }>('/api/funds/:id', async (req, reply) => {
    const id = readNumber(req.params.id)
    if (id === null || !Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'id must be a positive integer' })
    }
    const deleted = deleteFund(db, id)
    if (deleted === 0) return reply.code(404).send({ error: 'fund not found' })
    return { ok: true }
  })
}

/** 默认实现：东财基金掌上接口取最新单位净值 */
async function latestNav(code: string): Promise<number> {
  const url =
    `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?pageIndex=1&pageSize=1` +
    `&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=1&Fcodes=${code}`
  try {
    const res = await fetch(url)
    const body = (await res.json()) as { Datas?: Array<{ NAV?: unknown }> | null }
    return readNumber(body?.Datas?.[0]?.NAV) ?? 0
  } catch {
    return 0
  }
}
