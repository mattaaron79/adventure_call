import { describe, expect, it } from 'vitest'
import {
  elbowConnectors,
  layoutTree,
  subtreeGroups,
  type Rect,
  type Size,
  type TidyNode,
} from './tidyTree'

/**
 * A synthetic tree that reproduces the size mix the fs-tree mode will throw
 * at the layout: collapsed chips (120x36-ish) beside expanded file containers
 * (320x220), a parent wider than its child block, and a parent taller than
 * one of its branches.  All sizes are even, so every coordinate the default
 * gaps produce is an exact integer and the golden values below can be
 * hand-checked.
 *
 *   root 160x48
 *   ├── a 120x36            (collapsed chip, wider than nothing, narrower block)
 *   │   ├── a1 320x220      (expanded container)
 *   │   └── a2 120x36       (chip)
 *   └── b 320x220           (expanded container, taller than its children)
 *       ├── b1 120x36
 *       └── b2 140x44
 */
const TREE: TidyNode = {
  id: 'root',
  children: [
    {
      id: 'a',
      children: [{ id: 'a1' }, { id: 'a2' }],
    },
    {
      id: 'b',
      children: [{ id: 'b1' }, { id: 'b2' }],
    },
  ],
}

const SIZES: Record<string, Size> = {
  root: { width: 160, height: 48 },
  a: { width: 120, height: 36 },
  a1: { width: 320, height: 220 },
  a2: { width: 120, height: 36 },
  b: { width: 320, height: 220 },
  b1: { width: 120, height: 36 },
  b2: { width: 140, height: 44 },
}

const sizeOf = (node: TidyNode): Size => SIZES[node.id]

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height }
}

describe('layoutTree', () => {
  it('places every node at its hand-computed golden position (lr)', () => {
    const rects = layoutTree(TREE, sizeOf)
    // Tier x positions: 0, then 160+64, then 224+320+64.
    // Stack y positions: root centred on its 500-tall child block; `a`
    // centred on its 268-tall block; `b` clamped (taller than its 92-tall
    // block); leaves stacked with a 12px sibling gap.
    expect(rects.get('root')).toEqual(rect(0, 226, 160, 48))
    expect(rects.get('a')).toEqual(rect(224, 116, 120, 36))
    expect(rects.get('a1')).toEqual(rect(608, 0, 320, 220))
    expect(rects.get('a2')).toEqual(rect(608, 232, 120, 36))
    expect(rects.get('b')).toEqual(rect(224, 280, 320, 220))
    expect(rects.get('b1')).toEqual(rect(608, 280, 120, 36))
    expect(rects.get('b2')).toEqual(rect(608, 328, 140, 44))
    expect(rects.size).toBe(7)
  })

  it('is deterministic: same input, same output', () => {
    expect(layoutTree(TREE, sizeOf)).toEqual(layoutTree(TREE, sizeOf))
  })

  it('places every node at its hand-computed golden position (tb)', () => {
    // In 'tb' the tier axis is y and tiers are sized by the tallest node,
    // so the 220-tall containers set the d1/d2 band heights.
    const rects = layoutTree(TREE, sizeOf, { orientation: 'tb' })
    expect(rects.get('root')).toEqual(rect(312, 0, 160, 48))
    expect(rects.get('a')).toEqual(rect(166, 112, 120, 36))
    expect(rects.get('a1')).toEqual(rect(0, 396, 320, 220))
    expect(rects.get('a2')).toEqual(rect(332, 396, 120, 36))
    // b starts after a's 452-wide extent plus the 12px sibling gap.
    expect(rects.get('b')).toEqual(rect(464, 112, 320, 220))
    expect(rects.get('b1')).toEqual(rect(464, 396, 120, 36))
    expect(rects.get('b2')).toEqual(rect(596, 396, 140, 44))
  })

  it('lays out a lone leaf at the origin', () => {
    const rects = layoutTree({ id: 'only' }, () => ({ width: 90, height: 30 }))
    expect(rects.get('only')).toEqual(rect(0, 0, 90, 30))
  })

  it('honours custom gaps', () => {
    const tree: TidyNode = { id: 'p', children: [{ id: 'c' }] }
    const size = (): Size => ({ width: 100, height: 40 })
    const rects = layoutTree(tree, size, { tierGap: 10, siblingGap: 5 })
    expect(rects.get('p')).toEqual(rect(0, 0, 100, 40))
    expect(rects.get('c')).toEqual(rect(110, 0, 100, 40))
  })

  it('reads children through childrenOf when given', () => {
    const tree = { id: 'p', kids: [{ id: 'c' }] }
    const rects = layoutTree(tree, () => ({ width: 50, height: 20 }), {
      childrenOf: (n: typeof tree) => n.kids ?? [],
    })
    expect(rects.size).toBe(2)
    expect(rects.get('c')).toEqual(rect(114, 0, 50, 20))
  })

  it('throws on a duplicate id rather than silently collapsing nodes', () => {
    const bad: TidyNode = { id: 'x', children: [{ id: 'x' }] }
    expect(() => layoutTree(bad, () => ({ width: 10, height: 10 }))).toThrow(/duplicate/)
  })
})

