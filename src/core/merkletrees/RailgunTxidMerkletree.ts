/**
 * RAILGUN TxID Merkletree — maintains ordered RAILGUN transactions for PPOI proofs.
 */

import { poseidon } from '@railgun-community/circomlibjs'

import type { BatchOperation, Database } from './database'
import type { UTXOMerkleProof } from './types'
import { TREE_DEPTH, TREE_MAX_ITEMS } from './types'

import { ByteLength, ByteUtils } from '@/utils/crypto'
import { dlog } from '@/utils/debug'
import { MERKLE_ZERO_VALUE_BIGINT } from '@/utils/railgun-crypto'

type KeySegment = string | number

/**
 * RAILGUN Transaction data structure (from Subsquid)
 */
interface RailgunTransactionWithHash {
  // Transaction identifiers
  railgunTxid: string // Poseidon hash of nullifiers, commitments, boundParamsHash
  hash: string // Merkle leaf hash: poseidon([railgunTxid, utxoTreeIn, globalTreePosition])

  // Transaction data
  graphID: string
  commitments: string[]
  nullifiers: string[]
  boundParamsHash: string
  blockNumber: number
  timestamp: number

  // Tree positions
  utxoTreeIn: number
  utxoTreeOut: number
  utxoBatchStartPositionOut: number

  // Blockchain reference
  txid: string // EVM transaction hash

  // Optional unshield data
  unshield?: {
    tokenData: {
      tokenType: string
      tokenAddress: string
      tokenSubID: string
    }
    toAddress: string
    value: string
  }

  verificationHash: string
}

/**
 * Merkle proof data for a transaction
 */
interface TXIDMerkletreeData {
  railgunTransaction: RailgunTransactionWithHash
  currentTxidMerkleProofForTree: UTXOMerkleProof
  currentTxidIndexForTree: number
}

/**
 * RAILGUN TxID Merkletree for wallet-side PPOI proof generation
 */
type HistoricalMerkleState = {
  lastProcessedIndex: number
  lastPersistedIndex: number
  levelNodes: Map<number, Map<number, string>>
  pathElements: Map<number, string[]>
}

/**
 * Maintains the RAILGUN TxID Merkle tree for wallet-side PPOI proof generation.
 */
class RailgunTxidMerkletree {
  /**
   * Name of the network this merkle tree is associated with.
   */
  private readonly networkName: string
  /**
   * Database instance used for persistent storage of tree nodes and metadata.
   */
  private readonly db: Database
  /**
   * Precomputed zero-value hashes for each level of the tree.
   */
  private readonly zeros: string[] = []

  // Cache for performance
  /**
   * In-memory cache of node hashes keyed by their database key.
   */
  private cachedNodes: Map<string, string> = new Map()
  /**
   * Cached historical merkle state per tree index for incremental root computation.
   */
  private historicalState: Map<number, HistoricalMerkleState> = new Map()

  /**
   * Create a new RailgunTxidMerkletree instance and initialize zero values.
   * @param networkName - The network name used to namespace database keys.
   * @param db - The database instance for persistent storage.
   */
  constructor (networkName: string, db: Database) {
    this.networkName = networkName
    this.db = db
    this.initializeZeros()
  }

  /**
   * Initialize zero values for empty tree nodes
   * IMPORTANT: All hashes must NOT use 0x prefix to match PPOI node format
   */
  private initializeZeros (): void {
    this.zeros[0] = ByteUtils.nToHex(
      MERKLE_ZERO_VALUE_BIGINT,
      ByteLength.UINT_256
      // NO prefix - must match PPOI node format
    )

    for (let level = 1; level <= TREE_DEPTH; level += 1) {
      const previousZero = this.zeros[level - 1]!
      this.zeros[level] = this.hashLeftRight(previousZero, previousZero)
    }
  }

  /**
   * Get database key prefix for this network's txid tree.
   * @returns The network-namespaced key prefix string.
   */
  private getDBPrefix (): string {
    return `railgun-txid:${this.networkName}`
  }

  /**
   * Get database key for a tree node.
   * @param tree - The tree index.
   * @param level - The level within the tree.
   * @param index - The node index at the given level.
   * @returns The namespaced database key string.
   */
  private getNodeKey (tree: number, level: number, index: number): string {
    return this.buildKey('node', tree, level, index)
  }

