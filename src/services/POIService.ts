import { poseidon } from '@railgun-community/circomlibjs'
import axios from 'axios'
import { ethers } from 'ethers'

import { PPOINodeClient, TXIDVersion } from './PPOINodeClient'
import { RailgunTxidScanner } from './RailgunTxidScanner'
import { SentTransactionStorage } from './SentTransactionStorage'

import RailgunSmartWalletABI from '@/core/abis/RailgunSmartWallet.json'
import { getArtifactsPOI } from '@/core/artifacts'
import { TREE_MAX_ITEMS } from '@/core/merkletrees/types'
import type { POIProofInputs } from '@/core/prover-poi'
import { getCircuitSize, provePOI } from '@/core/prover-poi'
import type { NetworkName } from '@/types/network'
import { BalanceBucket, NETWORK_CONFIG, POI_REQUIRED_LIST_KEYS, POI_REQUIRED_NODE_URLS } from '@/types/network'
import type { POIStatus, SubsquidCommitment } from '@/types/wallet'
import { ByteUtils, getPublicSpendingKey } from '@/utils/crypto'
import { dlog, dwarn } from '@/utils/debug'
import { decodeRailgunAddress } from '@/utils/railgun-address'
import { getTokenDataHash } from '@/utils/railgun-crypto'
import { createProvider } from '@/utils/rpc'
import { verifyPOIMerkleProof } from '@/utils/verify-poi-proof'

/**
 * PPOI (Proof of Innocence) Service
 *
 * Orchestrates PPOI operations: cache management (localStorage + in-memory),
 * status checking for commitments, and proof generation/submission workflows.
 * Network communication is delegated to PPOINodeClient.
 */
export class POIService {
  /** Singleton instance of the POI service. */
  private static instance: POIService
  /** LocalStorage key for persisting the PPOI status cache. */
  private static readonly CACHE_KEY = 'railgun_poi_status_cache'
  /** LocalStorage key for the cache version marker. */
  private static readonly CACHE_VERSION_KEY = 'railgun_poi_cache_version'
  /** Current cache format version for invalidation on schema changes. */
  private static readonly CACHE_VERSION = '1.0.0'
  /** Duration in milliseconds before a cached PPOI status expires (24 hours). */
  private static readonly CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000 // 24 hours

  // In-memory cache: networkName -> commitment -> PPOI status
  /** Two-level cache mapping network name to commitment hash to PPOI status with timestamp. */
  private poiStatusCache: Map<string, Map<string, { status: POIStatus; timestamp: number }>> =
    new Map()

  // Lazy-loaded SubsquidBalanceScanner to break circular dependency.
  // SubsquidBalanceScanner also imports POIService, so we use dynamic import.

  /** Lazily-loaded SubsquidBalanceScanner instance to break circular dependency. */
  private _balanceScanner: any = null

  /**
   * Lazily resolve SubsquidBalanceScanner via dynamic import to break circular dependency.
   * @returns The SubsquidBalanceScanner singleton instance
   */
  private async getBalanceScanner (): Promise<any> {
    if (!this._balanceScanner) {
      const { SubsquidBalanceScanner } = await import('./SubsquidBalanceScanner')
      this._balanceScanner = SubsquidBalanceScanner.getInstance()
    }
    return this._balanceScanner
  }

  /**
   * Safely convert any value to BigInt. Handles hex strings with or without 0x prefix,
   * decimal strings, numbers, and existing bigints.
   * @param val - The value to convert (bigint, number, or string)
   * @returns The value as a bigint
   */
  private static toBigInt (val: any): bigint {
    if (typeof val === 'bigint') return val
    if (typeof val === 'number') return BigInt(val)
    if (typeof val === 'string') {
      if (val === '' || val === '0') return 0n
      // If it looks like hex (has a-f chars or starts with 0x), ensure 0x prefix
      if (val.startsWith('0x') || val.startsWith('0X')) return BigInt(val)
      if (/^[0-9a-fA-F]+$/.test(val) && /[a-fA-F]/.test(val)) return BigInt(`0x${val}`)
      // Pure decimal string
      return BigInt(val)
    }
    return BigInt(val)
  }

  /**
   * Initialize the POI service and load the persisted status cache.
   */
  private constructor () {
    this.loadCacheFromStorage()
  }

  /**
   * Get or create the singleton POIService instance.
   * @returns The singleton POIService instance
   */
  static getInstance (): POIService {
    if (!this.instance) {
      this.instance = new POIService()
    }
    return this.instance
  }

  /**
   * Load PPOI status cache from localStorage
   */
  private loadCacheFromStorage (): void {
    try {
      // Check if localStorage is available (browser environment)
      if (typeof localStorage === 'undefined' || !localStorage) {
        return
      }

      // Check cache version first
      const storedVersion = localStorage.getItem(POIService.CACHE_VERSION_KEY)
      if (storedVersion !== POIService.CACHE_VERSION) {
        this.clearCache()
        return
      }

      const stored = localStorage.getItem(POIService.CACHE_KEY)
      if (stored) {
        const data = JSON.parse(stored) as Record<
          string,
          Record<string, { status: any; timestamp: number }>
        >

        // Convert to Map structure and validate timestamps
        const now = Date.now()
        for (const [networkName, commitments] of Object.entries(data)) {
          const networkCache = new Map<string, { status: POIStatus; timestamp: number }>()

          for (const [commitment, cacheEntry] of Object.entries(commitments)) {
            // Check if cache entry is still valid (not expired)
            if (now - cacheEntry.timestamp < POIService.CACHE_EXPIRY_MS) {
              networkCache.set(commitment, {
                status: cacheEntry.status,
                timestamp: cacheEntry.timestamp,
              })
            }
          }

          if (networkCache.size > 0) {
            this.poiStatusCache.set(networkName, networkCache)
          }
        }
      }
    } catch (error) {
      console.error('PPOI: Failed to load cache from localStorage:', error)
      this.clearCache()
    }
  }

  /**
   * Save PPOI status cache to localStorage
   */
  private saveCacheToStorage (): void {
    try {
      // Check if localStorage is available (browser environment)
      if (typeof localStorage === 'undefined' || !localStorage) {
        return
      }

      // Convert Map structure to plain object for JSON serialization
      const data: Record<string, Record<string, { status: POIStatus; timestamp: number }>> = {}

      for (const [networkName, commitments] of this.poiStatusCache) {
        data[networkName] = {}
        for (const [commitment, cacheEntry] of commitments) {
          data[networkName][commitment] = cacheEntry
        }
      }

      localStorage.setItem(POIService.CACHE_KEY, JSON.stringify(data))
      localStorage.setItem(POIService.CACHE_VERSION_KEY, POIService.CACHE_VERSION)
    } catch (error) {
      console.error('PPOI: Failed to save status cache to localStorage:', error)
    }
  }

  /**
   * Get cached PPOI status for a commitment.
   * @param networkName - The network to look up the cache for
   * @param commitment - The normalized blinded commitment hash
   * @returns The cached PPOI status, or null if not cached or expired
   */
  private getCachedPOIStatus (networkName: string, commitment: string): POIStatus | null {
    const networkCache = this.poiStatusCache.get(networkName)
    if (!networkCache) return null

    const cacheEntry = networkCache.get(commitment)
    if (!cacheEntry) return null

    // Check if cache entry is still valid
    const now = Date.now()
    if (now - cacheEntry.timestamp >= POIService.CACHE_EXPIRY_MS) {
      // Cache entry expired, remove it
      networkCache.delete(commitment)
      return null
    }

    return cacheEntry.status
  }

  /**
   * Cache PPOI status for commitments.
   * @param networkName - The network the statuses belong to
   * @param statusMap - Map of commitment hashes to their PPOI statuses
   */
  private cachePOIStatuses (networkName: string, statusMap: Record<string, POIStatus>): void {
    if (!this.poiStatusCache.has(networkName)) {
      this.poiStatusCache.set(networkName, new Map())
    }

    const networkCache = this.poiStatusCache.get(networkName)!
    const timestamp = Date.now()

    for (const [commitment, status] of Object.entries(statusMap)) {
      networkCache.set(commitment, { status, timestamp })
    }

    // Persist to localStorage
    this.saveCacheToStorage()
  }

  /**
   * Clear all cached PPOI statuses
   */
  private clearCache (): void {
    this.poiStatusCache.clear()

    // Check if localStorage is available (browser environment)
    if (typeof localStorage !== 'undefined' && localStorage) {
      localStorage.removeItem(POIService.CACHE_KEY)
      localStorage.removeItem(POIService.CACHE_VERSION_KEY)
    }
  }

