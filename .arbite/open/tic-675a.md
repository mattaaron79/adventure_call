---
id: tic-675a
title: 'Variable impact view: what is affected when this changes'
status: open
type: feature
tier: high
domain: ui
epic: call-flow
priority: 11
tags:
- call-flow
- impact
- dataflow
assignee: null
depends_on:
- tic-13d7
- tic-7a5e
blocked_by: null
created: '2026-09-01T07:26:38'
updated: '2026-09-01T07:26:54'
closed: null
---

## Description
What the READS/WRITES edges are FOR. Depends on that ticket landing and on its measured edge counts being workable.

From a selected variable or attribute: every function that reads it, every function that writes it, and -- composing with the call graph -- everything transitively downstream of those, which is the actual blast radius of a change. From a selected function, the reverse: the state it touches.

The composition is the interesting part and is not just a union: "who writes X, and who calls the things that write X" is a different and more useful question than either edge type answers alone. This is the first place in the codebase where two edge types get traversed together, so the traversal wants to be written generically enough that CALLS + IMPORTS or CALLS + READS both work.

Surface it in two places rather than inventing a fourth mode: the inspector gains reads/writes sections (it already renders Imports and Imported By sections through a shared row shape -- follow that pattern rather than a new one), and the call-flow mode gains an overlay that draws state edges alongside call edges, off by default.

Also worth showing where it is cheapest: a write to a module-level variable from more than one function is a shared-mutable-state warning that needs no analysis beyond counting.

Verification: unit tests on the composed traversal, including a cycle in the call graph (must terminate), a variable written by several functions, and a variable nothing reads. Browser-verify against a real ../carnot module constant and spot-check the reader list by hand. npm run test, tsc -b.

## Notes
