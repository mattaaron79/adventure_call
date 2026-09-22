import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setProjectKey } from '../state/persist'
import { memoryStorage } from '../testing/memoryStorage'
import {
  applyExcludes,
  clearExcludes,
  compileExcludes,
  DEFAULT_EXCLUDES,
  EXCLUDES_STORAGE_KEY,
  globToRegExp,
  normalizePath,
  readExcludes,
  writeExcludes,
} from './filters'

describe('globToRegExp', () => {
  const matches = (pattern: string, path: string) => globToRegExp(pattern).test(path)

  it('anchors the whole path', () => {
    expect(matches('src/app.py', 'src/app.py')).toBe(true)
    expect(matches('src/app.py', 'lib/src/app.py')).toBe(false)
    expect(matches('src/app.py', 'src/app.pyi')).toBe(false)
  })

  it('stops * at a separator', () => {
    expect(matches('src/*.py', 'src/app.py')).toBe(true)
    expect(matches('src/*.py', 'src/deep/app.py')).toBe(false)
    expect(matches('*.py', 'conftest.py')).toBe(true)
  })

  it('matches a single character with ?', () => {
    expect(matches('src/a?.py', 'src/ab.py')).toBe(true)
    expect(matches('src/a?.py', 'src/a/.py')).toBe(false)
  })

  it('spans any number of segments with a trailing **', () => {
    expect(matches('.pytest_tmp/**', '.pytest_tmp/a/b/c.py')).toBe(true)
    expect(matches('.pytest_tmp/**', '.pytest_tmp/c.py')).toBe(true)
    expect(matches('.pytest_tmp/**', 'src/.pytest_tmp/c.py')).toBe(false)
  })

  it('lets an interior ** match zero segments', () => {
    expect(matches('src/**/test_*.py', 'src/test_a.py')).toBe(true)
    expect(matches('src/**/test_*.py', 'src/app/deep/test_a.py')).toBe(true)
    expect(matches('src/**/test_*.py', 'src/app/a.py')).toBe(false)
  })

  it('matches a leading ** at any depth', () => {
    expect(matches('**/__pycache__/**', '__pycache__/x.pyc')).toBe(true)
    expect(matches('**/__pycache__/**', 'src/app/__pycache__/x.pyc')).toBe(true)
    expect(matches('**/__pycache__/**', 'src/app/x.py')).toBe(false)
  })

  it('treats regex metacharacters in a pattern as literals', () => {
    expect(matches('a.b/c+d.py', 'a.b/c+d.py')).toBe(true)
    expect(matches('a.b/c+d.py', 'axb/cccd.py')).toBe(false)
  })
})

describe('normalizePath', () => {
  it('forward-slashes windows paths and drops a leading ./', () => {
    expect(normalizePath('src\\app\\loop.py')).toBe('src/app/loop.py')
    expect(normalizePath('./src/app.py')).toBe('src/app.py')
  })
})

describe('compileExcludes', () => {
  it('excludes a path matching any pattern', () => {
    const excluded = compileExcludes(DEFAULT_EXCLUDES)
    expect(excluded('.pytest_tmp/test_x0/pending/conftest.py')).toBe(true)
    expect(excluded('scratch/spike.py')).toBe(true)
    expect(excluded('src/app/__pycache__/loop.cpython-312.pyc')).toBe(true)
    expect(excluded('src/app/loop.py')).toBe(false)
  })

  it('normalises the path under test', () => {
    expect(compileExcludes(['scratch/**'])('scratch\\spike.py')).toBe(true)
  })

  it('ignores blank patterns rather than matching everything', () => {
    expect(compileExcludes(['', '   '])('src/app/loop.py')).toBe(false)
    expect(compileExcludes([])('src/app/loop.py')).toBe(false)
  })
})

describe('applyExcludes', () => {
  const files = [
    { file_path: 'src/app/loop.py' },
    { file_path: 'scratch/spike.py' },
    { file_path: '.pytest_tmp/t0/conftest.py' },
  ]

  it('keeps only the survivors', () => {
    expect(applyExcludes(files, DEFAULT_EXCLUDES)).toEqual([{ file_path: 'src/app/loop.py' }])
    expect(applyExcludes(files, [])).toEqual(files)
  })
})

describe('excludes are namespaced by project (tic-168b)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage())
  })

  afterEach(() => {
    setProjectKey(null)
    vi.unstubAllGlobals()
  })

  it('does not let one project exclude another project files', () => {
    writeExcludes(['src/**']) // no project yet: the unnamespaced key
    setProjectKey('carnot-70249695')
    // The unnamespaced list belongs to no project, so this one starts clean.
    expect(readExcludes()).toEqual([...DEFAULT_EXCLUDES])

    writeExcludes(['only/mine/**'])
    expect(localStorage.getItem(EXCLUDES_STORAGE_KEY)).not.toBeNull() // kept
    expect(readExcludes()).toEqual(['only/mine/**'])

    setProjectKey('other-1234abcd')
    expect(readExcludes()).toEqual([...DEFAULT_EXCLUDES])

    setProjectKey('carnot-70249695')
    expect(readExcludes()).toEqual(['only/mine/**'])
  })

  it('clears only the current project list', () => {
    setProjectKey('carnot-70249695')
    writeExcludes(['src/**'])
    clearExcludes()
    expect(readExcludes()).toEqual([...DEFAULT_EXCLUDES])
    // Nothing namespaced is left behind, and the unnamespaced key is untouched.
    expect(localStorage.getItem(EXCLUDES_STORAGE_KEY)).toBeNull()
  })
})
