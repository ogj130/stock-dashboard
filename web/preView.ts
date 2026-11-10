/**
 * 盘前视图换算。
 *
 * 盘前时段后端一次给两组数：`navPct` 是**上一交易日收盘**那一段（常规行情接口
 * 在盘前只会给这个），`preMarket` 是今天盘前进行中的那一段。两组都真，
 * 但只有后者是「现在」。
 *
 * 换算放在这一层而不是让每个组件各自判断，是为了让表格、汇总、排序、
 * 菜单栏卡片看到同一份数——否则很容易出现「涨跌是盘前的、金额是昨收的」，
 * 这种错位肉眼几乎看不出来。
 */
export interface PreViewFund {
  nav: number
  shares: number
  costBasis: number
  navPct: number
  amount: number
  marketValue: number
  holdingProfit: number
  preMarket?: {
    navPct: number
    amount: number
    basis: 'index' | 'constituents'
    constituentPct?: number
  }
}

/**
 * 把盘前数字铺到主字段上。
 *
 * **两段是串起来的，不是替换关系。** 这是这张表最容易算错的地方：
 * `navPct`（收盘口径）估的是「上一场美股收盘带来的净值变化」，而盘前涨跌是从
 * 那个收盘价再往后走的一段。所以当前价值 = 收盘估值市值 × (1 + 盘前涨跌)，
 * 而盘前那一段自己的盈亏 = 收盘估值市值 × 盘前涨跌。
 *
 * 早先的写法是直接拿 `nav × shares × (1 + 盘前)` 当市值，等于把上一场 3.18% 的
 * 涨幅凭空抹掉——总市值瞬间少三万多，看着像亏了，其实是把两段时间混成了一段。
 * 这里用 f.marketValue（= 收盘估值市值）当基准，天然避开这个坑。
 *
 * 没有盘前读数（覆盖不足/取数失败）的基金原样返回——宁可显示昨收，
 * 也不能凭空造一个 0。
 */
export function applyPreView<T extends PreViewFund>(f: T): T {
  const pm = f.preMarket
  if (!pm) return f
  const closeValue = f.marketValue
  const marketValue = closeValue * (1 + pm.navPct / 100)
  return {
    ...f,
    navPct: pm.navPct,
    // 盘前这一段自己带来的盈亏，而不是相对净值的那一整段
    amount: closeValue * (pm.navPct / 100),
    marketValue,
    holdingProfit: marketValue - f.costBasis,
  }
}

/** 批量：只对带盘前读数的基金生效 */
export function preViewFunds<T extends PreViewFund>(funds: readonly T[]): T[] {
  return funds.map(applyPreView)
}
