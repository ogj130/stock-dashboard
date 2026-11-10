# 工作约定（给所有接手这个仓库的 agent / 未来的自己）

## 改完之后必须重载（用户的明确要求）

**每一次改动之后，都要把后端和 Mac 菜单栏卡片重新拉起来**，用户不需要自己点：

```bash
./tools/dev/reload.sh      # 等价于 pnpm reload
```

它按顺序做四件事：构建前端 → 重启后端（launchd 会用新 dist 拉起）→
按需重编卡片 → **杀掉旧卡片进程并重新 `open`**。

为什么不能用「只改代码不重载」糊过去：

- 前端产物是哈希文件名的，重建后旧页面手里的资源 404，页面会白掉；
- 后端在 `@fastify/static` 里按启动时的 dist 注册路由，重建必须重启进程；
- 卡片是常驻 WKWebView，不重新拉就停在旧数据上——「改了却看不到」比报错更浪费人。

验收标准：脚本最后会打印卡片 pid；同时 `grep compact ~/Library/Logs/qdii-server.log`
里应出现一条新的 `/?compact=1` 请求（说明卡片真的重新加载了，不是只有进程活着）。

## 服务由 launchd 托管

`~/Library/LaunchAgents/local.qdii.server.plist`（模板在 `tools/dev/`）。
登录即起、退出即拉，日志 `~/Library/Logs/qdii-server.log`。

```bash
launchctl print gui/$(id -u)/local.qdii.server     # 状态
lsof -ti:5178 | xargs kill                          # 重启（KeepAlive 会拉起）
./tools/dev/install-launchd.sh                      # 重装/换目录后
```

## 数据红线

- 测试与验证**不许碰** `data/app.db`（用户真实持仓）；用 `DB_PATH=/tmp/xxx.db`。
- `git add` 必须显式列路径，不许 `git add -A`。
- 备份在 `data/backups/`（每日 `vacuum into`，留 7 份），已 gitignore。

## 估值口径的三条硬约束（改之前先读）

1. QDII 净值 T+1/T+2 滞后：市值必须按滞后链复合（见 `src/engine/pipeline.ts` 的 `navChain`）。
2. 跟踪指数的基金：常规时段用官方指数涨跌幅，盘前用代理 ETF（QQQ/SPY），不用成分自算。
3. 对账对齐按「这场之后第 slot 次公布」，不能按自然日 +N（周末必错，见 `src/engine/reconcile.ts`）。
