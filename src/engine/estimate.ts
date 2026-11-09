import type { EstimateInput, EstimateResult } from '../types'

/**
 * QDII 净值涨跌估算。
 *
 *   r_cov   = Σ(wᵢ·pctᵢ) / Σwᵢ           已覆盖部分的加权涨跌（pct 是百分数）
 *   W_cov   = min(1, max(0, Σwᵢ))         覆盖率：只有前十大时约 0.5~0.7
 *   W_unc   = 1 − W_cov                   未覆盖部分
 *   r_stock = W_cov·r_cov + W_unc·r_unc   未覆盖部分用残差代理，默认 0
 *   r_fx    = fxNow/fxPrev − 1            汇率收益率（小数）
 *   r_asset = (1+r_stock/100)(1+r_fx) − 1 复合；r_stock 是百分数，先 /100
 *   r_nav   = exposure · r_asset · 100    回到百分数
 *
 * exposure 由 calibrate 拟合，代表基金实际投资于标的资产的仓位比例
 * （联接基金常把 ~95% 投进 ETF，剩现金拖累收益）。余额收益按 0 计。
 *
 * 量纲契约：pct/navPct/stockPct/fxPct/contribution 均为百分数；
 * weight/exposure/coveredWeight 均为 0~1 小数；fxNow/fxPrev 是汇率原值。
 */
export function estimateNav(input: EstimateInput): EstimateResult {
  const { holdings, fxNow, fxPrev, exposure, residualPct } = input

  const totalWeight = holdings.reduce((s, h) => s + h.weight, 0)
  // totalWeight === 0 时不做除法，避免 0/0 → NaN
  const weighted =
    totalWeight > 0 ? holdings.reduce((s, h) => s + h.weight * h.pct, 0) / totalWeight : 0

  // 权重可能 < 1（只覆盖前十大）也可能 > 1（脏数据），两头都夹住
  const wCov = Math.min(1, Math.max(0, totalWeight))
  const wUnc = Math.max(0, 1 - wCov)
  const rUnc = residualPct ?? 0
  const rStock = wCov * weighted + wUnc * rUnc

  const rFx = fxPrev > 0 ? fxNow / fxPrev - 1 : 0
  const rAsset = (1 + rStock / 100) * (1 + rFx) - 1
  const rNav = exposure * rAsset * 100

  return {
    stockPct: rStock,
    fxPct: rFx * 100,
    navPct: rNav,
    coveredWeight: wCov,
    // 贡献 = 该股在「已覆盖组合」里的份额 × 自身涨跌 × 覆盖率 × 仓位，
    // 因此 exposure=1、r_fx=0 时各项之和 == navPct
    breakdown:
      totalWeight > 0
        ? holdings
            .map((h) => ({
              symbol: h.symbol,
              weight: h.weight,
              pct: h.pct,
              contribution: (h.weight / totalWeight) * h.pct * wCov * exposure,
            }))
            // 按贡献绝对值降序：展开明细时第一眼该看到「谁最影响这只基金」，
            // 而不是代码字母序第一只
            .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
        : [],
  }
}
