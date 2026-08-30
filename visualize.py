"""Render adventure-call output as interactive web apps.

Two modes:

  --mode graph  (default)  interactive call/import network from codebase_graph.json
  --mode files             IDE-style file tree browser from symbol_registry.json

Graph-mode semantic styling:
  node color  -> kind (module / class / function / method / external)
  node shape  -> box for containers, dot for callables
  edge color  -> edge type (CALLS / IMPORTS / CONTAINS)
  edge dashes -> heuristic resolution (solid = exact, dashed = heuristic)
  edge width  -> call count, capped for readability

Graph filtering:
  --edge-types CALLS          only show CALLS edges (drop the rest)
  --edge-types CALLS,CONTAINS show several types
  --no-filter                 disable the in-browser filter dropdown (on by default)
  --no-fullscreen             keep the fixed 900px canvas (fullscreen is on by default)
  --keep-isolated             keep nodes left with no edges after filtering

Usage:
    adventure-call <root> --out-dir out
    .venv\\Scripts\\python.exe visualize.py
    .venv\\Scripts\\python.exe visualize.py --edge-types CALLS --no-filter
    .venv\\Scripts\\python.exe visualize.py --mode files
"""

import argparse
import json
import sys
import webbrowser
from pathlib import Path

import networkx as nx
from pyvis.network import Network

GRAPH_PATH = Path("out/codebase_graph.json")
REGISTRY_PATH = Path("out/symbol_registry.json")
GRAPH_OUTPUT = Path("graph.html")
FILES_OUTPUT = Path("files.html")

ALL_EDGE_TYPES = "CALLS,IMPORTS,CONTAINS"

NODE_COLORS = {
    "module": "#1f77b4",
    "class": "#2ca02c",
    "function": "#ff7f0e",
    "method": "#ff7f0e",
    "external": "#999999",
}
EDGE_COLORS = {
    "CALLS": "#d62728",
    "IMPORTS": "#1f77b4",
    "CONTAINS": "#2ca02c",
}

# Injected into <head> after pyvis generates the page: makes the network fill
# the whole browser viewport (pyvis hardcodes a fixed canvas height instead).
FULLSCREEN_CSS = """
html, body {
    height: 100%;
    margin: 0;
    padding: 0;
    overflow: hidden;
}
body {
    display: flex;
    flex-direction: column;
}
.card {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    margin: 0 !important;
    border-radius: 0 !important;
}
#mynetwork {
    flex: 1 1 auto !important;
    min-height: 0;
    height: auto !important;
}
#mynetwork.card-body {
    padding: 0;
}
#filter-menu {
    flex: 0 0 auto;
}
#loadingBar {
    height: 100% !important;
}
"""


# ---------------------------------------------------------------------------
# shared CLI
# ---------------------------------------------------------------------------

def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Render adventure-call JSON output")
    parser.add_argument(
        "--mode",
        choices=("graph", "files"),
        default="graph",
        help="graph: interactive call/import network (default). "
        "files: IDE-style file tree browser",
    )
    parser.add_argument(
        "--registry",
        type=Path,
        default=None,
        help="path to symbol_registry.json (files mode only; default: "
        "out/symbol_registry.json)",
    )
    parser.add_argument(
        "--edge-types",
        default=ALL_EDGE_TYPES,
        metavar="TYPES",
        help=f"comma-separated edge types to show (graph mode; default: %(default)s)",
    )
    parser.add_argument(
        "--filter",
        action="store_true",
        default=True,
        help="add an in-browser dropdown to toggle node/edge properties (default: on)",
    )
    parser.add_argument(
        "--no-filter",
        action="store_false",
        dest="filter",
        help="disable the in-browser filter dropdown",
    )
    parser.add_argument(
        "--fullscreen",
        action="store_true",
        default=True,
        help="fill the whole browser viewport (default: on)",
    )
    parser.add_argument(
        "--no-fullscreen",
        action="store_false",
        dest="fullscreen",
        help="keep the fixed 900px canvas instead of full viewport",
    )
    parser.add_argument(
        "--keep-isolated",
        action="store_true",
        help="keep nodes left with no edges after filtering",
    )
    return parser


def main() -> None:
    args = build_arg_parser().parse_args()
    if args.mode == "files":
        _run_files_mode(args)
    else:
        _run_graph_mode(args)


# ---------------------------------------------------------------------------
# graph mode
# ---------------------------------------------------------------------------