  /**
   * Clear cached PPOI status for a specific commitment.
   * Useful when forcing a fresh check from the PPOI node.
   * @param networkName - The network the commitment belongs to
   * @param commitment - The blinded commitment hash to clear from cache
   */
  clearCommitmentCache (networkName: string, commitment: string): void {
    const networkCache = this.poiStatusCache.get(networkName)
    if (networkCache) {
      const normalizedCommitment = ByteUtils.normalizeHex256(commitment)
      networkCache.delete(normalizedCommitment)

      // Persist to localStorage
      this.saveCacheToStorage()
    }
  }

  /**
   * Compute the global tree position from tree number and local position.
   * @param tree - The tree number
   * @param position - The local position within the tree
   * @returns The global tree position as a bigint
   */
  private computeGlobalTreePosition (tree: number, position: number): bigint {
    return BigInt(tree) * BigInt(TREE_MAX_ITEMS) + BigInt(position)
  }

  /**
   * Format a railgun txid as a 32-byte hex string for PPOI node communication.
   * @param railgunTxid - The railgun transaction ID to format
   * @returns The formatted 32-byte hex string with 0x prefix
   */
  private formatRailgunTxidForNode (railgunTxid: string): string {
    return ByteUtils.formatToByteLength(railgunTxid, 32, true)
  }

  /**
   * Map a network name to its chain type and chain ID.
   * @param networkName - The network name to resolve
   * @returns Object containing the chain type and chain ID
   */
  private getChainFromNetworkName (networkName: string): { type: number; id: number } {
    const n = networkName.toLowerCase()
    switch (n) {
      case 'ethereum':
        return { type: 0, id: 1 }
      case 'ethereum_sepolia':
        return { type: 0, id: 11155111 }
      case 'bsc':
        return { type: 0, id: 56 }
      case 'polygon':
        return { type: 0, id: 137 }
      case 'arbitrum':
        return { type: 0, id: 42161 }
      default:
        return { type: 0, id: 11155111 }
    }
  }

  /**
   * Get cached PPOI status for commitments without making network calls.
   * Only returns status for commitments that are already cached.
   * @param networkName - The network to look up cached statuses for
   * @param commitmentData - Array of blinded commitments with their types
   * @returns Map of blinded commitment hashes to their cached PPOI statuses
   */
  getPOIStatusForCommitmentsFromCacheOnly (
    networkName: string,
    commitmentData: Array<{ blindedCommitment: string; type: 'Shield' | 'Transact' | 'Unshield' }>
  ): Record<string, POIStatus> {
    const result: Record<string, POIStatus> = {}

    for (const data of commitmentData) {
      const normalizedCommitment = ByteUtils.normalizeHex256(data.blindedCommitment)
      const cached = this.getCachedPOIStatus(networkName, normalizedCommitment)

      if (cached) {
        result[data.blindedCommitment] = cached
      }
    }

    return result
  }

  /**
   * Fetch PPOI status for commitments, using cache where available and querying the PPOI node for uncached entries.
   * @param networkName - The network to check PPOI status on
   * @param commitmentData - Array of blinded commitments with their types
   * @returns Map of blinded commitment hashes to their PPOI statuses
   */
  public async getPOIStatusForCommitments (
    networkName: string,
    commitmentData: Array<{ blindedCommitment: string; type: 'Shield' | 'Transact' | 'Unshield' }>
  ): Promise<Record<string, POIStatus>> {
    const result: Record<string, POIStatus> = {}

    // Check cache first
    const uncachedCommitments: typeof commitmentData = []

    for (const data of commitmentData) {
      const normalizedCommitment = ByteUtils.normalizeHex256(data.blindedCommitment)
      const cached = this.getCachedPOIStatus(networkName, normalizedCommitment)

      if (cached) {
        result[data.blindedCommitment] = cached
      } else {
        uncachedCommitments.push(data)
      }
    }

    // If all commitments were cached, return early
    if (uncachedCommitments.length === 0) {
      return result
    }

    try {
      const nodeUrl = this.getAvailablePOINode()
      if (!nodeUrl) {
        for (const data of uncachedCommitments) {
          result[data.blindedCommitment] = {
            listKey: POI_REQUIRED_LIST_KEYS.CHAINALYSIS_OFAC,
            status: 'missing',
          }
        }
        return result
      }

      const chain = this.getChainFromNetworkName(networkName)

      const listKey = POI_REQUIRED_LIST_KEYS.CHAINALYSIS_OFAC

      // Use V2 only
      const txidVersion: TXIDVersion = TXIDVersion.V2_PoseidonMerkle

      // Normalize outbound commitments for consistent lookups later
      const outboundData = uncachedCommitments.map((d) => ({
        blindedCommitment: ByteUtils.normalizeHex256(d.blindedCommitment),
        type: d.type,
      }))

      /**
       * Send a PPOI status request to the node, falling back to JSON-RPC if REST fails.
       * @param version - The TXID version to use for the request
       * @returns The Axios response from the PPOI node
       */
      const makeRequest = async (version: TXIDVersion) => {
        const body = {
          chainType: String(chain.type),
          chainID: String(chain.id),
          txidVersion: version,
          listKey,
          blindedCommitmentDatas: outboundData,
        }

        try {
          const response = await axios.post(`${nodeUrl}/pois-per-blinded-commitment`, body, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000,
          })
          return response
        } catch {
          // Fallback: try JSON-RPC method name if REST path rejects the schema
          const rpcBody = {
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'ppoi_pois_per_blinded_commitment',
            params: body,
          }
          const rpcResponse = await axios.post(nodeUrl, rpcBody, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000,
          })
          return rpcResponse
        }
      }

      const response = await makeRequest(txidVersion)

      // Response could be REST (plain map) or JSON-RPC ({ result: ... })
      const raw = (response.data?.result ?? response.data ?? {}) as any
      const poisPerCommitmentRaw: Record<string, any> =
        (raw && typeof raw === 'object' && !Array.isArray(raw) && raw) || {}