  /**
   * Get database key for railgunTxid → txidIndex lookup.
   * IMPORTANT: Normalizes the txid by stripping 0x prefix for consistent lookup.
   * @param railgunTxid - The RAILGUN transaction ID to look up.
   * @returns The namespaced database key for the txid lookup.
   */
  private getTxidLookupKey (railgunTxid: string): string {
    // Strip 0x prefix if present to ensure consistent lookups
    // This is needed because txids are stored without prefix but may be queried with prefix
    const normalizedTxid = ByteUtils.strip0x(railgunTxid)
    return this.buildKey('txid-lookup', normalizedTxid)
  }

  /**
   * Get database key for mapping a blockchain transaction hash to its unshield status.
   * @param txHash - The EVM transaction hash.
   * @returns The namespaced database key for the tx hash unshield lookup.
   */
  private getTxHashUnshieldKey (txHash: string): string {
    const normalized = txHash.toLowerCase().replace(/^0x/, '')
    return this.buildKey('txhash-unshield', normalized)
  }

  /**
   * Check if a blockchain transaction hash corresponds to an unshield transaction.
   * Uses locally stored lookup keys populated during TXID sync (no network call).
   * @param txHash - The EVM transaction hash to check.
   * @returns Whether the transaction hash has an associated unshield.
   */
  async hasUnshieldForTxHash (txHash: string): Promise<boolean> {
    try {
      const key = this.getTxHashUnshieldKey(txHash)
      const data = await this.db.get(key)
      return data?.hasUnshield === true
    } catch {
      return false
    }
  }

  /**
   * Get database key for historical merkleroot.
   * @param tree - The tree index.
   * @param index - The leaf index at which the merkleroot was recorded.
   * @returns The namespaced database key for the historical merkleroot.
   */
  private getMerklerootKey (tree: number, index: number): string {
    return this.buildKey('merkleroot', tree, index)
  }

  /**
   * Get database key for tree metadata.
   * @param tree - The tree index.
   * @returns The namespaced database key for the tree metadata.
   */
  private getTreeMetaKey (tree: number): string {
    return this.buildKey('tree-meta', tree)
  }

  /**
   * Get database key for latest synced block.
   * @returns The namespaced database key for the latest synced block number.
   */
  private getLatestBlockKey (): string {
    return this.buildKey('latest-block')
  }

  /**
   * Build a namespaced key using the current network prefix.
   * @param segments - The key segments to join with colons.
   * @returns The fully qualified namespaced database key.
   */
  private buildKey (...segments: KeySegment[]): string {
    const suffix = segments.map((segment) => String(segment)).join(':')
    return `${this.getDBPrefix()}:${suffix}`
  }

  /**
   * Convert global txid index to tree and local index.
   * @param globalIndex - The global position across all trees.
   * @returns The tree index and local index within that tree.
   */
  static getTreeAndIndexFromGlobalPosition (globalIndex: number): { tree: number; index: number } {
    return {
      tree: Math.floor(globalIndex / TREE_MAX_ITEMS),
      index: globalIndex % TREE_MAX_ITEMS,
    }
  }

  /**
   * Convert tree and local index to global txid index.
   * @param tree - The tree index.
   * @param index - The local index within the tree.
   * @returns The global position across all trees.
   */
  static getGlobalPosition (tree: number, index: number): number {
    return tree * TREE_MAX_ITEMS + index
  }

  /**
   * Get the latest tree and index.
   * @returns The tree index and the last occupied leaf index, or index -1 if empty.
   */
  async getLatestTreeAndIndex (): Promise<{ tree: number; index: number }> {
    // Start from tree 0 and find the highest tree with data
    let currentTree = 0

    while (true) {
      const treeMeta = await this.getTreeMeta(currentTree)
      if (treeMeta.length === 0) {
        // This tree is empty, so previous tree was the last
        if (currentTree === 0) {
          return { tree: 0, index: -1 } // No data at all
        }
        const prevMeta = await this.getTreeMeta(currentTree - 1)
        return { tree: currentTree - 1, index: prevMeta.length - 1 }
      }

      // Check if tree is full
      if (treeMeta.length < TREE_MAX_ITEMS) {
        return { tree: currentTree, index: treeMeta.length - 1 }
      }

      // Tree is full, check next tree
      currentTree++
    }
  }