def _run_graph_mode(args: argparse.Namespace) -> None:
    wanted_types = {t.strip().upper() for t in args.edge_types.split(",") if t.strip()}

    if not GRAPH_PATH.exists():
        raise SystemExit(
            f"missing {GRAPH_PATH} -- run first:\n"
            f"  adventure-call <root> --out-dir out"
        )

    graph = nx.node_link_graph(
        json.loads(GRAPH_PATH.read_text(encoding="utf-8")), edges="edges"
    )

    # --- data filtering happens HERE, before pyvis ever sees the graph ---
    # set_options() only controls rendering; the graph you pass is what is drawn.
    filtered = 0
    for source, target, data in list(graph.edges(data=True)):
        if data.get("type", "CALLS") not in wanted_types:
            graph.remove_edge(source, target)
            filtered += 1

    isolated = [n for n in graph.nodes if graph.degree(n) == 0]
    if isolated and not args.keep_isolated:
        graph.remove_nodes_from(isolated)

    # --- semantic styling -------------------------------------------------
    for node_id, data in graph.nodes(data=True):
        kind = data.get("kind", "module")
        data["group"] = kind  # used by the optional interactive filter menu
        data["color"] = NODE_COLORS.get(kind, "#888888")
        data["shape"] = "box" if kind in ("module", "class") else "dot"
        data["size"] = 18 if kind == "module" else 12
        data["title"] = f"<b>{node_id}</b><br/>kind: {kind}"

    for _source, _target, data in graph.edges(data=True):
        edge_type = data.get("type", "CALLS")
        data["color"] = EDGE_COLORS.get(edge_type, "#888888")
        # heuristic resolution shows up as a dashed line
        data["dashes"] = data.get("confidence") == "heuristic"
        # thicker line for more call sites
        data["width"] = min(1.0 + 0.5 * data.get("count", 1), 6.0)
        data["title"] = f"{edge_type} x{data.get('count', 1)}"

    # filter_menu is a constructor flag in this pyvis version (not a method);
    # it adds an in-browser dropdown that can filter by any node/edge property.
    net = Network(
        height="100vh",
        width="100%",
        directed=True,
        filter_menu=args.filter,
    )
    net.from_nx(graph)

    # set_options() requires STRICT JSON (it is parsed with json.loads):
    # double-quoted keys/values, no `var options =` wrapper, no semicolons.
    net.set_options(
        """
        {
          "nodes": { "font": { "size": 12 } },
          "edges": {
            "color": { "inherit": false },
            "arrows": { "to": { "enabled": true, "scaleFactor": 0.6 } },
            "smooth": false
          },
          "physics": {
            "stabilization": true,
            "barnesHut": { "gravitationalConstant": -60000 }
          }
        }
        """
    )

    print(
        f"{graph.number_of_edges()} edges, {graph.number_of_nodes()} nodes "
        f"({filtered} filtered out)"
    )

    # write_html() (not show()) avoids this pyvis version's notebook quirk and
    # lets us inject the fullscreen CSS BEFORE the browser opens.
    net.write_html(str(GRAPH_OUTPUT))  # cdn_resources="local" copies lib/ here

    if args.fullscreen:
        html = GRAPH_OUTPUT.read_text(encoding="utf-8")
        marker = "</head>"
        if marker in html and FULLSCREEN_CSS not in html:
            html = html.replace(
                marker,
                f"<style>\n{FULLSCREEN_CSS}\n</style>\n{marker}",
                1,
            )
            GRAPH_OUTPUT.write_text(html, encoding="utf-8")

    webbrowser.open(GRAPH_OUTPUT.resolve().as_uri())
    print(f"wrote {GRAPH_OUTPUT}")


# ---------------------------------------------------------------------------
# files mode: IDE-style tree browser built from symbol_registry.json
# ---------------------------------------------------------------------------

