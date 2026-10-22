"""Mermaid flowcharts of the view queries: ``--format mermaid`` (tic-3998).

The CLI twin of ``web/src/modes/mermaid.ts`` (tic-ca91), with the same
conventions: a leading comment naming the view, ``n0..`` ids, entity-escaped
labels, strokes rather than fills.  Each renderer draws the JSON its query
already returned, so the diagram and ``--format json`` always agree on what is
in the view.
"""

from __future__ import annotations

import re
from typing import Any

from adventure_call.query import Workspace

#: Mermaid's default limits; most renderers refuse a diagram beyond them.
MAX_EDGES = 500
MAX_TEXT = 50_000

# web/src/canvas/theme.ts
ACCENT = "#89b4fa"
CYCLE = "#f38ba8"
DIR = "#94e2d5"
EXTERNAL = "#6c7086"

_SHAPES = {
    "rect": '["{}"]',
    "round": '("{}")',
    "external": '[["{}"]]',
}


def escape(text: str) -> str:
    """Label text with Mermaid's syntax characters as entity codes."""
    return text.replace("#", "#35;").replace('"', "#34;").replace("<", "#60;").replace(">", "#62;")


class Diagram:
    """A flowchart under construction; nodes are keyed by the caller's ids."""

    def __init__(self, title: str, direction: str = "LR") -> None:
        self.header = [f"%% adventure-call: {title}", f"flowchart {direction}"]
        self.ids: dict[str, str] = {}
        self.lines: list[str] = []
        self.edges: list[str] = []
        self.strokes: dict[str, str] = {}
        self.link_styles: dict[str, list[int]] = {}

    def note(self, text: str) -> None:
        self.header.append(f"%% {text}")

    def node(self, key: str, label: str, sublabel: str | None = None, *, shape: str = "rect",
             stroke: str | None = None) -> str:
        if key in self.ids:
            return self.ids[key]
        node_id = self.ids[key] = f"n{len(self.ids)}"
        text = escape(label or "/") + (f"<br/>{escape(sublabel)}" if sublabel else "")
        self.lines.append(f"  {node_id}{_SHAPES[shape].format(text)}")
        if stroke:
            self.strokes[node_id] = stroke
        return node_id

    def edge(self, a: str, b: str, *, directed: bool = True, label: str | None = None,
             stroke: str | None = None, dashed: bool = False) -> None:
        arrow = "-->" if directed else "---"
        text = f'|"{escape(label)}"|' if label else ""
        index = len(self.edges)
        self.edges.append(f"  {self.ids[a]} {arrow}{text} {self.ids[b]}")
        parts = ([f"stroke:{stroke}"] if stroke else []) + (["stroke-dasharray:4 3"] if dashed else [])
        if parts:
            self.link_styles.setdefault(",".join(parts), []).append(index)

    def render(self) -> str:
        styles: list[str] = []
        by_colour: dict[str, list[str]] = {}
        for node_id, colour in self.strokes.items():
            by_colour.setdefault(colour, []).append(node_id)
        for i, (colour, members) in enumerate(by_colour.items()):
            styles.append(f"  classDef s{i} stroke:{colour},stroke-width:2px")
            styles.append(f"  class {','.join(members)} s{i}")
        for style, indices in self.link_styles.items():
            styles.append(f"  linkStyle {','.join(map(str, indices))} {style}")
        return "\n".join([*self.header, *self.lines, *self.edges, *styles]) + "\n"


def _count(value: int, metric: str) -> str:
    return f"{value} {metric[:-1] if value == 1 else metric}"


