import { ethers } from 'ethers'

import { POIService } from './POIService'
import { RailgunTxidScanner } from './RailgunTxidScanner'
import type { SubsquidBalanceScanner as BalanceScanner } from './SubsquidBalanceScanner'
import { TokenService } from './TokenService'
import { TransactionMetadataService } from './TransactionMetadataService'

import RelayAdaptABI from '@/core/abis/RelayAdapt.json'
import type { NetworkName } from '@/types/network'
import { NETWORK_CONFIG } from '@/types/network'
import type {
  DecryptedCommitment,
  DetailedTransaction,
  KnownTransactionType,
  POICommitmentType,
  POIStatus,
  RailgunWallet,
  SubsquidNullifier,
  TransactionType,
} from '@/types/wallet'
import { POI_COMMITMENT_TYPES, TRANSACTION_TYPES } from '@/types/wallet'
import { ByteLength, ByteUtils } from '@/utils/crypto'
import { dlog, dwarn } from '@/utils/debug'
import { calculateRailgunTxid } from '@/utils/poseidon'
import { reconstructSenderAddress } from '@/utils/sender-address-reconstruction'

/**
 * Transaction History Service
 *
 * Uses the wallet's decrypted balance data (UTXOs) to construct transaction history.
 * This approach follows RAILGUN principles:
 * 1. Only commitments that can be decrypted belong to the wallet
 * 2. Groups successfully decrypted commitments by transaction ID
 * 3. Builds transaction records from wallet-specific UTXOs only
 */
export class TransactionHistoryService {
  /**
   * Singleton instance of the TransactionHistoryService.
   */
  private static instance: TransactionHistoryService
  /**
   * POI service instance for generating and submitting PPOI proofs.
   */
  private poiService: POIService
  /**
   * Token service instance for resolving token symbols and metadata.
   */
  private tokenService: TokenService

  /**
   * Private constructor that initializes the POI and token service dependencies.
   */
  private constructor () {
    this.poiService = POIService.getInstance()
    this.tokenService = TokenService.getInstance()
  }

  /**
   * Returns the singleton instance of TransactionHistoryService, creating it if necessary.
   * @returns The singleton TransactionHistoryService instance
   */
  static getInstance (): TransactionHistoryService {
    if (!this.instance) {
      this.instance = new TransactionHistoryService()
    }
    return this.instance
  }

