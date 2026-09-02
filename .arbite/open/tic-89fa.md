---
id: tic-89fa
title: 'REFERENCES: a callable named without being called is invisible (Django URLconf,
  callbacks, handlers)'
status: open
type: feature
tier: high
domain: io
epic: call-flow
priority: 7
tags: []
assignee: null
depends_on: []
blocked_by: null
created: '2026-09-01T17:33:26'
updated: '2026-09-01T17:33:31'
closed: null
---

## Description
This is a **raw** ticket: it was captured from a brief request without proper classification. It must be filled out before it can be worked.

Original request: A callable NAMED without being called is invisible to the graph, and it is how a lot of real code is reached. Django's URLconf is the case that surfaced it (tic-f9f7): platform/menus/urls.py holds path('o/m/<slug>/', views.menu_items, name='menu_items') -- views.menu_items is an ARGUMENT REFERENCE, not a call, so the parser (which captures call sites only) never sees it. Measured on ../hypermenu the two urls modules produce exactly 3 edges, all IMPORTS to the view MODULES, and zero to any view function; 81 of the 150 remaining caller-less callables are literally named in a urls.py. But this is not a Django problem and must not be solved as one. The same shape is everywhere a callback is registered: Thread(target=worker), signal.connect(handler), atexit.register(cleanup), sorted(key=keyfunc), functools.partial(fn), click's add_command, flask's add_url_rule, pytest's parametrize. Measured more broadly on hypermenu, 62 of 231 caller-less callables are mentioned as a bare reference somewhere in the project. Proposal: a REFERENCES edge type -- a resolvable symbol named in an expression position where it is not being called. The parser already flattens dotted names for call sites (_attribute_path) and the resolver already resolves them, so the machinery is mostly present; what is new is capturing identifiers/attributes that are NOT a call's callee, and deciding how to avoid drowning the graph (probably: only when the target resolves to an in-project CALLABLE, and only in argument, assignment-value and collection-literal positions). Entry points would then treat 'referenced but never called' as evidence-backed reachability, which is what it is, instead of the absence-of-evidence 'entry' they get today. Note the deliberately-rejected alternative recorded in tic-f9f7: a filename rule matching views*.py would rescue 83 of hypermenu's unexplained callables and measured 100% accurate there, but it asserts a framework claim on the evidence of a filename, and the real evidence is sitting in urls.py unread.

What still needs to be done (human or agent triage, typically via `arbite fetch`):
- title -- replace "Requires Classification" with a short human-readable summary
- tier -- low | medium | high | frontier (agent capability tier required to work it; how capable the agent must be, not how urgent the work is)
- domain -- e.g. mesh, image_gen, audio_gen, ui, io (drives routing)
- epic -- this raw ticket is auto-grouped under the 'classification' epic (so triage can find it with `arbite list next --epic classification`); replace it with the real epic this work belongs to, e.g. mesh-pipeline
- priority -- numeric urgency index, lower = more urgent
- description -- expand this body into a proper task description based on the original request, including any acceptance criteria
- status -- set to `open` once classified so it becomes workable via `arbite list next` (skip this if you're claiming it yourself instead -- `arbite claim` sets status to `in_progress` directly)

## Notes