def tree(payload: dict[str, Any]) -> Diagram:
    """The fs-tree: directories joined to their contents, files sized by the metric."""
    metric = payload["metric"]
    root = payload["root"]
    diagram = Diagram(f"tree {root} ({metric})")
    body = payload["tree"]
    top = "dir:" + root
    diagram.node(top, "/" if root == "." else root, _count(body["_total"], metric), shape="round", stroke=DIR)

    def visit(parent: str, path: str, children: dict[str, Any]) -> None:
        for name, value in children.items():
            if name == "_total":
                continue
            key = f"{path}{name}"
            if name.endswith("/"):
                total = value["_total"] if isinstance(value, dict) else value
                diagram.node("dir:" + key, name.rstrip("/"), _count(total, metric), shape="round", stroke=DIR)
                diagram.edge(parent, "dir:" + key, directed=False)
                if isinstance(value, dict):
                    visit("dir:" + key, key, value)
            else:
                diagram.node(key, name, _count(value, metric))
                diagram.edge(parent, key, directed=False)

    visit(top, "", body)
    return diagram


_IMPORT_EDGE = re.compile(r"^(.*?) -> (.*?)(?: \[(.*)\])?$")


def _file_node(diagram: Diagram, path: str, *, stroke: str | None = None) -> str:
    directory, _, name = path.rpartition("/")
    return diagram.node(path, name, directory or None, stroke=stroke)


def imports(payload: dict[str, Any]) -> Diagram:
    """The import graph, whole or as one file's local view; cycles in red."""
    centre = payload.get("centre")
    if centre:
        title = f"imports around {centre} (depth {payload['depth']})"
    elif "edges" in payload:
        title = "imports"
    else:
        title = "import cycles"
    diagram = Diagram(title)
    if payload.get("truncated"):
        diagram.note(f"{payload['truncated']} more edges not drawn (raise --limit)")
    cycle_of = {f: i for i, cycle in enumerate(payload.get("cycles", [])) for f in cycle}

    if centre:
        _file_node(diagram, centre, stroke=ACCENT)
    if "edges" not in payload:
        # --cycles: membership only, one box per cycle.
        for i, cycle in enumerate(payload.get("cycles", []), 1):
            diagram.lines.append(f'  subgraph c{i}["cycle {i}"]')
            for path in cycle:
                _file_node(diagram, path, stroke=CYCLE)
            diagram.lines.append("  end")
        return diagram
    for side in ("imports", "imported_by"):
        for path in payload.get(side, {}):
            _file_node(diagram, path)
    for text in payload["edges"]:
        match = _IMPORT_EDGE.match(text)
        if not match:
            continue
        source, target, names = match.groups()
        _file_node(diagram, source)
        _file_node(diagram, target)
        cyclic = source in cycle_of and cycle_of[source] == cycle_of.get(target)
        diagram.edge(source, target, label=names, stroke=CYCLE if cyclic else None)
    return diagram


def calls(payload: dict[str, Any], ws: Workspace) -> Diagram:
    """The rooted call-flow cone; knots in red, external modules as subroutines."""
    root = payload["root"]
    diagram = Diagram(f"calls {root} ({payload['direction']}, depth {payload['depth']})")
    if payload.get("beyond"):
        diagram.note(f"{payload['beyond']} more just outside the view (raise --depth)")
    if payload.get("truncated"):
        diagram.note("truncated at --budget")
    knotted = {member for cycle in payload.get("cycles", []) for member in cycle}

    for node_id, where in payload["nodes"].items():
        hop, _, loc = where.partition(" ")
        module = ws.nodes.get(node_id, {}).get("module", "")
        name = node_id[len(module) + 1:] if module and node_id.startswith(module + ".") else node_id
        stroke = ACCENT if node_id == root else CYCLE if node_id in knotted else None
        diagram.node(node_id, name, loc if hop == "0" else f"{loc} · {hop}", stroke=stroke)
    for text in payload.get("edges", []):
        source, _, rest = text.partition(" -> ")
        target, _, note = rest.partition(" (")
        knot = source in knotted and target in knotted
        diagram.edge(source, target, label=note.rstrip(")") or None, dashed=bool(note),
                     stroke=CYCLE if knot else None)
    for node_id in payload.get("self_recursive", []):
        diagram.edge(node_id, node_id, stroke=CYCLE)
    for node_id, modules in payload.get("externals", {}).items():
        for module in modules:
            diagram.node("ext:" + module, module, shape="external", stroke=EXTERNAL)
            diagram.edge(node_id, "ext:" + module, stroke=EXTERNAL, dashed=True)
    return diagram