  /**
   * Get transaction history from decrypted balance data (UTXOs) and outgoing transactions
   * This approach matches how Railway builds transaction history from wallet UTXOs,
   * PLUS tracks outgoing transactions where the wallet spent UTXOs.
   * @param wallet - The RAILGUN wallet to retrieve transaction history for
   * @param networkName - The network to query transactions on
   * @param balanceScanner - Balance scanner instance providing decrypted commitments and outgoing transactions
   * @param page - Zero-based page number for pagination
   * @param pageSize - Number of transactions per page
   * @param cachedNullifiers - Optional pre-fetched nullifiers to avoid duplicate network requests
   * @returns Paginated transaction history with detailed transaction records
   */
  async getTransactionHistory (
    wallet: RailgunWallet,
    networkName: NetworkName,
    balanceScanner: BalanceScanner,
    page: number = 0,
    pageSize: number = 10,
    cachedNullifiers?: SubsquidNullifier[]
  ): Promise<{
    transactions: DetailedTransaction[]
    totalCount: number
    hasMore: boolean
  }> {
    try {
      // STEP 1: Get incoming transactions (from decrypted commitments)
      const decryptedCommitments = balanceScanner.getDecryptedCommitmentsForWallet(wallet.id)

      dlog(`Found ${decryptedCommitments.length} decrypted commitments for transaction history`)

      // Group commitments by transaction ID to build transaction records
      const incomingTransactionGroups = this.groupCommitmentsByTransaction(decryptedCommitments)

      dlog(`Grouped into ${Object.keys(incomingTransactionGroups).length} incoming transactions`)

      // STEP 2: Get outgoing transactions (from spent UTXOs via nullifiers)
      // Uses cached nullifiers from the balance scan to avoid duplicate network requests
      dlog('Building outgoing transactions from nullifiers...')
      const outgoingTxs = await balanceScanner.getOutgoingTransactions(
        wallet,
        networkName,
        cachedNullifiers
      )
      dlog(`Found ${outgoingTxs.length} outgoing transactions`)

      // STEP 3: Merge incoming and outgoing transactions
      // Create a map to store outgoing transaction metadata (block number, timestamp from nullifier event)
      const outgoingTxMetadata = new Map<string, { blockNumber: number; timestamp: number }>()

      for (const outgoingTx of outgoingTxs) {
        // Store the actual transaction metadata from the nullifier event
        outgoingTxMetadata.set(outgoingTx.txid, {
          blockNumber: outgoingTx.blockNumber,
          timestamp: outgoingTx.timestamp,
        })

        if (!incomingTransactionGroups[outgoingTx.txid]) {
          // This is a pure outgoing transaction (no decrypted outputs, only spent inputs)
          incomingTransactionGroups[outgoingTx.txid] = outgoingTx.spentCommitments
        } else {
          // Transaction exists with outputs (change) - MERGE the spent inputs
          // This is critical for calculating net amounts correctly
          const existing = incomingTransactionGroups[outgoingTx.txid]
          if (existing) {
            existing.push(...outgoingTx.spentCommitments)
          }
        }
      }

      dlog(`Total transactions after merging: ${Object.keys(incomingTransactionGroups).length}`)

      // Sort transaction groups by timestamp (newest first)
      // For outgoing-only transactions, use the nullifier event timestamp
      const sortedTransactionEntries = Object.entries(incomingTransactionGroups).sort(
        ([txidA, commitmentsA], [txidB, commitmentsB]) => {
          // Check if transactions are outgoing-only (all commitments are spent or sent to others)
          const isOutgoingOnlyA = commitmentsA.every((c) => c.isSpent || c.isSentToOther)
          const isOutgoingOnlyB = commitmentsB.every((c) => c.isSpent || c.isSentToOther)

          // Use nullifier event timestamp for outgoing-only, otherwise use commitment timestamp
          const timestampA =
            isOutgoingOnlyA && outgoingTxMetadata.has(txidA)
              ? outgoingTxMetadata.get(txidA)!.timestamp
              : Math.max(...commitmentsA.map((c) => c.timestamp || 0))
          const timestampB =
            isOutgoingOnlyB && outgoingTxMetadata.has(txidB)
              ? outgoingTxMetadata.get(txidB)!.timestamp
              : Math.max(...commitmentsB.map((c) => c.timestamp || 0))

          return timestampB - timestampA // Newest first (descending order)
        }
      )

      dlog(`Sorted ${sortedTransactionEntries.length} transactions by timestamp (newest first)`)

      // Pre-fetch unshield info (hasUnshield + unshieldToAddress) from Subsquid for outgoing transactions.
      // This avoids per-tx lookups and uses a single batch query.
      const pageEntries = sortedTransactionEntries.slice(page * pageSize, (page + 1) * pageSize)
      const outgoingTxHashes = pageEntries
        .filter(([, commitments]) => commitments.some((c) => c.isSpent))
        .map(([txid]) => txid)
      const unshieldInfo =
        outgoingTxHashes.length > 0
          ? await this.batchFetchUnshieldInfo(networkName, outgoingTxHashes)
          : new Map<string, { hasUnshield: boolean; unshieldToAddress?: string }>()

      // For RelayAdapt unshields (native ETH), Subsquid records the RelayAdapt contract as
      // the recipient. Resolve the true ETH recipient by decoding the transaction calldata.
      // Skips transactions that already have a cached recipient from TransactionMetadataService.
      if (unshieldInfo.size > 0) {
        await this.resolveRelayAdaptRecipients(networkName, unshieldInfo, wallet.id)
      }

      // Convert grouped commitments to detailed transactions with pagination
      const detailedTransactions: DetailedTransaction[] = await Promise.all(
        pageEntries.map(([txid, commitments]) => {
          const info = unshieldInfo.get(txid.toLowerCase())
          return this.buildTransactionFromCommitments(
            txid,
            commitments,
            networkName,
            balanceScanner,
            outgoingTxMetadata.get(txid), // Pass outgoing tx metadata if available
            wallet.id, // Pass walletId for metadata lookup
            wallet.ethereumAddress, // Pass wallet's 0x address for shield sender display
            info?.hasUnshield, // Pass pre-fetched unshield flag
            info?.unshieldToAddress // Pass 0x destination for unshield transactions
          )
        })
      )

      // DO NOT add PPOI status automatically - PPOI should only be checked on explicit user request
      // This prevents automatic network requests to PPOI nodes without user consent

      const totalCount = sortedTransactionEntries.length

      return {
        transactions: detailedTransactions,
        totalCount,
        hasMore: (page + 1) * pageSize < totalCount,
      }
    } catch (error) {
      console.error('Error building transaction history from UTXOs:', error)
      return {
        transactions: [],
        totalCount: 0,
        hasMore: false,
      }
    }
  }

  /**
   * Batch-fetch unshield info (hasUnshield flag and toAddress) from Subsquid.
   * @param networkName - The network to query
   * @param txHashes - Array of EVM transaction hashes to check
   * @returns Map of lowercase txHash to unshield info
   */
  private async batchFetchUnshieldInfo (
    networkName: NetworkName,
    txHashes: string[]
  ): Promise<Map<string, { hasUnshield: boolean; unshieldToAddress?: string }>> {
    const result = new Map<string, { hasUnshield: boolean; unshieldToAddress?: string }>()
    if (txHashes.length === 0) return result

    try {
      const networkConfig = NETWORK_CONFIG[networkName]
      if (!networkConfig?.subsquidUrl) return result

      const formatted = txHashes.map((h) =>
        h.startsWith('0x') ? h.toLowerCase() : '0x' + h.toLowerCase()
      )

      // Subsquid doesn't support transactionHash_in, so use OR conditions
      const orConditions = formatted.map((h) => `{ transactionHash_eq: "${h}" }`).join(', ')

      const query = {
        query: `
          query GetUnshieldInfo {
            transactions(where: { OR: [${orConditions}] }) {
              transactionHash
              hasUnshield
              unshieldToAddress
            }
          }
        `,
      }

      const response = await fetch(networkConfig.subsquidUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query),
      })

