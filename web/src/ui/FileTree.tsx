import { useState } from 'react'
import type { FsDir, FsFile, FsNode } from '../data/derive'
import { GoInIcon } from './GoInIcon'
import { GotoIcon } from './GotoIcon'

/**
 * Subtree pruned to the files `matches` accepts (tic-9098: the predicate is
 * built by the query parser, so the matching logic lives there, not here).  A
 * directory survives when anything in its subtree matches, so the result is
 * still a tree; `null` means nothing did.
 */
export function matchTree(root: FsDir, matches: (file: FsFile) => boolean): FsDir | null {
  const visit = (dir: FsDir): FsDir | null => {
    const children: FsNode[] = []
    let fileCount = 0
    for (const child of dir.children) {
      if (child.type === 'file') {
        if (matches(child)) {
          children.push(child)
          fileCount += 1
        }
      } else {
        const matched = visit(child)
        if (matched) {
          children.push(matched)
          fileCount += matched.fileCount
        }
      }
    }
    return children.length === 0 ? null : { ...dir, children, fileCount }
  }
  return visit(root)
}

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
        <div className="tree-row tree-file" style={indent} title={node.path}>
          <span className="tree-caret" />
          <span className="tree-label">{node.name}</span>
          <GotoIcon target={node.path} label={`Go to ${node.path}`} />
        </div>
      </li>
    )
  }

  const open = overrides[node.path] ?? depth === 0

  return (
    <li>
      <div className="tree-row tree-dir" style={indent} title={node.path}>
        <button
          type="button"
          className="tree-toggle"
          aria-expanded={open}
          onClick={() => setOverrides((prev) => ({ ...prev, [node.path]: !open }))}
        >
          <span className="tree-caret">{open ? '▾' : '▸'}</span>
          <span className="tree-label">{node.name}</span>
          <span className="tree-count">{node.fileCount}</span>
        </button>
        <GotoIcon target={node.path} label={`Go to ${node.path}`} />
        <GoInIcon target={node.path} label={`Go into ${node.path}`} />
      </div>
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