  /**
   * Get the latest index in a specific tree.
   * @param tree - The tree index to query.
   * @returns The last occupied leaf index, or 0 if the tree is empty.
   */
  async getLatestIndexForTree (tree: number): Promise<number> {
    const treeMeta = await this.getTreeMeta(tree)
    return treeMeta.length > 0 ? treeMeta.length - 1 : 0
  }

  /**
   * Get tree metadata (length).
   * @param tree - The tree index to query.
   * @returns An object containing the number of leaves in the tree.
   */
  private async getTreeMeta (tree: number): Promise<{ length: number }> {
    try {
      const meta = await this.db.get(this.getTreeMetaKey(tree))
      return meta || { length: 0 }
    } catch {
      return { length: 0 }
    }
  }

  /**
   * Queue RAILGUN transactions to be inserted into the tree
   *
   * IMPORTANT: This only queues leaves - call updateTreesFromWriteQueue() after
   * to actually update the tree structure. This  behavior.
   * @param railgunTransactions - Array of RAILGUN transactions to insert into the tree.
   */
  async queueRailgunTransactions (railgunTransactions: RailgunTransactionWithHash[]): Promise<void> {
    if (!railgunTransactions.length) {
      return
    }

    const { tree: latestTree, index: latestIndex } = await this.getLatestTreeAndIndex()
    let nextTree = latestIndex === -1 ? 0 : latestTree
    let nextIndex = latestIndex + 1

    const batchOps: BatchOperation[] = []

    // Queue all leaves first
    for (const tx of railgunTransactions) {
      // Check if we need to move to next tree
      if (nextIndex >= TREE_MAX_ITEMS) {
        nextTree++
        nextIndex = 0
      }

      // Store the leaf node (level 0)
      const leafKey = this.getNodeKey(nextTree, 0, nextIndex)
      batchOps.push({
        type: 'put',
        key: leafKey,
        value: { hash: tx.hash, transaction: tx },
      })

      // Store txid → index lookup
      const txidIndex = RailgunTxidMerkletree.getGlobalPosition(nextTree, nextIndex)
      batchOps.push({
        type: 'put',
        key: this.getTxidLookupKey(tx.railgunTxid),
        value: { txidIndex },
      })

      // Store txHash → hasUnshield lookup (for transaction type analysis in history)
      if (tx.txid) {
        batchOps.push({
          type: 'put',
          key: this.getTxHashUnshieldKey(tx.txid),
          value: { hasUnshield: !!tx.unshield },
        })
      }

      // Update tree metadata
      batchOps.push({
        type: 'put',
        key: this.getTreeMetaKey(nextTree),
        value: { length: nextIndex + 1 },
      })

      nextIndex++
    }

    // Write all queued leaves in one batch
    if (batchOps.length > 0) {
      await this.db.batch(batchOps)
    }
  }

  /**
   * Update tree structures from queued write operations
   *
   * IMPORTANT: Call this AFTER queueRailgunTransactions() to actually build
   * the merkle tree structure. This  behavior.
   */
  async updateTreesFromWriteQueue (): Promise<void> {
    const { tree: latestTree } = await this.getLatestTreeAndIndex()

    // Update all trees that have leaves
    for (let tree = 0; tree <= latestTree; tree++) {
      await this.updateTree(tree)
    }
  }

  /**
   * Update tree structure by recalculating all internal nodes.
   * IMPORTANT: Must write each level to DB before computing next level,
   * because higher levels depend on reading lower level nodes.
   * @param tree - The tree index to recalculate.
   */
  private async updateTree (tree: number): Promise<void> {
    const treeMeta = await this.getTreeMeta(tree)
    const treeLength = treeMeta.length

    if (treeLength === 0) {
      return
    }

    // Calculate all hashes level by level
    // Each level must be committed before computing the next level
    for (let level = 1; level <= TREE_DEPTH; level++) {
      const levelSize = Math.ceil(treeLength / 2 ** level)
      const batchOps: BatchOperation[] = []

      for (let index = 0; index < levelSize; index++) {
        const leftIndex = index * 2
        const rightIndex = leftIndex + 1

        // Get left and right child hashes
        const leftHash = await this.getNodeHash(tree, level - 1, leftIndex)
        const rightHash = await this.getNodeHash(tree, level - 1, rightIndex)

        // Calculate parent hash
        const parentHash = this.hashLeftRight(leftHash, rightHash)

        // Store parent node
        batchOps.push({
          type: 'put',
          key: this.getNodeKey(tree, level, index),
          value: { hash: parentHash },
        })

        // Update cache immediately so higher levels can read it
        this.cachedNodes.set(this.getNodeKey(tree, level, index), parentHash)
      }

      // Write this level to DB before computing next level
      await this.db.batch(batchOps)

      // Debug: Log final level (merkle root)
      if (level === TREE_DEPTH && batchOps.length > 0) {
        const rootHash = batchOps[0]?.value?.hash
        dlog(`Tree ${tree} computed merkleroot: ${rootHash}`)
      }
    }

    await this.storeHistoricalMerkleroots(tree, treeLength)
  }

