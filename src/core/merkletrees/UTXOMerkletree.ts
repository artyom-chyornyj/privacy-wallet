import type { ethers } from 'ethers'

import type { Database } from './database'
import type { UTXOMerkleProof } from './types'
import { TREE_DEPTH } from './types'

import { MerkleRootValidator } from '@/services/MerkleRootValidator'
import type { NetworkName } from '@/types/network'
import { ByteLength, ByteUtils } from '@/utils/crypto'
import { poseidonHex } from '@/utils/poseidon'
import { MERKLE_ZERO_VALUE_BIGINT } from '@/utils/railgun-crypto'

/**
 * Computes a Poseidon hash of two sibling nodes for the Merkle tree.
 * @param left - The left child node hash as a hex string
 * @param right - The right child node hash as a hex string
 * @returns The Poseidon hash of the two inputs as a hex string
 */
function hashLeftRight (left: string, right: string): string {
  return poseidonHex([left, right])
}

/**
 * UTXO Merkle tree implementation for RAILGUN commitment storage and proof generation.
 */
export class UTXOMerkletree {
  /**
   * Database instance for persisting tree node hashes.
   */
  private db: Database
  /**
   * Pre-computed zero values for each tree level used as default empty node hashes.
   */
  private zeros: string[] = []
  /**
   * Tracks the number of leaves inserted per tree index.
   */
  private treeLengths: Map<number, number> = new Map()
  /**
   * Queued leaf batches awaiting insertion, indexed by tree and starting index.
   */
  private writeQueue: any[][][] = [] // {tree: {startingIndex: [leaves]}}

  // Contract root validation ()
  /**
   * Network name used for contract root validation.
   */
  private networkName?: NetworkName
  /**
   * Ethers provider used for on-chain Merkle root lookups.
   */
  private provider?: ethers.Provider
  /**
   * Validator instance for comparing local Merkle roots against on-chain contract roots.
   */
  private merkleRootValidator?: MerkleRootValidator

  /**
   * Creates a new UTXOMerkletree instance and initializes zero values for all tree levels.
   * @param db - Database instance for persisting tree nodes
   * @param networkName - Optional network name for contract root validation
   * @param provider - Optional ethers provider for on-chain root lookups
   */
  constructor (db: Database, networkName?: NetworkName, provider?: ethers.Provider) {
    this.db = db
    if (networkName) {
      this.networkName = networkName
    }
    if (provider) {
      this.provider = provider
    }
    if (networkName && provider) {
      this.merkleRootValidator = MerkleRootValidator.getInstance()
    }
    this.initZeros()
  }

  /**
   * Initialize zero values for empty tree nodes
   */
  private initZeros (): void {
    // Use MERKLE_ZERO_VALUE_BIGINT
    this.zeros[0] = ByteUtils.nToHex(MERKLE_ZERO_VALUE_BIGINT, 32)
    for (let level = 1; level <= TREE_DEPTH; level++) {
      const prevZero = this.zeros[level - 1]
      if (!prevZero) {
        throw new Error(`Zero value not initialized for level ${level - 1}`)
      }
      this.zeros[level] = hashLeftRight(prevZero, prevZero)
    }
  }

  /**
   * Get node hash at specific position
   * @param tree - The tree index to look up
   * @param level - The tree level (0 = leaves, TREE_DEPTH = root)
   * @param index - The node index within the level
   * @returns The node hash, or the pre-computed zero value if the node does not exist
   */
  private async getNodeHash (tree: number, level: number, index: number): Promise<string> {
    try {
      const key = `${tree}:${level}:${index}`
      const hash = await this.db.get(key)

      return hash
    } catch {
      const zeroValue = this.zeros[level]
      if (!zeroValue) {
        throw new Error(`Zero value not initialized for level ${level}`)
      }
      return zeroValue
    }
  }

  /**
   * Get merkle proof for leaf at specific tree and index
   * @param tree - The tree index containing the leaf
   * @param index - The leaf position within the tree
   * @returns A complete Merkle proof containing the leaf, sibling elements, path indices, and root
   */
  async getUTXOMerkleProof (tree: number, index: number): Promise<UTXOMerkleProof> {
    // Fetch leaf
    const leaf = await this.getNodeHash(tree, 0, index)

    // CORRECT algorithm for RAILGUN circuit: Get sibling at each level
    const elements: string[] = []
    let currentIndex = index

    for (let level = 0; level < TREE_DEPTH; level++) {
      // Calculate sibling index: flip the least significant bit to get sibling
      const siblingIndex = currentIndex ^ 1

      // Get sibling hash from this level
      const siblingHash = await this.getNodeHash(tree, level, siblingIndex)
      elements.push(siblingHash)

      // Move to parent level: shift right by 1 bit
      currentIndex = Math.floor(currentIndex / 2)
    }

    // Convert index to bytes data, the binary representation is the indices of the merkle path
    // Pad to 32 bytes
    const indices = ByteUtils.nToHex(BigInt(index), ByteLength.UINT_256)

    // Fetch root
    const root = await this.getRoot(tree)

    // Return proof
    return {
      leaf,
      elements,
      indices,
      root,
    }
  }

