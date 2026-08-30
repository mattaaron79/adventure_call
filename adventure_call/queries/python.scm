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
