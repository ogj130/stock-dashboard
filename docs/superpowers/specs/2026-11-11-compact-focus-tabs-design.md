# 卡片「个股 / 大事」三 Tab · 设计文档

- 日期：2026-11-11
- 状态：已实现（2026-11-12；卡片外壳仍为 340×420，Tab 占 22px，基金列表少显示约一行）
- 作者：大鱼鱼（与 ouguangji 共同敲定）

## 1. 背景与目标

### 1.1 问题

菜单栏卡片（`?compact=1`，340×420）目前只回答一个问题：**我的基金今天涨了多少**。它把 16 只基金按市值列出来，但看不到这些基金共同押注的那几只美股今天在干什么，也看不到与持仓相关的近期大事。用户要判断“今天这波是普涨还是英伟达一只票拉起来的”，还得另外开行情软件。

### 1.2 目标

在卡片列表区加入「基金 / 个股 / 大事」三个 Tab：

1. **个股**：把 16 只基金的持仓按组合市值聚合成前 8 只重点个股，显示组合权重与当日涨跌幅，5 秒随估值刷新。
2. **大事**：显示最近 5 条财经快讯，重要事件优先，60 秒刷新；标题命中持仓股名时标注「持仓」。
3. **基金**：现有列表原样保留，不改排序、不改列宽、不改降级规则。

### 1.3 非目标

- 不新增个股行情请求。个股涨跌直接复用 `/api/estimate` 已经取到的 `breakdown`，不为这个功能扩大行情请求量。
- 不做个股 K 线、不做新闻详情页、不做点击跳转（卡片仍然只保留「完整页面」一个出口）。
- 不做新闻的语义分类/情绪分析，只做时间、重要度、持仓关键词命中这三种轻量标记。
- 不改完整页面（`App.tsx`）；本期只动卡片。

## 2. 现状与约束

| 约束 | 现状 |
|---|---|
| 卡片尺寸 | Swift 外壳固定 340×420（`tools/mac-card/card.swift` 的 `kCardSize`） |
| 列表滚动 | 只有基金列表可滚，页面本身不允许出现滚动条（`compact.css` 顶部三条硬约束） |
| 取数 | 卡片每 5 秒拉 `/api/estimate` 与 `/api/portfolio/history?range=session` |
| 估值数据 | 每只基金的 `FundEstimate.breakdown` 已含 `symbol / name / weight / pct / contribution` |
| 样式 | 暗色玻璃拟态，`--up` 红涨、`--down` 绿跌、`--muted` 次要信息 |
| 服务 | launchd 托管，改动后必须 `pnpm reload` 重载后端与卡片 |

## 3. 方案

### 3.1 数据流

```
/api/estimate (已有, 5s)
   └─ funds[].breakdown ──► 前端 deriveKeyStocks() ──► 个股 Tab
/api/news (新增, 60s 缓存)
   └─ items[] ──► 前端 deriveNewsRows() ──► 大事 Tab
```

个股不新增后端接口：`breakdown` 本来就是估值链的中间产物，卡片只是把它从“每只基金内部”抬到“整个组合”这一层看。

### 3.2 个股聚合规则

对每只基金 `f` 的每条持仓 `h`：

```
exposure(h)   += f.marketValue * h.weight          // 美元暴露
pctWeighted(h) += f.marketValue * h.weight * h.pct // 加权涨跌
```

汇总后：

```
组合权重% = exposure(h) / Σ f.marketValue * 100
当日涨跌% = pctWeighted(h) / exposure(h)
```

- 同一 symbol 被多只基金持有 → 合并成一行，不重复计。
- 名称取第一条非空 `h.name`，空则退回 symbol。
- 只保留 `weight > 0` 且 `pct` 有限的持仓；`breakdown` 缺失的基金跳过。
- 按 `exposure` 降序取前 8，同暴露按 symbol 升序（稳定、可测）。
- 个股行展示：`英伟达 NVDA` / `4.2%` / `+2.31%`，权重列定宽 42px、涨跌列定宽 52px。

### 3.3 快讯接口契约

新增 `GET /api/news?limit=5`：

```ts
interface NewsItem {
  id: string
  title: string        // 已去 HTML、压缩空白
  url: string          // 优先 url_m（https），退回 url_w
  source: 'eastmoney'
  tsMs: number         // showtime 按 Asia/Shanghai 解析
  important: boolean   // titlestyle !== '0'
}

interface NewsResponse {
  items: NewsItem[]
  tsMs: number
  stale: boolean       // true = 这次没拉到，返回的是上一次缓存
}
```

