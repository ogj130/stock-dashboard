import { describe, it, expect } from 'vitest'
import { derivePhase, isPreMarket, derivePhaseLocal } from '../../src/engine/phase'

describe('phase', () => {
  it('盘中与盘前都是 live', () => {
    expect(derivePhase('REG_MKT')).toBe('live')
    expect(derivePhase('PRE_MKT')).toBe('live')
  })
  it('盘后与闭市都是 settled', () => {
    expect(derivePhase('POST_MKT')).toBe('settled')
    expect(derivePhase('CLOSED')).toBe('settled')
  })
  it('盘前被单独标记，用于 UI 不覆盖已定数值', () => {
    expect(isPreMarket('PRE_MKT')).toBe(true)
    expect(isPreMarket('REG_MKT')).toBe(false)
  })
})

describe('derivePhaseLocal', () => {
  // 2026-11-09 是周一，美东为 EST(-05:00)
  it('美东周一 10:00 是盘中', () => {
    expect(derivePhaseLocal(new Date('2026-11-09T15:00:00Z'))).toBe('REG_MKT')
  })
  it('美东周一 05:00 是盘前', () => {
    expect(derivePhaseLocal(new Date('2026-11-09T10:00:00Z'))).toBe('PRE_MKT')
  })
  it('美东周一 02:00 是闭市', () => {
    expect(derivePhaseLocal(new Date('2026-11-09T07:00:00Z'))).toBe('CLOSED')
  })
  it('周六永远闭市', () => {
    expect(derivePhaseLocal(new Date('2026-11-07T15:00:00Z'))).toBe('CLOSED')
  })
  it('夏令时切换后仍按美东当地钟点判定', () => {
    // 2026-07-06 周一，EDT(-04:00)：13:00Z = 09:00 美东，属盘前
    expect(derivePhaseLocal(new Date('2026-07-06T13:00:00Z'))).toBe('PRE_MKT')
  })
})
