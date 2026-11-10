export const CONFIG = {
  batchSize: 100,
  // indices：底部指数条。它只是背景信息，30 秒一次足够，不必陪 5 秒轮询跑
  // pre 与 live 同频：盘前成交稀但价在跳，30 秒缓存足够（取数本身另有 60 秒缓存）
  staleMs: { pre: 30_000, live: 30_000, settled: 600_000, fx: 60_000, indices: 30_000 },
  conflictTolerance: 0.005,      // 主备偏差 0.5% 触发裁决
  degradeAfterFailures: 3,
  degradeCooldownMs: 600_000,
  pollMs: { pre: 5_000, live: 5_000, settled: 600_000 },
  cnbcRecheckMs: 300_000,
  navPollMs: 1_800_000,
  calibrationWindow: 60,
} as const
