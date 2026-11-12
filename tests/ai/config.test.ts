import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activeProfile,
  defaultAiConfigPath,
  isConfigured,
  maskKey,
  newProfileId,
  normalizeBaseUrl,
  readAiStore,
  writeAiStore,
} from '../../src/ai/config'

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'qdii-ai-')), 'ai.json')

afterEach(() => {
  delete process.env.AI_BASE_URL
  delete process.env.AI_MODEL
  delete process.env.AI_API_KEY
})

describe('ai.json · 多配置档案', () => {
  it('默认路径与 db 同级', () => {
    expect(defaultAiConfigPath('/data/qdii/app.db')).toBe('/data/qdii/ai.json')
  })

  it('写入后能读回，文件权限 0600，activeId 保留', () => {
    const file = tmpFile()
    writeAiStore(file, {
      activeId: 'p-a',
      profiles: [
        { id: 'p-a', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-a' },
        { id: 'p-b', name: '本地', baseUrl: 'http://127.0.0.1:8788', model: 'local', apiKey: '' },
      ],
    })
    const store = readAiStore(file)
    expect(store.activeId).toBe('p-a')
    expect(store.profiles).toHaveLength(2)
    expect(activeProfile(store)?.name).toBe('DeepSeek')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8')).profiles[0].apiKey).toBe('sk-a')
  })

  it('activeId 指向不存在的档案时退回第一条', () => {
    const file = tmpFile()
    writeAiStore(file, {
      activeId: 'gone',
      profiles: [{ id: 'p-a', name: 'A', baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' }],
    })
    expect(readAiStore(file).activeId).toBe('p-a')
  })

  it('旧版扁平配置自动迁移成「默认」档案', () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ baseUrl: 'https://old/v1', model: 'old-model', apiKey: 'old-key' }))
    const store = readAiStore(file)
    expect(store.profiles).toHaveLength(1)
    expect(store.profiles[0]).toMatchObject({ id: 'default', name: '默认', model: 'old-model' })
    expect(store.activeId).toBe('default')
  })

  it('文件坏了当作没配；空文件时环境变量兜底', () => {
    const file = tmpFile()
    writeFileSync(file, '{not json')
    expect(readAiStore(file).profiles).toEqual([])

    process.env.AI_BASE_URL = 'https://env.example/v1'
    process.env.AI_MODEL = 'env-model'
    process.env.AI_API_KEY = 'env-key'
    const store = readAiStore(file)
    expect(store.profiles[0]).toMatchObject({ id: 'env', baseUrl: 'https://env.example/v1' })
  })

  it('newProfileId 不重复', () => {
    expect(newProfileId()).not.toBe(newProfileId())
    expect(newProfileId()).toMatch(/^p-[0-9a-f]{8}$/)
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
  })

  it('三项齐全才算配置完成', () => {
    expect(isConfigured({ baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' })).toBe(true)
    expect(isConfigured({ baseUrl: 'https://x/v1', model: 'm', apiKey: '' })).toBe(false)
  })
})
