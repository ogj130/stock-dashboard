/**
 * 曲线的局部极值。
 *
 * 需求（2026-11-11）：「支持展示局部最高最低收益/亏损」。
 * 两件事其实是分开的，混在一起会做出一堆看不懂的点：
 *
 *   1. **窗口内的最高/最低**——这一屏里赚得最多与亏得最狠的那一刻。
 *      它一定有，与曲线怎么抖无关（哪怕只有两个点）。
 *   2. **局部拐点**——涨跌方向的转折处。它需要去噪：30 秒一个点，
 *      一段横盘里能有几十个「局部最高」，全画出来等于糊一层点。
 *
 * 所以这里给两个函数：`windowExtremes` 永远给答案；`findExtrema` 用
 * zigzag（阈值 = 全幅 × ratio）只挑出**够格的转折**。
 */

export type ExtremumKind = 'peak' | 'trough'

export interface Extremum {
  index: number
  value: number
  kind: ExtremumKind
  /** 与相邻转折点的落差（用于排序挑重点）；端点附近的极值取与窗口起点的差 */
  prominence: number
}

export interface WindowExtremes {
  peak: { index: number; value: number } | null
  trough: { index: number; value: number } | null
}

/**
 * 窗口内的最高点与最低点。
 *
 * 相等时取**最早**出现的那个：同一天两次摸到最高，先发生的那个才是「高点」，
 * 取最后的会让人以为后来又冲了一次。
 */
export function windowExtremes(values: readonly number[]): WindowExtremes {
  if (values.length === 0) return { peak: null, trough: null }
  let peak = { index: 0, value: values[0]! }
  let trough = { index: 0, value: values[0]! }
  for (let i = 1; i < values.length; i++) {
    const v = values[i]!
    if (!Number.isFinite(v)) continue
    if (v > peak.value) peak = { index: i, value: v }
    if (v < trough.value) trough = { index: i, value: v }
  }
  return { peak, trough }
}

export interface ExtremaOptions {
  /** 去噪阈值占全幅的比例；0.12 表示小于 12% 幅度的来回摆动不算转折 */
  ratio?: number
  /** 最多返回多少个（按 prominence 取前 N，再按时间排序） */
  limit?: number
  /** 最少要多少个点才开始找（点太少时"转折"没有意义） */
  minPoints?: number
}

/**
 * zigzag 找局部峰谷。
 *
 * 起点不预设方向：从第一个点同时记录「候选高点」和「候选低点」，
 * 谁的落差先超过阈值，谁就先成为一个转折点。这样不管曲线是先涨还是先跌都对。
 *
 * 端点（首尾）不当作转折点：它们是窗口边界，不是「涨了又跌回来」——
 * 窗口最高/最低由 `windowExtremes` 单独负责。
 */
export function findExtrema(values: readonly number[], options: ExtremaOptions = {}): Extremum[] {
  const ratio = options.ratio ?? 0.12
  const limit = options.limit ?? 6
  const minPoints = options.minPoints ?? 6
  const n = values.length
  if (n < minPoints) return []

  const finite = values.filter((v) => Number.isFinite(v))
  const max = Math.max(...finite)
  const min = Math.min(...finite)
  const span = max - min
  // 一条完全水平的线没有任何转折可言；用 span 当阈值会得到 0，反而把所有点都算成转折
  if (!(span > 1e-9)) return []
  const eps = span * ratio

  const raw: Extremum[] = []
  let mode: 'unknown' | 'down' | 'up' = 'unknown'
  let candHigh = { index: 0, value: values[0]! }
  let candLow = { index: 0, value: values[0]! }
  let prevPivotValue = values[0]!

  const push = (p: { index: number; value: number }, kind: ExtremumKind): void => {
    if (p.index <= 0 || p.index >= n - 1) return
    raw.push({
      index: p.index,
      value: p.value,
      kind,
      prominence: Math.abs(p.value - prevPivotValue),
    })
    prevPivotValue = p.value
  }

  for (let i = 1; i < n; i++) {
    const v = values[i]!

    if (mode !== 'down' && v > candHigh.value) candHigh = { index: i, value: v }
    if (mode !== 'up' && v < candLow.value) candLow = { index: i, value: v }

    if (mode !== 'down' && candHigh.value - v >= eps) {
      push(candHigh, 'peak')
      mode = 'down'
      candLow = { index: i, value: v }
      continue
    }
    if (mode !== 'up' && v - candLow.value >= eps) {
      push(candLow, 'trough')
      mode = 'up'
      candHigh = { index: i, value: v }
    }
  }

  if (raw.length <= limit) return raw
  const picked = [...raw].sort((a, b) => b.prominence - a.prominence).slice(0, limit)
  return picked.sort((a, b) => a.index - b.index)
}