  /**
   * Get node hash from database or return zero value.
   * @param tree - The tree index.
   * @param level - The level within the tree.
   * @param index - The node index at the given level.
   * @returns The hex hash string for the node, or the zero value for that level.
   */
  private async getNodeHash (tree: number, level: number, index: number): Promise<string> {
    const nodeKey = this.getNodeKey(tree, level, index)

    // Check cache first
    if (this.cachedNodes.has(nodeKey)) {
      return this.cachedNodes.get(nodeKey)!
    }

    try {
      const node = await this.db.get(nodeKey)
      const hash = node.hash
      this.cachedNodes.set(nodeKey, hash)
      return hash
    } catch {
      // Node doesn't exist, return zero value
      return this.zeros[level]!
    }
  }

  /**
   * Hash two nodes together using Poseidon.
   * IMPORTANT: Returns WITHOUT 0x prefix to match PPOI node format.
   * @param left - The left child hash.
   * @param right - The right child hash.
   * @returns The Poseidon hash of the two children without 0x prefix.
   */
  private hashLeftRight (left: string, right: string): string {
    const leftBigInt = ByteUtils.hexToBigInt(left)
    const rightBigInt = ByteUtils.hexToBigInt(right)

    const hashResult = poseidon([leftBigInt, rightBigInt])
    // Return hex WITHOUT 0x prefix (matching PPOI node's poseidonHex format)
    return ByteUtils.nToHex(hashResult, ByteLength.UINT_256)
  }

  /**
   * Get merkle proof for a specific tree position.
   * @param tree - The tree index.
   * @param index - The leaf index to generate a proof for.
   * @returns The merkle proof containing leaf, sibling elements, path indices, and root.
   */
  async getTxidMerkleProof (tree: number, index: number): Promise<UTXOMerkleProof> {
    const leaf = await this.getNodeHash(tree, 0, index)
    const elements: string[] = []

    let currentIndex = index
    for (let level = 0; level < TREE_DEPTH; level++) {
      const siblingIndex = currentIndex ^ 1 // Flip last bit to get sibling
      const siblingHash = await this.getNodeHash(tree, level, siblingIndex)
      elements.push(siblingHash)
      currentIndex = Math.floor(currentIndex / 2)
    }

    // Get root
    const root = await this.getNodeHash(tree, TREE_DEPTH, 0)

    // Convert index to bytes (path indices)
    const indices = ByteUtils.nToHex(BigInt(index), ByteLength.UINT_256, true)

    return {
      leaf,
      elements,
      indices,
      root,
    }
  }

  /**
   * Get merkle proof with HISTORICAL merkleroot (at the time this transaction was inserted).
   * This is CRITICAL for PPOI proof generation - we need the merkleroot that existed
   * when the transaction was added, not the current tree root.
   * @param tree - The tree index.
   * @param index - The leaf index to generate a historical proof for.
   * @returns The merkle proof with the historical root that existed when the leaf was inserted.
   */
  async getHistoricalTxidMerkleProof (tree: number, index: number): Promise<UTXOMerkleProof> {
    const state = await this.ensureHistoricalState(tree)
    if (state.lastProcessedIndex < index) {
      await this.processHistoricalRange(tree, state, state.lastProcessedIndex + 1, index)
    }

    const historicalRoot = await this.getHistoricalMerkleroot(tree, index)
    if (!historicalRoot) {
      throw new Error(`Historical merkleroot not found for tree ${tree}, index ${index}`)
    }

    const pathElements = state.pathElements.get(index)
    if (!pathElements) {
      throw new Error(`Historical merkle proof path not available for tree ${tree}, index ${index}`)
    }

    const leaf = await this.getNodeHash(tree, 0, index)
    const indices = ByteUtils.nToHex(BigInt(index), ByteLength.UINT_256, true)

    return {
      leaf,
      elements: [...pathElements],
      indices,
      root: historicalRoot,
    }
  }

