# adventure-call

Build a dependency graph of a Python codebase with [Tree-sitter](https://tree-sitter.github.io/)
and [NetworkX](https://networkx.org/), then ask it for the *room* around any symbol: the full
source of that symbol, the signatures of everything that calls it, and the signatures plus
docstrings of everything it calls. One hop, three levels of detail — enough context to understand
a function without shipping the repository.

```
                 signatures only          full code            signatures + docstrings
   callers  ─────────────────────►   [ symbol_id ]   ─────────────────────►  callees
```

## Setup

```bash
uv venv --python 3.12 .venv
uv pip install -e ".[dev]"
```

Requires Python 3.10+. Runtime dependencies are `tree-sitter` (0.25.x), `tree-sitter-python` and
`networkx`.

## Usage

```bash
# analyse a project, write both JSON files
adventure-call /path/to/project --out-dir ./out

# ...or without installing the script
python -m adventure_call /path/to/project --out-dir ./out

# print the level-of-detail context for one symbol
adventure-call /path/to/project --no-write --room src.auth.login_user
```

```python
from adventure_call import build_codebase_graph

builder, parsed_files, index = build_codebase_graph("path/to/project")
room = builder.get_room_context("src.auth.login_user")

print(room.to_markdown())        # prompt-ready
room.focus["code"]               # full source of the symbol
room.upstream                    # callers, signatures only
room.downstream                  # callees, signatures + docstrings
room.unresolved                  # calls that lead outside the graph
```

Or drive the four stages yourself:

```python
from adventure_call import CodebaseParser, SymbolResolver, GraphBuilder, OutputWriter

parsed_files = CodebaseParser("path/to/project").parse_tree()
index = SymbolResolver(parsed_files).resolve()
builder = GraphBuilder(parsed_files, index)
graph = builder.build()                      # nx.DiGraph
OutputWriter("out").write_all(graph, index, parsed_files)
```

### Useful flags

| Flag | Effect |
| --- | --- |
| `--strip-prefix src` | `src/auth.py` becomes module `auth`, not `src.auth` |
| `--module-prefix NAME` | override the package prefix (auto-detected from the root) |
| `--exclude GLOB`, `--exclude-dir NAME` | prune paths during the walk (repeatable) |
| `--no-source` | leave function bodies out of the registry (much smaller file) |
| `--no-heuristic` | drop edges that rely on the unique-name fallback |
| `--module-calls` | also draw CALLS edges for calls made at module level |
| `--contains-edges` | also draw CONTAINS edges (module→symbol, class→method) |
| `--external-imports` | add placeholder nodes for third-party imports |
| `--room ID --format json` | emit the room as JSON instead of markdown |
| `--max-neighbors N` | cap each side of a room; the overflow is reported, not hidden |

## The pipeline

**`CodebaseParser`** walks the tree and parses each file in memory, running one S-expression query
set ([`queries/python.scm`](adventure_call/queries/python.scm)) per file to capture definitions,
imports and call sites. Signatures and bodies come from byte ranges in the original source, so
annotations, defaults and formatting survive verbatim. Each call site is attributed to the innermost
definition whose byte range contains it.

**`SymbolResolver`** builds the symbol table and each module's import bindings, then matches every
call-site identifier against them, producing ids like `src.auth.login_user`. It follows
`self`/`cls` into the enclosing class and its in-project base classes, walks dotted names through
modules and classes, and follows package re-exports — both `from .core import thing` and chained
`from .core import *` — so `import networkx as nx; nx.shortest_path()` lands on the real definition.

**`GraphBuilder`** assembles an `nx.DiGraph`. Nodes are symbols (function, method, class) plus one
per module; every node carries a **stub** — decorators, signature, docstring, `...` — instead of a
body. Edges are `CALLS` (caller → callee) and `IMPORTS` (module → imported symbol). Repeated calls
fold into a single edge with a `count` and the line numbers.

**`OutputWriter`** writes the two files atomically.

### Output files

`codebase_graph.json` — NetworkX node-link format, so it round-trips directly:

```python
import json, networkx as nx
graph = nx.node_link_graph(json.load(open("out/codebase_graph.json")), edges="edges")
```

Nodes carry stubs, never bodies. Run metadata (`schema_version`, `generated_at`, `root`, `stats`)
rides in the standard `graph` attribute dictionary.

`symbol_registry.json` — the detail behind the graph: every symbol with params, byte ranges,
docstring, signature and full source; per-module imports; the resolved import bindings; every
unresolved call with its reason; and every parse diagnostic.

### Resolution confidence

Every CALLS edge is labelled:

- **`exact`** — follows from an import binding, the enclosing module, or the enclosing class.
- **`heuristic`** — nothing bound the name, but exactly one symbol in the project has it. Kept by
  default; drop with `--no-heuristic`.

Calls that resolve to nothing are not discarded — they land in `unresolved_calls` with a reason
(`external: json`, `computed callee`, `ambiguous: 6 symbols named 'is_directed'`, `unknown receiver
'path'`). There is no type inference here: a call on a local variable cannot be resolved statically,
and the tool says so rather than guessing.

## Error handling

Nothing in a source tree can make the parser raise. Unreadable files, binary blobs, oversized files,
undecodable bytes and syntax errors all become `ParseDiagnostic` records attached to the file, and
the walk continues. Tree-sitter's error recovery means a file with a syntax error still yields every
definition that parsed cleanly around the damage; a definition whose *header* sits in the damage is
dropped rather than reported with a nonsense signature. Diagnostics are counted in the run summary
and listed in `symbol_registry.json`.

## Scope and limitations

- **Python only.** The language registry in [`languages.py`](adventure_call/languages.py) already
  has JavaScript and TypeScript entries, disabled; enabling either needs a `queries/<name>.scm` using
  the same capture vocabulary (`@def.*`, `@import.*`, `@call.*`) and the `js` extra installed.
- **No type inference.** `obj.method()` on a local variable resolves only via the unique-name
  fallback, if at all.
- **Nested functions** are addressed as `module.outer.inner`, without Python's `<locals>` marker.
- **Dynamic dispatch** — `getattr`, decorator-generated names, `__getattr__` — is invisible, as it is
  to any static analysis.

## Tests

```bash
.venv/Scripts/python -m pytest -q
```

The suite runs against [`tests/fixtures/sample_project`](tests/fixtures/sample_project), which
includes relative and aliased imports, inheritance, nested functions and a file with a deliberate
syntax error.