      if (!response.ok) return result

      const data = await response.json()
      const txs = data?.data?.transactions
      if (Array.isArray(txs)) {
        for (const tx of txs) {
          if (tx.transactionHash) {
            result.set(tx.transactionHash.toLowerCase(), {
              hasUnshield: !!tx.hasUnshield,
              unshieldToAddress: tx.unshieldToAddress || undefined,
            })
          }
        }
      }
    } catch {
      // Non-critical — type analysis falls back to Transfer
    }

    return result
  }

  /**
   * For unshield-to-native-ETH transactions, the on-chain unshield event records the RelayAdapt
   * contract as the recipient (since WETH goes to RelayAdapt first, then unwrap → ETH transfer).
   * This method fetches the transaction calldata from RPC and decodes the actual ETH recipient
   * from the RelayAdapt relay() → transfer() call.
   * @param networkName - The network to query for transaction data
   * @param unshieldInfo - Map of txHash to unshield recipient info to resolve
   * @param walletId - The wallet ID to check ownership against
   */
  private async resolveRelayAdaptRecipients (
    networkName: NetworkName,
    unshieldInfo: Map<string, { hasUnshield: boolean; unshieldToAddress?: string }>,
    walletId?: string
  ): Promise<void> {
    const relayAdaptAddress = NETWORK_CONFIG[networkName]?.relayAdaptContract?.toLowerCase()
    if (!relayAdaptAddress) return

    const metadataService = TransactionMetadataService.getInstance()

    // Find transactions where unshieldToAddress is the RelayAdapt contract
    const relayAdaptTxHashes: string[] = []
    for (const [txHash, info] of unshieldInfo) {
      if (info.hasUnshield && info.unshieldToAddress?.toLowerCase() === relayAdaptAddress) {
        // Check if we already have a cached recipient from TransactionMetadataService
        if (walletId) {
          const cached = metadataService.getMetadata(walletId, txHash)
          if (cached?.recipientAddress) {
            info.unshieldToAddress = cached.recipientAddress
            continue
          }
        }
        relayAdaptTxHashes.push(txHash)
      }
    }
    if (relayAdaptTxHashes.length === 0) return

    const rpcUrl = NETWORK_CONFIG[networkName]?.rpcUrl
    if (!rpcUrl) return

    const provider = new ethers.JsonRpcProvider(rpcUrl)
    const relayAdaptIface = new ethers.Interface(RelayAdaptABI)
    const transferSelector = relayAdaptIface.getFunction('transfer')!.selector

    await Promise.all(
      relayAdaptTxHashes.map(async (txHash) => {
        try {
          const tx = await provider.getTransaction(txHash)
          if (!tx?.data) return

          // Decode relay(Transaction[], ActionData) calldata
          const decoded = relayAdaptIface.decodeFunctionData('relay', tx.data)
          // decoded[1] is ActionData: { random, requireSuccess, minGasLimit, calls[] }
          const actionData = decoded[1]
          const calls = actionData.calls || actionData[3]

          // Find the transfer() call within the relay's ordered calls
          for (const call of calls) {
            const callData = call.data || call[1]
            if (typeof callData === 'string' && callData.startsWith(transferSelector)) {
              // Decode transfer(TokenTransfer[]) — each TokenTransfer has { token, to, value }
              const transferDecoded = relayAdaptIface.decodeFunctionData('transfer', callData)
              const transfers = transferDecoded[0]
              if (transfers && transfers.length > 0) {
                const realRecipient = (transfers[0].to || transfers[0][1]) as string
                if (realRecipient) {
                  const info = unshieldInfo.get(txHash)
                  if (info) {
                    info.unshieldToAddress = realRecipient.toLowerCase()
                  }
                }
              }
              break
            }
          }
        } catch {
          // Non-critical — falls back to showing RelayAdapt address
        }
      })
    )
  }

  /**
   * Group decrypted commitments by transaction ID
   * Each transaction can have multiple commitments (inputs/outputs)
   * @param commitments - Array of decrypted commitments to group by their transaction IDs
   * @returns Record mapping transaction IDs to arrays of their associated commitments
   */
  private groupCommitmentsByTransaction (
    commitments: DecryptedCommitment[]
  ): Record<string, DecryptedCommitment[]> {
    const groups: Record<string, DecryptedCommitment[]> = {}

    for (const commitment of commitments) {
      const txid = commitment.txid
      if (!txid) continue

      if (!groups[txid]) {
        groups[txid] = []
      }
      groups[txid].push(commitment)
    }

    return groups
  }

  /**
   * Build a detailed transaction from grouped commitments
   * This analyzes the commitments to determine transaction type and details
   * @param txid - The blockchain transaction hash identifying this transaction
   * @param commitments - Array of decrypted commitments belonging to this transaction
   * @param networkName - The network this transaction occurred on
   * @param balanceScanner - Balance scanner instance for blinded commitment computation and POI status lookup
   * @param outgoingTxMetadata - Optional metadata from the nullifier event for outgoing transactions
   * @param outgoingTxMetadata.blockNumber - Block number from the nullifier event
   * @param outgoingTxMetadata.timestamp - Timestamp from the nullifier event
   * @param walletId - Optional wallet ID for loading saved transaction metadata
   * @param walletEthereumAddress - Optional wallet Ethereum address for shield sender display
   * @param hasUnshieldFlag - Optional pre-fetched flag indicating whether this transaction has an unshield
   * @param unshieldToAddress - Optional 0x destination address for unshield transactions (from Subsquid)
   * @returns A fully constructed DetailedTransaction with type analysis, token movements, and metadata
   */
  private async buildTransactionFromCommitments (
    txid: string,
    commitments: DecryptedCommitment[],
    networkName: NetworkName,
    balanceScanner: BalanceScanner,
    outgoingTxMetadata?: { blockNumber: number; timestamp: number },
    walletId?: string,
    walletEthereumAddress?: string,
    hasUnshieldFlag?: boolean,
    unshieldToAddress?: string
  ): Promise<DetailedTransaction> {
    const firstCommitment = commitments[0]

    // For outgoing-only transactions, use the nullifier event metadata
    // (the commitment timestamp is when the UTXO was created, not when it was spent)
    // isSentToOther commitments are outputs to other wallets, not our own outputs
    const isOutgoingOnly = commitments.every((c) => c.isSpent || c.isSentToOther)
    const timestamp =
      isOutgoingOnly && outgoingTxMetadata
        ? outgoingTxMetadata.timestamp
        : (firstCommitment?.timestamp ?? 0)
    const blockNumber =
      isOutgoingOnly && outgoingTxMetadata
        ? outgoingTxMetadata.blockNumber
        : (firstCommitment?.blockNumber ?? 0)

    // Determine transaction type based on commitment analysis
    const { type, category } = this.analyzeTransactionType(commitments, hasUnshieldFlag)

    // Map UNKNOWN to TRANSFER as a safe fallback for display and PPOI mapping
    const safeType: KnownTransactionType =
      type === TRANSACTION_TYPES.UNKNOWN
        ? TRANSACTION_TYPES.TRANSFER
        : (type as KnownTransactionType)

    // Calculate net token movements for this wallet
    const tokenMovements = this.calculateTokenMovements(commitments, networkName, safeType)

    // Get cached PPOI statuses from BalanceScanner
    const cachedPOIStatuses = balanceScanner.getCachedPOIStatuses()

    // Extract blinded commitments for PPOI checking
    // Exclude isSentToOther commitments - they belong to the receiver, not us
    const blindedCommitments = commitments
      .filter((c) => !c.isSentToOther)
      .map((c) => {
        const blindedCommitment = balanceScanner.blindedCommitmentOf(c)
        const poiStatus = cachedPOIStatuses[ByteUtils.normalizeHex256(blindedCommitment)]

        return {
          commitment: blindedCommitment,
          type: this.mapCommitmentTypeToPOI(c.commitmentType, safeType),
          isSpent: c.isSpent,
          ...(poiStatus && { poiStatus }),
        }
      })

    // NOTE: railgunTxid is lazily fetched only when needed for PPOI proof generation
    // to avoid spamming Subsquid with 100+ requests on page load
    const transaction: DetailedTransaction = {
      txid,
      // railgunTxid will be fetched lazily in generatePOIProofForTransaction
      type: safeType,
      category,
      timestamp, // Use the correct timestamp (from nullifier event if outgoing-only)
      blockNumber, // Use the correct block number (from nullifier event if outgoing-only)
      status: 'confirmed', // All decrypted commitments are from confirmed transactions
      blindedCommitments,
      transferredTokens: tokenMovements,
      version: 1, // or use the appropriate version if needed
      // PPOI status will be added later
    }

    // Load metadata if walletId provided
    if (walletId) {
      const savedMetadata = TransactionMetadataService.getInstance().getMetadata(walletId, txid)
      if (savedMetadata) {
        const { recipientAddress, recipientLabel, memo, tags } = savedMetadata
        const metadata: Record<string, any> = {
          ...(recipientAddress && { recipientAddress }),
          ...(recipientLabel && { recipientLabel }),
          ...(memo && { memo }),
          ...(tags && { tags }),
        }

        if (Object.keys(metadata).length > 0) {
          transaction.metadata = metadata
        }
      }
    }

    // Reconstruct the sender's 0zk address from on-chain data (for received transactions).
    // The receiver can decrypt the sender's MPK and unblind their viewing key from the ciphertext.
    // This is the only way to recover who sent us funds if we don't have local metadata.
    const firstReceived = commitments.find((c) => !c.isSpent && !c.isSentToOther && c.senderMasterPublicKey)
    if (firstReceived) {
      if (!transaction.metadata) {
        transaction.metadata = {}
      }

      const senderMPK = firstReceived.senderMasterPublicKey!
      transaction.metadata.senderMasterPublicKey = senderMPK

      // Try to reconstruct full sender address if we have all the data
      if (firstReceived.blindedSenderViewingKey && firstReceived.random) {
        try {
          const senderAddress = reconstructSenderAddress(
            senderMPK,
            firstReceived.blindedSenderViewingKey,
            firstReceived.random,
            undefined // chainId - leave undefined for all-chains address
          )

          if (senderAddress) {
            transaction.metadata.senderAddress = senderAddress
          }
        } catch (error) {
          dlog(`Failed to reconstruct sender address for tx ${txid.slice(0, 10)}...`, error)
        }
      }
    }

    // Reconstruct the receiver's 0zk address from on-chain data (for sent transactions).
    // The sender can decrypt the receiver's MPK and unblind their viewing key from the ciphertext.
    // This recovers who we sent funds to if the recipient address wasn't cached at send time
    // (e.g. imported wallet, cleared storage). The address is persisted after first balance refresh.
    if (!transaction.metadata?.recipientAddress) {
      const sentToOther = commitments.find((c) => c.isSentToOther && c.receiverAddress)
      if (sentToOther?.receiverAddress) {
        if (!transaction.metadata) {
          transaction.metadata = {}
        }
        transaction.metadata.recipientAddress = sentToOther.receiverAddress
      }
    }

    // Extract on-chain memo from decrypted commitments (if not already in local metadata)
    if (!transaction.metadata?.memo) {
      const memoCommitment = commitments.find((c) => c.memoText)
      if (memoCommitment?.memoText) {
        if (!transaction.metadata) {
          transaction.metadata = {}
        }
        transaction.metadata.memo = memoCommitment.memoText
      }
    }

    // For Shield transactions, the sender is the wallet's own Ethereum address
    // (shielding is done FROM one's own 0x address TO one's own 0zk address)
    if (safeType === TRANSACTION_TYPES.SHIELD && walletEthereumAddress) {
      if (!transaction.metadata) {
        transaction.metadata = {}
      }
      if (!transaction.metadata.senderAddress) {
        transaction.metadata.senderAddress = walletEthereumAddress
      }
    }

    // For Unshield transactions, the 0x destination address is stored on-chain and fetched from
    // Subsquid. Unlike private sends, no cryptographic reconstruction is needed - it's a plain
    // EVM address in the unshield event data.
    if (safeType === TRANSACTION_TYPES.UNSHIELD && unshieldToAddress && !transaction.metadata?.recipientAddress) {
      if (!transaction.metadata) {
        transaction.metadata = {}
      }
      transaction.metadata.recipientAddress = unshieldToAddress
    }

    return transaction
  }

  /**
   * Analyze commitments to determine transaction type
   *
   *  Transaction type is determined by the OUTPUT commitments created,
   * NOT by whether you spent inputs!
   *
   * - Shield: Creates ShieldCommitments (deposit from public → private)
   * - Transfer: Creates TransactCommitments (private → private send)
   * - Unshield: Creates UnshieldCommitments (private → public withdrawal)
   * @param commitments - Array of decrypted commitments to analyze for determining transaction type
   * @param hasUnshieldFlag - Optional flag from Subsquid indicating whether the transaction includes an unshield
   * @returns An object containing the determined transaction type and human-readable category label
   */
  private analyzeTransactionType (
    commitments: DecryptedCommitment[],
    hasUnshieldFlag?: boolean
  ): {
      type: TransactionType
      category: string
    } {
    // Check ALL commitment types first (regardless of isSpent status).
    // A ShieldCommitment is ALWAYS a Shield transaction even if the UTXO was later spent.
    // The isSpent flag indicates UTXO state, not transaction type.
    const allTypes = new Set(commitments.map((c) => c.commitmentType))

    // If ALL commitments are ShieldCommitments, this is a Shield deposit.
    // Shield commitments only appear in shield transactions (public → private).
    const hasOnlyShieldCommitments = allTypes.size === 1 && allTypes.has('ShieldCommitment')
    if (hasOnlyShieldCommitments) {
      return { type: TRANSACTION_TYPES.SHIELD, category: 'Shield' }
    }

    // Get unique commitment types from OUTPUTS (unspent/received commitments)
    const outputCommitments = commitments.filter((c) => !c.isSpent)
    const outputTypes = new Set(outputCommitments.map((c) => c.commitmentType))

    // Check what types of outputs this transaction created
    const hasShieldOutputs = outputTypes.has('ShieldCommitment')
    const hasTransactOutputs =
      outputTypes.has('TransactCommitment') || outputTypes.has('LegacyGeneratedCommitment')
    const hasUnshieldOutputs = outputTypes.has('UnshieldCommitment')

    // If we have outputs, use those to determine type
    if (outputCommitments.length > 0) {
      if (hasShieldOutputs && !hasTransactOutputs && !hasUnshieldOutputs) {
        return { type: TRANSACTION_TYPES.SHIELD, category: 'Shield' }
      } else if (hasUnshieldOutputs) {
        return { type: TRANSACTION_TYPES.UNSHIELD, category: 'Unshield' }
      } else if (hasTransactOutputs) {
        // TransactCommitment outputs could be either a private send OR an unshield with change.
        // When unshielding, the change output is a TransactCommitment (not an UnshieldCommitment),
        // so we need to check the hasUnshieldFlag from the TXID merkletree.
        if (hasUnshieldFlag) {
          return { type: TRANSACTION_TYPES.UNSHIELD, category: 'Unshield' }
        }
        return { type: TRANSACTION_TYPES.TRANSFER, category: 'Private Send' }
      }
    }

    // Fallback: If we only have spent inputs (outgoing-only transaction where we didn't receive change)
    // This means we sent funds to someone else and received no change back
    if (outputCommitments.length === 0 && commitments.some((c) => c.isSpent)) {
      // Pure outgoing transaction - we spent inputs but have no outputs
      if (hasUnshieldFlag) {
        return { type: TRANSACTION_TYPES.UNSHIELD, category: 'Unshield' }
      }
      // Otherwise it's a private send where we received no change
      return { type: TRANSACTION_TYPES.TRANSFER, category: 'Private Send' }
    }

    // Legacy fallback for mixed cases
    if (allTypes.has('UnshieldCommitment')) {
      return { type: TRANSACTION_TYPES.UNSHIELD, category: 'Unshield' }
    } else if (allTypes.has('TransactCommitment') || allTypes.has('LegacyGeneratedCommitment')) {
      return { type: TRANSACTION_TYPES.TRANSFER, category: 'Private Send' }
    } else if (allTypes.has('ShieldCommitment')) {
      return { type: TRANSACTION_TYPES.SHIELD, category: 'Shield' }
    }

    return { type: TRANSACTION_TYPES.UNKNOWN, category: 'Unknown' }
  }

  /**
   * Calculate net token movements for this wallet from commitments
   * @param commitments - Array of decrypted commitments with token and value data
   * @param networkName - The network name for resolving token symbols
   * @param transactionType - Optional transaction type to determine direction logic (shield vs transfer)
   * @returns Array of token movement records with address, symbol, net amount, decimals, and direction
   */
  private calculateTokenMovements (
    commitments: DecryptedCommitment[],
    networkName: NetworkName,
    transactionType?: TransactionType
  ): Array<{
    tokenAddress: string
    symbol: string
    amount: bigint
    decimals: number
    direction: 'sent' | 'received'
  }> {
    const movements: Record<
      string,
      {
        tokenAddress: string
        symbol: string
        amount: bigint
        decimals: number
        direction: 'sent' | 'received'
      }
    > = {}

    // Shield transactions: if ALL commitments are ShieldCommitments, this is a Shield deposit.
    // The isSpent flag only means the UTXO was later consumed, not that this wasn't a shield.
    const isShieldTransaction =
      commitments.every((c) => c.commitmentType === 'ShieldCommitment') ||
      transactionType === TRANSACTION_TYPES.SHIELD

    for (const commitment of commitments) {
      const tokenAddress = commitment.tokenAddress?.toLowerCase() || 'unknown'

      if (!movements[tokenAddress]) {
        movements[tokenAddress] = {
          tokenAddress,
          symbol: this.tokenService.getTokenSymbol(tokenAddress, networkName),
          amount: BigInt(0),
          decimals: 18,
          direction: 'received',
        }
      }

      const movement = movements[tokenAddress]!

      const value = commitment.value || BigInt(0)

      if (isShieldTransaction) {
        // Shield transactions: All commitments are "received" (deposit into RAILGUN)
        movement.amount += value
        movement.direction = 'received'
      } else {
        // Transfer and Unshield: Net the spent vs received amounts
        // Spent inputs are negative, sent-to-other outputs are negative,
        // change/received outputs are positive
        if (commitment.isSpent || commitment.isSentToOther) {
          movement.amount -= value
        } else {
          movement.amount += value
        }
      }
    }

    // Determine direction from net amount and make amounts positive for display
    return Object.values(movements)
      .map((m) => ({
        ...m,
        direction: m.amount >= 0 ? ('received' as const) : ('sent' as const),
        amount: m.amount < 0 ? -m.amount : m.amount,
      }))
      .filter((m) => m.amount > 0)
  }

  /**
   * Map commitment type to PPOI type based on ORIGINAL commitment type
   *  Use the commitment's original type (ShieldCommitment, TransactCommitment, etc.)
   * NOT the transaction type. A Shield commitment spent in a Transfer is still type "Shield" for PPOI.
   * @param commitmentType - The original commitment type string (e.g. ShieldCommitment, TransactCommitment)
   * @param transactionType - The overall transaction type used as fallback when commitment type is unknown
   * @returns The POI commitment type classification for PPOI proof generation
   */
  private mapCommitmentTypeToPOI (
    commitmentType: string,
    transactionType: KnownTransactionType
  ): POICommitmentType {
    // Use the ORIGINAL commitment type, not the transaction type
    switch (commitmentType) {
      case 'ShieldCommitment':
      case 'LegacyGeneratedCommitment':
        return POI_COMMITMENT_TYPES.SHIELD

      case 'TransactCommitment':
      case 'TransactCommitmentV2':
      case 'LegacyEncryptedCommitment':
        return POI_COMMITMENT_TYPES.TRANSACT

      default:
        // Fallback to transaction type if commitment type is unknown
        if (transactionType === TRANSACTION_TYPES.SHIELD) {
          return POI_COMMITMENT_TYPES.SHIELD
        }
        if (transactionType === TRANSACTION_TYPES.UNSHIELD) {
          return POI_COMMITMENT_TYPES.UNSHIELD
        }
        return POI_COMMITMENT_TYPES.TRANSACT
    }
  }

  /**
   * Get overall PPOI status for a transaction
   * ALL commitments (outputs AND spent inputs) must have valid PPOI
   * @param transaction - The detailed transaction to evaluate PPOI status for
   * @returns The aggregated PPOI status representing the worst-case status across all commitments
   */
  getTransactionPOIStatus (transaction: DetailedTransaction): POIStatus {
    const commitmentStatuses = transaction.blindedCommitments
      .map((c) => c.poiStatus)
      .filter(Boolean) as POIStatus[]

    if (commitmentStatuses.length === 0) {
      return {
        listKey: 'chainalysis_ofac',
        status: 'missing',
      }
    }

    // If any commitment is invalid, the whole transaction is invalid
    if (commitmentStatuses.some((status) => status.status === 'invalid')) {
      return {
        listKey: 'chainalysis_ofac',
        status: 'invalid',
      }
    }

    // If any commitment is pending, the whole transaction is pending
    if (commitmentStatuses.some((status) => status.status === 'pending')) {
      return {
        listKey: 'chainalysis_ofac',
        status: 'pending',
      }
    }

    // If any commitment is missing, the whole transaction is missing
    if (commitmentStatuses.some((status) => status.status === 'missing')) {
      return {
        listKey: 'chainalysis_ofac',
        status: 'missing',
      }
    }

    // If all commitments are valid, the transaction is valid
    return {
      listKey: 'chainalysis_ofac',
      status: 'valid',
    }
  }

  /**
   * Generate and submit PPOI proof for a transaction
   *
   * This method generates a PPOI proof by fetching the necessary data from blockchain
   * and calling POIService.generateAndSubmitPOIProof().
   * @param transaction - The transaction to generate PPOI for
   * @param networkName - Network the transaction is on
   * @param wallet - Wallet that created the transaction (needed for proof generation)
   * @returns Success status and optional error message
   */
  async generatePOIProofForTransaction (
    transaction: DetailedTransaction,
    networkName: NetworkName,
    wallet: any
  ): Promise<{ success: boolean; error?: string; blindedCommitments?: string[] }> {
    try {
      dlog('Generating PPOI proof for transaction:', {
        txid: transaction.txid.substring(0, 10) + '...',
        type: transaction.type,
        networkName,
      })

      // Validate this is a transact/unshield transaction
      if (
        transaction.type !== TRANSACTION_TYPES.TRANSFER &&
        transaction.type !== TRANSACTION_TYPES.UNSHIELD
      ) {
        return {
          success: false,
          error: 'PPOI proof generation only applies to Private Send and Unshield transactions',
        }
      }

      // NOTE: railgunTxid will be calculated from transaction data below
      // We don't require it to be pre-populated to avoid Subsquid spam on page load

      // Get locally decrypted output commitments (may be empty for outgoing-only transactions)
      const localOutputCommitments = transaction.blindedCommitments
        .filter((c) => !c.isSpent) // Outputs are not spent
        .map((c) => c.commitment)

      // Check if this is an outgoing-only transaction (we spent inputs but outputs went elsewhere)
      // For these transactions, we are the SENDER and can submit PPOI using on-chain output commitments
      const hasSpentInputs = transaction.blindedCommitments.some((c) => c.isSpent)
      const isOutgoingOnly = localOutputCommitments.length === 0 && hasSpentInputs

      if (localOutputCommitments.length > 0) {
        dlog(`Found ${localOutputCommitments.length} locally decrypted output commitments`)
      } else if (isOutgoingOnly) {
        dlog(
          'Outgoing-only transaction detected (outputs sent elsewhere, e.g., vault or external recipient)'
        )
        dlog(
          "Outgoing-only: wallet spent inputs but doesn't own the outputs - will use on-chain commitments"
        )
      } else {
        // No inputs spent and no outputs - this shouldn't happen for a valid Transfer
        return {
          success: false,
          error: 'No output commitments found and no inputs spent - invalid transaction state',
        }
      }

      // Fetch the transaction data from Subsquid (much faster than blockchain!)
      dlog('Fetching transaction data from Subsquid...')

      const networkConfig = NETWORK_CONFIG[networkName]
      if (!networkConfig) {
        return {
          success: false,
          error: `Network configuration not found for ${networkName}`,
        }
      }

      if (!networkConfig.subsquidUrl) {
        return {
          success: false,
          error: `No Subsquid URL configured for ${networkName}`,
        }
      }

      // Query Subsquid for transact event data
      const provedTransaction = await this.fetchTransactionDataFromSubsquid(
        transaction.txid,
        networkConfig.subsquidUrl
      )

      if (!provedTransaction) {
        return {
          success: false,
          error:
            'Failed to fetch transaction data from Subsquid. Transaction may not be indexed yet.',
        }
      }

      dlog(
        `Fetched from Subsquid: ${provedTransaction.nullifiers?.length || 0} nullifiers, ${provedTransaction.commitments?.length || 0} commitments`
      )

      // Verify we have output commitments from Subsquid
      if (!provedTransaction.commitments || provedTransaction.commitments.length === 0) {
        return {
          success: false,
          error: 'No output commitments found in on-chain transaction data',
        }
      }

      // For outgoing-only transactions, log that we're using on-chain commitments
      if (isOutgoingOnly) {
        dlog(
          `Using ${provedTransaction.commitments.length} on-chain output commitments for PPOI submission`
        )
      }

      //  Calculate railgunTxid from transaction data
      dlog('Calculating RAILGUN txid from transaction data...')
      const railgunTxidBigInt = calculateRailgunTxid(
        provedTransaction.nullifiers,
        provedTransaction.commitments,
        provedTransaction.boundParamsHash
      )
      const calculatedRailgunTxid = ByteUtils.nToHex(railgunTxidBigInt, ByteLength.UINT_256, true)
      dlog(`Calculated railgunTxid: ${calculatedRailgunTxid.substring(0, 16)}...`)

      // Call POIService to generate and submit the proof
      dlog('Calling POIService.generateAndSubmitPOIProof()...')

      // Sync FULL txid tree from genesis
      // This is required because the PPOI node validates against a complete merkletree.
      // Partial syncs cause merkle root mismatches.
      dlog('Syncing FULL txid merkletree (required for PPOI proof)...')
      await RailgunTxidScanner.syncFullTree(networkName as any)

      const result = await this.poiService.generateAndSubmitPOIProof(
        networkName,
        calculatedRailgunTxid,
        wallet
      )

      if (result.success) {
        dlog('PPOI proof generated and submitted successfully!')
      } else {
        console.error('PPOI proof generation failed:', result.error)
      }

      return result
    } catch (error: unknown) {
      console.error('Error generating PPOI proof:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      }
    }
  }

  /**
   * Fetch transaction data from Subsquid
   * This is MUCH faster than fetching from blockchain and decoding calldata
   *
   * **Subsquid Schema:**
   * - Table: `transactions` (NOT `transactEvents`)
   * - Field: `transactionHash` is `Bytes` type (REQUIRES 0x prefix)
   * - Fields: `nullifiers`, `commitments` are arrays of hex strings
   * - Field: `boundParamsHash` is the bound params hash
   * - Field: `hasUnshield` is a boolean flag
   * @param txHash - Blockchain transaction hash (with or without 0x prefix)
   * @param subsquidUrl - Subsquid GraphQL endpoint
   * @returns Transaction data with nullifiers, commitments, and bound params
   */
  private async fetchTransactionDataFromSubsquid (
    txHash: string,
    subsquidUrl: string
  ): Promise<{
    nullifiers: string[]
    commitments: string[]
    boundParamsHash: string
    hasUnshield: boolean
    blockNumber?: number
  } | null> {
    try {
      // Ensure tx hash has 0x prefix for Subsquid Bytes type
      const formattedTxHash = txHash.startsWith('0x')
        ? txHash.toLowerCase()
        : '0x' + txHash.toLowerCase()

      // Query Subsquid for transaction data
      // Note: Subsquid Bytes type REQUIRES 0x prefix
      const query = {
        query: `
          query GetTransaction($txHash: Bytes!) {
            transactions(where: { transactionHash_eq: $txHash }, limit: 1) {
              transactionHash
              nullifiers
              commitments
              boundParamsHash
              hasUnshield
              blockNumber
              unshieldValue
            }
          }
        `,
        variables: {
          txHash: formattedTxHash,
        },
      }

      dlog('Querying Subsquid for transaction:', formattedTxHash)

      const response = await fetch(subsquidUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query),
      })

      if (!response.ok) {
        console.error(`Subsquid request failed: HTTP ${response.status}`)
        return null
      }

      const data = await response.json()

      // Check for GraphQL errors
      if (data.errors) {
        console.error('Subsquid GraphQL errors:', JSON.stringify(data.errors, null, 2))
        return null
      }

      if (!data.data?.transactions?.[0]) {
        dwarn('Transaction not found in Subsquid. May not be indexed yet.')
        return null
      }

      const txData = data.data.transactions[0]

      // Format nullifiers (add 0x prefix)
      const nullifiers = (txData.nullifiers || []).map((n: string) =>
        n.startsWith('0x') ? n : '0x' + n
      )

      // Format commitments (add 0x prefix) - commitments is already an array of strings
      const commitments = (txData.commitments || []).map((c: string) =>
        c.startsWith('0x') ? c : '0x' + c
      )

      // Format bound params hash
      const boundParamsHash = txData.boundParamsHash?.startsWith('0x')
        ? txData.boundParamsHash
        : '0x' + (txData.boundParamsHash || '0'.repeat(64))

      // Check if has unshield - use hasUnshield flag if available, otherwise check unshieldValue
      const hasUnshield =
        txData.hasUnshield ?? (txData.unshieldValue && BigInt(txData.unshieldValue) > 0n)

      const blockNumber = Number(txData.blockNumber ?? 0)

      dlog('Fetched transaction data from Subsquid:', {
        nullifiers: nullifiers.length,
        commitments: commitments.length,
        hasUnshield,
        blockNumber,
      })

      return {
        nullifiers,
        commitments,
        boundParamsHash,
        hasUnshield,
        ...(Number.isFinite(blockNumber) && blockNumber > 0 && { blockNumber }),
      }
    } catch (error: unknown) {
      console.error('Failed to fetch transaction data from Subsquid:', error instanceof Error ? error.message : String(error))
      return null
    }
  }
}