  /**
   * Get RAILGUN transaction by railgunTxid.
   * @param railgunTxid - The RAILGUN transaction ID to look up.
   * @returns The transaction data if found, or undefined.
   */
  async getRailgunTransactionByTxid (
    railgunTxid: string
  ): Promise<RailgunTransactionWithHash | undefined> {
    try {
      const lookupData = await this.db.get(this.getTxidLookupKey(railgunTxid))
      const txidIndex = lookupData.txidIndex
      const { tree, index } = RailgunTxidMerkletree.getTreeAndIndexFromGlobalPosition(txidIndex)
      return this.getRailgunTransaction(tree, index)
    } catch {
      return undefined
    }
  }

  /**
   * Get RAILGUN transaction by tree and index.
   * @param tree - The tree index.
   * @param index - The leaf index within the tree.
   * @returns The transaction data if found, or undefined.
   */
  async getRailgunTransaction (
    tree: number,
    index: number
  ): Promise<RailgunTransactionWithHash | undefined> {
    try {
      const node = await this.db.get(this.getNodeKey(tree, 0, index))
      return node.transaction
    } catch {
      return undefined
    }
  }

  /**
   * Get txid index by railgunTxid.
   * @param railgunTxid - The RAILGUN transaction ID to look up.
   * @returns The global txid index if found, or undefined.
   */
  async getTxidIndexByRailgunTxid (railgunTxid: string): Promise<number | undefined> {
    try {
      const lookupData = await this.db.get(this.getTxidLookupKey(railgunTxid))
      return lookupData.txidIndex
    } catch {
      return undefined
    }
  }

  /**
   * Get complete merkletree data for a railgun transaction
   *
   * IMPORTANT: The PPOI node expects:
   * 1. The CURRENT merkle proof (proof that the txid is in the current tree state)
   * 2. The LATEST txid index (the current position of the last txid in the tree)
   * @param railgunTxid - The RAILGUN transaction ID to retrieve merkletree data for.
   * @returns The transaction, current merkle proof, and latest txid index for the tree.
   */
  async getRailgunTxidMerkletreeData (railgunTxid: string): Promise<TXIDMerkletreeData> {
    const txidIndex = await this.getTxidIndexByRailgunTxid(railgunTxid)
    if (txidIndex === undefined) {
      await this.logMissingTxidDebugInfo(railgunTxid)
      throw new Error(`RAILGUN TxID not found: ${railgunTxid}`)
    }

    const { tree, index } = RailgunTxidMerkletree.getTreeAndIndexFromGlobalPosition(txidIndex)
    const railgunTransaction = await this.getRailgunTransaction(tree, index)
    if (!railgunTransaction) {
      throw new Error(`Transaction not found at tree ${tree}, index ${index}`)
    }

    // Get the CURRENT merkle proof (not historical) - this proves the txid is in the current tree
    const currentTxidMerkleProofForTree = await this.getTxidMerkleProof(tree, index)

    // Get the LATEST index in the tree (not the transaction's own index)
    // This is what the PPOI node expects - the current state of the tree
    const latestIndex = await this.getLatestIndexForTree(tree)
    const currentTxidIndexForTree = RailgunTxidMerkletree.getGlobalPosition(tree, latestIndex)

    dlog(
      `Txid merkletree data for ${railgunTxid.slice(0, 16)}...: index=${txidIndex} (tree ${tree}, pos ${index}), latestIndex=${currentTxidIndexForTree}, root=${currentTxidMerkleProofForTree.root}`
    )

    return {
      railgunTransaction,
      currentTxidMerkleProofForTree,
      currentTxidIndexForTree,
    }
  }

