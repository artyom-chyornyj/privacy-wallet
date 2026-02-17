/**
 * Syncs RAILGUN transactions from Subsquid and maintains the txid merkletree.
 */

import { ethers } from 'ethers'

import RailgunSmartWalletABI from '@/core/abis/RailgunSmartWallet.json'
import { createPersistentMerkletreeDatabase } from '@/core/merkletrees/database'
import type { RailgunTransactionWithHash } from '@/core/merkletrees/RailgunTxidMerkletree'
import { RailgunTxidMerkletree } from '@/core/merkletrees/RailgunTxidMerkletree'
import { TREE_MAX_ITEMS } from '@/core/merkletrees/types'
import type { NetworkName } from '@/types/network'
import { NETWORK_CONFIG } from '@/types/network'
import { ByteUtils } from '@/utils/crypto'
import { dlog, dwarn } from '@/utils/debug'
import { calculateRailgunTxid, poseidon } from '@/utils/poseidon'
import { createProvider } from '@/utils/rpc'

// Singleton instances per network
const txidMerkletrees = new Map<NetworkName, RailgunTxidMerkletree>()

/**
 * Manages syncing and storage of RAILGUN transaction IDs into a local merkletree.
 */
export class RailgunTxidScanner {
  /**
   * Get or create the txid merkletree for a network.
   * @param networkName - The network to get the merkletree for
   * @returns The txid merkletree instance for the specified network
   */
  static getTxidMerkletree (networkName: NetworkName): RailgunTxidMerkletree {
    if (!txidMerkletrees.has(networkName)) {
      const storageKey = `railgun-txid-db:${networkName}`
      const db = createPersistentMerkletreeDatabase(storageKey)
      const tree = new RailgunTxidMerkletree(networkName, db)
      txidMerkletrees.set(networkName, tree)
      dlog(`Initialized txid merkletree for ${networkName}`)
    }
    return txidMerkletrees.get(networkName)!
  }

  /**
   * Sync RAILGUN transactions from Subsquid.
   * @param networkName - The network to sync transactions for
   * @param fromBlock - The starting block number to sync from
   * @param toBlock - The ending block number to sync to
   */
  static async syncTransactions (
    networkName: NetworkName,
    fromBlock?: number,
    toBlock?: number
  ): Promise<void> {
    const merkletree = this.getTxidMerkletree(networkName)
    const latestSyncedBlock = await merkletree.getLatestSyncedBlock()
    const startBlock = fromBlock ?? latestSyncedBlock

    dlog(`Syncing RAILGUN txid tree for ${networkName} from block ${startBlock}...`)

    const transactions = await this.fetchTransactionsFromSubsquid(networkName, startBlock, toBlock)

    if (transactions.length === 0) {
      dlog('No new transactions to sync')
      return
    }

    dlog(`Fetched ${transactions.length} RAILGUN transactions`)

    await merkletree.queueRailgunTransactions(transactions)
    await merkletree.updateTreesFromWriteQueue()

    const highestBlock = Math.max(...transactions.map((tx) => tx.blockNumber))
    const newLatestBlock = Math.max(latestSyncedBlock, highestBlock)
    await merkletree.setLatestSyncedBlock(newLatestBlock)

    dlog(`Synced to block ${newLatestBlock}`)
  }

  /**
   * Sync the complete txid merkletree from genesis.
   * Required for PPOI proof generation — local merkle root must match the PPOI node's,
   * so we need ALL transactions in order.
   * @param networkName - The network to perform a full tree sync for
   */
  static async syncFullTree (networkName: NetworkName): Promise<void> {
    dlog(`Syncing complete txid merkletree for ${networkName} from genesis...`)

    const merkletree = this.getTxidMerkletree(networkName)
    const { tree: currentTree, index: currentIndex } = await merkletree.getLatestTreeAndIndex()
    const currentTxids = currentTree * TREE_MAX_ITEMS + (currentIndex + 1)

    // Clear and rebuild to ensure correct ordering from genesis
    if (currentTxids > 0) {
      dlog(`Clearing ${currentTxids} existing txids for fresh rebuild`)
      await merkletree.clear()
    }

    await this.syncTransactions(networkName, 0, undefined)

    const { tree, index } = await merkletree.getLatestTreeAndIndex()
    const totalTxids = tree * TREE_MAX_ITEMS + (index + 1)
    dlog(`Full txid tree synced: ${totalTxids} total transactions`)
  }

  /**
   * Fetch RAILGUN transactions from Subsquid GraphQL.
   * @param networkName - The network to fetch transactions for
   * @param fromBlock - The starting block number
   * @param toBlock - The ending block number
   * @returns The fetched and formatted RAILGUN transactions
   */
  private static async fetchTransactionsFromSubsquid (
    networkName: NetworkName,
    fromBlock: number,
    toBlock?: number
  ): Promise<RailgunTransactionWithHash[]> {
    const subsquidURL = this.getSubsquidURL(networkName)
    if (!subsquidURL) {
      dwarn(`No Subsquid URL for network ${networkName}`)
      return []
    }

    const query = this.getTransactionsGraphQLQuery(fromBlock, toBlock)

    const response = await fetch(subsquidURL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })

    if (!response.ok) {
      throw new Error(`Subsquid request failed (${response.status}): ${response.statusText}`)
    }

    const data = await response.json()

    if (data.errors) {
      throw new Error(`GraphQL query failed: ${data.errors[0]?.message || 'Unknown error'}`)
    }

    const transactions = data?.data?.transactions || []
    return transactions.map((tx: any) => this.formatTransaction(tx))
  }

  /**
   * Format raw Subsquid transaction to our interface.
   * Matches ppoi-private railgun-tx-fetching.ts formatting.
   * @param tx - The raw transaction data from Subsquid GraphQL
   * @returns The formatted RAILGUN transaction with computed hash and txid
   */
  private static formatTransaction (tx: any): RailgunTransactionWithHash {
    // Format all values to exactly 32 bytes with 0x prefix before BigInt conversion.
    // Matches PPOI node's subsquid-fetcher.ts formatting.
    const formattedNullifiers = tx.nullifiers.map((n: string) =>
      ByteUtils.formatToByteLength(n, 32, true)
    )
    const formattedCommitments = tx.commitments.map((c: string) =>
      ByteUtils.formatToByteLength(c, 32, true)
    )
    const formattedBoundParamsHash = ByteUtils.formatToByteLength(tx.boundParamsHash, 32, true)

    const railgunTxidBigInt = calculateRailgunTxid(
      formattedNullifiers,
      formattedCommitments,
      formattedBoundParamsHash
    )

    const globalTreePosition = this.getGlobalTreePosition(
      Number(tx.utxoTreeOut),
      Number(tx.utxoBatchStartPositionOut)
    )

    const hashBigInt = poseidon([railgunTxidBigInt, BigInt(tx.utxoTreeIn), globalTreePosition])

    // No 0x prefix — matches PPOI node storage format
    const result: RailgunTransactionWithHash = {
      railgunTxid: ByteUtils.nToHex(railgunTxidBigInt, 32),
      hash: ByteUtils.nToHex(hashBigInt, 32),
      graphID: tx.id,
      commitments: formattedCommitments,
      nullifiers: formattedNullifiers,
      boundParamsHash: formattedBoundParamsHash,
      blockNumber: Number(tx.blockNumber),
      timestamp: Number(tx.blockTimestamp),
      utxoTreeIn: Number(tx.utxoTreeIn),
      utxoTreeOut: Number(tx.utxoTreeOut),
      utxoBatchStartPositionOut: Number(tx.utxoBatchStartPositionOut),
      // Format txid WITHOUT prefix (matches PPOI node)
      txid: ByteUtils.formatToByteLength(tx.transactionHash, 32, false),
      // Format verificationHash WITH prefix (matches PPOI node)
      verificationHash: ByteUtils.formatToByteLength(tx.verificationHash, 32, true),
    }

    if (tx.hasUnshield) {
      result.unshield = {
        tokenData: {
          tokenType: tx.unshieldToken.tokenType,
          tokenAddress: tx.unshieldToken.tokenAddress,
          tokenSubID: tx.unshieldToken.tokenSubID,
        },
        toAddress: tx.unshieldToAddress,
        value: tx.unshieldValue,
      }
    }

    return result
  }

  /**
   * Get global tree position from tree number and index.
   * @param tree - The tree number
   * @param index - The position index within the tree
   * @returns The global position as a bigint
   */
  private static getGlobalTreePosition (tree: number, index: number): bigint {
    return BigInt(tree * TREE_MAX_ITEMS + index)
  }

  /**
   * Build GraphQL query for RAILGUN transactions.
   * @param fromBlock - The starting block number filter
   * @param toBlock - The ending block number filter
   * @returns The GraphQL query string
   */
  private static getTransactionsGraphQLQuery (fromBlock: number, toBlock?: number): string {
    let whereClause = `blockNumber_gte: ${fromBlock}`
    if (toBlock !== undefined) {
      whereClause += `, blockNumber_lte: ${toBlock}`
    }

    return `
      query GetRailgunTransactions {
        transactions(
          where: { ${whereClause} }
          orderBy: [blockNumber_ASC, id_ASC]
          limit: 10000
        ) {
          id
          commitments
          nullifiers
          boundParamsHash
          transactionHash
          blockNumber
          blockTimestamp
          utxoTreeIn
          utxoTreeOut
          utxoBatchStartPositionOut
          verificationHash
          hasUnshield
          unshieldToken {
            tokenType
            tokenAddress
            tokenSubID
          }
          unshieldToAddress
          unshieldValue
        }
      }
    `
  }

  /**
   * Get Subsquid URL for network.
   * @param networkName - The network to get the Subsquid URL for
   * @returns The Subsquid GraphQL endpoint URL, or undefined if not configured
   */
  private static getSubsquidURL (networkName: NetworkName): string | undefined {
    return NETWORK_CONFIG[networkName]?.subsquidUrl
  }

  /**
   * Insert a transaction directly from RPC data, bypassing Subsquid indexing delays.
   * Used immediately after a transaction is confirmed.
   * @param networkName - The network the transaction was submitted on
   * @param txHash - The on-chain transaction hash
   * @param ppoiData - The PPOI-relevant data from the proved transaction
   * @param ppoiData.nullifiers - The nullifiers used in the transaction
   * @param ppoiData.commitments - The commitments created by the transaction
   * @param ppoiData.boundParamsHash - The bound parameters hash for the transaction
   * @returns The computed RAILGUN transaction ID
   */
  static async insertTransactionFromRPC (
    networkName: NetworkName,
    txHash: string,
    ppoiData: {
      nullifiers: string[]
      commitments: string[]
      boundParamsHash: string
    }
  ): Promise<string> {
    const provider = createProvider(networkName)
    const receipt = await provider.getTransactionReceipt(txHash)

    if (!receipt) {
      throw new Error(`Transaction receipt not found for ${txHash}`)
    }

    const TRANSACT_EVENT_TOPIC =
      '0x56a618cda1e34057b7f849a5792f6c8587a2dbe11c83d0254e72cb3daffda7d1'
    const NULLIFIED_EVENT_TOPIC =
      '0x04dea0530f1fa02794e880a05ed8fc3a4c60156f59a0c6c7a5a65e38f2e9e1e3'

    const contractInterface = new ethers.Interface(RailgunSmartWalletABI)

    let utxoTreeOut: number | undefined
    let utxoBatchStartPositionOut: number | undefined
    let utxoTreeIn: number | undefined

    for (const log of receipt.logs) {
      if (log.topics[0] === TRANSACT_EVENT_TOPIC) {
        try {
          const parsedLog = contractInterface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          })
          if (parsedLog && parsedLog.name === 'Transact') {
            const { treeNumber, startPosition } = parsedLog.args
            utxoTreeOut = Number(treeNumber)
            utxoBatchStartPositionOut = Number(startPosition)
          }
        } catch (err) {
          dwarn('Failed to parse Transact log:', err)
        }
      }

      if (log.topics[0] === NULLIFIED_EVENT_TOPIC) {
        try {
          const parsedLog = contractInterface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          })
          if (parsedLog && parsedLog.name === 'Nullified') {
            const { treeNumber } = parsedLog.args
            utxoTreeIn = Number(treeNumber)
          }
        } catch (err) {
          dwarn('Failed to parse Nullified log:', err)
        }
      }
    }

    if (utxoTreeOut === undefined || utxoBatchStartPositionOut === undefined) {
      throw new Error('Could not find Transact event in transaction receipt')
    }

    // Shield transactions have no Nullified event — fall back to utxoTreeOut
    if (utxoTreeIn === undefined) {
      utxoTreeIn = utxoTreeOut
    }

    const railgunTxidBigInt = calculateRailgunTxid(
      ppoiData.nullifiers,
      ppoiData.commitments,
      ppoiData.boundParamsHash
    )

    // Calculate globalTreePosition for leaf hash
    const globalTreePosition = this.getGlobalTreePosition(utxoTreeOut, utxoBatchStartPositionOut)

    // Calculate hash (merkle leaf)
    const hashBigInt = poseidon([railgunTxidBigInt, BigInt(utxoTreeIn), globalTreePosition])

    // No 0x prefix — matches formatTransaction and PPOI node storage format
    const railgunTxid = ByteUtils.nToHex(railgunTxidBigInt, 32)

    const transaction: RailgunTransactionWithHash = {
      railgunTxid,
      hash: ByteUtils.nToHex(hashBigInt, 32),
      graphID: `rpc-${txHash}`,
      commitments: ppoiData.commitments,
      nullifiers: ppoiData.nullifiers,
      boundParamsHash: ppoiData.boundParamsHash,
      blockNumber: receipt.blockNumber,
      timestamp: Math.floor(Date.now() / 1000), // Use current timestamp as approximation
      utxoTreeIn,
      utxoTreeOut,
      utxoBatchStartPositionOut,
      txid: txHash,
      verificationHash: '', // Not available from RPC
    }

    const merkletree = this.getTxidMerkletree(networkName)
    await merkletree.queueRailgunTransactions([transaction])
    await merkletree.updateTreesFromWriteQueue()

    const currentBlock = await merkletree.getLatestSyncedBlock()
    if (receipt.blockNumber > currentBlock) {
      await merkletree.setLatestSyncedBlock(receipt.blockNumber)
    }

    dlog(`Inserted transaction ${railgunTxid.slice(0, 16)}... into txid merkletree`)

    return railgunTxid
  }

  /**
   * Get statistics about the txid tree.
   * @param networkName - The network to get statistics for
   * @returns The current tree index and latest synced block number
   */
  static async getStats (networkName: NetworkName): Promise<{
    currentIndex: number
    latestBlock: number
  }> {
    const merkletree = this.getTxidMerkletree(networkName)
    const currentIndex = await merkletree.getCurrentTxidIndex()
    const latestBlock = await merkletree.getLatestSyncedBlock()

    return {
      currentIndex,
      latestBlock,
    }
  }
}
