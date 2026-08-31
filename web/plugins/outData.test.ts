import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveAbsoluteRoot } from './outData'

describe('resolveAbsoluteRoot', () => {
  it('prefers the absolute root recorded at generation time (tic-7f0b)', () => {
    expect(
      resolveAbsoluteRoot({ root: '../carnot', root_abs: 'Y:/projects/carnot' }, '/out'),
    ).toBe('Y:/projects/carnot')
  })

  it('normalises a Windows absolute root to forward slashes', () => {
    expect(
      resolveAbsoluteRoot({ root: '..\\carnot', root_abs: 'Y:\\projects\\carnot' }, '/out'),
    ).toBe('Y:/projects/carnot')
  })

  it('falls back to the relative root resolved against the out dir when root_abs is absent', () => {
    const dir = resolve('/repo/out')
    // Old export (no root_abs): degrade to the pre-fix behaviour -- the dev
    // server joins the relative root with the out directory.
    expect(resolveAbsoluteRoot({ root: '../carnot' }, dir)).toBe(resolve(dir, '../carnot'))
  })

  it('returns null when no root is present at all', () => {
    expect(resolveAbsoluteRoot({}, '/out')).toBeNull()
    expect(resolveAbsoluteRoot(undefined, '/out')).toBeNull()
  })

  it('ignores a non-string root_abs', () => {
    expect(resolveAbsoluteRoot({ root: '', root_abs: 42 }, '/out')).toBeNull()
  })
})
