;; S-expression queries used to extract graph material from Python sources.
;; Capture names are the contract with parser.py: the text before the first dot
;; selects the extractor, the text after it selects the role.

;; --------------------------------------------------------------------------
;; Definitions -- functions, methods and classes.
;; The def node itself is captured alongside its name/params/body so a single
;; QueryCursor.matches() pass yields the pieces already grouped per definition.
;; --------------------------------------------------------------------------
(function_definition
  name: (identifier) @def.name
  parameters: (parameters) @def.params
  body: (block) @def.body) @def.function

(class_definition
  name: (identifier) @def.name
  body: (block) @def.body) @def.class

;; --------------------------------------------------------------------------
;; Imports -- located by query, destructured by field in the parser because the
;; `name:` field repeats and relative prefixes need counting.
;; --------------------------------------------------------------------------
(import_statement) @import.plain

(import_from_statement) @import.from

;; --------------------------------------------------------------------------
;; Call sites -- foo(...), a.b(...), self.m(...).
;; Subscripted or otherwise computed callees are deliberately not captured:
;; they cannot be resolved statically and would only add noise to the graph.
;; --------------------------------------------------------------------------
(call
  function: [(identifier) (attribute)] @call.callee) @call.site

;; --------------------------------------------------------------------------
;; Assignments -- module-level constants, class attributes, instance attributes.
;; `X = 1`, `X: int = 1` and the bare `X: int` all parse as an `assignment`
;; with an identifier on the left, so one pattern covers the three.  Tuple
;; targets and subscripts have a different left-hand shape and are deliberately
;; left out.  The parser drops whatever turns out to sit inside a function body
;; -- locals are not symbols.
;; --------------------------------------------------------------------------
(assignment
  left: (identifier) @assign.name) @assign.site

;; --------------------------------------------------------------------------
;; `with expr() as name:` / `async with expr() as name:` (tic-97ce).
;; The bound name is what a later `name.method()` call has as its receiver, and
;; the context expression is the only thing that says what it is.  Tuple
;; targets (`with open(a) as (x, y)`) have an `as_pattern_target` holding a
;; pattern rather than an identifier and are deliberately not matched: a
;; destructured element's type is not the expression's type.
;; --------------------------------------------------------------------------
(with_item
  value: (as_pattern
           alias: (as_pattern_target (identifier) @with.name))) @with.item

;; `self.x = ...` inside a method.  Requiring a plain identifier as the object
;; keeps deeper chains such as `self.a.b = ...` out -- only a one-level
;; attribute is a name worth indexing.  The receiver is captured rather than
;; matched here so the parser can check it is `self`/`cls` (`other.x = ...` is
;; someone else's business) and hang the symbol off the owning class.
(assignment
  left: (attribute
          object: (identifier) @assign.receiver
          attribute: (identifier) @assign.name)) @assign.site

;; --------------------------------------------------------------------------
;; References -- a callable NAMED without being called (tic-89fa).
;;
;; `path("o/m/<slug>/", views.menu_items)` names a view; it does not call it,
;; so the call-site patterns above never see it and the view looks like dead
;; code.  Same shape wherever a callback is registered: Thread(target=worker),
;; signal.connect(handler), a dispatch table `[_cmd_state, _cmd_validate]`.
;;
;; Three positions, chosen by measuring what each rescues on two real
;; codebases (see tic-89fa's notes): an argument, an assigned value, and a
;; collection literal.  Decorators, parameter defaults and returns were
;; measured too and rescue nothing at all on either, so they are not here.
;;
;; These patterns are deliberately loose -- `f(x)` matches for any `x` -- and
;; the noise is filtered downstream: the parser drops any name the enclosing
;; function binds, and the resolver keeps only what lands on an in-project
;; callable.  Measured, that takes carnot's 753 candidate sites to 91 edges.
;; --------------------------------------------------------------------------
(argument_list [(identifier) (attribute)] @ref.name) @ref.argument
(keyword_argument value: [(identifier) (attribute)] @ref.name) @ref.argument
(assignment right: [(identifier) (attribute)] @ref.name) @ref.assign
(list [(identifier) (attribute)] @ref.name) @ref.collection
(set [(identifier) (attribute)] @ref.name) @ref.collection
(tuple [(identifier) (attribute)] @ref.name) @ref.collection
(pair value: [(identifier) (attribute)] @ref.name) @ref.collection

;; --------------------------------------------------------------------------
;; Variable and attribute accesses (tic-13d7) -- the data edges.
;;
;; Unlike every other pattern here these are captured WITHOUT a position, on
;; purpose: a read happens anywhere an expression can, and enumerating the
;; positions would be a list that is wrong the moment someone writes an
;; f-string.  So every identifier and every one-level attribute is a candidate,
;; and the parser refuses the positions that are not reads (a call's callee, a
;; def's own name, an import) by field rather than by pattern.
;;
;; The volume that produces is the reason resolution is all-or-nothing: 33974
;; candidate sites on ../carnot yield 1728 accesses and 1248 merged edges, so
;; recording the remainder as unresolved would bury the signal.
;;
;; One level only.  `self.x` and `config.limit` name something the project
;; defines; `a.b.c` does not, because nothing here knows what `a.b` is.
;; --------------------------------------------------------------------------
(identifier) @access.name

(attribute
  object: (identifier)
  attribute: (identifier)) @access.dotted

;; --------------------------------------------------------------------------
;; Names a scope BINDS (tic-89fa), so a reference to one can be refused.
;;
;; `def test_x(session): do(session)` must not report a reference to a
;; module-level `session` -- it is the parameter.  Measured on ../carnot,
;; leaving this out made 85% of the argument references wrong.
;;
;; Over-broad on purpose: a binding form missed here becomes a false
;; reference, while one caught unnecessarily only costs a true reference we
;; decline to draw.  Parameters, nested definitions and import aliases are not
;; here because the parser already has them from the patterns above.
;; --------------------------------------------------------------------------
(assignment left: (identifier) @bind.name)
(assignment left: (pattern_list (identifier) @bind.name))
(assignment left: (tuple_pattern (identifier) @bind.name))
(augmented_assignment left: (identifier) @bind.name)
(named_expression name: (identifier) @bind.name)
(for_statement left: (identifier) @bind.name)
(for_statement left: (pattern_list (identifier) @bind.name))
(for_statement left: (tuple_pattern (identifier) @bind.name))
(for_in_clause left: (identifier) @bind.name)
(for_in_clause left: (pattern_list (identifier) @bind.name))
(for_in_clause left: (tuple_pattern (identifier) @bind.name))
(as_pattern alias: (as_pattern_target (identifier) @bind.name))
(global_statement (identifier) @bind.name)
(nonlocal_statement (identifier) @bind.name)
