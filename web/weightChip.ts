type WeightsFrom = 'index' | 'top10' | 'none'

/**
 * 「估值口径降级」这一类提示语。
 *
 * 单独抽出来是因为这几句文案的差别不是文风问题，而是**下一步动作**问题：
 * - 成分取数失败 → 等重试，会自己好
 * - 没配跟踪指数 → 去填配置，不填永远不会好
 * - 指数涨跌幅没拿到 → 数字会随盘后零星成交漂
 * 说错一句，用户就会去修一个没坏的东西，或者干等一个不会好的状态。
 */
export interface WeightChipInput {
  weightsFrom: WeightsFrom
  indexPctAvailable: boolean
  indexWeightsUnavailable: boolean
}

export type ChipTone = 'warn' | 'bad'

export interface ChipText {
  tone: ChipTone
  text: string
}

export function weightChip(f: WeightChipInput): ChipText | null {
  if (f.weightsFrom === 'none') {
    return { tone: 'bad', text: '未取到持仓，无法估值' }
  }
  if (f.weightsFrom === 'top10') {
    // 同一条分支，两种原因：取数失败会自己好，配置缺失不会
    return f.indexWeightsUnavailable
      ? { tone: 'warn', text: '指数成分获取失败，暂用前十大' }
      : { tone: 'warn', text: '未配置跟踪指数，估值偏保守' }
  }
  // weightsFrom === 'index'：成分是指数口径，但涨跌幅可能是自算的
  if (!f.indexPctAvailable) {
    return { tone: 'warn', text: '指数口径不可用，当前为成分加权' }
  }
  return null
}
