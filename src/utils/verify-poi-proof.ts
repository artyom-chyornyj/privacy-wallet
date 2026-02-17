import { poseidon } from '@railgun-community/circomlibjs'

import { ByteUtils } from './crypto'

import { dlog } from '@/utils/debug'

/**
 * Verify a PPOI merkle proof manually
 * Reconstructs the root from the leaf and path elements
 * @param leaf - The leaf hash to verify in the merkle tree
 * @param pathElements - Array of sibling hashes along the path from leaf to root
 * @param indices - Bit-packed index indicating left/right position at each tree level
 * @param expectedRoot - The expected merkle root to validate against
 * @param debug - Whether to log detailed verification steps
 * @returns Verification result with validity flag and the computed root
 */
export function verifyPOIMerkleProof (
  leaf: string,
  pathElements: string[],
  indices: string,
  expectedRoot: string,
  debug: boolean = false
): { valid: boolean; computedRoot: string; error?: string } {
  try {
    const leafBigInt = ByteUtils.hexToBigInt(leaf)
    const indicesBigInt = ByteUtils.hexToBigInt(indices)

    if (debug) {
      dlog('MERKLE PROOF VERIFICATION DEBUG:')
      dlog(`   Leaf: ${leaf}`)
      dlog(`   LeafBigInt: ${leafBigInt.toString(16).slice(0, 20)}...`)
      dlog(`   Indices: ${indices}`)
      dlog(`   IndicesBigInt: ${indicesBigInt}`)
      dlog(`   Expected root: ${expectedRoot}`)
      dlog(`   Path elements count: ${pathElements.length}`)
    }

    let currentHash = leafBigInt

    // Process each level of the merkle tree
    for (let i = 0; i < pathElements.length; i++) {
      const element = pathElements[i]
      if (element === undefined) continue
      const pathElement = ByteUtils.hexToBigInt(element)

      // Get the bit at position i from indices (LSB first)
      const isRightNode = (indicesBigInt >> BigInt(i)) & 1n

      if (isRightNode) {
        // Current node is on the right, path element is on the left
        currentHash = poseidon([pathElement, currentHash])
      } else {
        // Current node is on the left, path element is on the right
        currentHash = poseidon([currentHash, pathElement])
      }

      if (debug && i < 3) {
        dlog(`   Level ${i}: isRight=${isRightNode}, element=${element.slice(0, 20)}...`)
        dlog(`      hash = ${ByteUtils.nToHex(currentHash, 32, true).slice(0, 20)}...`)
      }
    }

    const computedRootHex = ByteUtils.nToHex(currentHash, 32, true)
    const expectedRootHex = ByteUtils.formatToByteLength(expectedRoot, 32, true)

    if (debug) {
      dlog(`   Computed root: ${computedRootHex}`)
      dlog(`   Expected root (formatted): ${expectedRootHex}`)
    }

    const valid = computedRootHex.toLowerCase() === expectedRootHex.toLowerCase()

    return {
      valid,
      computedRoot: computedRootHex,
    }
  } catch (error) {
    return {
      valid: false,
      computedRoot: '',
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}
