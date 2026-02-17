const TREE_DEPTH = 16
const TREE_MAX_ITEMS = 2 ** TREE_DEPTH

type UTXOMerkleProof = {
  leaf: string
  elements: string[]
  indices: string
  root: string
}

export type { UTXOMerkleProof }
export { TREE_DEPTH, TREE_MAX_ITEMS }
