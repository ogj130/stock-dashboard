import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultAiConfigPath,
  isConfigured,
  maskKey,
  normalizeBaseUrl,
  readAiConfig,
  writeAiConfig,
} from '../../src/ai/config'

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'qdii-ai-')), 'ai.json')

afterEach(() => {
  delete process.env.AI_BASE_URL
  delete process.env.AI_MODEL
  delete process.env.AI_API_KEY
})

describe('ai.json · 配置文件', () => {
  it('默认路径与 db 同级', () => {
    expect(defaultAiConfigPath('/data/qdii/app.db')).toBe('/data/qdii/ai.json')
  })

  it('写入后能读回，文件权限是 0600（密钥不给人看）', () => {
    const file = tmpFile()
    writeAiConfig(file, { baseUrl: 'https://api.deepseek.com/v1/', model: 'deepseek-chat', apiKey: 'sk-test-123456' })
    const cfg = readAiConfig(file)
    expect(cfg.baseUrl).toBe('https://api.deepseek.com/v1/')
    expect(cfg.model).toBe('deepseek-chat')
    expect(cfg.apiKey).toBe('sk-test-123456')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('apiKey 传 undefined 保留原值，传空串清空', () => {
    const file = tmpFile()
    writeAiConfig(file, { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' })
    writeAiConfig(file, { model: 'm2' })
    expect(readAiConfig(file).apiKey).toBe('k')
    writeAiConfig(file, { apiKey: '' })
    expect(readAiConfig(file).apiKey).toBe('')
  })

  it('文件坏了当作没配，不让服务起不来', () => {
    const file = tmpFile()
    writeAiConfig(file, { baseUrl: 'https://x/v1' })
    writeFileSync(file, '{not json')
    expect(readAiConfig(file).baseUrl).toBe('')
  })

  it('文件为空时用环境变量兜底，文件优先', () => {
    const file = tmpFile()
    process.env.AI_BASE_URL = 'https://env.example/v1'
    process.env.AI_MODEL = 'env-model'
    process.env.AI_API_KEY = 'env-key'
    const fromEnv = readAiConfig(file)
    expect(fromEnv).toEqual({ baseUrl: 'https://env.example/v1', model: 'env-model', apiKey: 'env-key' })

    writeAiConfig(file, { baseUrl: 'https://file.example/v1' })
    expect(readAiConfig(file).baseUrl).toBe('https://file.example/v1')
    // 文件里没写的字段仍然吃环境变量
    expect(readAiConfig(file).model).toBe('env-model')
  })
})

describe('配置的小工具', () => {
  it('maskKey 只露前后几位', () => {
    expect(maskKey('sk-1234567890abcdef')).toBe('sk-…cdef')
    expect(maskKey('short')).toBe('••••••')
    expect(maskKey('')).toBe('')
  })

  it('normalizeBaseUrl 去尾斜杠、只认 http(s)', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1')
    expect(normalizeBaseUrl('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1:8080/v1')
    expect(normalizeBaseUrl('ftp://x')).toBeNull()
    expect(normalizeBaseUrl('api.deepseek.com')).toBeNull()
    expect(normalizeBaseUrl('')).toBeNull()
  })

  it('三项齐全才算配置完成', () => {
    expect(isConfigured({ baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' })).toBe(true)
    expect(isConfigured({ baseUrl: 'https://x/v1', model: 'm', apiKey: '' })).toBe(false)
  })
})
