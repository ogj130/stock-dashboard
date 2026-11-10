import type { FastifyInstance } from 'fastify'
import type { Db } from '../store/db'
import { listFunds } from '../store/queries'
import {
  alignResiduals,
  fitSlot,
  summarize,
  type NavDay,
  type Residual,
} from '../engine/reconcile'
import { fitExposure } from '../engine/calibrate'

/**
 * 对账接口：我们到底准不准。
 *
 * 只读、不做任何写入——每次现算。原因很直接：estimate_log 与 nav_history 都是
 * 事实表，对账结论是它们的**派生值**，缓存起来只会多一个会与事实脱节的东西。
 * 数据量级是「16 只 × 几十天」，现算的成本远低于维护一份残差表的成本。
 *
 * 输出三样东西，缺一不可：
 *   1. 我们用的 lag（净值日对应哪一场美股）—— 拟合出来的，附全部候选的 MAE
 *   2. 逐基金 MAE / 偏差方向 —— 判断"准不准"的唯一硬指标
 *   3. 建议仓位系数 —— 与当前配置对比，供人工决定要不要改
 */
export interface FundAccuracy {
  code: string
  name: string
  /** 可对账的样本数 */
  n: number
  mae: number
  /** 平均偏差：正 = 系统性高估 */
  bias: number
  /** 当前用的 exposure */
  exposure: number
  /** 由残差拟合出的建议值（样本不足时等于默认 0.95） */
  suggestedExposure: number
}

export interface AccuracyResponse {
  /** 拟合出的公布滞后：净值在那一场之后第几次公布（1 = 次日公布，QDII 常态） */
  slot: number
  /** 该 lag 下的整体 MAE（百分点）；0 表示样本还不够 */
  mae: number
  /** 参与对账的总样本数 */
  samples: number
  /** 样本不足时界面要能说「还不够对账」，而不是显示一个 0.00 */
  enough: boolean
  slotCandidates: Array<{ slot: number; mae: number; samples: number }>
  funds: FundAccuracy[]
}

interface EstimateRow {
  fund_code: string
  target_nav_date: string
  phase: string
  model_pct: number
  model_ts: number
}

/** 每只基金、每一场，取最接近收盘的那条留痕（settled > live > pre） */
const PHASE_RANK: Record<string, number> = { settled: 3, live: 2, pre: 1 }

export function buildAccuracy(db: Db, slotOverride?: number): AccuracyResponse {
  const funds = listFunds(db)

  // 同一天可能留下多个相位的痕迹（pre/live/settled），只保留最接近收盘的那条：
  // 那一场走完之后记下的数才是这一场的结果，盘中的数是过程
  const best = new Map<string, { pct: number; score: number }>()
  for (const row of db
    .prepare(
      `select fund_code, target_nav_date, phase, model_pct, model_ts
         from estimate_log
        order by target_nav_date asc, model_ts desc`,
    )
    .all() as unknown as EstimateRow[]) {
    const key = `${row.fund_code}|${row.target_nav_date}`
    const score = PHASE_RANK[row.phase] ?? 0
    const prev = best.get(key)
    if (!prev || score > prev.score) best.set(key, { pct: row.model_pct, score })
  }

  const modelByFund = new Map<string, Map<string, number>>()
  for (const [key, value] of best) {
    const [fund, date] = key.split('|') as [string, string]
    const perDate = modelByFund.get(fund) ?? new Map<string, number>()
    perDate.set(date, value.pct)
    modelByFund.set(fund, perDate)
  }

  const navsByFund = new Map<string, NavDay[]>()
  for (const row of db
    .prepare('select fund_code, nav_date, pct from nav_history order by nav_date asc')
    .all() as unknown as Array<{ fund_code: string; nav_date: string; pct: number }>) {
    const list = navsByFund.get(row.fund_code) ?? []
    list.push({ date: row.nav_date, pct: row.pct })
    navsByFund.set(row.fund_code, list)
  }

  const fit = fitSlot(modelByFund, navsByFund)
  const slot = slotOverride ?? fit.slot

  const perFund: FundAccuracy[] = []
  let allResiduals: Residual[] = []

  for (const fund of funds) {
    const model = modelByFund.get(fund.code) ?? new Map()
    const navs = navsByFund.get(fund.code) ?? []
    const residuals = alignResiduals(model, navs, slot)
    const s = summarize(residuals)
    allResiduals = allResiduals.concat(residuals)
    perFund.push({
      code: fund.code,
      name: fund.name || fund.code,
      n: s.n,
      mae: s.mae,
      bias: s.bias,
      exposure: fund.exposure,
      // 每只基金用自己的残差拟合：拿全组合的斜率去改单只基金是另一种糊弄
      suggestedExposure: fitExposure(
        residuals.map((r) => r.modelPct),
        residuals.map((r) => r.actualPct),
      ),
    })
  }

  const overall = summarize(allResiduals)
  return {
    slot,
    mae: overall.mae,
    samples: overall.n,
    enough: overall.n >= 6,
    slotCandidates: fit.candidates,
    funds: perFund,
  }
}

export function registerAccuracyRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Querystring: { slot?: unknown } }>('/api/accuracy', async (req) => {
    const raw = req.query?.slot
    const slot = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : undefined
    return buildAccuracy(db, Number.isFinite(slot) ? slot : undefined)
  })
}
