import { describe, expect, it } from 'vitest'
import type { FsDir, FsFile } from '../data/derive'
import { matchTree } from './FileTree'

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

describe('matchTree', () => {
  it('returns the tree unchanged for a blank query', () => {
    expect(matchTree(TREE, '')).toBe(TREE)
    expect(matchTree(TREE, '   ')).toBe(TREE)
  })

  it('keeps only files whose path matches, in their directories', () => {
    const filtered = matchTree(TREE, 'loop')!
    expect(filtered.children).toHaveLength(1)
    const src = filtered.children[0] as FsDir
    expect(src.path).toBe('src')
    const app = src.children[0] as FsDir
    expect(app.path).toBe('src/app')
    expect(app.children.map((c) => c.path)).toEqual(['src/app/loop.py'])
  })

  it('matches directories by name too, keeping their whole subtree', () => {
    const filtered = matchTree(TREE, 'app')!
    const src = filtered.children[0] as FsDir
    const app = src.children[0] as FsDir
    expect(app.children).toHaveLength(2)
  })

  it('rolls file counts up to the surviving directories', () => {
    const filtered = matchTree(TREE, 'loop')!
    const src = filtered.children[0] as FsDir
    const app = src.children[0] as FsDir
    expect(app.fileCount).toBe(1)
    expect(src.fileCount).toBe(1)
    expect(filtered.fileCount).toBe(1)
  })

  it('is null when nothing matches', () => {
    expect(matchTree(TREE, 'nope')).toBeNull()
  })
})
