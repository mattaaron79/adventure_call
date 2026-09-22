import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { metaDocument, projectIdFromRoot, resolveAbsoluteRoot } from './outData'

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

describe('projectIdFromRoot (tic-168b)', () => {
  it('is the directory name plus the first 8 hex of the path hash', () => {
    // The digest is the one serve.project_id computes in Python, asserted to the
    // same literal in tests/test_serve.py: a project reached through the dev
    // server and through 'vcall serve' shares one set of saved state.
    expect(projectIdFromRoot('/repo/projects/carnot')).toBe('carnot-70249695')
    // Hashing the whole path, not just the name: two projects called 'deploy'
    // are two different projects.
    expect(projectIdFromRoot('/repo/other/deploy')).not.toBe(
      projectIdFromRoot('/repo/projects/deploy'),
    )
  })

  it('is stable for one path and different for two', () => {
    expect(projectIdFromRoot('/a/b/app')).toBe(projectIdFromRoot('/a/b/app'))
    expect(projectIdFromRoot('/a/b/app')).not.toBe(projectIdFromRoot('/a/b/other'))
  })

  it('slugifies the name so it is readable in devtools', () => {
    expect(projectIdFromRoot('/repo/projects/My Project')).toBe('my-project-eed87839')
  })

  it('falls back to the bare digest when the path has no name to slug', () => {
    expect(projectIdFromRoot('/')).toBe('8a5edab2')
  })

  it('names no project without a root', () => {
    expect(projectIdFromRoot(null)).toBeNull()
    expect(projectIdFromRoot('')).toBeNull()
  })
})

describe('metaDocument (tic-168b)', () => {
  it('carries the root and the project it names', () => {
    expect(metaDocument('/repo/projects/carnot')).toEqual({
      root: '/repo/projects/carnot',
      project: 'carnot-70249695',
    })
  })

  it('reports no root and no project when the export has neither', () => {
    expect(metaDocument(null)).toEqual({ root: null, project: null })
  })
})
