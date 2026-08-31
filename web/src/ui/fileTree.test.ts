import { describe, expect, it } from 'vitest'
import type { FsDir, FsFile } from '../data/derive'
import { ancestorDirs, matchTree } from './FileTree'

const file = (path: string): FsFile => {
  const name = path.split('/').pop()!
  return { type: 'file', name, path, module: {} as FsFile['module'] }
}

const TREE: FsDir = {
  type: 'dir',
  name: '',
  path: '',
  fileCount: 3,
  children: [
    {
      type: 'dir',
      name: 'src',
      path: 'src',
      fileCount: 3,
      children: [
        { type: 'dir', name: 'app', path: 'src/app', fileCount: 2, children: [file('src/app/loop.py'), file('src/app/cli.py')] },
        file('src/readme.py'),
      ],
    },
    file('setup.py'),
  ],
}

/** The predicate the sidebar builds from a parsed query: path substring. */
const pathIncludes = (needle: string) => (file: FsFile) =>
  file.path.toLowerCase().includes(needle.toLowerCase())

describe('matchTree', () => {
  it('keeps every file when the predicate accepts everything', () => {
    // The root fixture's count is stale on purpose; matchTree recomputes it.
    expect(matchTree(TREE, () => true)).toEqual({ ...TREE, fileCount: 4 })
  })

  it('keeps only files the predicate accepts, in their directories', () => {
    const filtered = matchTree(TREE, pathIncludes('loop'))!
    expect(filtered.children).toHaveLength(1)
    const src = filtered.children[0] as FsDir
    expect(src.path).toBe('src')
    const app = src.children[0] as FsDir
    expect(app.path).toBe('src/app')
    expect(app.children.map((c) => c.path)).toEqual(['src/app/loop.py'])
  })

  it('hands each file to the predicate with its full path', () => {
    const seen: string[] = []
    matchTree(TREE, (file) => {
      seen.push(file.path)
      return false
    })
    expect(seen).toEqual(['src/app/loop.py', 'src/app/cli.py', 'src/readme.py', 'setup.py'])
  })

  it('rolls file counts up to the surviving directories', () => {
    const filtered = matchTree(TREE, pathIncludes('loop'))!
    const src = filtered.children[0] as FsDir
    const app = src.children[0] as FsDir
    expect(app.fileCount).toBe(1)
    expect(src.fileCount).toBe(1)
    expect(filtered.fileCount).toBe(1)
  })

  it('is null when nothing matches', () => {
    expect(matchTree(TREE, () => false)).toBeNull()
  })
})

describe('ancestorDirs', () => {
  it('lists every folder a file sits in, root first', () => {
    expect(ancestorDirs('src/app/loop.py')).toEqual(['src', 'src/app'])
  })

  it('omits the target itself so a goto does not expand the target', () => {
    expect(ancestorDirs('src/app')).toEqual(['src'])
  })

  it('is empty for a top-level file', () => {
    expect(ancestorDirs('setup.py')).toEqual([])
  })

  it('is empty for a top-level directory', () => {
    expect(ancestorDirs('src')).toEqual([])
  })

  it('is empty for a non-path target (scene element id, symbol id, empty string)', () => {
    expect(ancestorDirs('dir:src/app')).toEqual([])
    expect(ancestorDirs('row:src/app/loop.py:imp:typing')).toEqual([])
    expect(ancestorDirs('src.auth.login')).toEqual([])
    expect(ancestorDirs('')).toEqual([])
  })

  it('tolerates a leading slash, normalising to root-relative dirs', () => {
    expect(ancestorDirs('/src/app/cli.py')).toEqual(['src', 'src/app'])
  })
})