- `limit` 夹在 1–10，缺省 5。
- 数据源：东财快讯 `https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_50_1_.html`，响应是 `var ajaxResult={...};`，取第一个 `{` 到最后一个 `}` 之间做 JSON 解析。
- 选取顺序：`important` 优先、其余按 `tsMs` 降序，取 `limit` 条；同一 `id` 去重。
- 服务端缓存 60 秒；拉取失败时返回上一次成功缓存并置 `stale: true`；从未成功过则返回空数组。
- 路由永不 500：失败只记一条节流 warn，卡片拿到空数组后显示“资讯暂不可用”。

### 3.4 卡片 UI

```
┌───────────────────────────┐
│ 总资产 240,845.63          │  ← 不动
│ 今日估算 +5,643.32 +2.34%  │
│ 持有收益 +18,015.52        │
│ [迷你曲线 52px]            │
│ ┌─────┬─────┬─────┐        │  ← 新增 22px 三段切换
│ │基金 │个股 │大事 │        │
│ ├─────┴─────┴─────┤        │
│ │ 当前 Tab 的列表   │        │  ← 唯一可滚动区
│ │                  │        │
│ └──────────────────┘        │
│ ● 盘前 · 5秒刷新   20:53 完整页面 │  ← 不动
└───────────────────────────┘
```

- Tab 默认「基金」，不持久化；切换只改本地 state，不重新请求。
- 个股行三列：名称+代码（flex）、组合权重（42px，muted）、涨跌（52px，红/绿/灰）。
- 大事行：`20:46`（9px muted）+ 标题（10.5px，两行截断）+ 标签；行间 1px 分隔线。
  - `important` → 「重要」小标签（`--warn`）
  - 标题命中任一重点个股的 name（长度 ≥ 2）或 ticker（词边界、大小写不敏感）→ 「持仓」小标签
  - 两个标签可同时出现，最多两个，不换行。
- 列表区复用现有 `.cc-list` 的滚动与隐藏滚动条规则；三个 Tab 各自一个 `<ul>`，空态各自给文案。
- 可访问性：`role="tablist"` / `role="tab"` / `aria-selected`；列表 `aria-label` 分别为“全部基金 / 重点个股 / 近期大事”。

### 3.5 刷新与缓存

| 数据 | 前端 | 后端 |
|---|---|---|
| 基金估值 / 个股 | 5 秒（沿用现有 tick） | `/api/estimate` 现有逻辑 |
| 快讯 | 挂载时拉一次，之后每 60 秒 | `/api/news` 60 秒缓存 |

快讯失败不影响个股与基金：三个 Tab 的数据各自独立，新闻挂了只让「大事」显示降级文案。

### 3.6 降级规则

| 场景 | 显示 |
|---|---|
| `breakdown` 全缺失 | 个股 Tab：「暂无持仓明细」 |
| 个股有数据但不足 8 只 | 有多少显示多少，不补空行 |
| 快讯从未成功 | 大事 Tab：「资讯暂不可用」 |
| 快讯有旧缓存但本轮失败 | 继续显示旧条目，Tab 标题旁加极淡「缓存」二字 |
| 基金列表为空 | 维持现有「还没有基金 / 正在读取… / 连不上后端」三分支 |

## 4. 文件改动

| 文件 | 改动 |
|---|---|
| `src/sources/news.ts` | 新增：东财快讯抓取、解析、60 秒缓存、失败回退 |
| `src/routes/news.ts` | 新增：`GET /api/news`，注入式 fetch 便于离线测试 |
| `src/server.ts` | 注册 `registerNewsRoutes(app)` |
| `web/compact.ts` | 新增 `deriveKeyStocks` / `deriveNewsRows` / 类型；纯函数、不 import React |
| `web/CompactCard.tsx` | 三 Tab state、快讯 60 秒轮询、三个列表分支 |
| `web/compact.css` | `.cc-tabs` / `.cc-stock-*` / `.cc-news-*` 样式 |
| `tests/web/compact.test.ts` | 追加聚合、排序、降级、标签命中用例 |
| `tests/sources/news.test.ts` | 新增解析夹具（`var ajaxResult=...`） |
| `tests/routes/news.test.ts` | 新增成功 / 失败 / 缓存 / limit 夹取用例 |

无数据库迁移、无新增依赖、无配置项。

## 5. 测试计划

1. `deriveKeyStocks`
   - 两只基金持有同一 symbol → 合并、暴露相加、权重按总市值算。
   - 按暴露降序、同暴露按 symbol；超过 8 只截断。
   - `breakdown` 缺失 / weight 为 0 → 跳过，不产生假 0。
   - 名称缺失 → 退回 symbol。
