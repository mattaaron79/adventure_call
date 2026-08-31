import { describe, expect, it } from 'vitest'
import { breadcrumbSegments, elideBreadcrumbs, parentPath } from './breadcrumbs'

describe('parentPath', () => {
  it('returns the parent directory, or the root for a top-level path', () => {
    expect(parentPath('src/app/cli')).toBe('src/app')
    expect(parentPath('src')).toBe('')
    expect(parentPath('')).toBe('')
  })
})

describe('breadcrumbSegments (tic-b1ab)', () => {
  it('has no trail at the root, so the toolbar does not exist', () => {
    expect(breadcrumbSegments('')).toEqual([])
  })

  it('builds one crumb per ancestor level, outermost first, each jumping to its full path', () => {
    expect(breadcrumbSegments('src/app/cli')).toEqual([
      { path: 'src', label: 'src', current: false },
      { path: 'src/app', label: 'app', current: false },
      { path: 'src/app/cli', label: 'cli', current: true },
    ])
  })

  it('marks the current folder and handles a single-level scope', () => {
    expect(breadcrumbSegments('src')).toEqual([{ path: 'src', label: 'src', current: true }])
  })
})

describe('elideBreadcrumbs (tic-b1ab)', () => {
  const crumbs = breadcrumbSegments('a/b/c/d/e/f/g/h/i/j')

  it('passes a short trail through untouched', () => {
    const short = breadcrumbSegments('a/b')
    expect(elideBreadcrumbs(short, 6)).toEqual(short)
  })

  it('elides the middle of a long trail, keeping the current folder', () => {
    const elided = elideBreadcrumbs(crumbs, 6)
    // head (2) + ellipsis + tail: the current folder (last) always survives.
    expect(elided.map((c) => (c === null ? null : c.label))).toEqual([
      'a',
      'b',
      null,
      'h',
      'i',
      'j',
    ])
    expect(elided[elided.length - 1]).toEqual(crumbs[crumbs.length - 1])
    expect(elided[elided.length - 1]!.current).toBe(true)
  })

  it('keeps at least one trailing crumb even at a tight cap', () => {
    const elided = elideBreadcrumbs(crumbs, 3)
    expect(elided.length).toBeGreaterThanOrEqual(3)
    expect(elided[elided.length - 1]).toEqual(crumbs[crumbs.length - 1])
  })
})