      // Build a normalized map to handle 0x prefix and casing differences
      const poisPerCommitment = Object.fromEntries(
        Object.entries(poisPerCommitmentRaw).map(([k, v]) => {
          const key = ByteUtils.normalizeHex256(k)
          // If server returned per-list map, select our listKey
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            const statusForList =
              v[listKey] ?? v[String(listKey).toLowerCase()] ?? v[String(listKey).toUpperCase()]
            return [key, statusForList ? String(statusForList) : 'missing']
          }
          return [key, String(v)]
        })
      ) as Record<string, string>

      for (const data of outboundData) {
        const key = ByteUtils.normalizeHex256(data.blindedCommitment)
        const nodeStatus = poisPerCommitment[key] || poisPerCommitment[key.replace(/^0x/, '')]
        if (nodeStatus) {
          result[data.blindedCommitment] = {
            listKey,
            status: this.mapPOIStatus(nodeStatus),
          }
        } else {
          result[data.blindedCommitment] = { listKey, status: 'missing' }
        }
      }

      // Cache the newly fetched PPOI statuses
      const statusesToCache: Record<string, POIStatus> = {}
      for (const data of outboundData) {
        const status = result[data.blindedCommitment]
        if (status) {
          const normalizedCommitment = ByteUtils.normalizeHex256(data.blindedCommitment)
          statusesToCache[normalizedCommitment] = status
        }
      }

      if (Object.keys(statusesToCache).length > 0) {
        this.cachePOIStatuses(networkName, statusesToCache)
      }

      // If V2 doesn't have data for some commitments, they remain 'missing'.

      return result
    } catch (error: unknown) {
      console.error('PPOI: Failed to fetch commitment status:', {
        network: networkName,
        commitments: uncachedCommitments.length,
        error: error instanceof Error ? error.message : String(error),
      })

      // Return pending status for all commitments on error
      for (const data of uncachedCommitments) {
        result[data.blindedCommitment] = {
          listKey: POI_REQUIRED_LIST_KEYS.CHAINALYSIS_OFAC,
          status: 'pending',
        }
      }
      return result
    }
  }

  /**
   * Get the URL of an available PPOI node, preferring local nodes over production.
   * @returns The PPOI node URL, or null if none is available
   */
  private getAvailablePOINode (): string | null {
    return POI_REQUIRED_NODE_URLS[0] || null
  }

  /**
   * Map a raw PPOI node status string to a normalized status value.
   * @param nodeStatus - The raw status string from the PPOI node
   * @returns The normalized status ('valid', 'invalid', 'pending', or 'missing')
   */
  private mapPOIStatus (nodeStatus: string): 'valid' | 'invalid' | 'pending' | 'missing' {
    const s = (nodeStatus || '').toLowerCase()
    if (s === 'valid') return 'valid'
    if (s === 'shieldblocked') return 'invalid'
    if (s === 'proofsubmitted') return 'pending'
    if (s === 'missing') return 'missing'
    if (s === 'invalid') return 'invalid'
    if (s === 'pending') return 'pending'
    return 'missing'
  }

  /**
   * Get balance bucket for a commitment based on PPOI status.
   * @param commitment - The commitment data to determine the bucket for
   * @param commitment.isSpent - Whether the commitment has been spent
   * @param commitment.commitmentType - The type of commitment (ShieldCommitment, TransactCommitment, etc.)
   * @param commitment.isSentNote - Whether the commitment is a sent note
   * @param commitment.outputType - The output type enum value
   * @param commitment.poisPerList - Optional per-list PPOI status map
   * @param poiStatus - Optional PPOI status from cache or node query
   * @returns The balance bucket classification for this commitment
   */
  getBalanceBucketForCommitment (
    commitment: {
      isSpent: boolean
      commitmentType: string
      isSentNote?: boolean
      outputType?: number
      poisPerList?: Record<string, string>
    },
    poiStatus?: POIStatus
  ): BalanceBucket {
    // If already spent, mark as spent
    if (commitment.isSpent) {
      return BalanceBucket.Spent
    }

    const isShield = commitment.commitmentType === 'ShieldCommitment'

    // If no PPOI data available — status hasn't been checked yet
    if (!poiStatus && !commitment.poisPerList) {
      if (isShield) {
        return BalanceBucket.ShieldPending
      }
      return BalanceBucket.Unknown
    }

    // Check PPOI status
    if (poiStatus) {
      switch (poiStatus.status) {
        case 'valid':
          return BalanceBucket.Spendable
        case 'invalid':
          return BalanceBucket.ShieldBlocked
        case 'pending':
          return isShield ? BalanceBucket.ShieldPending : BalanceBucket.ProofSubmitted
        case 'missing':
          if (isShield) {
            return BalanceBucket.ShieldPending
          }
          return BalanceBucket.MissingInternalPOI
      }
    }

    // Fallback — no status checked
    if (isShield) {
      return BalanceBucket.ShieldPending
    }
    return BalanceBucket.Unknown
  }

  /**
   * Clear entire PPOI status cache
   */
  clearPOICache (): void {
    this.clearCache()
  }

  /**
   * Get PPOI launch block for network (before which legacy PPOI proofs are used).
   * @param networkName - The network name to look up the launch block for
   * @returns The PPOI launch block number, or undefined if not configured
   */
  private getPOILaunchBlock (networkName: string): number | undefined {
    // Find the matching network config
    // Try exact match first, then case-insensitive
    let networkConfig = Object.values(NETWORK_CONFIG).find(
      (config: any) => config.name === networkName
    ) as any

    if (!networkConfig) {
      // Try case-insensitive match
      networkConfig = Object.values(NETWORK_CONFIG).find(
        (config: any) => config.name.toLowerCase() === networkName.toLowerCase()
      ) as any
    }

    if (!networkConfig) {
      dwarn(`No network config found for "${networkName}"`)
      dwarn(
        `Available networks: ${Object.values(NETWORK_CONFIG)
          .map((c: any) => c.name)
          .join(', ')}`
      )
      return undefined
    }

    // Return the PPOI launch block from network config
    // For testnets without PPOI config, default to 0 (all transactions require PPOI)
    const launchBlock = networkConfig.poi?.launchBlock ?? 0

    dlog(`PPOI launch block for ${networkName}: ${launchBlock}`)
    return launchBlock
  }

  /**
   * Get wallet TXOs (spent and unspent UTXOs).
   * Integrates with SubsquidBalanceScanner to get all TXOs for a wallet.
   * @param walletId - The wallet ID to retrieve TXOs for
   * @param networkName - The network name (used for error messages)
   * @returns Array of all decrypted commitments (TXOs) for the wallet
   */
  private async getWalletTXOs (walletId: string, networkName: string): Promise<any[]> {
    const scanner = await this.getBalanceScanner()

    // Get all TXOs (spent and unspent) for this wallet
    const allTXOs = scanner.getDecryptedCommitmentsForWallet(walletId)

    if (!allTXOs || allTXOs.length === 0) {
      throw new Error(
        `No TXOs found for wallet ${walletId} on ${networkName}. Please scan balances first.`
      )
    }

    return allTXOs
  }

  /**
   * Fetch commitment ciphertexts from Subsquid for a specific transaction.
   * Used when the commitment data isn't in the scanner cache.
   * @param txHash - The Ethereum transaction hash to fetch commitments for
   * @param networkName - The network to query Subsquid on
   * @returns Array of Subsquid commitments from the transaction
   */
  private async fetchCommitmentsFromSubsquid (
    txHash: string,
    networkName: string
  ): Promise<SubsquidCommitment[]> {
    try {
      const networkConfig = NETWORK_CONFIG[networkName as NetworkName]
      if (!networkConfig?.subsquidUrl) {
        console.error(`No Subsquid URL for network ${networkName}`)
        return []
      }

      const formattedTxHash = txHash.startsWith('0x')
        ? txHash.toLowerCase()
        : '0x' + txHash.toLowerCase()

      const query = {
        query: `
          query GetCommitments($txHash: Bytes!) {
            commitments(
              where: { transactionHash_eq: $txHash }
              orderBy: treePosition_ASC
            ) {
              hash
              treeNumber
              treePosition
              commitmentType
              transactionHash
              blockNumber
              ... on TransactCommitment {
                ciphertext {
                  id
                  ciphertext {
                    id
                    iv
                    tag
                    data
                  }
                  blindedSenderViewingKey
                  blindedReceiverViewingKey
                  annotationData
                  memo
                }
              }
              ... on ShieldCommitment {
                encryptedBundle
                shieldKey
              }
            }
          }
        `,
        variables: { txHash: formattedTxHash },
      }

      const response = await fetch(networkConfig.subsquidUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query),
      })

      if (!response.ok) {
        console.error(`Subsquid request failed: HTTP ${response.status}`)
        return []
      }

      const data = await response.json()

      if (data.errors) {
        console.error('Subsquid GraphQL errors:', JSON.stringify(data.errors, null, 2))
        return []
      }

      const commitments = data.data?.commitments || []

      // FALLBACK: If Subsquid returns no commitments, try fetching directly from blockchain
      if (commitments.length === 0) {
        dwarn(
          `Subsquid returned no commitments for txHash ${formattedTxHash} - transaction may not be indexed yet`
        )
        return []
      }

      // Transform to SubsquidCommitment format
      return commitments.map((c: any) => ({
        hash: c.hash.startsWith('0x') ? c.hash : '0x' + c.hash,
        treeNumber: c.treeNumber,
        treePosition: c.treePosition,
        commitmentType: c.commitmentType as 'ShieldCommitment' | 'TransactCommitment',
        transactionHash: c.transactionHash,
        blockNumber: c.blockNumber,
        ciphertext:
          c.commitmentType === 'TransactCommitment' && c.ciphertext
            ? {
                id: c.ciphertext.id || '',
                ciphertext: c.ciphertext.ciphertext
                  ? {
                      id: c.ciphertext.ciphertext.id || '',
                      iv: c.ciphertext.ciphertext.iv || '',
                      tag: c.ciphertext.ciphertext.tag || '',
                      data: c.ciphertext.ciphertext.data || [],
                    }
                  : { id: '', iv: '', tag: '', data: [] },
                blindedSenderViewingKey: c.ciphertext.blindedSenderViewingKey || '',
                blindedReceiverViewingKey: c.ciphertext.blindedReceiverViewingKey || '',
                annotationData: c.ciphertext.annotationData || '',
                memo: c.ciphertext.memo || '',
              }
            : c.commitmentType === 'ShieldCommitment' && c.encryptedBundle
              ? {
                  encryptedBundle: c.encryptedBundle,
                  shieldKey: c.shieldKey,
                }
              : undefined,
      }))
    } catch (error) {
      console.error('Failed to fetch commitments from Subsquid:', error)
      return []
    }
  }

  /**
   * Fetch commitments directly from blockchain transaction data (fallback when Subsquid is unavailable).
   * Parses the transaction input to extract ciphertext data.
   * @param txHash - The Ethereum transaction hash to fetch from the blockchain
   * @param networkName - The network to query via RPC
   * @returns Array of commitments parsed from transaction event logs
   */
  private async fetchCommitmentsFromRPC (
    txHash: string,
    networkName: string
  ): Promise<SubsquidCommitment[]> {
    try {
      const networkConfig = NETWORK_CONFIG[networkName as NetworkName]
      if (!networkConfig) {
        console.error(`No config for network ${networkName}`)
        return []
      }

      const provider = createProvider(networkName as NetworkName)

      // Get transaction receipt to access event logs
      const receipt = await provider.getTransactionReceipt(txHash)
      if (!receipt) {
        console.error(`Transaction receipt not found for ${txHash}`)
        return []
      }

      // Transact event topic: keccak256("Transact(uint256,uint256,bytes32[],(bytes32[4],bytes32,bytes32,bytes,bytes)[])")
      const TRANSACT_EVENT_TOPIC =
        '0x56a618cda1e34057b7f849a5792f6c8587a2dbe11c83d0254e72cb3daffda7d1'

      const contractInterface = new ethers.Interface(RailgunSmartWalletABI)

      const commitments: SubsquidCommitment[] = []

      // Filter and parse Transact event logs from the receipt
      for (const log of receipt.logs) {
        if (log.topics[0] !== TRANSACT_EVENT_TOPIC) continue

        try {
          const parsedLog = contractInterface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          })

          if (!parsedLog || parsedLog.name !== 'Transact') continue

          const { treeNumber, startPosition, hash, ciphertext: ciphertextArray } = parsedLog.args

          // Process each commitment in the event
          for (let i = 0; i < hash.length; i++) {
            const commitmentHash = hash[i]
            const ciphertextData = ciphertextArray[i]

            if (!ciphertextData) {
              dwarn(`RPC: Missing ciphertext for commitment ${i}`)
              continue
            }

            // Extract ciphertext blocks (array of 4 bytes32 values)
            const ciphertextBlocks = ciphertextData.ciphertext || ciphertextData[0]

            if (!Array.isArray(ciphertextBlocks) || ciphertextBlocks.length !== 4) {
              console.error(
                `RPC: Invalid ciphertext structure for commitment ${i}:`,
                ciphertextBlocks
              )
              continue
            }

            // Parse IV (first 16 bytes) and tag (last 16 bytes) from first block
            const firstBlock = ciphertextBlocks[0]
            const iv = firstBlock.substring(0, 34) // '0x' + 32 hex chars (16 bytes)
            const tag = '0x' + firstBlock.substring(34) // Remaining 32 hex chars (16 bytes)

            const treePosition = Number(startPosition) + i

            commitments.push({
              id: `${txHash}-${treePosition}`,
              hash: commitmentHash,
              treeNumber: Number(treeNumber),
              treePosition,
              commitmentType: 'TransactCommitment' as const,
              transactionHash: txHash,
              blockNumber: receipt.blockNumber,
              blockTimestamp: '', // Not available from receipt
              batchStartTreePosition: Number(startPosition),
              ciphertext: {
                id: `${txHash}-${treePosition}-ciphertext`,
                ciphertext: {
                  id: `${txHash}-${treePosition}-ciphertext-data`,
                  iv,
                  tag,
                  data: [
                    ciphertextBlocks[1], // Encrypted NPK
                    ciphertextBlocks[2], // Encrypted tokenHash
                    ciphertextBlocks[3], // Encrypted random+value
                  ],
                },
                blindedSenderViewingKey:
                  ciphertextData.blindedSenderViewingKey || ciphertextData[1],
                blindedReceiverViewingKey:
                  ciphertextData.blindedReceiverViewingKey || ciphertextData[2],
                annotationData: ciphertextData.annotationData || ciphertextData[3] || '0x',
                memo: ciphertextData.memo || ciphertextData[4] || '0x',
              },
            })
          }
        } catch (parseError) {
          console.error('Error parsing Transact event log:', parseError)
        }
      }

      return commitments
    } catch (error) {
      console.error('Error fetching commitments from RPC:', error)
      return []
    }
  }

  /**
   * Get sent commitments (outputs) for a specific railgunTxid.
   *
   * Returns the output commitment hashes from the transaction itself.
   * These are the blinded commitments that need PPOI validation.
   *
   * Note: We get these from the transaction data, NOT from wallet UTXOs,
   * because wallet UTXOs only contain commitments we can decrypt (received),
   * but PPOI needs ALL output commitments including those sent to others.
   * @param walletId - Runtime wallet ID for SubsquidBalanceScanner TXO lookup
   * @param walletAddress - Deterministic wallet address for SentTransactionStorage lookup
   * @param networkName - The network the transaction occurred on
   * @param railgunTxid - The RAILGUN transaction ID
   * @param railgunTransaction - The full RAILGUN transaction data
   * @param receiverAddresses - Optional map of output index to receiver 0zk address
   * @param receiverWallets - Optional map of output index to receiver wallet for decryption
   * @param senderWallet - Optional sender wallet for decrypting sent outputs
   * @returns Array of output commitment data with NPK, value, and random where available
   */
  private async getSentCommitmentsForRailgunTxid (
    walletId: string, // Used for SubsquidBalanceScanner TXO lookup (runtime ID)
    walletAddress: string, // Used for SentTransactionStorage lookup (deterministic, persists across sessions)
    networkName: string,
    railgunTxid: string,
    railgunTransaction: any,
    receiverAddresses?: Map<number, string>, // Optional: output index -> receiver 0zk address
    receiverWallets?: Map<number, any>, // Optional: output index -> receiver wallet for decryption
    senderWallet?: any // Optional: sender wallet for decryption
  ): Promise<any[]> {
    // Get the raw commitment hashes from the transaction
    // These ARE the blinded commitments that need PPOI validation
    const allCommitments = railgunTransaction.commitments as string[]

    // For unshield transactions, exclude the last commitment (the unshield itself)
    // The unshield commitment is handled separately via getUnshieldEventsForRailgunTxid
    // This 's pattern: nonUnshieldCommitments = hasUnshield ? commitmentsOut.slice(0, -1) : commitmentsOut
    const hasUnshield = railgunTransaction.unshield
    const commitments = hasUnshield ? allCommitments.slice(0, -1) : allCommitments

    // Get wallet TXOs to enrich with npk and value for the ones we can decrypt
    const scanner = await this.getBalanceScanner()
    const allTXOs = scanner.getDecryptedCommitmentsForWallet(walletId)

    // Get full commitment data from Subsquid (includes ciphertexts for decryption)
    let subsquidCommitments = scanner.lastAllCommitments.filter(
      (c: any) => c.transactionHash.toLowerCase() === railgunTransaction.txid.toLowerCase()
    )

    // If no commitments found in cache, fetch directly from Subsquid
    if (subsquidCommitments.length === 0) {
      subsquidCommitments = await this.fetchCommitmentsFromSubsquid(
        railgunTransaction.txid,
        networkName
      )
      // If Subsquid still returns nothing, try RPC fallback
      if (subsquidCommitments.length === 0) {
        subsquidCommitments = await this.fetchCommitmentsFromRPC(
          railgunTransaction.txid,
          networkName
        )
      }
    }

    // Build a map by tree position (more reliable than hash due to BigInt precision issues)
    const subsquidByPosition = new Map<number, SubsquidCommitment>()
    for (const commit of subsquidCommitments) {
      subsquidByPosition.set(commit.treePosition, commit)
    }

    // Filter TXOs from this specific transaction (by txid)
    const txosFromThisTx = allTXOs.filter((txo: any) => txo.txid === railgunTransaction.txid)

    // Build a map by tree position to match commitments
    // Commitments in the transaction are in the order they were inserted in the tree
    const startPosition = railgunTransaction.utxoBatchStartPositionOut
    const txoByTreePosition = new Map<number, any>()
    for (const txo of txosFromThisTx) {
      txoByTreePosition.set(txo.position, txo)
    }

    // Strategy 1: Get sent outputs from local storage (stored at transaction creation time)
    const sentStorage = SentTransactionStorage.getInstance()
    // Use walletAddress (deterministic) for storage lookup - persists across browser sessions
    // Try looking up by railgunTxid first, then fall back to Ethereum txHash
    let storedOutputs = sentStorage.getSentOutputsByRailgunTxid(
      walletAddress,
      railgunTransaction.txid
    )
    if (storedOutputs.length === 0) {
      // Fallback: try looking up by Ethereum transaction hash (for older stored outputs)
      storedOutputs = sentStorage.getSentOutputsForTransaction(
        walletAddress,
        railgunTransaction.txid
      )
    }

    // Build a map by commitment hash for quick lookup
    const storedOutputsByCommitment = new Map<string, any>()
    for (const output of storedOutputs) {
      storedOutputsByCommitment.set(output.commitmentHash.toLowerCase(), output)
    }

    // Map each commitment to an object with the data needed for PPOI proof
    // Use Promise.all to handle async decryption operations
    return Promise.all(
      commitments.map(async (blindedCommitment, index) => {
        // Calculate tree position for this output commitment
        const treePosition = startPosition + index
        const txo = txoByTreePosition.get(treePosition)

        // Try to get stored output data (for payments sent to others)
        const storedOutput = storedOutputsByCommitment.get(blindedCommitment.toLowerCase())

        // Priority: 1) Decrypted TXO, 2) Stored output, 3) Sender decryption, 4) Receiver address derivation
        let derivedNPK = txo?.npk || storedOutput?.npk
        let derivedValue = txo?.value || storedOutput?.value
        let derivedRandom = txo?.random || storedOutput?.random
        let derivedTokenType = txo?.tokenType || storedOutput?.tokenType
        let derivedTokenAddress = txo?.tokenAddress || storedOutput?.tokenAddress
        let derivedTokenSubID = txo?.tokenSubID || storedOutput?.tokenSubID

        // Strategy 2: Decrypt as SENDER using ECDH(senderViewingKey, blindedReceiverViewingKey)
        if (!derivedNPK && senderWallet) {
          const subsquidCommitment = subsquidByPosition.get(treePosition)

          if (subsquidCommitment?.commitmentType === 'TransactCommitment') {
            const ciphertext = (subsquidCommitment as any).ciphertext

            if (ciphertext) {
              try {
                const decrypted = await this.tryDecryptCommitmentAsSender(
                  subsquidCommitment,
                  senderWallet
                )

                if (decrypted) {
                  derivedNPK = decrypted.npk
                  derivedValue = decrypted.value
                  derivedRandom = decrypted.random
                  derivedTokenType = decrypted.tokenType
                  derivedTokenAddress = decrypted.tokenAddress
                  derivedTokenSubID = decrypted.tokenSubID
                }
              } catch (error) {
                dlog(`Failed to decrypt output ${index} as sender: ${(error as Error)?.message}`)
              }
            }
          }
        }

        // Strategy 3: Derive NPK from receiver's 0zk address + random (legacy fallback)
        if (!derivedNPK && receiverAddresses && receiverAddresses.has(index) && derivedRandom) {
          const receiverAddress = receiverAddresses.get(index)!

          try {
            derivedNPK = this.deriveNPKFromReceiverAddress(receiverAddress, derivedRandom)
            dlog(`Derived NPK for output ${index} from receiver address`)
          } catch (error) {
            console.error(`Failed to derive NPK for output ${index}:`, error)
          }
        }

        // Return commitment data
        // Priority: 1) Decrypted TXO, 2) Decrypted as receiver, 3) Stored output data, 4) Just blinded commitment
        return {
          blindedCommitment,
          railgunTxid,
          index, // Position in output array
          treePosition, // Position in merkle tree
          // Use decrypted data if available, otherwise use stored/derived data
          npk: derivedNPK,
          value: derivedValue,
          random: derivedRandom,
          tokenType: derivedTokenType,
          tokenAddress: derivedTokenAddress,
          tokenSubID: derivedTokenSubID,
          // Flag if this came from stored data (for debugging)
          fromStorage: !txo && !!storedOutput,
          fromReceiverDecryption:
            !!receiverWallets?.has(index) && !!derivedNPK && !txo && !storedOutput,
        }
      })
    )
  }

  /**
   * Decrypt a commitment ciphertext as the SENDER using ECDH shared key derivation.
   * Calls TransactNote.decrypt with isSentNote=true.
   * @param subsquidCommitment - The Subsquid commitment with ciphertext data
   * @param senderWallet - The sender wallet for ECDH key derivation
   * @returns The decrypted commitment data, or null if decryption fails
   */
  private async tryDecryptCommitmentAsSender (
    subsquidCommitment: SubsquidCommitment,
    senderWallet: any
  ): Promise<any | null> {
    try {
      // Only TransactCommitments have ciphertexts to decrypt
      if (subsquidCommitment.commitmentType !== 'TransactCommitment') {
        return null
      }

      const ciphertextData = (subsquidCommitment as any).ciphertext
      if (!ciphertextData) {
        return null
      }

      const scanner = await this.getBalanceScanner()

      // Decrypt as SENDER using our viewing private key
      // This calls TransactNote.decrypt with isSentNote=true
      const decrypted = await scanner.tryDecryptCommitmentAsSender(subsquidCommitment, senderWallet)

      return decrypted
    } catch (error) {
      console.error('Failed to decrypt commitment as sender:', error)
      return null
    }
  }

  /**
   * Derive NPK from receiver's 0zk address and random value.
   * NPK = poseidon([receiverMasterPublicKey, random]).
   *
   * This is used when we need the receiver's MPK to recalculate NPK.
   * This is a fallback strategy when we have random but couldn't decrypt the full commitment.
   * @param receiverAddress - The receiver's 0zk RAILGUN address
   * @param random - The random value as a hex string
   * @returns The computed note public key as a hex string
   */
  private deriveNPKFromReceiverAddress (receiverAddress: string, random: string): string {
    // Decode receiver's 0zk address to get their master public key
    const decoded = decodeRailgunAddress(receiverAddress)
    const receiverMasterPublicKey = decoded.masterPublicKey

    // Calculate NPK = poseidon([receiverMPK, random])
    const randomBigInt = ByteUtils.hexToBigInt(random)
    const npk = poseidon([receiverMasterPublicKey, randomBigInt])

    // Return as hex string
    return ByteUtils.hexlify(npk)
  }

  /**
   * Get unshield events for a specific railgunTxid.
   * Filters for unshield commitments matching the railgunTxid.
   * @param _walletId - The wallet ID (unused, reserved for future use)
   * @param _networkName - The network name (unused, reserved for future use)
   * @param railgunTxid - The RAILGUN transaction ID to find unshield events for
   * @param allTXOs - All wallet TXOs to search for unshield commitments
   * @param railgunTransaction - The full RAILGUN transaction data with unshield info
   * @returns Array of unshield event objects for this transaction
   */
  private async getUnshieldEventsForRailgunTxid (
    _walletId: string,
    _networkName: string,
    railgunTxid: string,
    allTXOs: any[],
    railgunTransaction: any
  ): Promise<any[]> {
    // Filter for unshield events matching this railgunTxid
    // Unshield events are commitments with commitmentType 'UnshieldCommitment'
    const unshieldEvents = allTXOs.filter((txo) => {
      if (txo.commitmentType !== 'UnshieldCommitment') return false

      // Match unshield events by transaction hash
      return txo.txid === railgunTxid
    })

    if (unshieldEvents.length > 0) {
      return unshieldEvents
    }

    // If no UnshieldCommitments found in TXOs, check if this transaction has an unshield
    // Unshield transactions have unshield field set with boundParams.unshield value
    // AND they have unshieldPreimage with the commitment data
    if (!railgunTransaction.unshield || !railgunTransaction.unshield.toAddress) {
      return []
    }

    // Extract unshield data from the transaction's unshieldPreimage
    // The unshieldPreimage contains: npk (toAddress), token, value
    const unshieldPreimage = railgunTransaction.unshield

    // For unshields, the NPK is actually the toAddress (EVM address), not a cryptographic key
    // The blinded commitment for unshields is the railgunTxid itself (not a poseidon hash)
    const unshieldEvent = {
      id: `${railgunTxid}-unshield`,
      txid: railgunTxid,
      railgunTxid,
      commitmentType: 'UnshieldCommitment',
      hash: railgunTxid, // Unshield commitment hash is the railgunTxid
      toAddress: unshieldPreimage.toAddress,
      value: POIService.toBigInt(unshieldPreimage.value),
      npk: unshieldPreimage.toAddress, // For unshields, npk is the toAddress
      tokenAddress: unshieldPreimage.tokenAddress,
      tokenType: unshieldPreimage.tokenType,
      tokenSubID: unshieldPreimage.tokenSubID || '0',
      blockNumber: railgunTransaction.blockNumber,
      timestamp: railgunTransaction.timestamp,
      //  Unshield blinded commitment is the railgunTxid itself (not poseidon hash)
      blindedCommitment: railgunTxid,
    }

    return [unshieldEvent]
  }

  /**
   * Derive spending public key from spending private key using BabyJubJub curve.
   * @param spendingKey - The spending private key as a hex string
   * @returns The public spending key as a tuple of two bigints [x, y]
   */
  private getSpendingPublicKey (spendingKey: string): [bigint, bigint] {
    const spendingKeyBytes = ByteUtils.hexStringToBytes(spendingKey)
    return getPublicSpendingKey(spendingKeyBytes)
  }

  /**
   * Get list keys that can generate POIs for these commitments.
   * Matches PPOI.getListKeysCanGenerateSpentPOIs.
   * @param _spentTXOs - The spent TXOs (unused, reserved for future filtering)
   * @param _sentCommitments - The sent commitments (unused, reserved for future filtering)
   * @param _unshieldEvents - The unshield events (unused, reserved for future filtering)
   * @param _isLegacyPOIProof - Whether this is a legacy proof (unused, reserved for future filtering)
   * @returns Array of list key strings to generate proofs for
   */
  private getListKeysCanGenerateSpentPOIs (
    _spentTXOs: any[],
    _sentCommitments: any[],
    _unshieldEvents: any[],
    _isLegacyPOIProof: boolean
  ): string[] {
    return [POI_REQUIRED_LIST_KEYS.CHAINALYSIS_OFAC]
  }

  /**
   * Core PPOI proof generation for a given railgunTxid and listKey.
   *
   * PPOI proofs validate INPUTS (spent UTXOs have clean provenance), not outputs.
   * Flow: fetch PPOI merkle proofs for inputs -> generate SNARK proof -> submit to node.
   * On success, the PPOI node adds the output commitments to the PPOI tree.
   * @param networkName - The network the transaction occurred on
   * @param railgunTxid - The RAILGUN transaction ID
   * @param _txid - The Ethereum transaction hash (unused, kept for API compatibility)
   * @param listKey - The PPOI list key to generate the proof for
   * @param _isLegacyPOIProof - Whether this is a legacy proof (unused on testnet)
   * @param orderedSpentTXOs - The spent TXOs ordered by nullifier position
   * @param txidMerkletreeData - The TXID merkle tree data including transaction and proof
   * @param sentCommitmentsForRailgunTxid - The output commitments for this transaction
   * @param unshieldEventsForRailgunTxid - The unshield events for this transaction
   * @param wallet - The sender wallet with spending and viewing keys
   * @returns Array of blinded commitment hashes that were submitted to the PPOI node
   */
  private async generatePOIForRailgunTxidAndListKey (
    networkName: string,
    railgunTxid: string,
    _txid: string,
    listKey: string,
    _isLegacyPOIProof: boolean, // Not used on testnet - all transactions require PPOI
    orderedSpentTXOs: any[],
    txidMerkletreeData: any,
    sentCommitmentsForRailgunTxid: any[],
    unshieldEventsForRailgunTxid: any[],
    wallet: any
  ): Promise<string[]> {
    const { railgunTransaction } = txidMerkletreeData

    try {
      // Normalize both txids by stripping 0x prefix before comparison
      // The stored railgunTxid has no prefix, but the passed one may have 0x prefix
      const storedTxid = ByteUtils.strip0x(railgunTransaction.railgunTxid)
      const expectedTxid = ByteUtils.strip0x(railgunTxid)
      if (storedTxid !== expectedTxid) {
        throw new Error(
          `Invalid railgun transaction data for proof: stored=${storedTxid}, expected=${expectedTxid}`
        )
      }

      // STEP 1: Get blinded commitments for spent TXOs
      const blindedCommitmentsIn: string[] = orderedSpentTXOs
        .map((txo) => txo.blindedCommitment)
        .filter((bc): bc is string => bc !== undefined)

      dlog(`INPUT: ${orderedSpentTXOs.length} spent UTXOs for PPOI proof generation`)

      if (blindedCommitmentsIn.length !== railgunTransaction.nullifiers.length) {
        if (!orderedSpentTXOs.length) {
          throw new Error('No spent TXOs found for nullifier - data is likely still syncing')
        }
        throw new Error(
          `Not enough TXO blinded commitments for railgun transaction nullifiers: expected ${railgunTransaction.nullifiers.length}, got ${blindedCommitmentsIn.length}`
        )
      }

      // STEP 2: Get PPOI merkle proofs for INPUT commitments (not outputs — outputs are new
      // and don't exist in the PPOI tree yet)
      const ppoiClient = new PPOINodeClient(networkName as any)

      // Pre-check: verify input commitments exist in PPOI tree
      try {
        const inputCommitmentStatuses = await this.getPOIStatusForCommitments(
          networkName,
          blindedCommitmentsIn.map((bc) => ({ blindedCommitment: bc, type: 'Transact' as const }))
        )

        // Check if any missing inputs are Transact type (not Shield) — these are true dependency failures
        const missingTransactInputs = orderedSpentTXOs.filter((txo, i) => {
          const status = inputCommitmentStatuses[blindedCommitmentsIn[i]!]
          return (
            txo.commitmentType !== 'ShieldCommitment' && (!status || status.status === 'missing')
          )
        })

        if (missingTransactInputs.length > 0) {
          throw new Error(
            `This transaction depends on ${missingTransactInputs.length} earlier transaction(s) whose PPOI hasn't been submitted yet.`
          )
        }
      } catch (error: unknown) {
        if (error instanceof Error && error.message.includes('depends on')) {
          throw error
        }
        console.error('Failed to check PPOI status for input commitments:', error instanceof Error ? error.message : String(error))
      }

      // Fetch PPOI merkle proofs from PPOI node for ALL input commitments
      // Shield commitments are auto-mined by the PPOI node (public on-chain data)
      // Transact commitments need prior PPOI proofs submitted by sender
      let listPOIMerkleProofs: any[]

      try {
        listPOIMerkleProofs = await ppoiClient.getPOIMerkleProofs(
          listKey,
          blindedCommitmentsIn,
          TXIDVersion.V2_PoseidonMerkle
        )
        dlog(`Got ${listPOIMerkleProofs.length} PPOI merkle proofs from PPOI node`)
      } catch (error: unknown) {
        console.error(
          `Failed to get PPOI merkle proofs from PPOI node: ${error instanceof Error ? error.message : String(error)} (requested ${blindedCommitmentsIn.length} proofs)`
        )
        throw error
      }

      // Verify PPOI merkle proofs from PPOI node
      for (let i = 0; i < blindedCommitmentsIn.length; i++) {
        const proof = listPOIMerkleProofs[i]
        if (!proof) continue

        const rootStr = typeof proof.root === 'string' ? proof.root : String(proof.root)
        const indicesStr = typeof proof.indices === 'string' ? proof.indices : String(proof.indices)
        const blindedCommitment = blindedCommitmentsIn[i]
        if (!blindedCommitment) continue

        if (proof.elements && Array.isArray(proof.elements) && !Array.isArray(proof.elements[0])) {
          const verification = verifyPOIMerkleProof(
            blindedCommitment,
            proof.elements,
            indicesStr,
            rootStr
          )

          if (!verification.valid) {
            throw new Error(
              `PPOI merkle proof ${i} validation failed - PPOI node returned invalid proof`
            )
          }
        }
      }

      // STEP 3: Validate unshield events
      if (unshieldEventsForRailgunTxid.length > 1) {
        throw new Error('Cannot have more than 1 unshield event per railgun txid')
      }

      const hasUnshield = unshieldEventsForRailgunTxid.length > 0
      if ((railgunTransaction.unshield !== undefined) !== hasUnshield) {
        throw new Error('Expected unshield railgun transaction to have matching unshield event')
      }

      const numRailgunTransactionCommitmentsWithoutUnshields = hasUnshield
        ? railgunTransaction.commitments.length - 1
        : railgunTransaction.commitments.length

      // STEP 4: Prepare railgunTxidIfHasUnshield
      // Use 0x00 if there is no unshield
      const railgunTxidIfHasUnshield = hasUnshield
        ? this.formatRailgunTxidForNode(railgunTxid)
        : '0x00'

      if (!sentCommitmentsForRailgunTxid.length && !unshieldEventsForRailgunTxid.length) {
        throw new Error(
          `No sent commitments w/ values or unshield events for railgun txid: ${railgunTxid}`
        )
      }

      // STEP 5: Extract NPKs, values, and blinded commitments for outputs
      // Do not send 'npks' for unshields. Send for all commitments (so they match the number of commitmentsOut - unshields).
      const npksOut: bigint[] = sentCommitmentsForRailgunTxid.map((sentCommitment, index) => {
        // If we don't have npk (output sent to others), throw error immediately
        if (!sentCommitment.npk) {
          throw new Error(
            `Output ${index} is missing NPK - cannot generate valid PPOI proof!\n` +
              `  Commitment: ${sentCommitment.blindedCommitment}\n` +
              '  Possible causes:\n' +
              '    - Sender cannot decrypt their own sent outputs\n' +
              '    - Receiver wallet not provided or decryption failed\n' +
              "    - SentTransactionStorage doesn't have stored output data\n" +
              '  Solutions:\n' +
              '    1. Provide receiver wallet to generateAndSubmitPOIProof() for decryption\n' +
              '    2. Ensure SentTransactionStorage captures output data at transaction creation time'
          )
        }
        const npkBigInt = POIService.toBigInt(sentCommitment.npk)

        //  Validate NPK is not 0 (would cause invalid proof)
        if (npkBigInt === 0n) {
          throw new Error(
            `Output ${index} has NPK = 0 which will generate an invalid proof!\n` +
              `  Commitment: ${sentCommitment.blindedCommitment}\n` +
              `  NPK value: ${sentCommitment.npk}\n` +
              '  This indicates the NPK was set but has an invalid zero value.'
          )
        }

        return npkBigInt
      })
      if (npksOut.length !== numRailgunTransactionCommitmentsWithoutUnshields) {
        throw new Error(
          `Invalid number of npksOut for transaction sent commitments: expected ${numRailgunTransactionCommitmentsWithoutUnshields}, got ${npksOut.length}`
        )
      }

      const valuesOut: bigint[] = sentCommitmentsForRailgunTxid.map((sentCommitment) => {
        if (!sentCommitment.value) return 0n
        return POIService.toBigInt(sentCommitment.value)
      })
      if (valuesOut.length !== numRailgunTransactionCommitmentsWithoutUnshields) {
        throw new Error(
          `Invalid number of valuesOut for transaction sent commitments: expected ${numRailgunTransactionCommitmentsWithoutUnshields}, got ${valuesOut.length}`
        )
      }

      // Do not send 'blinded commitments' for unshields. Send for all commitments. Zero out any with 0-values.
      const ZERO_32_BYTE_VALUE =
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      const blindedCommitmentsOut: string[] = sentCommitmentsForRailgunTxid
        .map((sentCommitment) => {
          if (!sentCommitment.value || POIService.toBigInt(sentCommitment.value) === 0n) {
            return ZERO_32_BYTE_VALUE
          }
          return sentCommitment.blindedCommitment as string
        })
        .filter((bc): bc is string => bc !== undefined)

      if (blindedCommitmentsOut.length !== numRailgunTransactionCommitmentsWithoutUnshields) {
        throw new Error(
          `Not enough blindedCommitments out for transaction sent commitments (ONLY with values): expected ${numRailgunTransactionCommitmentsWithoutUnshields}, got ${blindedCommitmentsOut.length}`
        )
      }

      // STEP 6: Verify railgun txid merkle proof
      const txidMerkleProof = txidMerkletreeData.currentTxidMerkleProofForTree
      const anyRailgunTxidMerklerootAfterTransaction = txidMerkleProof.root

      const txidProofVerification = verifyPOIMerkleProof(
        txidMerkleProof.leaf,
        txidMerkleProof.elements,
        txidMerkleProof.indices,
        txidMerkleProof.root
      )

      if (!txidProofVerification.valid) {
        throw new Error('Railgun TXID merkle proof validation failed')
      }

      // STEP 7: Construct PPOI proof inputs
      const poiProofInputs: POIProofInputs = {
        anyRailgunTxidMerklerootAfterTransaction: txidMerkleProof.root,
        boundParamsHash: railgunTransaction.boundParamsHash,
        nullifiers: railgunTransaction.nullifiers,
        commitmentsOut: railgunTransaction.commitments,

        // Spender wallet info
        // Derive spending public key from spending private key
        spendingPublicKey: this.getSpendingPublicKey(wallet.spendingKey),
        nullifyingKey: wallet.nullifyingKey,

        //  Nullified notes data
        token: orderedSpentTXOs[0].tokenHash,
        randomsIn: orderedSpentTXOs.map((txo: any) => txo.random), // Keep as string
        valuesIn: orderedSpentTXOs.map((txo: any) => POIService.toBigInt(txo.value)),
        utxoPositionsIn: orderedSpentTXOs.map((txo: any) => txo.position),
        utxoTreeIn: orderedSpentTXOs[0].treeNumber,

        // Commitment notes data
        npksOut,
        valuesOut,
        utxoBatchGlobalStartPositionOut: this.computeGlobalTreePosition(
          railgunTransaction.utxoTreeOut,
          railgunTransaction.utxoBatchStartPositionOut
        ),
        railgunTxidIfHasUnshield,

        // Railgun txid tree
        railgunTxidMerkleProofIndices: txidMerkleProof.indices,
        railgunTxidMerkleProofPathElements: txidMerkleProof.elements,

        // PPOI tree — merkle roots for INPUT commitments (proves inputs have clean provenance)
        poiMerkleroots: listPOIMerkleProofs.map((poiMerkleProof: any) => poiMerkleProof.root),
        poiInMerkleProofIndices: listPOIMerkleProofs.map((poiMerkleProof: any) => poiMerkleProof.indices),
        poiInMerkleProofPathElements: listPOIMerkleProofs.map(
          (poiMerkleProof: any) => poiMerkleProof.elements
        ),
      }
      // STEP 8: Generate SNARK proof
      const {
        proof: snarkProof,
        publicSignals,
      } = await provePOI(poiProofInputs, blindedCommitmentsOut, (_progress: number) => {})

      // Use public signals from circuit output, NOT publicInputs
      // publicSignals[0..maxOutputs-1] contains circuit-calculated blinded commitments
      // The circuit calculates these from poseidon([commitmentHash, npk, position])
      const { maxInputs, maxOutputs } = getCircuitSize(
        orderedSpentTXOs.length,
        blindedCommitmentsOut.length
      )

      /**
       * Convert a value to a 0x-prefixed 32-byte hex string.
       * @param v - The value to convert
       * @returns The formatted hex string
       */
      const toHex = (v: any) => '0x' + POIService.toBigInt(v).toString(16).padStart(64, '0')

      const circuitBlindedCommitmentsOut = publicSignals
        .slice(0, maxOutputs)
        .map((signal) => toHex(signal))

      // Only submit blinded commitments for ACTUAL outputs (not padded zeros)
      const actualOutputCount = blindedCommitmentsOut.length
      const blindedCommitmentsToSubmit = circuitBlindedCommitmentsOut.slice(0, actualOutputCount)

      // STEP 9: Verify proof locally before submitting
      const artifacts = await getArtifactsPOI(maxInputs, maxOutputs)
      const snarkjs = await import('snarkjs')

      const isValid = await snarkjs.groth16.verify(artifacts.vkey, publicSignals, snarkProof)

      if (!isValid) {
        throw new Error('Generated proof failed local verification')
      }

      // STEP 10: Submit proof to PPOI node (strip 0x prefix — PPOI node stores without it)
      const poiMerklerootsWithoutPrefix = poiProofInputs.poiMerkleroots.map((root: string) =>
        root.startsWith('0x') ? root.slice(2) : root
      )

      const txidMerklerootWithoutPrefix = anyRailgunTxidMerklerootAfterTransaction.startsWith('0x')
        ? anyRailgunTxidMerklerootAfterTransaction.slice(2)
        : anyRailgunTxidMerklerootAfterTransaction

      // Validate txid merkleroot with PPOI node before submission
      const isTxidMerklerootValid = await ppoiClient.validateTxidMerkleroot(
        txidMerklerootWithoutPrefix,
        txidMerkletreeData.currentTxidIndexForTree,
        TXIDVersion.V2_PoseidonMerkle
      )

      if (!isTxidMerklerootValid) {
        // Check if the PPOI node simply hasn't indexed this transaction yet
        try {
          const latestValidated = await ppoiClient.getLatestValidatedRailgunTxid(
            TXIDVersion.V2_PoseidonMerkle
          )
          const ppoinodeIndex = latestValidated.validatedTxidIndex
          const ourIndex = txidMerkletreeData.currentTxidIndexForTree

          if (ppoinodeIndex == null || ppoinodeIndex < ourIndex) {
            // PPOI node is behind — it hasn't indexed our transaction yet
            dlog(`PPOI node is still indexing. Node at index ${ppoinodeIndex}, transaction at index ${ourIndex}.`)
            throw new Error(
              'PPOI is still indexing the transaction. Please wait a moment and try again.'
            )
          }

          // PPOI node is at or ahead of our index but still doesn't recognize the merkleroot — a real mismatch
          console.error('TXID merkleroot validation failed. PPOI node latest:', {
            validatedIndex: ppoinodeIndex,
            validatedMerkleroot: latestValidated.validatedMerkleroot,
            ourIndex,
          })
        } catch (e: unknown) {
          // Re-throw the user-friendly "still indexing" error
          if (e instanceof Error && e.message.includes('still indexing')) {
            throw e
          }
          console.error('TXID merkleroot validation failed and could not get PPOI node status:', e)
        }

        throw new Error(
          `TXID merkleroot validation failed. The PPOI node does not recognize merkleroot ${txidMerklerootWithoutPrefix} at index ${txidMerkletreeData.currentTxidIndexForTree}`
        )
      }

      dlog('TXID merkleroot validated by PPOI node')

      const chain = this.getChainFromNetworkName(networkName)
      await ppoiClient.submitTransactProof(
        TXIDVersion.V2_PoseidonMerkle,
        chain.type.toString(),
        chain.id,
        listKey,
        snarkProof,
        poiMerklerootsWithoutPrefix,
        anyRailgunTxidMerklerootAfterTransaction,
        txidMerkletreeData.currentTxidIndexForTree,
        blindedCommitmentsToSubmit,
        railgunTxidIfHasUnshield
      )
      dlog('Proof submitted and accepted by PPOI node')

      // Clear cache for these commitments so their status is re-fetched next time
      blindedCommitmentsToSubmit.forEach((commitment: string) => {
        this.clearCommitmentCache(networkName, commitment)
      })

      return blindedCommitmentsToSubmit
    } catch (cause: unknown) {
      console.error(`Failed to generate POIs for txid ${railgunTxid}:`, cause instanceof Error ? cause.message : String(cause))
      throw cause
    }
  }

  /**
   * Generate and submit a PPOI proof for a specific RAILGUN transaction.
   * @param networkName - The network the transaction occurred on
   * @param railgunTxid - The RAILGUN transaction ID to generate a proof for
   * @param wallet - The sender wallet with spending key, viewing key, and nullifying key
   * @param receiverAddresses - Optional map of output index to receiver 0zk address
   * @param receiverWallets - Optional map of output index to receiver wallet for decryption
   * @returns Result object with success flag, optional error message, and blinded commitments
   */
  public async generateAndSubmitPOIProof (
    networkName: NetworkName,
    railgunTxid: string,
    wallet: any, // Should be RailgunWallet with spendingPublicKey and nullifyingKey
    receiverAddresses?: Map<number, string>, // Optional: output index -> receiver 0zk address
    receiverWallets?: Map<number, any> // Optional: output index -> receiver wallet for decryption
  ): Promise<{ success: boolean; error?: string; blindedCommitments?: string[] }> {
    try {
      // Validate wallet has required keys
      if (!wallet) {
        throw new Error('Wallet is required for PPOI proof generation')
      }
      if (!wallet.id) {
        throw new Error('Wallet must have an ID')
      }

      const walletId = wallet.id

      // Get txid merkletree for this network
      const txidMerkletree = RailgunTxidScanner.getTxidMerkletree(networkName)

      // Get txid merkletree data (railgunTransaction + merkle proof)
      const txidMerkletreeData = await txidMerkletree.getRailgunTxidMerkletreeData(railgunTxid)
      const { railgunTransaction } = txidMerkletreeData

      // Get PPOI launch block to determine if this is a legacy proof
      // Legacy PPOI proofs are for transactions that occurred BEFORE PPOI was launched
      // on mainnet. These use a different proof structure (no PPOI tree proof required).
      // For testnet (Sepolia), PPOI was always required, so launchBlock = 0.
      const poiLaunchBlock = this.getPOILaunchBlock(networkName)
      if (poiLaunchBlock === undefined) {
        throw new Error(`No PPOI launch block configured for network: ${networkName}`)
      }
      const isLegacyPOIProof = railgunTransaction.blockNumber < poiLaunchBlock

      // Get TXOs (spent UTXOs) from wallet that match this transaction's nullifiers
      const allTXOs = await this.getWalletTXOs(walletId, networkName)

      // Compute nullifiers for spent TXOs and match against transaction nullifiers
      // Nullifier = poseidon([nullifyingKey, leafIndex])
      // where leafIndex is the tree position (NOT global tree position)
      const nullifyingKey = POIService.toBigInt(wallet.nullifyingKey)

      // Check ALL TXOs (not just those marked isSpent) for nullifier matches.
      // The on-chain nullifier is the authoritative proof that a TXO was spent.
      // The scanner's isSpent flag may be stale if a rescan hasn't happened yet
      // (e.g. immediately after performing a transaction).

      const spentTXOs = allTXOs.filter((txo) => {
        // Compute nullifier for this TXO
        // Use tree position for nullifier derivation
        const leafIndex = BigInt(txo.position)
        const nullifier = poseidon([nullifyingKey, leafIndex])
        const nullifierHex = '0x' + nullifier.toString(16).padStart(64, '0')

        // Check if this nullifier matches any in the transaction
        const matches = railgunTransaction.nullifiers.some(
          (txNullifier: string) => txNullifier.toLowerCase() === nullifierHex.toLowerCase()
        )

        if (matches) {
          txo.isSpent = true
        }

        return matches
      })

      if (spentTXOs.length === 0) {
        throw new Error(
          'No spent TXOs found for this transaction - transaction may not belong to this wallet'
        )
      }

      // Compute and attach blinded commitments and token hashes to spent TXOs
      // The spent TXOs need these for PPOI proof generation
      const scanner = await this.getBalanceScanner()
      for (const txo of spentTXOs) {
        if (!txo.blindedCommitment) {
          txo.blindedCommitment = scanner.blindedCommitmentOf(txo)
        }
        if (!txo.tokenHash) {
          const tokenHashHex = getTokenDataHash({
            tokenType: txo.tokenType,
            tokenAddress: txo.tokenAddress,
            tokenSubID: txo.tokenSubID,
          })
          // getTokenDataHash now returns a hex string
          txo.tokenHash = tokenHashHex
        }
      }

      // Get sent commitments (outputs) for this railgunTxid
      const sentCommitmentsForRailgunTxid = await this.getSentCommitmentsForRailgunTxid(
        walletId,
        wallet.address, // Use wallet.address for SentTransactionStorage (deterministic, persists)
        networkName,
        railgunTxid,
        railgunTransaction,
        receiverAddresses, // Pass receiver addresses for NPK derivation
        receiverWallets, // Pass receiver wallets for decrypting payment data
        wallet // Pass sender wallet for payment decryption
      )

      // Get unshield events for this railgunTxid (if any)
      const unshieldEventsForRailgunTxid = await this.getUnshieldEventsForRailgunTxid(
        walletId,
        networkName,
        railgunTxid,
        allTXOs,
        railgunTransaction
      )

      // Validate we have all commitments decrypted
      if (
        railgunTransaction.commitments.length !==
        sentCommitmentsForRailgunTxid.length + unshieldEventsForRailgunTxid.length
      ) {
        throw new Error(
          `Cannot generate PPOI: have not decrypted all commitments for railgunTxid ${railgunTxid}. ` +
            `Expected ${railgunTransaction.commitments.length}, have ${sentCommitmentsForRailgunTxid.length + unshieldEventsForRailgunTxid.length}`
        )
      }

      // Skip if unshield transaction but no unshield events
      if (railgunTransaction.unshield && !unshieldEventsForRailgunTxid.length) {
        throw new Error('Transaction has unshield but no unshield events found')
      }

      // Get list keys we can generate POIs for
      const listKeys = this.getListKeysCanGenerateSpentPOIs(
        spentTXOs,
        sentCommitmentsForRailgunTxid,
        unshieldEventsForRailgunTxid,
        isLegacyPOIProof
      )

      if (!listKeys.length) {
        throw new Error('No list keys available for PPOI generation')
      }

      // Order spent TXOs by nullifier order in railgunTransaction
      // This is CRITICAL for prover validation
      const orderedSpentTXOs = railgunTransaction.nullifiers
        .map((nullifier: string) => {
          // Find the TXO that matches this nullifier
          // We need to recompute the nullifier for each TXO to match
          return spentTXOs.find((txo) => {
            const leafIndex = BigInt(txo.position)
            const computedNullifier = poseidon([nullifyingKey, leafIndex])
            const nullifierHex = '0x' + computedNullifier.toString(16).padStart(64, '0')
            return nullifierHex.toLowerCase() === nullifier.toLowerCase()
          })
        })
        .filter((txo): txo is NonNullable<typeof txo> => txo !== undefined)

      if (orderedSpentTXOs.length !== spentTXOs.length) {
        throw new Error('Could not order all spent TXOs by nullifier')
      }

      // Generate and submit PPOI for first list key
      const listKey = listKeys[0]
      if (!listKey) {
        throw new Error('No list keys available for PPOI generation')
      }

      const blindedCommitments = await this.generatePOIForRailgunTxidAndListKey(
        networkName,
        railgunTxid,
        railgunTransaction.txid,
        listKey,
        isLegacyPOIProof,
        orderedSpentTXOs,
        txidMerkletreeData,
        sentCommitmentsForRailgunTxid,
        unshieldEventsForRailgunTxid,
        wallet
      )

      dlog('PPOI proof generated and submitted successfully, verifying status...')

      return { success: true, blindedCommitments }
    } catch (error: unknown) {
      console.error('Failed to generate PPOI proof:', {
        railgunTxid,
        error: error instanceof Error ? error.message : String(error),
      })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error during PPOI proof generation',
      }
    }
  }
}