  /**
   * Detailed logging to aid debugging when a txid lookup fails.
   * @param railgunTxid - The RAILGUN transaction ID that was not found.
   */
  private async logMissingTxidDebugInfo (railgunTxid: string): Promise<void> {
    console.error(`RAILGUN TxID not found: ${railgunTxid} (network: ${this.networkName})`)

    try {
      const allKeys = await this.db.keys()
      const txidLookupKeys = allKeys.filter((key) => key.includes(':txid-lookup:'))
      dlog(`Total txids in database: ${txidLookupKeys.length}`)

      if (txidLookupKeys.length > 0) {
        const normalizedLookup = railgunTxid.toLowerCase()
        const caseInsensitiveMatch = txidLookupKeys.find((key) => {
          const keyTxid = key.split(':txid-lookup:')[1]
          return keyTxid?.toLowerCase() === normalizedLookup
        })

        if (caseInsensitiveMatch) {
          const matchedTxid = caseInsensitiveMatch.split(':txid-lookup:')[1]
          console.error(`Found case-insensitive match: ${matchedTxid}`)
        }
      }
    } catch (debugError) {
      console.error('Could not debug txid lookup:', debugError)
    }
  }

  /**
   * Get historical merkleroot for a specific tree and index.
   * @param tree - The tree index.
   * @param index - The leaf index at which the historical merkleroot was recorded.
   * @returns The historical merkleroot hash if found, or undefined.
   */
  async getHistoricalMerkleroot (tree: number, index: number): Promise<string | undefined> {
    try {
      const merkleroot = await this.db.get(this.getMerklerootKey(tree, index))
      return merkleroot
    } catch {
      return undefined
    }
  }

  /**
   * Store historical merkleroots for each leaf index in the tree.
   * @param tree - The tree index.
   * @param treeLength - The number of leaves currently in the tree.
   */
  private async storeHistoricalMerkleroots (tree: number, treeLength: number): Promise<void> {
    if (treeLength === 0) {
      return
    }

    const state = await this.ensureHistoricalState(tree)
    const targetLastIndex = treeLength - 1

    if (state.lastProcessedIndex > targetLastIndex) {
      // Tree was reset; rebuild state from scratch.
      this.historicalState.delete(tree)
      const rebuiltState = await this.ensureHistoricalState(tree)
      await this.processHistoricalRange(
        tree,
        rebuiltState,
        rebuiltState.lastProcessedIndex + 1,
        targetLastIndex
      )
      return
    }

    await this.processHistoricalRange(tree, state, state.lastProcessedIndex + 1, targetLastIndex)
  }

  /**
   * Process a range of leaf indices to compute and persist their historical merkleroots.
   * @param tree - The tree index.
   * @param state - The mutable historical merkle state being built incrementally.
   * @param startIndex - The first leaf index to process (inclusive).
   * @param endIndex - The last leaf index to process (inclusive).
   */
  private async processHistoricalRange (
    tree: number,
    state: HistoricalMerkleState,
    startIndex: number,
    endIndex: number
  ): Promise<void> {
    if (startIndex > endIndex) {
      return
    }

    const batchOps: BatchOperation[] = []

    for (let index = startIndex; index <= endIndex; index++) {
      const root = await this.processLeafForState(tree, state, index)
      if (index > state.lastPersistedIndex) {
        batchOps.push({
          type: 'put',
          key: this.getMerklerootKey(tree, index),
          value: root,
        })
      }
    }

    if (batchOps.length > 0) {
      await this.db.batch(batchOps)
      state.lastPersistedIndex = endIndex
    }
  }

  /**
   * Ensure a historical merkle state object exists for the given tree, creating and replaying persisted data if needed.
   * @param tree - The tree index.
   * @returns The historical merkle state for the tree.
   */
  private async ensureHistoricalState (tree: number): Promise<HistoricalMerkleState> {
    if (this.historicalState.has(tree)) {
      return this.historicalState.get(tree)!
    }

    const levelNodes = new Map<number, Map<number, string>>()
    for (let level = 0; level <= TREE_DEPTH; level++) {
      levelNodes.set(level, new Map())
    }

    const lastPersistedIndex = await this.getLastStoredHistoricalIndex(tree)
    const state: HistoricalMerkleState = {
      lastProcessedIndex: -1,
      lastPersistedIndex,
      levelNodes,
      pathElements: new Map(),
    }

    this.historicalState.set(tree, state)

    if (lastPersistedIndex >= 0) {
      await this.processHistoricalRange(tree, state, 0, lastPersistedIndex)
    }

    return state
  }

