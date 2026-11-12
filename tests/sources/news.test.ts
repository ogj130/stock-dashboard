import { describe, it, expect } from 'vitest'
import {
  NewsReader,
  cleanNewsTitle,
  parseEastmoneyNews,
  parseEastmoneyTime,
  pickNews,
  type NewsItem,
} from '../../src/sources/news'

/**
 * 夹具照抄东财真实回包的外形（`var ajaxResult={...};`），字段名一个都不能猜：
 * 这个接口是非官方接口，形状一变解析就会静默返回空数组——夹具就是那道防线。
 */
const FIXTURE = `var ajaxResult={"rc":1,"me":"","LivesList":[
  {"id":"202611123928809947","url_w":"http://finance.eastmoney.com/a/1.html","url_m":"https://wap.eastmoney.com/a/1.html","title":"乌克兰总统泽连斯基已抵达爱尔兰","showtime":"2026-11-12 01:30:47","titlestyle":"0"},
  {"id":"202611123928809741","url_w":"http://finance.eastmoney.com/a/2.html","url_m":"http://wap.eastmoney.com/a/2.html","title":"<b>瑞士法郎</b>兑美元跌幅扩大至1%","showtime":"2026-11-12 01:20:35","titlestyle":"3"},
  {"id":"202611123928809947","url_w":"http://finance.eastmoney.com/a/dup.html","title":"重复 id 只留第一条","showtime":"2026-11-12 01:31:00","titlestyle":"0"},
  {"id":"no-time","title":"缺时间的那条","showtime":"","titlestyle":"0"},
  {"id":"202611123928809000","title":"   ","showtime":"2026-11-12 01:00:00","titlestyle":"0"}
],"PageCount":1}`

const item = (over: Partial<NewsItem> = {}): NewsItem => ({
  id: 'a',
  title: '标题',
  url: '',
  source: 'eastmoney',
  tsMs: 1_000,
  important: false,
  ...over,
})

describe('parseEastmoneyTime · 北京时间 → epoch', () => {
  it('"2026-11-12 01:30:47" 按 +08:00 换算', () => {
    expect(parseEastmoneyTime('2026-11-12 01:30:47')).toBe(Date.UTC(2026, 10, 12, 1, 30, 47) - 8 * 3600_000)
  })

  it('T 分隔符也认（别把 ISO 串当成坏数据）', () => {
    expect(parseEastmoneyTime('2026-11-12T01:30:47')).toBe(parseEastmoneyTime('2026-11-12 01:30:47'))
  })

  it('空串 / 格式不对 → null，不返回「现在」' , () => {
    expect(parseEastmoneyTime('')).toBeNull()
    expect(parseEastmoneyTime('01:30:47')).toBeNull()
    expect(parseEastmoneyTime('2026/11/12 01:30:47')).toBeNull()
  })
})

describe('cleanNewsTitle', () => {
  it('去标签、解实体、压缩空白', () => {
    expect(cleanNewsTitle('<b>瑞士法郎</b>&nbsp;兑美元   跌幅&amp;扩大')).toBe(
      '瑞士法郎 兑美元 跌幅&扩大',
    )
  })

  it('纯空白 → 空串（调用方据此丢行）', () => {
    expect(cleanNewsTitle('   ')).toBe('')
  })
})

describe('parseEastmoneyNews', () => {
  it('解析 var ajaxResult=... 的赋值形式，并按 id 去重', () => {
    const items = parseEastmoneyNews(FIXTURE)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      id: '202611123928809947',
      title: '乌克兰总统泽连斯基已抵达爱尔兰',
      url: 'https://wap.eastmoney.com/a/1.html',
      important: false,
    })
    // 第二条：title 里有 HTML、titlestyle=3 标重要、url_m 不是 https 就退回 url_w
    expect(items[1]).toMatchObject({
      id: '202611123928809741',
      title: '瑞士法郎兑美元跌幅扩大至1%',
      url: 'http://finance.eastmoney.com/a/2.html',
      important: true,
    })
  })

  it('缺时间 / 空标题的行整条丢弃，不影响其它条', () => {
    const items = parseEastmoneyNews(FIXTURE)
    expect(items.map((i) => i.id)).not.toContain('no-time')
  })

  it('回包形状变了（不是 JSON / 没有 LivesList）→ 空数组，不抛错', () => {
    expect(parseEastmoneyNews('<html>502 Bad Gateway</html>')).toEqual([])
    expect(parseEastmoneyNews('var ajaxResult={"rc":1};')).toEqual([])
    expect(parseEastmoneyNews('')).toEqual([])
  })
})

describe('pickNews · 重要优先，其余按时间降序', () => {
  it('重要事件排最前，同组内新的在前', () => {
    const items = [
      item({ id: 'old', tsMs: 10 }),
      item({ id: 'imp-old', tsMs: 20, important: true }),
      item({ id: 'new', tsMs: 30 }),
      item({ id: 'imp-new', tsMs: 40, important: true }),
    ]
    expect(pickNews(items, 5).map((i) => i.id)).toEqual(['imp-new', 'imp-old', 'new', 'old'])
  })

  it('limit 生效且不改动入参', () => {
    const items = [item({ id: 'a', tsMs: 3 }), item({ id: 'b', tsMs: 2 })]
    expect(pickNews(items, 1).map((i) => i.id)).toEqual(['a'])
    expect(items.map((i) => i.id)).toEqual(['a', 'b'])
  })
})

describe('NewsReader · 60 秒缓存与失败回退', () => {
  it('TTL 内不重复打外网，过期后重新拉', async () => {
    let now = 0
    let calls = 0
    const reader = new NewsReader({
      fetchNews: async () => {
        calls += 1
        return [item({ id: `n${calls}`, tsMs: 1 })]
      },
      now: () => now,
    })

    expect((await reader.read(5)).items[0]!.id).toBe('n1')
    now = 30_000
    expect((await reader.read(5)).items[0]!.id).toBe('n1')
    expect(calls).toBe(1)

    now = 60_000
    expect((await reader.read(5)).items[0]!.id).toBe('n2')
    expect(calls).toBe(2)
  })

  it('首次失败 → 空数组 + stale，HTTP 层面仍是成功', async () => {
    const warns: unknown[] = []
    const reader = new NewsReader({
      fetchNews: async () => {
        throw new Error('boom')
      },
      now: () => 0,
      onWarn: (err) => warns.push(err),
    })
    expect(await reader.read(5)).toEqual({ items: [], tsMs: 0, stale: true })
    expect(warns).toHaveLength(1)
  })

  it('有旧缓存但这一轮失败 → 继续给旧条目 + stale', async () => {
    let fail = false
    let now = 0
    const reader = new NewsReader({
      fetchNews: async () => {
        if (fail) throw new Error('boom')
        return [item({ id: 'cached', tsMs: 1 })]
      },
      now: () => now,
    })
    await reader.read(5)
    fail = true
    now = 61_000
    const payload = await reader.read(5)
    expect(payload.stale).toBe(true)
    expect(payload.items.map((i) => i.id)).toEqual(['cached'])
  })

  it('并发读只发一次请求', async () => {
    let calls = 0
    const reader = new NewsReader({
      fetchNews: async () => {
        calls += 1
        return [item()]
      },
      now: () => 0,
    })
    await Promise.all([reader.read(5), reader.read(5), reader.read(5)])
    expect(calls).toBe(1)
  })
})
