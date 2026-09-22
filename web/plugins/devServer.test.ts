import { describe, expect, it } from 'vitest'
import { DEFAULT_OUT_DIR, DEFAULT_PORT, resolveHost, resolveOutDir, resolvePort } from './devServer'

describe('resolveOutDir', () => {
  it('keeps the committed default when nothing is set (tic-ac17)', () => {
    expect(resolveOutDir(undefined)).toBe(DEFAULT_OUT_DIR)
    expect(resolveOutDir('')).toBe(DEFAULT_OUT_DIR)
    expect(resolveOutDir('   ')).toBe(DEFAULT_OUT_DIR)
  })

  it('takes the store directory the CLI hands over, trimmed and verbatim', () => {
    expect(resolveOutDir('/media/matt/proj/.adventure-call')).toBe('/media/matt/proj/.adventure-call')
    expect(resolveOutDir('  C:/proj/out ')).toBe('C:/proj/out')
  })
})

describe('resolvePort', () => {
  it('keeps 5175 for plain npm run dev and the F5 launch config', () => {
    expect(resolvePort(undefined)).toBe(DEFAULT_PORT)
    expect(resolvePort('')).toBe(DEFAULT_PORT)
  })

  it('falls back to the default for a value that is not a usable port', () => {
    expect(resolvePort('vite')).toBe(DEFAULT_PORT)
    expect(resolvePort('0')).toBe(DEFAULT_PORT)
    expect(resolvePort('-1')).toBe(DEFAULT_PORT)
    expect(resolvePort('70000')).toBe(DEFAULT_PORT)
  })

  it('honours the port vcall serve --dev resolved', () => {
    expect(resolvePort('5180')).toBe(5180)
    expect(resolvePort(' 5180 ')).toBe(5180)
    expect(resolvePort('65535')).toBe(65535)
  })
})

describe('resolveHost', () => {
  it('leaves the bind address to Vite when nothing was asked for', () => {
    expect(resolveHost(undefined)).toBeUndefined()
    expect(resolveHost('  ')).toBeUndefined()
  })

  it('passes an explicit address through', () => {
    expect(resolveHost('0.0.0.0')).toBe('0.0.0.0')
  })
})