FILES_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Files</title>
<style>
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; overflow: hidden; }
body { display: flex; flex-direction: column; font-family: "Segoe UI", system-ui, sans-serif;
       background: #1e1e2e; color: #cdd6f4; font-size: 14px; }
header { flex: 0 0 auto; display: flex; align-items: center; gap: 16px; padding: 10px 16px;
         background: #11111b; border-bottom: 1px solid #313244; }
header h1 { font-size: 15px; margin: 0; font-weight: 600; color: #89b4fa; }
header input { flex: 0 1 360px; padding: 6px 10px; border-radius: 6px;
               border: 1px solid #45475a; background: #181825; color: #cdd6f4; }
#stats { margin-left: auto; color: #6c7086; font-size: 12.5px; }
#layout { flex: 1 1 auto; display: flex; min-height: 0; }
#sidebar { flex: 0 0 340px; min-width: 240px; overflow: auto; border-right: 1px solid #313244;
           background: #181825; padding: 10px 8px; }
#main { flex: 1 1 auto; overflow: auto; padding: 20px 28px; }
ul.tree { list-style: none; margin: 0; padding-left: 16px; }
#tree > ul.tree { padding-left: 4px; }
li { margin: 1px 0; white-space: nowrap; }
.dir { cursor: pointer; color: #89b4fa; font-weight: 600; user-select: none; }
.dir::before { content: "\\25B8 "; color: #6c7086; }
.dir.open::before { content: "\\25BE "; }
.file { cursor: pointer; color: #cdd6f4; text-decoration: none; padding: 1px 4px; border-radius: 4px; }
.file:hover { background: #313244; }
.file.selected { background: #45475a; color: #f5e0dc; }
.hidden { display: none; }
h2 { margin: 0 0 6px; font-size: 20px; color: #f5e0dc; word-break: break-all; }
.meta { color: #6c7086; margin-bottom: 10px; }
.meta code { background: #11111b; padding: 1px 6px; border-radius: 4px; }
blockquote { margin: 8px 0 16px; padding: 8px 12px; border-left: 3px solid #89b4fa;
             background: #181825; color: #bac2de; white-space: pre-wrap; }
h3 { margin: 22px 0 8px; font-size: 14px; text-transform: uppercase; letter-spacing: .05em;
     color: #a6adc8; border-bottom: 1px solid #313244; padding-bottom: 4px; }
.muted { color: #6c7086; }
table.imports { border-collapse: collapse; width: 100%; margin-bottom: 8px; font-size: 13px; }
table.imports th, table.imports td { text-align: left; padding: 4px 10px; border-bottom: 1px solid #313244; }
table.imports th { color: #a6adc8; }
details.symbol { margin: 6px 0; border: 1px solid #313244; border-radius: 6px; background: #181825; }
details.symbol > summary { cursor: pointer; padding: 7px 12px; font-family: Consolas, "Courier New", monospace;
                           font-size: 13px; color: #89b4fa; }
details.symbol.class > summary { color: #a6e3a1; }
details.symbol.method > summary { color: #f9e2af; }
details.symbol .docstring { padding: 6px 12px 0; color: #bac2de; font-style: italic; }
details.symbol pre { margin: 8px 12px 12px; padding: 12px; background: #11111b; border-radius: 6px;
                     overflow: auto; font-family: Consolas, "Courier New", monospace;
                     font-size: 12.5px; line-height: 1.55; color: #cdd6f4; }
details.symbol .methods { padding: 0 12px; }
details.symbol .methods details.symbol { background: #15151f; }
.empty { color: #6c7086; padding: 40px; text-align: center; font-size: 15px; }
</style>
</head>
<body>
<header>
  <h1>Files</h1>
  <input id="search" type="search" placeholder="Filter files...">
  <span id="stats"></span>
</header>
<div id="layout">
  <div id="sidebar"><ul class="tree" id="tree"></ul></div>
  <div id="main"><div class="empty">Select a file in the tree to see its imports, classes, functions and source.</div></div>
</div>
<script>
const DATA = __DATA__;
const treeEl = document.getElementById('tree');
const mainEl = document.getElementById('main');
const searchEl = document.getElementById('search');
const statsEl = document.getElementById('stats');
const nodeMap = {};

function esc(s) {
  // HTML-escape for innerHTML. Entity strings are built from a char code so
  // this template never has to contain literal '&...;' sequences.
  var amp = String.fromCharCode(38); // &
  var map = { '&': amp + 'amp;', '<': amp + 'lt;', '>': amp + 'gt;',
              '"': amp + 'quot;', "'": amp + '#39;' };
  return String(s == null ? '' : s)
    .replace(/[&<>"']/g, function (c) { return map[c]; });
}

function renderTreeNode(node, container) {
  const li = document.createElement('li');
  nodeMap[node.path] = li;
  if (node.is_file) {
    li.classList.add('file-item');
    const a = document.createElement('a');
    a.href = '#'; a.className = 'file'; a.textContent = node.name;
    a.dataset.path = node.path;
    a.addEventListener('click', (e) => { e.preventDefault(); selectFile(node.path); });
    li.appendChild(a);
  } else {
    li.classList.add('dir-item');
    const span = document.createElement('span');
    span.className = 'dir'; span.textContent = node.name;
    const ul = document.createElement('ul'); ul.className = 'tree hidden';
    renderTree(node.children, ul);
    li.appendChild(span); li.appendChild(ul);
    span.addEventListener('click', () => {
      ul.classList.toggle('hidden');
      span.classList.toggle('open');
    });
  }
  container.appendChild(li);
}

function renderTree(nodes, container) { (nodes || []).forEach(n => renderTreeNode(n, container)); }

function reveal(path) {
  const parts = path.split('/');
  let cur = '';
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur ? cur + '/' + parts[i] : parts[i];
    const li = nodeMap[cur];
    if (li && li.classList.contains('dir-item')) {
      const ul = li.querySelector(':scope > ul');
      if (ul) ul.classList.remove('hidden');
      const span = li.querySelector(':scope > .dir');
      if (span) span.classList.add('open');
    }
  }
}

function selectFile(path) {
  document.querySelectorAll('.file.selected').forEach(el => el.classList.remove('selected'));
  const li = nodeMap[path];
  if (li) {
    reveal(path);
    const a = li.querySelector('.file');
    if (a) a.classList.add('selected');
    li.scrollIntoView({ block: 'nearest' });
  }
  showDetails(path);
}

function symbolHTML(sym, children) {
  const open = sym.kind === 'class' ? ' open' : '';
  let h = '<details class="symbol ' + esc(sym.kind) + '"' + open + '>';
  h += '<summary>' + esc(sym.signature || (sym.name + '(\\u2026)')) + '</summary>';
  if (sym.docstring) h += '<div class="docstring">' + esc(sym.docstring) + '</div>';
  if (children && children.length) {
    h += '<div class="methods">' + children.map(m => symbolHTML(m, [])).join('') + '</div>';
  }
  h += '<pre><code>' + esc(sym.code || sym.stub || '') + '</code></pre>';
  h += '</details>';
  return h;
}

function showDetails(path) {
  const d = DATA.details[path];
  if (!d) { mainEl.innerHTML = '<div class="empty">No registry entry for ' + esc(path) + '</div>'; return; }
  const classes = d.symbols.filter(s => s.kind === 'class');
  const functions = d.symbols.filter(s => s.kind === 'function'
    || (s.kind === 'method' && !classes.some(c => c.id === s.parent)));
  const methods = d.symbols.filter(s => s.kind === 'method');
  let h = '';
  h += '<h2>' + esc(path) + '</h2>';
  h += '<div class="meta">module <code>' + esc(d.module) + '</code> &middot; ' + esc(d.language)
     + ' &middot; ' + d.symbols.length + ' symbol' + (d.symbols.length === 1 ? '' : 's') + '</div>';
  if (d.docstring) h += '<blockquote>' + esc(d.docstring) + '</blockquote>';

  h += '<h3>Imports (' + d.imports.length + ')</h3>';
  if (!d.imports.length) h += '<p class="muted">none</p>';
  else {
    h += '<table class="imports"><tr><th>local</th><th>source</th><th>flags</th><th>line</th></tr>';
    d.imports.forEach(imp => {
      const src = imp.target
        || (imp.target_module ? imp.target_module + (imp.target_symbol ? '.' + imp.target_symbol : '') : '');
      const flags = [];
      if (imp.is_relative) flags.push('relative');
      if (imp.is_wildcard) flags.push('wildcard');
      h += '<tr><td><code>' + esc(imp.alias) + '</code></td><td><code>' + esc(src) + '</code></td>'
         + '<td>' + flags.map(esc).join(', ') + '</td><td>' + (imp.line != null ? imp.line : '') + '</td></tr>';
    });
    h += '</table>';
  }

  h += '<h3>Classes (' + classes.length + ')</h3>';
  if (!classes.length) h += '<p class="muted">none</p>';
  classes.forEach(c => {
    h += symbolHTML(c, methods.filter(m => m.parent === c.id));
  });

  h += '<h3>Functions (' + functions.length + ')</h3>';
  if (!functions.length) h += '<p class="muted">none</p>';
  functions.forEach(f => { h += symbolHTML(f, []); });

  mainEl.innerHTML = h;
}

function applyFilter(q) {
  const files = document.querySelectorAll('#tree li.file-item');
  if (!q) {
    files.forEach(li => li.style.display = '');
    document.querySelectorAll('#tree ul.tree').forEach(ul => ul.classList.add('hidden'));
    document.querySelectorAll('#tree .dir').forEach(s => s.classList.remove('open'));
    return;
  }
  files.forEach(li => {
    const path = li.querySelector('.file').dataset.path;
    const match = path.toLowerCase().includes(q);
    li.style.display = match ? '' : 'none';
    if (match) reveal(path);
  });
  document.querySelectorAll('#tree li.dir-item').forEach(li => {
    const kids = li.querySelectorAll('li.file-item');
    const hasVisible = Array.from(kids).some(f => f.style.display !== 'none');
    li.style.display = hasVisible ? '' : 'none';
  });
}

searchEl.addEventListener('input', () => applyFilter(searchEl.value.trim().toLowerCase()));

(function init() {
  renderTree(DATA.tree.children, treeEl);
  const s = DATA.stats;
  statsEl.textContent = (s.files || 0) + ' files, ' + (s.symbols || 0) + ' symbols'
    + (s.edge_types && s.edge_types.CALLS ? ', ' + s.edge_types.CALLS + ' CALLS edges' : '');
})();
</script>
</body>
</html>
"""


def _build_file_tree(paths: list[str]) -> dict:
    """Turn flat file paths into a nested {name, path, is_file, children} tree."""
    root: dict = {"name": "", "path": "", "is_file": False, "children": {}}
    for path in paths:
        node = root
        parts = path.split("/")
        for i, part in enumerate(parts):
            is_file = i == len(parts) - 1
            if part not in node["children"]:
                node["children"][part] = {
                    "name": part,
                    "path": "/".join(parts[: i + 1]),
                    "is_file": is_file,
                    "children": {},
                }
            node = node["children"][part]

    def to_list(n: dict) -> dict:
        dirs, files = [], []
        for child in n["children"].values():
            (files if child["is_file"] else dirs).append(to_list(child))
        dirs.sort(key=lambda x: x["name"].lower())
        files.sort(key=lambda x: x["name"].lower())
        return {
            "name": n["name"],
            "path": n["path"],
            "is_file": n["is_file"],
            "children": dirs + files,
        }

    return to_list(root)


def _load_files_data(registry_path: Path) -> dict:
    """Extract a slim file-centric view from symbol_registry.json."""
    with open(registry_path, encoding="utf-8") as fh:
        registry = json.load(fh)

    symbols = registry.get("symbols", {})
    modules = registry.get("modules", {})
    details: dict[str, dict] = {}
    paths: list[str] = []

    for module, info in modules.items():
        path = info.get("file_path", "").replace("\\", "/")
        file_syms = []
        for sid in info.get("symbol_ids", []):
            sym = symbols.get(sid, {})
            file_syms.append(
                {
                    "id": sid,
                    "kind": sym.get("kind", "symbol"),
                    "name": sym.get("name", sid.rsplit(".", 1)[-1]),
                    "signature": sym.get("signature", ""),
                    "docstring": sym.get("docstring"),
                    "code": sym.get("code", ""),
                    "stub": sym.get("stub", ""),
                    "parent": sym.get("parent"),
                }
            )
        imports = [
            {
                "alias": imp.get("alias", ""),
                "target": imp.get("target", ""),
                "target_module": imp.get("target_module", ""),
                "target_symbol": imp.get("target_symbol", ""),
                "line": imp.get("line"),
                "is_relative": imp.get("is_relative", False),
                "is_wildcard": imp.get("is_wildcard", False),
            }
            for imp in info.get("imports", [])
        ]
        details[path] = {
            "module": module,
            "language": info.get("language", "python"),
            "docstring": info.get("docstring"),
            "imports": imports,
            "symbols": file_syms,
        }
        paths.append(path)

    return {
        "tree": _build_file_tree(paths),
        "details": details,
        "stats": registry.get("stats", {}),
    }


def _render_files_html(data: dict) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    payload = payload.replace("</", "<\\/")  # keep safe inside <script>
    return FILES_HTML_TEMPLATE.replace("__DATA__", payload)


def _run_files_mode(args: argparse.Namespace) -> None:
    registry_path = args.registry or REGISTRY_PATH
    if not registry_path.exists():
        raise SystemExit(
            f"missing {registry_path} -- run first:\n"
            f"  adventure-call <root> --out-dir out"
        )

    data = _load_files_data(registry_path)
    FILES_OUTPUT.write_text(_render_files_html(data), encoding="utf-8")

    webbrowser.open(FILES_OUTPUT.resolve().as_uri())
    print(f"{len(data['details'])} files in file tree")
    print(f"wrote {FILES_OUTPUT}")


if __name__ == "__main__":
    sys.exit(main())