  /**
   * Adds leaves to queue to be added to tree
   * @param tree - tree number to add to
   * @param startingIndex - index of first leaf
   * @param leaves - leaves to add
   */
  async queueLeaves (tree: number, startingIndex: number, leaves: any[]): Promise<void> {
    // Get tree length
    const treeLength = await this.getTreeLength(tree)

    // Ensure write queue for tree exists
    if (!this.writeQueue[tree]) {
      this.writeQueue[tree] = []
    }

    if (treeLength <= startingIndex) {
      // If starting index is greater or equal to tree length, insert to queue
      this.writeQueue[tree][startingIndex] = leaves
    }
  }

  /**
   * Process write queue to update trees
   */
  async updateTreesFromWriteQueue (): Promise<void> {
    const treeIndices = this.treeIndicesFromWriteQueue()
    for (const treeIndex of treeIndices) {
      await this.processWriteQueueForTree(treeIndex)
    }
  }

  /**
   * Get tree indices from write queue
   * @returns Array of tree index numbers that have pending writes in the queue
   */
  private treeIndicesFromWriteQueue (): number[] {
    return Object.keys(this.writeQueue).map(Number)
  }

  /**
   * Process write queue for specific tree
   * @param treeIndex - The tree index to process queued writes for
   */
  private async processWriteQueueForTree (treeIndex: number): Promise<void> {
    const treeWriteQueue = this.writeQueue[treeIndex]
    if (!treeWriteQueue) return

    const startingIndices = Object.keys(treeWriteQueue)
      .map(Number)
      .sort((a, b) => a - b)

    for (const startingIndex of startingIndices) {
      const leaves = treeWriteQueue[startingIndex]
      if (leaves && leaves.length > 0) {
        // Use batch processing algorithm
        await this.insertLeaves(treeIndex, startingIndex, leaves)

        // Clear processed queue
        delete treeWriteQueue[startingIndex]
      }
    }

    // Clear empty writequeue tree
    if (Object.keys(treeWriteQueue).length === 0) {
      delete this.writeQueue[treeIndex]
    }
  }

  /**
   * Insert leaves using batch algorithm
   * @param tree - The tree index to insert leaves into
   * @param startIndex - The starting leaf index for the batch
   * @param leaves - Array of leaf objects containing hash values to insert
   */
  private async insertLeaves (tree: number, startIndex: number, leaves: any[]): Promise<void> {
    let index = startIndex
    const endIndex = startIndex + leaves.length

    const firstLevelHashWriteGroup: string[][] = []
    const dataWriteGroup: any[] = []

    firstLevelHashWriteGroup[0] = []

    // Push values to leaves of write index
    for (const leaf of leaves) {
      // Set writecache value
      firstLevelHashWriteGroup[0][index] = leaf.hash
      dataWriteGroup[index] = leaf
      index += 1
    }

    // Fill hash write group for all tree levels
    const hashWriteGroup: string[][] = await this.fillHashWriteGroup(
      firstLevelHashWriteGroup,
      tree,
      startIndex,
      endIndex
    )

    // Write to database
    await this.writeTreeToDB(tree, hashWriteGroup, dataWriteGroup)
  }

  /**
   * Fill hash write group - compute parent hashes up through all tree levels
   * @param firstLevelHashWriteGroup - Initial leaf-level hash array to build upon
   * @param tree - The tree index for looking up existing node hashes
   * @param startIndex - The starting leaf index of the batch
   * @param endIndex - The ending leaf index of the batch (exclusive)
   * @returns The complete hash write group with computed hashes at all tree levels
   */
  private async fillHashWriteGroup (
    firstLevelHashWriteGroup: string[][],
    tree: number,
    startIndex: number,
    endIndex: number
  ): Promise<string[][]> {
    const hashWriteGroup: string[][] = firstLevelHashWriteGroup

    // Create nodeHashLookup callback
    /**
     * Looks up an existing node hash from the database for use during parent hash computation.
     * @param level - The tree level to look up
     * @param nodeIndex - The node index within the level
     * @returns The stored node hash or the zero value if not found
     */
    const nodeHashLookup = async (level: number, nodeIndex: number): Promise<string> => {
      return await this.getNodeHash(tree, level, nodeIndex)
    }

    let level = 0
    let nextLevelStartIndex = startIndex
    let nextLevelEndIndex = endIndex

    // Loop through each level, computing parent hashes
    while (level < TREE_DEPTH) {
      // Ensure writecache arrays exist for current and next level
      hashWriteGroup[level] = hashWriteGroup[level] ?? []
      hashWriteGroup[level + 1] = hashWriteGroup[level + 1] ?? []

      // Process pairs at this level
      for (
        let pairIndex = nextLevelStartIndex;
        pairIndex <= nextLevelEndIndex + 1;
        pairIndex += 2
      ) {
        // Get left and right children - using nodeHashLookup for missing values
        const levelArray = hashWriteGroup[level]
        const leftChild =
          (levelArray ? levelArray[pairIndex] : undefined) ??
          (await nodeHashLookup(level, pairIndex))
        const rightChild =
          (levelArray ? levelArray[pairIndex + 1] : undefined) ??
          (await nodeHashLookup(level, pairIndex + 1))

        // Calculate parent hash using Poseidon
        const nodeHash = hashLeftRight(leftChild, rightChild)

        // Store in next level at parent index
        const parentIndex = Math.floor(pairIndex / 2)
        const nextLevelArray = hashWriteGroup[level + 1]
        if (nextLevelArray) {
          nextLevelArray[parentIndex] = nodeHash
        }
      }

      // Move to next level - indices shift right (parent level has half the nodes)
      nextLevelStartIndex = Math.floor(nextLevelStartIndex / 2)
      nextLevelEndIndex = Math.floor(nextLevelEndIndex / 2)
      level += 1
    }

    return hashWriteGroup
  }

