import { useState } from 'react'
import type { FsDir, FsNode } from '../data/derive'

/**
 * The derived directory tree. Top-level directories start open and everything
 * below starts collapsed, which is the only way ~150 files stay readable in a
 * 260px rail; the open set is keyed by path so it survives a `/out` refetch.
 */
export function FileTree({ root }: { root: FsDir }) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})

  return (
    <ul className="tree">
      {root.children.map((child) => (
        <TreeNode
          key={child.path}
          node={child}
          depth={0}
          overrides={overrides}
          setOverrides={setOverrides}
        />
      ))}
    </ul>
  )
}

interface NodeProps {
  node: FsNode
  depth: number
  overrides: Record<string, boolean>
  setOverrides: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
}

function TreeNode({ node, depth, overrides, setOverrides }: NodeProps) {
  const indent = { paddingLeft: `${depth * 11 + 4}px` }

  if (node.type === 'file') {
    return (
      <li>
        <span className="tree-row tree-file" style={indent} title={node.path}>
          <span className="tree-caret" />
          {node.name}
        </span>
      </li>
    )
  }

  const open = overrides[node.path] ?? depth === 0

  return (
    <li>
      <button
        type="button"
        className="tree-row tree-dir"
        style={indent}
        title={node.path}
        aria-expanded={open}
        onClick={() => setOverrides((prev) => ({ ...prev, [node.path]: !open }))}
      >
        <span className="tree-caret">{open ? '▾' : '▸'}</span>
        {node.name}
        <span className="tree-count">{node.fileCount}</span>
      </button>
      {open && (
        <ul>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              overrides={overrides}
              setOverrides={setOverrides}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