2. `deriveNewsRows`
   - `showtime` → `HH:MM`。
   - 标题命中 name / ticker → `related: true`；大小写与词边界正确。
   - `important` 保留。
3. `parseEastmoneyNews`
   - 解析 `var ajaxResult=...;`、去 HTML、时间转 epoch（Asia/Shanghai）。
   - 缺字段 / 空列表 → 返回 `[]` 不抛错。
4. `/api/news`
   - 正常返回 5 条、`stale=false`。
   - 源抛错且无缓存 → `items: []`、HTTP 200。
   - 源抛错但有缓存 → 返回旧条目、`stale=true`。
   - `limit=999` → 夹到 10。
5. 回归：`pnpm test` 全绿、`pnpm typecheck` 通过；现有 compact 用例不改口径。

## 6. 验收标准

- `pnpm test` 与 `pnpm typecheck` 均通过。
- `pnpm reload` 后卡片重新加载（`grep compact ~/Library/Logs/qdii-server.log` 出现新的 `/?compact=1`）。
- 卡片出现三个 Tab；「基金」内容与改动前逐行一致。
- 「个股」显示 8 行以内，权重合计不等于 100%（因为只取前 8）但顺序与**当日成交额**（热度）一致（见 §9.1）。
- 「大事」显示 5 条，重要事件带「重要」，命中持仓的带「持仓」。
- 断网/东财快讯失败时，卡片不白屏、不报错，大事 Tab 显示缓存或「资讯暂不可用」。
- 盘前、盘中、收盘三个相位各看一次，个股涨跌与基金列表里的涨跌方向不矛盾。

## 7. 风险与取舍

- **东财快讯是非官方接口**：路径或字段可能变。解析器单独成文件 + 夹具测试；失败只降级，不影响估值主链路。
- **新闻相关度有限**：只匹配标题，不匹配正文，避免把“提到英伟达”当成“英伟达大事”。宁可少标，不多标。
- **盘前个股名称可能是英文**：盘前行情源不带中文名，ticker 始终显示，不影响识别。
- **Tab 占用 22px**：基金列表少显示约一行，但列表本来就可滚动，可接受。
- **点击跳转的边界**：快讯点击交给 Swift 外壳用系统浏览器打开（只放行 http/https），卡片自身不做内嵌浏览（见 §9.3）。

## 8. 回滚

删除新增文件、还原 `src/server.ts` 的注册行、还原 `CompactCard.tsx` / `compact.ts` / `compact.css` 即可；无数据迁移，回滚不影响 `data/app.db`。

## 9. 实现记录与修订（2026-11-12）

### 9.1 个股顺序改为「热度」

- 口径：按**当日成交额（美元）降序**取前 8，成交额缺失时退回组合暴露降序，再同值按 symbol 升序。
- 数据来源：复用同一次 `/api/estimate`，不给卡片新增行情请求。腾讯 `[37]` 与东财 `f6` 本来就带成交额，`Quote.turnover` → `FundEstimate.breakdown[].turnover` 透传；CNBC / 新浪缺这个字段时不写键，前端据此降级。
- 为什么不是按组合权重：权重回答不了「今天市场在炒什么」，而这个 Tab 的目的正是看持仓里哪几只在今天最活跃。组合权重仍然在行内如实显示。

### 9.2 个股显示中文名

- 名称优先级（`src/engine/pipeline.ts`）：行情源中文名 > 指数报文英文公司名 > ticker。
- 腾讯 `[1]`、新浪 `[0]`、东财 `f14` 都是中文简称，本次把腾讯/新浪的解析补上（此前只有东财提供，东财域名解析失败时整卡都是英文全称）。
- 兜底：英文全称仍会剥掉 `Common Stock` / `Class A` / `Inc.` 等后缀再显示（`shortenStockName`）。
- 副产品：大事 Tab 的「持仓」标签终于能命中中文标题（此前英文名与中文快讯永远匹配不上）。

### 9.3 大事可点击跳转

- 每行是一个 `<button>`，点击发 `postMessage('open-url:<url>')`；Swift 外壳只接受 http/https，用 `NSWorkspace` 打开系统浏览器，并收起置顶卡片（否则它会一直盖在文章上）。
- 在普通浏览器里调试卡片时退回 `window.open`。
- 没有 URL 的条目仍然显示，只是点了不会有动作。

### 9.4 重载脚本补一步

- `tools/dev/reload.sh` 在 `open` 之前调用 `lsregister -f` 重新登记 bundle：重建会 `rm -rf` 整个 `.app`，LaunchServices 仍记着旧 inode 时会报「executable is missing」（文件明明在），2026-11-12 实际踩到过。