  /**
   * Write tree to database
   * @param treeIndex - The tree index to write data for
   * @param hashWriteGroup - Multi-level array of computed node hashes to persist
   * @param dataWriteGroup - Array of leaf data objects indexed by leaf position
   */
  private async writeTreeToDB (
    treeIndex: number,
    hashWriteGroup: string[][],
    dataWriteGroup: any[]
  ): Promise<void> {
    // Store leaf data
    const leafLevelArray = hashWriteGroup[0]
    for (let index = 0; index < dataWriteGroup.length; index++) {
      if (dataWriteGroup[index]) {
        const leafKey = `${treeIndex}:0:${index}`
        const leafHash = leafLevelArray?.[index]
        if (leafHash) {
          await this.db.put(leafKey, leafHash)
        }

        // Update tree length
        this.treeLengths.set(treeIndex, Math.max(this.treeLengths.get(treeIndex) || 0, index + 1))
      }
    }

    // Store intermediate and root hashes
    for (let level = 1; level <= TREE_DEPTH; level++) {
      const levelArray = hashWriteGroup[level]
      if (levelArray) {
        for (let index = 0; index < levelArray.length; index++) {
          const nodeHash = levelArray[index]
          if (nodeHash) {
            const nodeKey = `${treeIndex}:${level}:${index}`
            await this.db.put(nodeKey, nodeHash)
          }
        }
      }
    }
  }

  /**
   * Get tree length
   * @param tree - The tree index to get the leaf count for
   * @returns The number of leaves currently stored in the tree
   */
  private async getTreeLength (tree: number): Promise<number> {
    return this.treeLengths.get(tree) || 0
  }

  /**
   * Get root of merkletree - use local calculation to match contract state
   * This should match the contract's current merkle root and be present in rootHistory
   * @param tree - The tree index to compute the root for
   * @returns The root hash of the specified tree
   */
  async getRoot (tree: number): Promise<string> {
    return this.getNodeHash(tree, TREE_DEPTH, 0)
  }

  /**
   * Get current contract root for validation purposes only
   * @param tree - The tree index to fetch the on-chain root for
   * @returns The contract root hash, or null if validation is unavailable or fails
   */
  async getContractRoot (tree: number): Promise<string | null> {
    if (this.networkName && this.provider && this.merkleRootValidator) {
      try {
        const result = await this.merkleRootValidator.validateMerkleRoot(
          tree,
          '0x0', // Dummy local root for comparison
          this.networkName,
          this.provider
        )
        return result.contractRoot || null
      } catch (error) {
        console.error('Failed to get contract root:', error)
        return null
      }
    }
    return null
  }

  /**
   * Verify merkle proof
   * @param proof - The Merkle proof containing leaf, elements, indices, and root to verify
   * @returns True if the proof is valid and the computed root matches the expected root
   */
  static verifyUTXOMerkleProof (proof: UTXOMerkleProof): boolean {
    try {
      // Get indices as BigInt form
      const indices = ByteUtils.hexToBigInt(proof.indices)

      // Reduce through proof elements to compute root
      const calculatedRoot = proof.elements.reduce((current, element, index) => {
        // If index is right
        if ((indices & (2n ** BigInt(index))) > 0n) {
          const result = hashLeftRight(element, current)
          return result
        }

        // If index is left
        const result = hashLeftRight(current, element)
        return result
      }, proof.leaf)

      const valid = ByteUtils.hexlify(proof.root) === ByteUtils.hexlify(calculatedRoot)

      return valid
    } catch (error) {
      return false
    }
  }
}
