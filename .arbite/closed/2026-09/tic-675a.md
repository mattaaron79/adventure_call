---
id: tic-675a
title: 'Variable impact view: what is affected when this changes'
status: closed
type: feature
tier: high
domain: ui
epic: call-flow
priority: 11
tags:
- call-flow
- impact
- dataflow
assignee: claude.opus.001
depends_on:
- tic-13d7
- tic-7a5e
blocked_by: null
created: '2026-09-01T07:26:38'
updated: '2026-09-02T00:30:57'
closed: '2026-09-02T00:30:57'
---

## Description
What the READS/WRITES edges are FOR. Depends on that ticket landing and on its measured edge counts being workable.

From a selected variable or attribute: every function that reads it, every function that writes it, and -- composing with the call graph -- everything transitively downstream of those, which is the actual blast radius of a change. From a selected function, the reverse: the state it touches.

The composition is the interesting part and is not just a union: "who writes X, and who calls the things that write X" is a different and more useful question than either edge type answers alone. This is the first place in the codebase where two edge types get traversed together, so the traversal wants to be written generically enough that CALLS + IMPORTS or CALLS + READS both work.

Surface it in two places rather than inventing a fourth mode: the inspector gains reads/writes sections (it already renders Imports and Imported By sections through a shared row shape -- follow that pattern rather than a new one), and the call-flow mode gains an overlay that draws state edges alongside call edges, off by default.

Also worth showing where it is cheapest: a write to a module-level variable from more than one function is a shared-mutable-state warning that needs no analysis beyond counting.

Verification: unit tests on the composed traversal, including a cycle in the call graph (must terminate), a variable written by several functions, and a variable nothing reads. Browser-verify against a real ../carnot module constant and spot-check the reader list by hand. npm run test, tsc -b.

## Notes
- 2026-09-02T00:30:56 claude.opus.001: Done. `web/src/data/dataFlow.ts` plus inspector sections and a call-flow
overlay.

## The composition, measured

  blast radius over 496 carnot variables:  median 9   p90 202   max 224
  hypermenu, 227 variables:                median 2   p90  67   max 110

That distribution is the finding rather than a nuisance: most state is local to
a handful of functions, and a tenth of it reaches everything. 68 of carnot's
496 saturate the 200 budget, so the UI renders `200+` and never `200`.

  symbols touching state directly:                    carnot 555  hypermenu 262
  symbols touching state ONLY through what they call:  carnot 836  hypermenu 141

Those 836 are the ones that read as pure and are not. Deepest is
`web.app.build_app.create_session`: touches nothing itself, reaches 111
variables through its callees.

## Two things measurement corrected

1. THE CALLER CLOSURE IS THE EXPENSIVE DIRECTION, not the cheap one. I had
   written the opposite into the docstring on the assumption that callees would
   blow up. Summed over every variable on carnot the caller closure is 21699
   symbols against the callee closure's 5548 -- 4x the other way. So walking
   callers is not the conservative choice, it is the correct one, and the
   budget exists because of what it costs. Docstring fixed.

2. THE OVERLAY IS NEARLY EMPTY IN THE OVERVIEW, and that is structural rather
   than a bug. The carnot overview draws 9 couplings across 156 chips (4 with
   no call beside them); hypermenu's draws NONE. The overview draws entry
   points and their frontier, while state coupling lives among the sibling
   methods of one class. Rooted on `PromptStore._load`, hypermenu draws 3
   chips, 2 call edges and 3 couplings -- one of them `__init__` and `_persist`
   sharing `_lock` and `_prompts` with no call between them. It is a
   rooted-view feature that is harmless in the overview, which is why one
   toggle covers both rather than two.

## Shared mutable state: cheap, and rare enough to mean something

Exactly ONE module-level variable qualifies on each codebase:
`workbench.camoufox_server._browser_cm` and `extraction.app.db.POOL`. Both are
a global resource handle written from two places. No analysis beyond counting,
and a signal-to-noise ratio nothing else here comes close to.

Module-level only, deliberately. A class attribute written by three methods is
ordinary object state; flagging it would cry wolf on every class in the
project.

## The hand spot-check the ticket asked for

`workbench/camoufox_server.py:36`, `_browser_cm`, checked line by line against
the source:

  writers reported: _ensure_browser (line 53), _shutdown (line 100)   correct
  readers reported: _shutdown (lines 95, 97)                          correct
  declaration at line 36                     correctly NOT a write edge
  both writers sit under `global _browser_cm`, and tic-13d7's un-shadowing
  is what makes them appear at all

One honest miss, and it is a known consequence rather than a surprise: line 54
is `_browser = _browser_cm.__enter__()`, which reads `_browser_cm` as the
receiver of a method call. A callee position is not a read (tic-13d7), so
`_ensure_browser` is absent from the reader list. Every count here is a floor,
which the module says in as many words.

## Shape

`closureFrom(seeds, step, budget)` takes its adjacency as an argument and knows
nothing about edges -- the generic half the ticket asked for. It composes
CALLS+READS here and would compose CALLS+IMPORTS unchanged. Cycle-safe because
the visited set is seeded with the seeds; mutual recursion is ordinary, not
exotic.

`variableImpact` walks callers, `stateTouchedBy` walks callees. Same traversal,
opposite adjacency, which is the whole reason it is a parameter.

INSPECTOR. A variable gets Written By / Read By, writers above readers for the
same reason Imported By sits above Imports: the consequence first. A callable
gets Writes / Reads / Through Calls. Rows are `ImportRow`s rendered through the
existing `ImportSection`, per the ticket -- one markup, no drift. Lists cap at
20 rows with the rest in the summary line, because a section rendering 111
variables would push Source off the card.

OVERLAY. Draws callable -> callable, not callable -> variable. Variables are
not nodes in mode 3 and adding them would change what the mode IS -- node set,
layout, entry ranking -- to show a relationship that is really between the two
functions at either end. So the state edges are projected onto the nodes
already drawn: writer -> reader, `kind: 'state'` (never `'call'`), dotted in
the accent colour, muted when a call already joins the same pair. A pair
coupled BOTH ways folds into one undirected line; 1 of carnot's 9 is mutual and
drawing two opposed arrows doubled the lines while saying nothing more.

Direction is write-to-read because that is where the value moves. Two functions
that merely both READ a variable are coupled too, but undirected and weakly --
every reader of a config constant joined to every other is a mesh, not a
finding -- so they are not drawn.

`StateEdgeData.via` carries the shared variable names as a short string. The
canvas draws no edge labels today, so nothing renders it yet; it rides on the
data rather than being recomputed by whatever eventually does.

## Also fixed on the way

Three literal NUL bytes I had just introduced into callFlow.ts, which made git
and grep treat it as binary -- the same fault as tic-c6ee. Replaced with the
`\\u0000` escape derive.ts uses for the same separator, and every touched file
is now checked for them.

## Verification

862 web tests, up from 817. tsc -b clean, build clean.

Mutation-checked nine rules, each failing exactly the tests that state it:
impact walking callees fails 5, shared state ignoring the symbol kind fails 1,
the visited set not starting with the seeds fails 1 (the cycle test),
`throughCalls` not excluding what the function touches itself fails 1, coupling
a function to itself fails 2, not folding mutual pairs fails 1, never detecting
`beside` fails 1, the overlay defaulting to on fails 1, and giving a coupling
`kind: 'call'` fails 4.

Not browser-verified -- the user is away. The derive layer and the scene output
are checked against fresh carnot and hypermenu exports, and the reader list is
hand-checked above; what remains unverified is only how the dotted overlay
looks on the canvas.