describe('elbowConnectors', () => {
  it('routes parent -> child with the golden elbow polylines', () => {
    const rects = layoutTree(TREE, sizeOf)
    const edges = elbowConnectors(TREE, rects)
    // Depth-first: each parent's edge precedes its descendants' edges.
    expect(edges).toEqual([
      // root -> a: out of root's right edge at y=250, across midX=192, into a.
      { id: 'root->a', points: [160, 250, 192, 250, 192, 134, 224, 134] },
      { id: 'a->a1', points: [344, 134, 476, 134, 476, 110, 608, 110] },
      { id: 'a->a2', points: [344, 134, 476, 134, 476, 250, 608, 250] },
      { id: 'root->b', points: [160, 250, 192, 250, 192, 390, 224, 390] },
      { id: 'b->b1', points: [544, 390, 576, 390, 576, 298, 608, 298] },
      { id: 'b->b2', points: [544, 390, 576, 390, 576, 350, 608, 350] },
    ])
  })

  it('collapses to a straight line when child aligns with parent', () => {
    const tree: TidyNode = { id: 'p', children: [{ id: 'c' }] }
    const size = (): Size => ({ width: 100, height: 48 })
    const rects = layoutTree(tree, size)
    expect(elbowConnectors(tree, rects)).toEqual([
      { id: 'p->c', points: [100, 24, 100 + 64, 24] },
    ])
  })

  it('routes vertically for the tb orientation', () => {
    const tree: TidyNode = { id: 'p', children: [{ id: 'c' }] }
    const size = (n: TidyNode): Size => (n.id === 'p' ? { width: 100, height: 40 } : { width: 60, height: 40 })
    const rects = layoutTree(tree, size, { orientation: 'tb' })
    // p at (0,0) 100x40; c at (0,104) 60x40 (tier = p's height 40 + 64 gap).
    expect(rects.get('c')).toEqual(rect(0, 104, 60, 40))
    expect(elbowConnectors(tree, rects, { orientation: 'tb' })).toEqual([
      { id: 'p->c', points: [50, 40, 50, 72, 30, 72, 30, 104] },
    ])
  })
})

describe('subtreeGroups', () => {
  it('bounds each branching subtree, padded, in pre-order', () => {
    const rects = layoutTree(TREE, sizeOf)
    expect(subtreeGroups(TREE, rects)).toEqual([
      // root's whole tree: x 0..928, y 0..500 (the b container reaches y=500),
      // padded by 12.
      { id: 'root:group', rect: rect(-12, -12, 952, 524) },
      // a's subtree: x 224..928, y 0..268.
      { id: 'a:group', rect: rect(212, -12, 728, 292) },
      // b's subtree: x 224..748, y 280..500.
      { id: 'b:group', rect: rect(212, 268, 548, 244) },
    ])
  })

  it('gives no group for a leaf-only tree', () => {
    const tree: TidyNode = { id: 'only' }
    const rects = layoutTree(tree, () => ({ width: 10, height: 10 }))
    expect(subtreeGroups(tree, rects)).toEqual([])
  })
})

