import { describe, expect, it } from 'vitest'
import {
  breadcrumbSegments,
  elideBreadcrumbs,
  parentPath,
  toolbarCrumbs,
  toolbarScreenY,
} from './breadcrumbs'

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

describe('toolbarScreenY (tic-9f02)', () => {
  it('floats above the folder when there is room, clearing its top boundary', () => {
    // Folder top at 100, toolbar height 24, GAP 8: the toolbar's top must sit
    // at 100 - 8 - 24 so its bottom just clears the folder, not overlapping
    // it by the toolbar's own height.
    expect(toolbarScreenY(100, 200, 24)).toBe(100 - 8 - 24)
  })

  it('drops below the folder when there is not enough room above', () => {
    // Folder top at 10 (too close to the canvas edge for the toolbar above):
    // the toolbar goes below the folder's bottom instead.
    expect(toolbarScreenY(10, 60, 24)).toBe(60 + 8)
  })

  it('uses the custom gap when supplied', () => {
    expect(toolbarScreenY(100, 200, 24, 12)).toBe(100 - 12 - 24)
  })
})

describe('toolbarCrumbs (tic-d7d7)', () => {
  it('is the elided ancestor trail for an ordinary directory scope', () => {
    expect(toolbarCrumbs('src/app/cli', false, 6)).toEqual(
      elideBreadcrumbs(breadcrumbSegments('src/app/cli'), 6),
    )
    expect(toolbarCrumbs('a/b/c/d/e/f/g/h', false, 6)).toContain(null)
  })

  it('is the focused item alone in rootOnly mode, however deep it sits', () => {
    // The import graph's Local View focuses a FILE: its parent directories
    // are not scopes that mode can render, so the trail collapses to the one
    // crumb naming what the scene is about -- and never elides, so the
    // ellipsis a long path would have produced cannot appear.
    expect(toolbarCrumbs('src/app/cli/main.py', true, 6)).toEqual([
      { path: 'src/app/cli/main.py', label: 'main.py', current: true },
    ])
    expect(toolbarCrumbs('a/b/c/d/e/f/g/h.py', true, 6)).toEqual([
      { path: 'a/b/c/d/e/f/g/h.py', label: 'h.py', current: true },
    ])
  })

  it('keeps the full path on the crumb, so the label can stay the bare name', () => {
    const [crumb] = toolbarCrumbs('src/app/cli/main.py', true, 6)
    expect(crumb).not.toBeNull()
    expect(crumb!.label).toBe('main.py')
    expect(crumb!.path).toBe('src/app/cli/main.py')
  })

  it('has no crumbs at the root in either mode, so the toolbar does not exist', () => {
    expect(toolbarCrumbs('', true, 6)).toEqual([])
    expect(toolbarCrumbs('', false, 6)).toEqual([])
  })
})