  /**
   * Find the highest leaf index that already has a persisted historical merkleroot.
   * @param tree - The tree index.
   * @returns The highest persisted index, or -1 if none exist.
   */
  private async getLastStoredHistoricalIndex (tree: number): Promise<number> {
    const keys = await this.db.keys()
    const prefix = `${this.getDBPrefix()}:merkleroot:${tree}:`
    let maxIndex = -1

    for (const key of keys) {
      if (!key.startsWith(prefix)) {
        continue
      }
      const indexStr = key.slice(prefix.length)
      const index = Number.parseInt(indexStr, 10)
      if (!Number.isNaN(index) && index > maxIndex) {
        maxIndex = index
      }
    }

    return maxIndex
  }

  /**
   * Process a single leaf into the historical state, updating all ancestor nodes and recording the path elements and merkleroot.
   * @param tree - The tree index.
   * @param state - The mutable historical merkle state to update.
   * @param leafIndex - The leaf index being processed.
   * @returns The merkleroot after inserting this leaf.
   */
  private async processLeafForState (
    tree: number,
    state: HistoricalMerkleState,
    leafIndex: number
  ): Promise<string> {
    const leafHash = await this.getNodeHash(tree, 0, leafIndex)
    state.levelNodes.get(0)!.set(leafIndex, leafHash)

    let currentIndex = leafIndex
    for (let level = 0; level < TREE_DEPTH; level++) {
      const levelMap = state.levelNodes.get(level)!
      const leftIndex = currentIndex & ~1
      const rightIndex = leftIndex + 1
      const left = levelMap.get(leftIndex) ?? this.zeros[level]!
      const right = levelMap.get(rightIndex) ?? this.zeros[level]!
      const parentHash = this.hashLeftRight(left, right)
      state.levelNodes.get(level + 1)!.set(Math.floor(currentIndex / 2), parentHash)
      currentIndex = Math.floor(currentIndex / 2)
    }

    const pathElements: string[] = []
    let siblingIndexCursor = leafIndex
    for (let level = 0; level < TREE_DEPTH; level++) {
      const levelMap = state.levelNodes.get(level)!
      const siblingIndex = siblingIndexCursor ^ 1
      const siblingHash = levelMap.get(siblingIndex) ?? this.zeros[level]!
      pathElements.push(siblingHash)
      siblingIndexCursor = Math.floor(siblingIndexCursor / 2)
    }

    state.pathElements.set(leafIndex, pathElements)
    state.lastProcessedIndex = leafIndex
    return state.levelNodes.get(TREE_DEPTH)!.get(0) ?? this.zeros[TREE_DEPTH]!
  }

  /**
   * Get the latest synced block number.
   * @returns The block number of the last sync, or 0 if never synced.
   */
  async getLatestSyncedBlock (): Promise<number> {
    try {
      const data = await this.db.get(this.getLatestBlockKey())
      return data.blockNumber || 0
    } catch {
      return 0
    }
  }

  /**
   * Set the latest synced block number.
   * @param blockNumber - The block number to persist as the latest sync point.
   */
  async setLatestSyncedBlock (blockNumber: number): Promise<void> {
    await this.db.put(this.getLatestBlockKey(), { blockNumber })
  }

  /**
   * Get current txid index (latest).
   * @returns The global position of the latest txid, or -1 if the tree is empty.
   */
  async getCurrentTxidIndex (): Promise<number> {
    const { tree, index } = await this.getLatestTreeAndIndex()
    if (index === -1) {
      return -1
    }
    return RailgunTxidMerkletree.getGlobalPosition(tree, index)
  }

  /**
   * Clear all data (for testing or reset)
   */
  async clear (): Promise<void> {
    const allKeys = await this.db.keys()
    const prefix = this.getDBPrefix()
    const keysToDelete = allKeys.filter((key) => key.startsWith(prefix))

    const batchOps: BatchOperation[] = keysToDelete.map((key) => ({
      type: 'del',
      key,
    }))

    await this.db.batch(batchOps)
    this.cachedNodes.clear()
    this.historicalState.clear()
  }
}

export type { RailgunTransactionWithHash, TXIDMerkletreeData }
export { RailgunTxidMerkletree }
