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

;; `self.x = ...` inside a method.  Requiring a plain identifier as the object
;; keeps deeper chains such as `self.a.b = ...` out -- only a one-level
;; attribute is a name worth indexing.  The receiver is captured rather than
;; matched here so the parser can check it is `self`/`cls` (`other.x = ...` is
;; someone else's business) and hang the symbol off the owning class.
(assignment
  left: (attribute
          object: (identifier) @assign.receiver
          attribute: (identifier) @assign.name)) @assign.site