// -- zero-overlap property ----------------------------------------------------

/** Deterministic LCG so the property test always draws the same trees. */
function lcg(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_102_352_477 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
}

function randomTree(rand: () => number, depth: number): TidyNode {
  const id = `n${rand().toFixed(6)}-${depth}`
  if (depth === 0 || rand() < 0.3) return { id }
  const childCount = 1 + Math.floor(rand() * 3)
  return { id, children: Array.from({ length: childCount }, () => randomTree(rand, depth - 1)) }
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  )
}

describe('zero overlap across a mix of node sizes', () => {
  const orientations = ['lr', 'tb'] as const

  for (const orientation of orientations) {
    it(`holds for 200 seeded random trees (${orientation})`, () => {
      const rand = lcg(20260830)
      for (let i = 0; i < 200; i++) {
        const tree = randomTree(rand, 1 + Math.floor(rand() * 4))
        const sizeOfRandom = (node: TidyNode): Size => {
          // Sizes keyed off the id keeps sizeOf a pure function of the node.
          let h = 0
          for (const ch of node.id) h = (h * 31 + ch.charCodeAt(0)) | 0
          const r = ((h >>> 0) % 1000) / 1000
          return { width: 40 + Math.floor(r * 320), height: 24 + Math.floor(r * 216) }
        }
        const rects = [...layoutTree(tree, sizeOfRandom, { orientation })].map(
          ([, rect_]) => rect_,
        )
        for (let a = 0; a < rects.length; a++) {
          for (let b = a + 1; b < rects.length; b++) {
            if (overlaps(rects[a], rects[b])) {
              throw new Error(
                `overlap in tree ${i} (${orientation}): ${JSON.stringify(rects[a])} vs ` +
                  `${JSON.stringify(rects[b])}`,
              )
            }
          }
        }
      }
    })
  }

  it('holds for the pathological wide-parent / tall-container golden tree', () => {
    const rects = [...layoutTree(TREE, sizeOf).values()]
    for (let a = 0; a < rects.length; a++) {
      for (let b = a + 1; b < rects.length; b++) {
        expect(overlaps(rects[a], rects[b])).toBe(false)
      }
    }
  })
})

// -- golden snapshot ----------------------------------------------------------

/**
 * A deeper synthetic tree, snapshotted as a golden file: any change to the
 * algorithm shows up as a reviewable diff of every coordinate.
 */
describe('golden snapshot', () => {
  it('matches the committed golden file', () => {
    const tree: TidyNode = {
      id: 'src',
      children: [
        { id: 'src/api', children: [{ id: 'api.py' }, { id: 'routes.py' }] },
        {
          id: 'src/auth',
          children: [
            { id: 'auth.py' },
            { id: 'tokens.py' },
            { id: 'src/auth/handlers', children: [{ id: 'login.py' }, { id: 'logout.py' }] },
          ],
        },
        { id: 'models.py' },
      ],
    }
    const sizes: Record<string, Size> = {
      src: { width: 140, height: 40 },
      'src/api': { width: 120, height: 36 },
      'api.py': { width: 260, height: 180 },
      'routes.py': { width: 120, height: 36 },
      'src/auth': { width: 120, height: 36 },
      'auth.py': { width: 240, height: 140 },
      'tokens.py': { width: 120, height: 36 },
      'src/auth/handlers': { width: 120, height: 36 },
      'login.py': { width: 200, height: 90 },
      'logout.py': { width: 120, height: 36 },
      'models.py': { width: 220, height: 160 },
    }
    const rects = layoutTree(tree, (n) => sizes[n.id])
    expect(Object.fromEntries(rects)).toMatchSnapshot()
    expect(elbowConnectors(tree, rects)).toMatchSnapshot('connectors')
    expect(subtreeGroups(tree, rects)).toMatchSnapshot('groups')
  })
})
