/**
 * Mode ids, in one leaf module (tic-e738).
 *
 * A mode must not import another mode -- tic-0680 settled that when the
 * import graph wanted the fs-tree's expanded-container rows, and lifted the
 * shared vocabulary into ./fileDetail rather than letting one mode reach into
 * the other.  The registry (./registry) stays the only way a mode is
 * discovered.
 *
 * But cross-mode navigation means a mode has to NAME a destination, and a
 * bare string literal fails silently: a typo resolves to the default mode
 * with no error anywhere.  So the ids live here, depended on by everything
 * and depending on nothing -- each mode takes its own `id` from this file,
 * and a mode declaring an `openIn` target takes the destination's from it
 * too.  Naming a mode is not the same as importing one.
 */

export const FS_TREE_MODE_ID = 'fs-tree'
export const IMPORT_GRAPH_MODE_ID = 'import-graph'
export const CALL_FLOW_MODE_ID = 'call-flow'
